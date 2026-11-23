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

// GitHub repo names: letters, digits, - _ . (no "." or ".." on their own), max 100 chars.
const repoNameOk = (n) => typeof n === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(n) && n !== '.' && n !== '..';

// Default name for "a new repo just for this video": openvideo-2026-11-24-0258 (from the recording's date).
function newRepoName(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `openvideo-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

module.exports = { EXTS, resolveInside, recordingName, repoNameOk, newRepoName };
