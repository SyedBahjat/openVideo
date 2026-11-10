const { app, BrowserWindow, ipcMain, desktopCapturer, session, screen, globalShortcut, shell,
  systemPreferences, clipboard, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { EXTS, resolveInside, recordingName } = require('./lib');
const sharing = require('./share');

const IS_MAC = process.platform === 'darwin';
const SHORTCUT = 'CommandOrControl+Shift+L';
const DRAW_SHORTCUT = 'CommandOrControl+Shift+D';
const COUNTDOWN_MS = 3000;
const DIR = path.join(app.getPath('videos'), 'openVideo');

// ponytail: Electron documents system-audio loopback as Windows-only; these Chromium flags enable the
// ScreenCaptureKit path on macOS 13+. If a future Electron drops them, mac system audio silently records nothing.
if (IS_MAC) app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');

let panel, camera, controls, drawing;
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
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function createPanel() {
  panel = makeWindow('panel.html', { width: 460, height: 760, minWidth: 400, title: 'openVideo' });
  panel.setContentProtection(true); // keep the setup UI out of recordings
  panel.once('ready-to-show', () => panel.show());
  panel.on('closed', () => app.quit());
}

// --- Camera bubble: a transparent, draggable, always-on-top circle that IS captured in the screen recording.
function showCamera(deviceId) {
  if (camera && !camera.isDestroyed()) camera.destroy();
  camera = null;
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
  hideDrawing();
  hideControls();
  panel.show();
  panel.focus();
}

function closeRecording() {
  const { file, out } = rec;
  rec = null;
  return new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve(file))));
}

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

ipcMain.handle('camera', (_e, deviceId) => showCamera(typeof deviceId === 'string' ? deviceId : null));

ipcMain.handle('permissions', () => (IS_MAC ? { screen: systemPreferences.getMediaAccessStatus('screen') } : { screen: 'granted' }));

ipcMain.handle('open-screen-settings', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'));

ipcMain.handle('countdown', () => new Promise((resolve) => {
  const w = makeWindow('countdown.html', { ...OVERLAY, width: 240, height: 240, focusable: false });
  w.setIgnoreMouseEvents(true);
  w.setContentProtection(true);
  floatAbove(w);
  w.once('ready-to-show', () => w.showInactive());
  panel.hide();
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
  return file;
});

// Chunks land on disk every second, so a crash loses at most ~1s (same idea as Loom's HLS segments).
ipcMain.handle('rec:chunk', (_e, buf) => new Promise((resolve, reject) => {
  if (!rec) return reject(new Error('Not recording'));
  rec.out.write(Buffer.from(buf), (err) => (err ? reject(err) : resolve()));
}));

ipcMain.handle('rec:stop', async () => {
  if (!rec) { backToPanel(); return null; }
  try { return await closeRecording(); } finally { backToPanel(); }
});

ipcMain.handle('rec:discard', async () => {
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
ipcMain.on('state', (_e, s) => controls?.webContents.send('state', s));
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
ipcMain.handle('share:set', (_e, patch) => sharing.updateSettings(patch));
ipcMain.handle('share:login', () => sharing.login((code) => panel?.webContents.send('share-code', code)));
ipcMain.handle('share:logout', () => sharing.logout());
ipcMain.handle('star:status', () => sharing.starStatus());
ipcMain.handle('star:star', () => sharing.star());
ipcMain.handle('star:nudged', () => sharing.markStarNudged());
ipcMain.handle('share:upload', async (_e, name) => {
  const url = await sharing.share(resolveInside(DIR, name), name);
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

  createPanel();
  if (!globalShortcut.register(SHORTCUT, () => panel?.webContents.send('control', 'toggle'))) {
    console.warn(`openVideo: shortcut ${SHORTCUT} is taken by another app`);
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
