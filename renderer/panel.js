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
  // Device labels are only exposed after a permission grant, so ask once up front (also triggers the OS prompt).
  for (const kind of ['video', 'audio']) {
    try { stopTracks([await navigator.mediaDevices.getUserMedia({ [kind]: true })]); } catch { /* no device or denied */ }
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  fillSelect($('#cam'), devices.filter((d) => d.kind === 'videoinput'), 'No camera');
  fillSelect($('#mic'), devices.filter((d) => d.kind === 'audioinput'), 'No microphone');
  syncCamera();
}

async function loadSources(openSettings = false) {
  const perms = await ov.permissions();
  if (perms.screen !== 'granted' && perms.screen !== 'not-determined') {
    notice('Screen Recording permission is off. Enable openVideo in System Settings → Privacy & Security → Screen Recording, then restart openVideo. "Cam only" works meanwhile.');
    if (openSettings) ov.openScreenSettings();
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
}

function syncCamera() {
  ov.camera(mode !== 'screen' && $('#cam').value ? $('#cam').value : null);
}

// ---------- recording
async function start() {
  if (session) return;
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
      if (!shareCfg.connected) $('#sharing').open = true; // walk them to the setup steps
      b.disabled = false;
      b.textContent = 'Share';
    }
  });
  return [b];
}

function renderShare() {
  const c = shareCfg;
  const hasShared = Object.keys(c.shares || {}).length > 0;
  $('#share-status').textContent = c.connected ? `@${c.login}` : 'not set up';
  $('#step-connect').classList.toggle('done', Boolean(c.connected));
  $('#step-share').classList.toggle('done', hasShared);
  $('#gh-connect').hidden = Boolean(c.connected);
  $('#gh-logout').hidden = !c.connected;
  $('#repo-name').textContent = c.connected ? `github.com/${c.login}/${c.repo}` : c.repo || 'openvideo-recordings';
  if (document.activeElement !== $('#site-url')) $('#site-url').value = c.siteUrl || '';
  if (document.activeElement !== $('#client-id')) $('#client-id').value = c.githubClientId || '';
  if (!c.githubClientId) $('.advanced').open = true; // the one thing that blocks Connect
}

async function refreshShare() {
  shareCfg = await ov.shareConfig();
  renderShare();
}

async function saveShareSetting(patch) {
  try { shareCfg = await ov.shareSet(patch); } catch (err) { notice(errMsg(err)); }
  renderShare();
}

$('#site-url').addEventListener('change', (e) => saveShareSetting({ siteUrl: e.target.value }));
$('#client-id').addEventListener('change', (e) => saveShareSetting({ githubClientId: e.target.value }));
$('#gh-logout').addEventListener('click', async () => { shareCfg = await ov.shareLogout(); renderShare(); });
$('#gh-connect').addEventListener('click', async () => {
  const b = $('#gh-connect');
  b.disabled = true;
  b.textContent = 'Waiting for GitHub…';
  try {
    shareCfg = await ov.shareLogin();
    notice(`Connected to GitHub as @${shareCfg.login}.`);
    refreshStar();
  } catch (err) {
    notice(`GitHub sign-in failed: ${errMsg(err)}`);
  } finally {
    $('#gh-code').hidden = true;
    b.disabled = false;
    b.textContent = 'Connect GitHub';
    renderShare();
  }
});
ov.onShareCode(({ userCode, url }) => {
  $('#gh-code').hidden = false;
  $('#gh-code').textContent = `Enter ${userCode} at ${url} (opened in your browser)`;
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

// ---------- boot
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('#cam').addEventListener('change', syncCamera);
$('#start').addEventListener('click', start);
$('#refresh').addEventListener('click', () => loadSources(true));
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

setMode(mode);
refreshStar();
Promise.all([loadDevices(), loadSources(true), refreshShare().then(() => { if (!shareCfg.connected) $('#sharing').open = true; return loadLibrary(); })]).catch((err) => notice(errMsg(err)));
