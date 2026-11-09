// Main closes this window after 3s; this only animates the digits.
let n = 3;
const el = document.getElementById('n');
const id = setInterval(() => {
  n -= 1;
  if (n < 1) return clearInterval(id);
  el.textContent = String(n);
  el.style.animation = 'none';
  void el.offsetWidth; // restart the pop animation
  el.style.animation = '';
}, 1000);
