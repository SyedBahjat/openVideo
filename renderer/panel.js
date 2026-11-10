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

const notice = (msg) => { $('#notice').hidden = !msg; $('#notice').textContent = msg || ''; };
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

function syncCamera() {
  ov.camera(mode !== 'screen' && perms.camera === 'granted' && $('#cam').value ? $('#cam').value : null);
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
  if (fresh) play(fresh);
}

// ---------- sharing
function shareActions(it) {
  const url = shareCfg.shares[it.name];
  if (url) {
    return [
      action('Copy link', () => navigator.clipboard.writeText(url).then(() => notice('Link copied.'))),
      action('Open', () => ov.openUrl(url)),
    ];
  }
  const b = action('Share', async () => {
    if (!shareCfg.configured) return notice('Sharing isn\'t available in this build of openVideo.');
    if (!shareCfg.connected) { pendingShare = () => b.click(); showStep('intro'); return; }
    b.disabled = true;
    b.textContent = 'Uploading…';
    try {
      const link = await ov.shareUpload(it.name);
      notice(`Link copied: ${link}`);
      maybeNudgeStar();
      await refreshShare();
      await loadLibrary();
    } catch (err) {
      notice(`Share failed: ${errMsg(err)}`);
      b.disabled = false;
      b.textContent = 'Share';
    }
  });
  return [b];
}

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

async function connectGitHub() {
  $('#connect-go').disabled = true;
  try {
    shareCfg = await ov.shareLogin();
    const next = pendingShare; // read before close(): the close handler clears it
    pendingShare = null;
    $('#connect').close();
    notice(`Connected to GitHub as @${shareCfg.login}.`);
    refreshStar();
    renderShare();
    if (next) next(); // carry on with the share they asked for
  } catch (err) {
    const msg = errMsg(err);
    if (msg !== 'Cancelled') { $('#connect').close(); notice(`GitHub sign-in failed: ${msg}`); }
  } finally {
    $('#connect-go').disabled = false;
  }
}

$('#connect-go').addEventListener('click', connectGitHub);
$('#reopen').addEventListener('click', () => { if (deviceUrl) ov.openUrl(deviceUrl); });
$('#account').addEventListener('click', () => {
  $('#acct-login').textContent = shareCfg.login;
  $('#acct-repo').textContent = `github.com/${shareCfg.login}/${shareCfg.repo}`;
  showStep('account');
});
$('#acct-repo').addEventListener('click', (e) => { e.preventDefault(); ov.openUrl(`https://github.com/${shareCfg.login}/${shareCfg.repo}`); });
$('#disconnect').addEventListener('click', async () => { shareCfg = await ov.shareLogout(); $('#connect').close(); renderShare(); refreshStar(); });
document.querySelectorAll('#connect [data-close]').forEach((b) => b.addEventListener('click', () => $('#connect').close()));
$('#connect').addEventListener('close', () => { pendingShare = null; ov.shareCancelLogin(); });
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
$('#sys-note').textContent = ov.platform === 'darwin' ? '(macOS 13+, best effort)' : '';
navigator.mediaDevices.addEventListener('devicechange', loadDevices);

(async () => {
  try { perms = { ...perms, ...(await ov.permissions()) }; } catch { /* assume granted; capture will report errors */ }
  setMode(mode);
  refreshStar();
  await Promise.all([loadDevices(), loadSources(), refreshShare().then(() => loadLibrary())]);
})().catch((err) => notice(errMsg(err)));
