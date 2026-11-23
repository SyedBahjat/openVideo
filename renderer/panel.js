/* global ov */
const $ = (s) => document.querySelector(s);
const MIME_CANDIDATES = [
  ['video/mp4;codecs=avc1,mp4a.40.2', '.mp4'], // H.264 + AAC: plays in QuickTime / Windows Media Player
  ['video/mp4', '.mp4'],
  ['video/webm;codecs=vp9,opus', '.webm'],
  ['video/webm', '.webm'],
];
const CHUNK_MS = 1000;

let mode = 'screen+cam';
let sourceId = null;
let session = null; // active recording
let shareCfg = { shares: {} };

// Shown above whichever section is open (a message on a hidden page looks like "nothing happened").
let noticeTimer = null;
const notice = (msg) => {
  $('#notice').hidden = !msg;
  $('#notice').textContent = msg || '';
  clearTimeout(noticeTimer);
  if (msg) noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 12_000);
};
// IPC errors arrive as "Error invoking remote method 'x': Error: msg"; show just msg.
const errMsg = (e) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const stopTracks = (streams) => streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));

function pickMime() {
  const hit = MIME_CANDIDATES.find(([m]) => MediaRecorder.isTypeSupported(m));
  if (!hit) throw new Error('This system cannot encode video with MediaRecorder.');
  return { mime: hit[0], ext: hit[1] };
}

// MediaRecorder records one audio track, so mic + system audio are mixed first.
function mixAudio(tracks) {
  if (tracks.length <= 1) return { track: tracks[0], ctx: null };
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  tracks.forEach((t) => ctx.createMediaStreamSource(new MediaStream([t])).connect(dest));
  return { track: dest.stream.getAudioTracks()[0], ctx };
}

// ---------- setup UI
function fillSelect(sel, devices, none) {
  const prev = sel.value;
  sel.replaceChildren(new Option(none, ''), ...devices.map((d, i) => new Option(d.label || `Device ${i + 1}`, d.deviceId)));
  sel.value = devices.some((d) => d.deviceId === prev) ? prev : (devices[0]?.deviceId ?? '');
}

async function loadDevices() {
  // Labels/ids are only exposed after a grant. Probe only what's already allowed; the permission card asks for the rest.
  for (const [kind, perm] of [['video', 'camera'], ['audio', 'microphone']]) {
    if (perms[perm] !== 'granted') continue;
    try { stopTracks([await navigator.mediaDevices.getUserMedia({ [kind]: true })]); } catch { /* no device */ }
  }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.deviceId);
  fillSelect($('#cam'), devices.filter((d) => d.kind === 'videoinput'), perms.camera === 'granted' ? 'No camera' : 'Camera not allowed yet');
  fillSelect($('#mic'), devices.filter((d) => d.kind === 'audioinput'), perms.microphone === 'granted' ? 'No microphone' : 'Microphone not allowed yet');
  syncCamera();
  reportBar();
}

async function loadSources() {
  if (perms.screen !== 'granted') {
    const empty = document.createElement('p');
    empty.className = 'sources-empty';
    empty.textContent = 'Your screens and windows show up here once Screen Recording is allowed (see the steps above).';
    $('#sources').replaceChildren(empty);
    sourceId = null;
    return;
  }
  const sources = await ov.sources();
  $('#sources').replaceChildren(...sources.map((s) => {
    const b = document.createElement('button');
    b.className = 'source';
    b.dataset.id = s.id;
    b.setAttribute('role', 'option');
    const img = new Image();
    img.src = s.thumb;
    img.alt = '';
    const label = document.createElement('span');
    label.textContent = s.screen ? `🖥 ${s.name}` : s.name; // textContent: window titles are untrusted
    b.append(img, label);
    b.addEventListener('click', () => { sourceId = s.id; markSource(); });
    return b;
  }));
  if (!sources.some((s) => s.id === sourceId)) sourceId = sources[0]?.id ?? null;
  markSource();
}

function markSource() {
  document.querySelectorAll('.source').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.id === sourceId)));
  reportBar();
}

function setMode(next) {
  mode = next;
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  $('#source-block').hidden = mode === 'cam';
  $('#sys-field').hidden = mode === 'cam';
  $('#cam-field').hidden = mode === 'screen';
  syncCamera();
  renderPerms();
}

// The camera bubble is a preview: only while you're on the Record page (main also drops it when this window is
// hidden or minimised). During a recording main keeps it regardless.
function syncCamera() {
  const onRecord = !$('#view-record').hidden;
  ov.camera(onRecord && mode !== 'screen' && perms.camera === 'granted' && $('#cam').value ? $('#cam').value : null);
}

// ---------- recording
async function start() {
  if (session) return;
  if (missingPerms().length) { pointAtPerms(); return; }
  $('#start').disabled = true;
  notice('');
  const streams = [];
  let fileOpen = false;
  try {
    let video;
    if (mode !== 'cam') {
      if (!sourceId) throw new Error('Pick a screen or window to record.');
      const sys = $('#sys').checked;
      await ov.selectSource(sourceId, sys);
      const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: sys });
      streams.push(display);
      video = display.getVideoTracks()[0];
    } else {
      if (!$('#cam').value) throw new Error('Pick a camera to record.');
      const cam = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: $('#cam').value }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      streams.push(cam);
      video = cam.getVideoTracks()[0];
    }
    if ($('#mic').value) {
      streams.push(await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: $('#mic').value }, echoCancellation: true, noiseSuppression: true },
      }));
    }
    const { track: audio, ctx } = mixAudio(streams.flatMap((s) => s.getAudioTracks()));
    const { mime, ext } = pickMime();

    await ov.camera(mode !== 'screen' && $('#cam').value ? $('#cam').value : null); // bubble for the recording
    await ov.countdown();
    await ov.recStart(ext, mode !== 'cam');
    fileOpen = true;

    const rec = new MediaRecorder(new MediaStream(audio ? [video, audio] : [video]), {
      mimeType: mime, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 160_000,
    });
    const s = { rec, streams, ctx, queue: Promise.resolve(), discard: false, restart: false, error: null };
    session = s;
    // Serialize writes so chunks hit the disk in order; on a write failure stop instead of writing a gappy file.
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      s.queue = s.queue
        .then(() => (s.error ? null : e.data.arrayBuffer().then(ov.chunk)))
        .catch((err) => { s.error = err; stop(); });
    };
    rec.onstop = () => finish(s);
    video.addEventListener('ended', stop); // user hit the OS "Stop sharing" button
    rec.start(CHUNK_MS);
    ov.state({ paused: false });
    reportBar();
  } catch (err) {
    stopTracks(streams);
    if (fileOpen) await ov.recDiscard();
    else await ov.recStop(); // brings the panel back if the countdown hid it
    notice(errMsg(err));
    $('#start').disabled = false;
  }
}

function stop() {
  if (session && session.rec.state !== 'inactive') session.rec.stop();
}

async function finish(s) {
  await s.queue;
  stopTracks(s.streams);
  s.ctx?.close();
  session = null;
  let name = null;
  try {
    name = s.discard ? await ov.recDiscard() : await ov.recStop();
  } catch (err) {
    s.error = s.error || err;
  }
  $('#start').disabled = false;
  reportBar();
  if (s.error) notice(`Recording stopped early: ${errMsg(s.error)}. Whatever was saved is kept in the library.`);
  await loadLibrary(name);
  if (s.restart) start();
}

ov.onControl((action) => {
  if (!session) { if (action === 'toggle') start(); return; }
  const { rec } = session;
  if (action === 'toggle' || action === 'stop') stop();
  else if (action === 'pause' && rec.state === 'recording') { rec.pause(); ov.state({ paused: true }); }
  else if (action === 'resume' && rec.state === 'paused') { rec.resume(); ov.state({ paused: false }); }
  else if (action === 'restart') { session.discard = true; session.restart = true; stop(); }
  else if (action === 'cancel') { session.discard = true; stop(); }
});
ov.onRecError((msg) => notice(`Disk write failed: ${msg}`));

// ---------- library
const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function play(item) {
  const p = $('#player');
  p.hidden = false;
  p.src = item.url;
  p.play().catch(() => {});
}

function action(label, fn) {
  const b = document.createElement('button');
  b.className = 'link';
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

async function loadLibrary(highlight) {
  const items = await ov.list();
  $('#lib-count').textContent = items.length ? `${items.length} recording${items.length === 1 ? '' : 's'}` : 'Your recordings';
  $('#empty').hidden = items.length > 0;
  $('#list').replaceChildren(...items.map((it) => {
    const li = document.createElement('li');
    if (it.name === highlight) li.classList.add('fresh');
    const title = document.createElement('button');
    title.className = 'title';
    title.textContent = it.name.replace(/^openVideo /, '').replace(/\.\w+$/, '');
    title.addEventListener('click', () => play(it));
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${fmtDate(it.mtime)} · ${fmtSize(it.size)}`;
    const acts = document.createElement('span');
    acts.className = 'acts';
    acts.append(
      ...shareActions(it),
      action('Show', () => ov.reveal(it.name)),
      action('Copy path', () => ov.copyPath(it.name).then(() => notice('Path copied to clipboard.'))),
      action('Trash', async () => {
        if ($('#player').src === it.url) { $('#player').removeAttribute('src'); $('#player').hidden = true; }
        await ov.trash(it.name);
        loadLibrary();
      }),
    );
    li.append(title, meta, acts);
    return li;
  }));
  const fresh = items.find((i) => i.name === highlight);
  if (fresh) { showView('library'); play(fresh); }
}

// ---------- sharing
function shareActions(it) {
  const url = shareCfg.shares[it.name];
  if (url) {
    const acts = [
      action('Copy link', () => navigator.clipboard.writeText(url).then(() => notice('Link copied.'))),
      action('Open', () => ov.openUrl(url)),
    ];
    if (shareCfg.privateShares?.[it.name]) {
      const tag = document.createElement('span');
      tag.className = 'private-tag';
      tag.textContent = '🔒 Private';
      tag.title = 'Only people with access to the repo on GitHub can watch';
      acts.unshift(tag);
    }
    return acts;
  }
  const b = action('Share', () => {
    if (!shareCfg.configured) return notice('Sharing isn\'t available in this build of openVideo.');
    if (!shareCfg.connected) { pendingShare = () => openDest(it, b); showStep('intro'); return; }
    openDest(it, b);
  });
  return [b];
}

async function upload(it, b, dest) {
  b.disabled = true;
  b.textContent = 'Uploading…';
  try {
    const link = await ov.shareUpload(it.name, dest);
    notice(`Link copied: ${link}${dest.private ? ' (private: viewers sign in with GitHub)' : ''}`);
    maybeNudgeStar();
    await refreshShare();
    await loadLibrary();
  } catch (err) {
    const msg = errMsg(err);
    b.disabled = false;
    b.textContent = 'Share';
    if (msg === 'NEED_PRIVATE') { pendingShare = () => upload(it, b, dest); showStep('private'); return; }
    if (msg === 'RECONNECT') {
      await refreshShare();
      pendingShare = () => upload(it, b, dest);
      $('#connect-expired').hidden = false;
      showStep('intro');
      return;
    }
    notice(`Share failed: ${msg}`);
  }
}

// ---------- "Share this video" sheet: which repo, and public or private
let destFor = null; // { it, b }
let repos = [];
let vis = 'public';

const destKind = () => document.querySelector('input[name="dest"]:checked')?.value || 'main';

function setVis(next) {
  vis = next;
  document.querySelectorAll('[data-vis]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.vis === vis)));
}

// Visibility is chosen only when a repo is being created; an existing repo keeps its own.
function renderDest() {
  const kind = destKind();
  const main = repos.find((r) => r.name === shareCfg.repo);
  const picked = repos.find((r) => r.name === $('#dest-existing').value);
  const fixed = kind === 'main' ? main : kind === 'existing' ? picked : null;
  $('#dest-vis-block').hidden = Boolean(fixed);
  $('#dest-vis-note').textContent = fixed
    ? (fixed.private
      ? `🔒 ${fixed.name} is private: only people you've given access to it on GitHub can watch. They sign in with GitHub.`
      : `${fixed.name} is public: anyone with the link can watch.`)
    : (vis === 'private'
      ? 'Viewers sign in with GitHub, and only people with access to this repo can watch. Add teammates in the repo\'s Settings → Collaborators on GitHub.'
      : 'Anyone with the link can watch. Don\'t share anything private.');
  $('#dest-main-note').textContent = `github.com/${shareCfg.login}/${shareCfg.repo}${main ? (main.private ? ' · private' : ' · public') : ' · created on first share'}`;
  $('#dest-error').hidden = true;
}

async function openDest(it, b) {
  destFor = { it, b };
  $('#dest-video').textContent = it.name.replace(/^openVideo /, '').replace(/\.\w+$/, '');
  $('#dest-go').disabled = true;
  showStep('dest');
  try { repos = await ov.shareRepos(); } catch { repos = []; } // offline or expired: Share will say so
  const others = repos.filter((r) => r.name !== shareCfg.repo);
  $('#dest-existing').replaceChildren(...others.map((r) => new Option(`${r.private ? '🔒 ' : ''}${r.name}`, r.name)));
  $('#dest-existing-opt').hidden = others.length === 0;
  $('#dest-new').value = await ov.shareNewName(it.name).catch(() => 'openvideo-video');
  const last = shareCfg.dest || { kind: 'main' };
  const kind = last.kind === 'existing' && others.some((r) => r.name === last.repo) ? 'existing' : (last.kind === 'new' ? 'new' : 'main');
  if (kind === 'existing') $('#dest-existing').value = last.repo;
  document.querySelector(`input[name="dest"][value="${kind}"]`).checked = true;
  setVis(last.private ? 'private' : 'public');
  renderDest();
  $('#dest-go').disabled = false;
}

function destChoice() {
  const kind = destKind();
  const repo = kind === 'main' ? shareCfg.repo : kind === 'existing' ? $('#dest-existing').value : $('#dest-new').value.trim();
  const known = repos.find((r) => r.name === repo);
  return { kind, repo, private: known ? known.private : vis === 'private' };
}

$('#dest-go').addEventListener('click', () => {
  const dest = destChoice();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(dest.repo) || dest.repo === '.' || dest.repo === '..') {
    $('#dest-error').hidden = false;
    $('#dest-error').textContent = 'Repo names can use letters, numbers, - _ and . (up to 100 characters).';
    return;
  }
  if (dest.kind === 'new' && repos.some((r) => r.name === dest.repo)) {
    $('#dest-error').hidden = false;
    $('#dest-error').textContent = `You already have ${dest.repo}. Pick it under "Another openVideo repo", or choose a new name.`;
    return;
  }
  const { it, b } = destFor;
  $('#connect').close();
  upload(it, b, dest);
});
document.querySelectorAll('input[name="dest"]').forEach((r) => r.addEventListener('change', renderDest));
$('#dest-existing').addEventListener('change', () => { document.querySelector('input[name="dest"][value="existing"]').checked = true; renderDest(); });
$('#dest-new').addEventListener('focus', () => { document.querySelector('input[name="dest"][value="new"]').checked = true; renderDest(); });
document.querySelectorAll('[data-vis]').forEach((x) => x.addEventListener('click', () => { setVis(x.dataset.vis); renderDest(); }));
$('#private-go').addEventListener('click', () => connectGitHub({ wantPrivate: true }));

// The connect sheet: intro -> device code -> (account view when already connected).
let pendingShare = null; // share the user clicked before connecting; resumed after sign-in
let deviceUrl = '';

function showStep(step) {
  document.querySelectorAll('#connect [data-step]').forEach((el) => { el.hidden = el.dataset.step !== step; });
  if (!$('#connect').open) $('#connect').showModal();
}

function renderShare() {
  const c = shareCfg;
  $('#account').hidden = !c.connected;
  $('#account').textContent = c.connected ? `@${c.login}` : '';
  $('#account').title = 'GitHub account used for share links';
}

async function refreshShare() {
  shareCfg = await ov.shareConfig();
  renderShare();
}

async function connectGitHub(opts = {}) {
  $('#connect-go').disabled = true;
  $('#private-go').disabled = true;
  try {
    shareCfg = await ov.shareLogin(opts);
    const next = pendingShare; // read before close(): the close handler clears it
    pendingShare = null;
    $('#connect-expired').hidden = true;
    $('#connect').close();
    notice(opts.wantPrivate ? 'Private repos allowed.' : `Connected to GitHub as @${shareCfg.login}.`);
    refreshStar();
    renderShare();
    if (next) next(); // carry on with the share they asked for
  } catch (err) {
    const msg = errMsg(err);
    if (msg !== 'Cancelled') { $('#connect').close(); notice(`GitHub sign-in failed: ${msg}`); }
  } finally {
    $('#connect-go').disabled = false;
    $('#private-go').disabled = false;
  }
}

$('#connect-go').addEventListener('click', () => connectGitHub());
$('#reopen').addEventListener('click', () => { if (deviceUrl) ov.openUrl(deviceUrl); });
$('#account').addEventListener('click', () => {
  $('#acct-login').textContent = shareCfg.login;
  $('#acct-repo').textContent = `github.com/${shareCfg.login}/${shareCfg.repo}`;
  showStep('account');
});
$('#acct-repo').addEventListener('click', (e) => { e.preventDefault(); ov.openUrl(`https://github.com/${shareCfg.login}/${shareCfg.repo}`); });
$('#disconnect').addEventListener('click', async () => { shareCfg = await ov.shareLogout(); $('#connect').close(); renderShare(); refreshStar(); });
document.querySelectorAll('#connect [data-close]').forEach((b) => b.addEventListener('click', () => $('#connect').close()));
$('#connect').addEventListener('close', () => { pendingShare = null; $('#connect-expired').hidden = true; ov.shareCancelLogin(); });
ov.onShareCode(({ userCode, url }) => {
  deviceUrl = url;
  $('#device-code').textContent = userCode;
  showStep('code');
});

// ---------- star
let starState = { starred: false, connected: false, nudged: false };

function renderStar() {
  $('#star').textContent = starState.starred ? '★ Starred' : '★ Star';
  $('#star').classList.toggle('on', starState.starred);
  $('#star').title = starState.starred ? 'Thanks for starring openVideo!' : 'Star openVideo on GitHub';
}

async function refreshStar() {
  try { starState = await ov.starStatus(); } catch { /* offline: keep defaults */ }
  renderStar();
}

async function handleStar() {
  if (starState.starred) return;
  try {
    const r = await ov.star();
    if (r.starred) { starState = { ...starState, starred: true }; notice('Thank you for the star! ⭐'); }
    else notice('Opened openVideo on GitHub. Click ★ Star at the top of the page.');
  } catch (err) { notice(errMsg(err)); }
  $('#star-nudge').hidden = true;
  renderStar();
}

function maybeNudgeStar() {
  if (starState.starred || starState.nudged) return;
  $('#star-nudge').hidden = false;
  starState = { ...starState, nudged: true };
  ov.starNudged(); // once per install
}

$('#star').addEventListener('click', handleStar);
$('#nudge-star').addEventListener('click', handleStar);
$('#nudge-close').addEventListener('click', () => { $('#star-nudge').hidden = true; });

// ---------- permissions (spoon-fed: one card, one row per missing permission)
let perms = { screen: 'granted', camera: 'granted', microphone: 'granted', platform: ov.platform };
const IS_MAC = ov.platform === 'darwin';
const PERM_INFO = {
  screen: { icon: '🖥️', title: 'Screen Recording', why: 'so openVideo can see the screen you want to record' },
  camera: { icon: '📷', title: 'Camera', why: 'for your camera bubble' },
  microphone: { icon: '🎙️', title: 'Microphone', why: 'so your voice is in the video' },
};

function missingPerms() {
  const need = ['microphone'];
  if (mode !== 'cam') need.unshift('screen');
  if (mode !== 'screen') need.push('camera');
  return need.filter((k) => perms[k] !== 'granted');
}

// "Click **Open Settings**" -> text with <b> parts, without innerHTML.
function rich(text) {
  const p = document.createElement('span');
  text.split('**').forEach((part, i) => {
    if (!part) return;
    if (i % 2) { const b = document.createElement('b'); b.textContent = part; p.append(b); } else p.append(part);
  });
  return p;
}

function button(label, cls, fn) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

function stepsFor(kind) {
  const status = perms[kind];
  if (kind === 'screen') {
    return {
      steps: [
        'Click **Open Settings**. It opens **Screen & System Audio Recording**.',
        'Find **openVideo** in the list and switch it **on**. Not in the list? Click **+**, then pick openVideo in Applications.',
        'If macOS offers **Quit & Reopen**, click it. Otherwise click **Restart openVideo** here.',
      ],
      mock: true,
      actions: [
        button('Open Settings', 'pill-btn', () => ov.requestPermission('screen')),
        button('Restart openVideo', 'link', () => ov.relaunch()),
      ],
    };
  }
  const name = PERM_INFO[kind].title.toLowerCase();
  if (IS_MAC && status === 'not-determined') {
    return {
      steps: [`Click **Allow ${name}**, then click **Allow** in the box macOS shows.`],
      actions: [button(`Allow ${name}`, 'pill-btn', () => ov.requestPermission(kind).then(applyPerms))],
    };
  }
  return {
    steps: IS_MAC
      ? [`Click **Open Settings**. It opens the **${PERM_INFO[kind].title}** list.`, 'Switch **openVideo** on.', 'Come back here. This card updates by itself.']
      : [`Click **Open Settings**.`, `Turn on **Let desktop apps access your ${name}**.`, 'Come back here. This card updates by itself.'],
    mock: IS_MAC,
    actions: [button('Open Settings', 'pill-btn', () => ov.requestPermission(kind))],
  };
}

function permRow(kind) {
  const info = PERM_INFO[kind];
  const { steps, actions, mock } = stepsFor(kind);
  const li = document.createElement('li');
  li.className = 'perm';
  const head = document.createElement('div');
  head.className = 'perm-head';
  const icon = document.createElement('span');
  icon.className = 'perm-icon';
  icon.textContent = info.icon;
  const title = document.createElement('div');
  title.append(rich(`**${info.title}**`), document.createElement('br'));
  const why = document.createElement('small');
  why.textContent = `Needed ${info.why}.`;
  title.append(why);
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = 'Not allowed yet';
  head.append(icon, title, badge);

  const ol = document.createElement('ol');
  ol.className = 'perm-steps';
  steps.forEach((t) => { const s = document.createElement('li'); s.append(rich(t)); ol.append(s); });
  li.append(head, ol);
  if (mock) li.append(settingsMock());
  const row = document.createElement('div');
  row.className = 'row';
  row.append(...actions);
  li.append(row);
  return li;
}

// A tiny picture of the System Settings row they need to find, with the switch flipping on.
function settingsMock() {
  const m = document.createElement('div');
  m.className = 'mock';
  m.setAttribute('aria-hidden', 'true');
  const img = new Image();
  img.src = 'icon.png';
  img.alt = '';
  const name = document.createElement('span');
  name.textContent = 'openVideo';
  const sw = document.createElement('span');
  sw.className = 'switch';
  m.append(img, name, sw);
  return m;
}

function renderPerms() {
  const missing = missingPerms();
  $('#perms').hidden = missing.length === 0;
  $('#perm-list').replaceChildren(...missing.map(permRow));
  $('#start').lastChild.textContent = missing.length ? 'Allow access first' : 'Start recording';
  reportBar();
}

function pointAtPerms() {
  $('#perms').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#perms').classList.remove('flash');
  void $('#perms').offsetWidth; // restart the highlight animation
  $('#perms').classList.add('flash');
}

async function applyPerms(next) {
  const before = perms;
  perms = { ...perms, ...next };
  const changed = ['screen', 'camera', 'microphone'].some((k) => before[k] !== perms[k]);
  if (!changed) return;
  renderPerms();
  if (before.camera !== perms.camera || before.microphone !== perms.microphone) await loadDevices();
  if (before.screen !== perms.screen) await loadSources();
  if (!missingPerms().length) notice('All set. You can record now.');
}

async function refreshPerms() {
  try { await applyPerms(await ov.permissions()); } catch { /* keep last known */ }
}

ov.onPermissionsChanged(applyPerms);
// While the card is up, keep checking: people flip the switch in Settings and come straight back.
setInterval(() => { if (!$('#perms').hidden) refreshPerms(); }, 1500);

// ---------- sections (sidebar tabs)
function showView(name) {
  document.querySelectorAll('[role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === name)));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  syncCamera();
}

// ---------- recording bar (floating pill). The panel owns the choices; the bar mirrors them and sends actions.
let lastMic = '';
const optionText = (sel) => (sel.value ? sel.selectedOptions[0]?.textContent || '' : '');
const hasDevice = (sel) => [...sel.options].some((o) => o.value);

function reportBar() {
  const src = [...document.querySelectorAll('.source')].find((b) => b.dataset.id === sourceId);
  ov.bar.report({
    mode, sourceId, sourceName: src ? src.querySelector('span').textContent.replace(/^🖥 /, '') : '',
    hasCamera: hasDevice($('#cam')), cameraName: optionText($('#cam')),
    hasMic: hasDevice($('#mic')), mic: Boolean($('#mic').value), micName: optionText($('#mic')),
    sys: $('#sys').checked, needsPerms: missingPerms().length > 0, recording: Boolean(session),
  });
}

ov.bar.onAction(async ({ action, id }) => {
  if (action === 'source') {
    if (mode === 'cam') setMode('screen+cam');
    sourceId = String(id);
    await loadSources(); // a window opened after our last refresh may be new to the grid
  } else if (action === 'cam-only') setMode('cam');
  else if (action === 'camera') setMode(mode === 'screen+cam' ? 'screen' : mode === 'cam' ? 'screen' : 'screen+cam');
  else if (action === 'mic') {
    const mic = $('#mic');
    if (mic.value) { lastMic = mic.value; mic.value = ''; }
    else mic.value = [...mic.options].some((o) => o.value === lastMic) ? lastMic : ([...mic.options].find((o) => o.value)?.value ?? '');
  } else if (action === 'sys') $('#sys').checked = !$('#sys').checked;
  else if (action === 'record') {
    if (missingPerms().length) { showView('record'); pointAtPerms(); } else start();
  }
  reportBar();
});

// ---------- boot
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('#cam').addEventListener('change', syncCamera);
$('#start').addEventListener('click', start);
$('#refresh').addEventListener('click', () => loadSources());
$('#open-dir').addEventListener('click', () => ov.openDir());
$('#import').addEventListener('click', async () => {
  try {
    const name = await ov.importVideo();
    if (name) { await loadLibrary(name); notice('Video added. Click Share to get a link.'); }
  } catch (err) { notice(`Could not add video: ${errMsg(err)}`); }
});
$('#shortcut').textContent = ov.platform === 'darwin' ? '⌘ ⇧ L' : 'Ctrl Shift L';
$('#shortcut2').textContent = $('#shortcut').textContent;
if (ov.platform !== 'darwin') $('#feat-draw').textContent = 'Point things out with Ctrl+Shift+D';
$('#mic').addEventListener('change', reportBar);
$('#sys').addEventListener('change', reportBar);
$('#show-bar').addEventListener('click', () => ov.bar.act('show'));
document.querySelectorAll('[role="tab"]').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
$('#sys-note').textContent = ov.platform === 'darwin' ? '(macOS 13+, best effort)' : '';
navigator.mediaDevices.addEventListener('devicechange', loadDevices);

(async () => {
  try { perms = { ...perms, ...(await ov.permissions()) }; } catch { /* assume granted; capture will report errors */ }
  setMode(mode);
  refreshStar();
  await Promise.all([loadDevices(), loadSources(), refreshShare().then(() => loadLibrary())]);
})().catch((err) => notice(errMsg(err)));
