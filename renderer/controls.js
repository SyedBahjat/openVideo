/* global ov */
const $ = (id) => document.getElementById(id);
let elapsed = 0;          // ms recorded before the current run
let runningSince = Date.now();
let paused = false;

const fmt = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const tick = () => { $('time').value = fmt(elapsed + (paused ? 0 : Date.now() - runningSince)); };

ov.onState((s) => {
  if (s.paused && !paused) elapsed += Date.now() - runningSince;
  if (!s.paused && paused) runningSince = Date.now();
  paused = s.paused;
  $('pause').textContent = paused ? '▶' : '❚❚';
  $('pause').title = paused ? 'Resume' : 'Pause';
  $('pause').setAttribute('aria-label', $('pause').title);
  document.body.classList.toggle('paused', paused);
  tick();
});

ov.onDraw((on) => $('draw').setAttribute('aria-pressed', String(on)));
$('draw').addEventListener('click', () => ov.drawToggle());
$('stop').addEventListener('click', () => ov.control('stop'));
$('pause').addEventListener('click', () => ov.control(paused ? 'resume' : 'pause'));
$('restart').addEventListener('click', () => ov.control('restart'));
$('cancel').addEventListener('click', () => ov.control('cancel'));
setInterval(tick, 250);
