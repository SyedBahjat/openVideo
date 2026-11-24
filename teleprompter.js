// Teleprompter: a floating script window only you can see (content-protected, so it stays out of recordings),
// with voice following (native speech helper), auto-scroll or manual scrolling, and an optional click-through mode.
const { app, ipcMain, globalShortcut, dialog, screen, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const core = require('./renderer/prompter-core');

const IS_MAC = process.platform === 'darwin';
const MAX_IMPORT_BYTES = 1_000_000;
const SPEECH_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition';
// Control+Alt (⌃⌥ on macOS): rarely used by other apps, unlike ⌘⌥Space (Finder search) or ⌘⇧arrows (text selection).
const KEYS = {
  'Control+Alt+Space': 'toggle',
  'Control+Alt+Up': 'back',
  'Control+Alt+Down': 'forward',
  'Control+Alt+0': 'restart',
  'Control+Alt+=': 'bigger',
  'Control+Alt+-': 'smaller',
  'Control+Alt+L': 'lock',
  'Control+Alt+T': 'hide',
  'Control+Alt+V': 'capture',
};

module.exports = function setupTeleprompter({ makeWindow, floatAbove, getPanel, onState = () => {}, showInRecording: initialShow = false }) {
  const file = path.join(app.getPath('userData'), 'teleprompter.json');
  let settings = load();
  let win = null;
  let speech = null; // { proc, stopping }
  let saveTimer = null;
  let recState = 'stopped';
  // Hidden from recordings unless the user turned "show in recording" on (remembered by main.js between launches).
  let showInRecording = initialShow;

  function load() {
    try { return core.sanitizeSettings(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return { ...core.DEFAULTS }; }
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.promises.writeFile(file, JSON.stringify(settings, null, 2)).catch((err) => console.warn('teleprompter: save failed', err));
    }, 300);
  }

  const isOpen = () => Boolean(win && !win.isDestroyed());
  const send = (w, ch, v) => { if (w && !w.isDestroyed()) w.webContents.send(ch, v); };
  const state = () => ({ open: isOpen(), visible: isOpen() && win.isVisible(), platform: process.platform, rec: recState, showInRecording });

  function broadcast() {
    send(getPanel(), 'tp:settings', settings);
    send(win, 'tp:settings', settings);
    send(getPanel(), 'tp:state', state());
    send(win, 'tp:state', state());
    onState();
  }

  function update(partial) {
    const prevThrough = settings.clickThrough;
    settings = core.sanitizeSettings({ ...settings, ...partial }, settings);
    if (isOpen() && settings.clickThrough !== prevThrough) applyClickThrough();
    save();
    broadcast();
    return settings;
  }

  function applyClickThrough() {
    win.setIgnoreMouseEvents(settings.clickThrough);
    // Focusable only when it's meant to be clicked, so a click-through prompter never steals keys from your app.
    win.setFocusable(!settings.clickThrough);
  }

  // Saved position, but only if it's still on a connected display.
  function initialBounds() {
    const { workArea } = screen.getPrimaryDisplay();
    const b = settings.bounds;
    if (b && screen.getAllDisplays().some(({ workArea: w }) => b.x >= w.x - 50 && b.y >= w.y - 50
      && b.x + 100 <= w.x + w.width && b.y + 60 <= w.y + w.height)) return b;
    const width = Math.min(920, workArea.width - 80);
    // Top centre, right under the camera, so your eyes stay near the lens.
    return { x: Math.round(workArea.x + (workArea.width - width) / 2), y: workArea.y + 8, width, height: 260 };
  }

  function open() {
    if (isOpen()) { win.showInactive(); broadcast(); return; }
    win = makeWindow('prompter.html', {
      ...initialBounds(), frame: false, transparent: true, hasShadow: false, resizable: true, skipTaskbar: true,
      minimizable: false, maximizable: false, fullscreenable: false, alwaysOnTop: true, minWidth: 360, minHeight: 140,
      title: 'openVideo teleprompter', // "openVideo…" titles are filtered out of the capture source list
    });
    win.setContentProtection(!showInRecording); // visible to you, not to screen recordings or screen sharing
    floatAbove(win, 2); // above the drawing overlay, camera bubble and control pill
    applyClickThrough();
    win.once('ready-to-show', () => { win.showInactive(); broadcast(); });
    const remember = () => { if (isOpen()) update({ bounds: win.getBounds() }); };
    win.on('moved', remember);
    win.on('resized', remember);
    win.on('closed', () => { win = null; stopSpeech(); unregisterKeys(); send(getPanel(), 'tp:state', state()); onState(); });
    registerKeys();
  }

  function close() { if (isOpen()) win.close(); }

  function setVisible(on) {
    if (!isOpen()) { if (on) open(); return; }
    if (on) win.showInactive(); else win.hide();
    broadcast();
  }

  function setShowInRecording(on) {
    showInRecording = Boolean(on);
    if (isOpen()) {
      win.setContentProtection(!showInRecording);
      // A running recording only picks up a window when it appears; re-show so it's captured (see main.js reshow).
      if (showInRecording && win.isVisible()) { win.hide(); win.showInactive(); }
    }
    broadcast();
  }

  function registerKeys() {
    for (const [accel, action] of Object.entries(KEYS)) {
      const handler = () => {
        if (action === 'lock') update({ clickThrough: !settings.clickThrough });
        else if (action === 'hide') setVisible(!win.isVisible());
        else if (action === 'capture') setShowInRecording(!showInRecording);
        else send(win, 'tp:key', action);
      };
      if (!globalShortcut.register(accel, handler)) console.warn(`openVideo: teleprompter shortcut ${accel} is taken`);
    }
  }

  function unregisterKeys() {
    for (const accel of Object.keys(KEYS)) globalShortcut.unregister(accel);
  }

  // --- speech helper (one JSON object per line on stdout)
  function helperCommand() {
    const base = app.isPackaged ? path.join(process.resourcesPath, 'speech') : path.join(__dirname, 'native');
    const locale = app.getLocale() || 'en-US';
    if (IS_MAC) {
      const bin = app.isPackaged ? path.join(base, 'openvideo-speech') : path.join(base, 'bin', 'openvideo-speech');
      return fs.existsSync(bin) ? [bin, [locale, ...core.scriptHints(settings.script)]] : null;
    }
    if (process.platform === 'win32') {
      const ps1 = path.join(base, 'speech-win.ps1');
      return fs.existsSync(ps1)
        ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Locale', locale]]
        : null;
    }
    return null;
  }

  const speechStatus = (s) => send(win, 'tp:speech', { type: 'status', ...s });

  function startSpeech() {
    if (speech) return;
    const cmd = helperCommand();
    if (!cmd) {
      speechStatus({ state: 'unavailable', message: 'Voice following isn\'t available in this build. Use Auto-scroll instead.' });
      return;
    }
    const proc = spawn(cmd[0], cmd[1], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const s = { proc, stopping: false, reported: false };
    speech = s;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg?.type === 'heard') {
        const words = (Array.isArray(msg.words) ? msg.words : [msg.words]).filter((w) => typeof w === 'string').slice(-8);
        send(win, 'tp:speech', { type: 'heard', words });
      } else if (msg?.type === 'status' && typeof msg.state === 'string') {
        if (msg.state !== 'listening') s.reported = true;
        speechStatus({ state: msg.state, message: typeof msg.message === 'string' ? msg.message.slice(0, 300) : '' });
      }
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-500); });
    proc.on('error', (err) => { s.reported = true; speechStatus({ state: 'error', message: `Couldn't start voice following: ${err.message}` }); });
    proc.on('exit', (code, signal) => {
      if (speech === s) speech = null;
      if (s.stopping) return;
      if (!s.reported) {
        // macOS kills a process that asks for a permission its app doesn't declare (e.g. running from source).
        const msg = signal ? 'Voice following stopped unexpectedly. Run the installed app, or use Auto-scroll.'
          : `Voice following stopped (${(stderr.trim().split('\n').pop() || `exit ${code}`).slice(0, 200)}).`;
        speechStatus({ state: 'error', message: msg });
      }
      speechStatus({ state: 'stopped' });
    });
  }

  function stopSpeech() {
    if (!speech) return;
    speech.stopping = true;
    speech.proc.stdin.end(); // the helper exits when stdin closes
    const { proc } = speech;
    setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill(); }, 1000);
    speech = null;
  }

  // --- IPC
  ipcMain.handle('tp:get', () => ({ settings, state: state() }));
  ipcMain.handle('tp:set', (_e, partial) => update(partial && typeof partial === 'object' ? partial : {}));
  ipcMain.handle('tp:open', () => { open(); return state(); });
  ipcMain.handle('tp:close', () => { close(); return state(); });
  ipcMain.handle('tp:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getPanel(), {
      title: 'Import a script', properties: ['openFile'],
      filters: [{ name: 'Text or Markdown', extensions: ['txt', 'md', 'markdown', 'text'] }],
    });
    if (canceled || !filePaths[0]) return null;
    const { size } = await fs.promises.stat(filePaths[0]);
    if (size > MAX_IMPORT_BYTES) throw new Error('That file is too big for a script (1 MB max).');
    return update({ script: await fs.promises.readFile(filePaths[0], 'utf8') });
  });
  ipcMain.handle('tp:show', (_e, on) => { setVisible(on !== false); return state(); });
  ipcMain.handle('tp:capture', (_e, on) => { setShowInRecording(on); return state(); });
  ipcMain.handle('tp:speech-settings', () => (IS_MAC ? shell.openExternal(SPEECH_SETTINGS_URL) : shell.openExternal('ms-settings:speech')));
  ipcMain.on('tp:listen', (_e, on) => (on ? startSpeech() : stopSpeech()));

  app.on('will-quit', stopSpeech);

  return {
    // Called by main.js as a recording starts, pauses, resumes and ends.
    recording(next) {
      recState = next;
      if (next === 'recording' && !isOpen() && settings.autoOpen && settings.script.trim()) open();
      send(win, 'tp:rec', next);
    },
    isOpen,
    showsInRecording: () => showInRecording,
    setShowInRecording,
    // Re-assert the window's capture setting (see main.js: something can flip it back during a recording).
    reapply() { if (isOpen()) win.setContentProtection(!showInRecording); },
    reshow() { if (isOpen() && win.isVisible()) { win.hide(); win.showInactive(); } },
    // Bar button: open → close, but a hidden teleprompter is brought back instead of closed.
    toggle() { if (!isOpen()) open(); else if (!win.isVisible()) setVisible(true); else close(); },
    isVisible: () => isOpen() && win.isVisible(),
  };
};
