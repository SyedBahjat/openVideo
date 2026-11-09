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

// Trust boundary: share settings come from the renderer. Unknown keys are dropped.
function normalizeShareSettings(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if ('siteUrl' in patch) {
    let u;
    try { u = new URL(String(patch.siteUrl)); } catch { throw new Error('Site URL must be a full URL like https://openvideo.example'); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) {
      throw new Error('Site URL must use https (http is allowed only for localhost)');
    }
    out.siteUrl = u.origin;
  }
  if ('githubClientId' in patch) {
    const id = String(patch.githubClientId).trim();
    if (!/^[A-Za-z0-9._-]{0,64}$/.test(id)) throw new Error('That does not look like a GitHub OAuth client ID');
    out.githubClientId = id;
  }
  return out;
}

module.exports = { EXTS, resolveInside, recordingName, normalizeShareSettings };
