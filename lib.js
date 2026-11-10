const path = require('node:path');

const EXTS = new Set(['.mp4', '.webm']);

// Trust boundary: renderer sends bare file names; never let them escape the recordings dir.
function resolveInside(dir, name) {
  const ok = typeof name === 'string' && name === path.basename(name) && !name.includes('\\')
    && EXTS.has(path.extname(name).toLowerCase());
  if (!ok) throw new Error(`Invalid recording name: ${String(name)}`);
  return path.join(dir, name);
}

function recordingName(date, ext) {
  if (!EXTS.has(ext)) throw new Error(`Unsupported extension: ${ext}`);
  const p = (n) => String(n).padStart(2, '0');
  const d = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  const t = `${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`;
  return `openVideo ${d} at ${t}${ext}`;
}

module.exports = { EXTS, resolveInside, recordingName };
