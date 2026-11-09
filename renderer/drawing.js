/* global ov */
// Keys while the pen is on: 1-4 colour, C clear, Esc put the pen down. Putting the pen down clears the screen.
const COLORS = { 1: '#e5432d', 2: '#f7c948', 3: '#2f80ff', 4: '#ffffff' };
const WIDTH = 5;
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let color = COLORS[1];
let last = null; // previous point of the active stroke; null when the pen is up

function fit() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = WIDTH;
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 3;
}
const clear = () => ctx.clearRect(0, 0, canvas.width, canvas.height);

// Stroke only the newest segment; re-stroking the whole path would darken it as the shadow stacks up.
function segment(to) {
  ctx.beginPath();
  ctx.moveTo(last.x, last.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  last = to;
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  ctx.strokeStyle = color;
  last = { x: e.clientX, y: e.clientY };
  segment({ x: e.clientX + 0.1, y: e.clientY }); // a click leaves a dot
});
canvas.addEventListener('pointermove', (e) => { if (last) segment({ x: e.clientX, y: e.clientY }); });
canvas.addEventListener('pointerup', () => { last = null; });

addEventListener('keydown', (e) => {
  if (COLORS[e.key]) color = COLORS[e.key];
  else if (e.key === 'c' || e.key === 'C') clear();
  else if (e.key === 'Escape') ov.drawOff();
});

ov.onDraw((on) => {
  document.body.classList.toggle('pen', on);
  if (!on) clear();
});
addEventListener('resize', fit);
fit();
