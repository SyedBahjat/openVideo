const { app, BrowserWindow, ipcMain, desktopCapturer, session, screen, globalShortcut, shell,
  systemPreferences, clipboard, dialog, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { EXTS, resolveInside, recordingName } = require('./lib');
const sharing = require('./share');
const setupTeleprompter = require('./teleprompter');

const IS_MAC = process.platform === 'darwin';
const SHORTCUT = 'CommandOrControl+Shift+L';
const DRAW_SHORTCUT = 'CommandOrControl+Shift+D';
const COUNTDOWN_MS = 3000;
const DIR = path.join(app.getPath('videos'), 'openVideo');

// ponytail: Electron documents system-audio loopback as Windows-only; these Chromium flags enable the
// ScreenCaptureKit path on macOS 13+. If a future Electron drops them, mac system audio silently records nothing.
if (IS_MAC) app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');

let panel, camera, controls, drawing, prompter, launcher;
let barState = {}; // what the panel last reported for the recording bar (source, camera, mic, ...)
let drawOn = false;
let selected = null; // { id, audio, displayId } chosen in the panel before getDisplayMedia()
const displayBySource = new Map(); // desktopCapturer source id -> display id ('' for windows)
let rec = null;      // { file, out }

const OVERLAY = { frame: false, transparent: true, resizable: false, skipTaskbar: true, hasShadow: false,
  minimizable: false, maximizable: false, fullscreenable: false, alwaysOnTop: true };

function makeWindow(file, opts = {}, query) {
  const w = new BrowserWindow({ show: false, ...opts,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false } });
  w.loadFile(path.join(__dirname, 'renderer', file), query ? { query } : undefined);
  return w;
}

// relativeLevel keeps the camera + controls stacked above the drawing overlay (level 0).
function floatAbove(w, relativeLevel = 1) {
  w.setAlwaysOnTop(true, 'screen-saver', relativeLevel);
  // skipTransformProcessType: without it, macOS turns the whole app into a background (UIElement) app
  // and the Dock icon disappears.
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
}

function createPanel() {
  panel = makeWindow('panel.html', { width: 1080, height: 780, minWidth: 880, minHeight: 620, title: 'openVideo' });
  panel.setContentProtection(true); // keep the setup UI out of recordings (switchable for tutorials, see below)
  panel.once('ready-to-show', () => {
    panel.show();
    if (IS_MAC) app.focus({ steal: true }); // first launch from Finder/installer: put the panel in front
  });
  panel.on('closed', () => app.quit());
  for (const ev of ['show', 'hide', 'minimize', 'restore']) panel.on(ev, () => setImmediate(updateCamera));
}

// --- Camera bubble: a transparent, draggable, always-on-top circle that IS captured in the screen recording.
// It only exists while it's useful: the panel is open on Record (preview), or a recording is starting or running.
let camDevice = null;  // camera picked in the panel (null = no bubble wanted)
let camShown = null;   // device the current bubble window is showing
let camHold = false;   // countdown + recording: keep the bubble even though the panel is hidden

function updateCamera() {
  const panelOpen = panel && !panel.isDestroyed() && panel.isVisible() && !panel.isMinimized();
  const want = camDevice && (camHold || panelOpen) ? camDevice : null;
  if (want === camShown && (!want || (camera && !camera.isDestroyed()))) return;
  showCamera(want);
}

function showCamera(deviceId) {
  if (camera && !camera.isDestroyed()) camera.destroy();
  camera = null;
  camShown = deviceId;
  if (!deviceId) return;
  const { workArea } = screen.getPrimaryDisplay();
  const size = 220;
  camera = makeWindow('camera.html', { ...OVERLAY, width: size, height: size,
    x: workArea.x + 32, y: workArea.y + workArea.height - size - 32 }, { device: deviceId });
  floatAbove(camera);
  camera.once('ready-to-show', () => camera.showInactive());
}

// --- Floating control pill: excluded from capture via content protection.
function showControls() {
  if (controls && !controls.isDestroyed()) return controls.showInactive();
  const { workArea } = screen.getPrimaryDisplay();
  const [width, height] = [340, 56];
  controls = makeWindow('controls.html', { ...OVERLAY, width, height,
    x: Math.round(workArea.x + (workArea.width - width) / 2), y: workArea.y + workArea.height - height - 24 });
  controls.setContentProtection(true);
  floatAbove(controls);
  controls.once('ready-to-show', () => controls.showInactive());
}

function hideControls() {
  if (controls && !controls.isDestroyed()) controls.destroy();
  controls = null;
}

// --- Drawing overlay: covers the recorded display, IS captured, click-through until the pen is on.
function showDrawing() {
  const displays = screen.getAllDisplays();
  const display = displays.find((d) => String(d.id) === selected?.displayId) || screen.getPrimaryDisplay();
  drawing = makeWindow('drawing.html', { ...OVERLAY, ...display.bounds, focusable: true, enableLargerThanScreen: true });
  drawing.setIgnoreMouseEvents(true);
  floatAbove(drawing, 0);
  drawing.once('ready-to-show', () => drawing.showInactive());
  globalShortcut.register(DRAW_SHORTCUT, toggleDraw);
}

function setDraw(on) {
  if (!drawing || drawing.isDestroyed()) return;
  drawOn = on;
  drawing.setIgnoreMouseEvents(!on);
  if (on) drawing.focus(); // so the overlay gets keys (1-4 colours, C clear, Esc exit)
  drawing.webContents.send('draw', on);
  controls?.webContents.send('draw', on);
}
const toggleDraw = () => setDraw(!drawOn);

function hideDrawing() {
  globalShortcut.unregister(DRAW_SHORTCUT);
  if (drawing && !drawing.isDestroyed()) drawing.destroy();
  drawing = null;
  drawOn = false;
}

function backToPanel() {
  camHold = false;
  hideDrawing();
  hideControls();
  showLauncher();
  panel.show();
  panel.focus();
}

function closeRecording() {
  const { file, out } = rec;
  rec = null;
  return new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve(file))));
}

// --- Recording bar: a floating pill (like Loom/Recordly) to pick a source, toggle camera/mic/system audio/
// teleprompter and hit Record without opening the main window. Hidden from the recording; the panel owns the state.
const BAR = { width: 640, height: 64 };

// Bring the main window to the front, even when another app is active (macOS won't by default).
function focusPanel() {
  panel.show();
  if (IS_MAC) app.focus({ steal: true });
  panel.focus();
}

function showLauncher() {
  if (launcher && !launcher.isDestroyed()) { launcher.showInactive(); return; }
  const { workArea } = screen.getPrimaryDisplay();
  launcher = makeWindow('launcher.html', { ...OVERLAY, ...BAR, focusable: true,
    x: Math.round(workArea.x + (workArea.width - BAR.width) / 2), y: workArea.y + workArea.height - BAR.height - 20 });
  launcher.setContentProtection(true);
  floatAbove(launcher);
  launcher.once('ready-to-show', () => { launcher.showInactive(); sendBar(); });
  launcher.on('closed', () => { launcher = null; });
}

function hideLauncher() {
  if (launcher && !launcher.isDestroyed()) launcher.hide();
}

const barSnapshot = () => ({ ...barState, tp: prompter.isOpen(), tpVisible: prompter.isVisible(), platform: process.platform });

function sendBar() {
  launcher?.webContents.send('bar:state', barSnapshot());
}

async function sourceMenu() {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 64, height: 40 } });
  const item = (s) => ({
    label: s.name.length > 48 ? `${s.name.slice(0, 47)}…` : s.name,
    type: 'radio', checked: barState.mode !== 'cam' && barState.sourceId === s.id,
    icon: s.thumbnail.isEmpty() ? undefined : s.thumbnail,
    click: () => panel.webContents.send('bar', { action: 'source', id: s.id }),
  });
  const visible = sources.filter((s) => !s.name.startsWith('openVideo'));
  Menu.buildFromTemplate([
    { label: 'Screens', enabled: false }, ...visible.filter((s) => s.id.startsWith('screen:')).map(item),
    { type: 'separator' },
    { label: 'Windows', enabled: false }, ...visible.filter((s) => !s.id.startsWith('screen:')).map(item),
    { type: 'separator' },
    { label: 'Camera only', type: 'radio', checked: barState.mode === 'cam', click: () => panel.webContents.send('bar', { action: 'cam-only' }) },
  ]).popup({ window: launcher });
}

ipcMain.on('bar:state', (_e, s) => { barState = s && typeof s === 'object' ? s : {}; sendBar(); });
ipcMain.handle('bar:get', barSnapshot);
ipcMain.on('bar:do', (_e, action) => {
  if (action === 'source') sourceMenu().catch((err) => console.warn('openVideo: source menu', err));
  else if (action === 'panel') focusPanel();
  else if (action === 'hide') hideLauncher();
  else if (action === 'show') showLauncher();
  else if (action === 'teleprompter') prompter.toggle();
  else if (['camera', 'mic', 'sys', 'record'].includes(action)) {
    if (action === 'record' && barState.needsPerms) focusPanel();
    panel.webContents.send('bar', { action });
  }
});

// --- IPC
ipcMain.handle('sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 } });
  sources.forEach((s) => displayBySource.set(s.id, s.display_id));
  return sources
    .filter((s) => !s.name.startsWith('openVideo'))
    .map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL(), screen: s.id.startsWith('screen:') }));
});

ipcMain.handle('select-source', (_e, id, audio) => {
  selected = { id: String(id), audio: Boolean(audio), displayId: displayBySource.get(String(id)) || '' };
});

ipcMain.handle('camera', (_e, deviceId) => {
  if (rec || camHold) return; // the panel can't swap the camera mid-recording
  camDevice = typeof deviceId === 'string' ? deviceId : null;
  updateCamera();
});

// --- Permissions. macOS: screen / camera / microphone via TCC. Windows: camera / microphone privacy switches.
const PERM_KINDS = ['screen', 'camera', 'microphone'];
const SETTINGS_URL = IS_MAC ? {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
} : { camera: 'ms-settings:privacy-webcam', microphone: 'ms-settings:privacy-microphone' };

function permissionStatus() {
  const status = (kind) => {
    if (kind === 'screen' && !IS_MAC) return 'granted'; // Windows has no screen-capture permission
    try { return systemPreferences.getMediaAccessStatus(kind); } catch { return 'granted'; }
  };
  return Object.fromEntries(PERM_KINDS.map((k) => [k, status(k)]));
}

ipcMain.handle('permissions', () => ({ ...permissionStatus(), platform: process.platform }));

// "Allow" button: show the OS prompt when macOS still can, otherwise open the exact Settings page.
ipcMain.handle('permissions:request', async (_e, kind) => {
  if (!PERM_KINDS.includes(kind)) throw new Error(`Unknown permission ${kind}`);
  const current = permissionStatus()[kind];
  if (IS_MAC && kind !== 'screen' && current === 'not-determined') {
    await systemPreferences.askForMediaAccess(kind);
    return permissionStatus();
  }
  if (IS_MAC && kind === 'screen') {
    // Attempting a capture is what makes macOS list openVideo under Screen & System Audio Recording.
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
  }
  if (SETTINGS_URL[kind]) await shell.openExternal(SETTINGS_URL[kind]);
  return permissionStatus();
});

// "Show openVideo in the recording": for tutorials about openVideo itself. Works mid-recording.
ipcMain.handle('app:show-in-recording', (_e, on) => {
  panel.setContentProtection(!on);
  return Boolean(on);
});

// macOS only applies a new Screen Recording permission after the app restarts.
ipcMain.handle('app:relaunch', () => { app.relaunch(); app.exit(0); });

// Re-check permissions whenever the user comes back to the app (e.g. from System Settings).
app.on('browser-window-focus', () => panel?.webContents.send('permissions-changed', permissionStatus()));


ipcMain.handle('countdown', () => new Promise((resolve) => {
  const w = makeWindow('countdown.html', { ...OVERLAY, width: 240, height: 240, focusable: false });
  w.setIgnoreMouseEvents(true);
  w.setContentProtection(true);
  floatAbove(w);
  w.once('ready-to-show', () => w.showInactive());
  camHold = true; // keep the bubble through the countdown and the recording
  updateCamera();
  panel.hide();
  hideLauncher();
  setTimeout(() => { if (!w.isDestroyed()) w.destroy(); resolve(); }, COUNTDOWN_MS);
}));

ipcMain.handle('rec:start', async (_e, ext, withDrawing) => {
  if (rec) throw new Error('Already recording');
  if (!EXTS.has(ext)) throw new Error(`Unsupported format ${ext}`);
  await fs.promises.mkdir(DIR, { recursive: true });
  const file = recordingName(new Date(), ext);
  rec = { file, out: fs.createWriteStream(resolveInside(DIR, file), { flags: 'wx' }) };
  rec.out.on('error', (err) => panel.webContents.send('rec-error', err.message));
  showControls();
  if (withDrawing) showDrawing();
  prompter.recording('recording');
  return file;
});

// Chunks land on disk every second, so a crash loses at most ~1s (same idea as Loom's HLS segments).
ipcMain.handle('rec:chunk', (_e, buf) => new Promise((resolve, reject) => {
  if (!rec) return reject(new Error('Not recording'));
  rec.out.write(Buffer.from(buf), (err) => (err ? reject(err) : resolve()));
}));

ipcMain.handle('rec:stop', async () => {
  prompter.recording('stopped');
  if (!rec) { backToPanel(); return null; }
  try { return await closeRecording(); } finally { backToPanel(); }
});

ipcMain.handle('rec:discard', async () => {
  prompter.recording('stopped');
  if (!rec) { backToPanel(); return null; }
  const file = rec.file;
  try {
    await closeRecording().catch(() => {});
    await fs.promises.rm(resolveInside(DIR, file), { force: true });
  } finally { backToPanel(); }
  return null;
});

// Controls pill -> panel (which owns the MediaRecorder), and panel state -> pill.
ipcMain.on('control', (_e, action) => panel?.webContents.send('control', String(action)));
ipcMain.on('state', (_e, s) => {
  controls?.webContents.send('state', s);
  if (rec) prompter.recording(s?.paused ? 'paused' : 'recording');
});
ipcMain.on('draw:toggle', toggleDraw);
ipcMain.on('draw:off', () => setDraw(false));

ipcMain.handle('lib:list', async () => {
  await fs.promises.mkdir(DIR, { recursive: true });
  const names = (await fs.promises.readdir(DIR)).filter((n) => EXTS.has(path.extname(n).toLowerCase()));
  const items = await Promise.all(names.map(async (name) => {
    const full = resolveInside(DIR, name);
    const st = await fs.promises.stat(full);
    return { name, size: st.size, mtime: st.mtimeMs, url: pathToFileURL(full).href };
  }));
  return items.sort((a, b) => b.mtime - a.mtime);
});
ipcMain.handle('lib:reveal', (_e, name) => shell.showItemInFolder(resolveInside(DIR, name)));
ipcMain.handle('lib:copy', (_e, name) => clipboard.writeText(resolveInside(DIR, name)));
ipcMain.handle('lib:trash', (_e, name) => shell.trashItem(resolveInside(DIR, name)));
ipcMain.handle('share:config', () => sharing.publicConfig());
ipcMain.handle('share:login', (_e, opts) => sharing.login((code) => {
  clipboard.writeText(code.userCode); // so the user can paste it straight into GitHub
  panel?.webContents.send('share-code', code);
}, { wantPrivate: Boolean(opts?.wantPrivate) }));
ipcMain.handle('share:repos', () => sharing.listRepos());
ipcMain.handle('share:new-name', async (_e, name) => {
  const st = await fs.promises.stat(resolveInside(DIR, name)).catch(() => null); // file may have been moved meanwhile
  return sharing.newRepoName(st ? new Date(st.mtimeMs) : new Date());
});
ipcMain.handle('share:cancel-login', () => sharing.cancelLogin());
ipcMain.handle('share:logout', () => sharing.logout());
ipcMain.handle('star:status', () => sharing.starStatus());
ipcMain.handle('star:star', () => sharing.star());
ipcMain.handle('star:nudged', () => sharing.markStarNudged());
ipcMain.handle('share:upload', async (_e, name, dest) => {
  const url = await sharing.share(resolveInside(DIR, name), name, dest);
  clipboard.writeText(url);
  return url;
});
ipcMain.handle('share:open', (_e, url) => {
  const u = new URL(String(url));
  if (u.protocol === 'https:' || u.protocol === 'http:') return shell.openExternal(u.href); // never file:/custom schemes
  return null;
});
// Bring in a video recorded elsewhere (e.g. downloaded from the website) so it can be shared.
ipcMain.handle('lib:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(panel, {
    title: 'Add a video to openVideo', properties: ['openFile'], filters: [{ name: 'Videos', extensions: ['mp4', 'webm'] }],
  });
  if (canceled || !filePaths[0]) return null;
  const src = filePaths[0];
  const ext = path.extname(src).toLowerCase();
  if (!EXTS.has(ext)) throw new Error('Only .mp4 and .webm videos can be added.');
  await fs.promises.mkdir(DIR, { recursive: true });
  const name = recordingName(new Date((await fs.promises.stat(src)).mtimeMs), ext);
  await fs.promises.copyFile(src, resolveInside(DIR, name), fs.constants.COPYFILE_EXCL);
  return name;
});
ipcMain.handle('lib:open-dir', async () => { await fs.promises.mkdir(DIR, { recursive: true }); return shell.openPath(DIR); });

app.whenReady().then(() => {
  // getDisplayMedia() in the renderer is answered with whatever source the user picked in our own UI.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const video = sources.find((s) => s.id === selected?.id);
      if (!video) return callback(null);
      callback(selected.audio ? { video, audio: 'loopback' } : { video });
    } catch {
      callback(null);
    }
  });

  prompter = setupTeleprompter({ makeWindow, floatAbove, getPanel: () => panel, onState: sendBar });
  createPanel();
  showLauncher();
  // Everything that can be hidden can be brought back from here (or by clicking the Dock icon).
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Show openVideo window', accelerator: 'CommandOrControl+1', click: focusPanel },
      { label: 'Show recording bar', accelerator: 'CommandOrControl+Shift+B', click: showLauncher },
      { label: 'Show / hide teleprompter', accelerator: 'Control+Alt+T', registerAccelerator: false, click: () => prompter.toggle() },
    ] },
    { role: 'windowMenu' },
  ]));
  if (!globalShortcut.register(SHORTCUT, () => panel?.webContents.send('control', 'toggle'))) {
    console.warn(`openVideo: shortcut ${SHORTCUT} is taken by another app`);
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('activate', () => { panel?.show(); showLauncher(); }); // Dock icon click
