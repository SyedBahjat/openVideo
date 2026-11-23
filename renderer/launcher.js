/* global ov */
// Recording bar. It holds no state of its own: the panel owns source/camera/mic choices and reports them here.
const $ = (id) => document.getElementById(id);
const MOD = ov.platform === 'darwin' ? '⌘⇧L' : 'Ctrl+Shift+L';

function toggle(id, on, title, disabled = false) {
  const b = $(id);
  b.setAttribute('aria-pressed', String(Boolean(on)));
  b.disabled = disabled;
  b.title = title;
}

function render(s) {
  const camOnly = s.mode === 'cam';
  $('source-name').textContent = camOnly ? 'Camera only' : (s.sourceName || 'Choose a screen');
  toggle('camera', s.mode !== 'screen', s.cameraName ? `Camera: ${s.cameraName}` : 'No camera found', !s.hasCamera && s.mode === 'screen');
  toggle('mic', Boolean(s.mic), s.micName ? `Microphone: ${s.micName}` : 'Microphone off', !s.hasMic);
  toggle('sys', s.sys && !camOnly, 'Record the sound your computer plays', camOnly);
  const tpHidden = s.tp && s.tpVisible === false;
  toggle('tp', s.tp && !tpHidden, tpHidden ? 'The teleprompter is hidden. Click to show it again' : s.tp ? 'Close the teleprompter' : 'Show your script (only you can see it)');
  $('record-label').textContent = s.needsPerms ? 'Set up' : 'Record';
  $('record').title = s.needsPerms ? 'openVideo needs your permission first. Opens the setup steps.' : `Start recording (${MOD})`;
}

for (const id of ['camera', 'mic', 'sys', 'record', 'panel', 'hide']) $(id).addEventListener('click', () => ov.bar.act(id));
$('source').addEventListener('click', () => ov.bar.act('source'));
$('tp').addEventListener('click', () => ov.bar.act('teleprompter'));
ov.bar.onState(render);
ov.bar.get().then(render);
