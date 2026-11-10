// Share links for the desktop app. Each user's videos go to THEIR OWN public repo <login>/openvideo-recordings
// as release assets (free, up to 2 GB per file). The link points at the website's /v/gh watch page.
// Sign-in is GitHub's device flow, so the app never needs a client secret.
const { app, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeShareSettings } = require('./lib');

const GH_REPO = 'openvideo-recordings';
const PROJECT_REPO = 'SyedBahjat/openVideo'; // this app's own repo, for the Star button
const API = 'https://api.github.com';
const GH_MAX_BYTES = 2e9; // release asset limit
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfgPath = () => path.join(app.getPath('userData'), 'share-config.json');
const tokenPath = () => path.join(app.getPath('userData'), 'github-token.bin');
const DEFAULTS = {
  siteUrl: process.env.OPENVIDEO_SITE_URL || 'http://localhost:3000',
  githubClientId: process.env.OPENVIDEO_GITHUB_CLIENT_ID || '',
  login: '',
  shares: {}, // recording file name -> share URL
};

function readConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) }; } catch { return { ...DEFAULTS }; }
}
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.writeFileSync(cfgPath(), JSON.stringify(next, null, 2));
  return next;
}

// The token is encrypted with the OS keychain (Keychain on macOS, DPAPI on Windows); never stored in plain text.
function saveToken(token) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('The OS keychain is unavailable, so the GitHub token cannot be stored safely.');
  fs.writeFileSync(tokenPath(), safeStorage.encryptString(token), { mode: 0o600 });
}
function loadToken() {
  try { return safeStorage.decryptString(fs.readFileSync(tokenPath())); } catch { return null; }
}

function publicConfig() {
  const { siteUrl, githubClientId, login, shares } = readConfig();
  return { siteUrl, githubClientId, login, shares, connected: Boolean(loadToken()), repo: GH_REPO };
}

function updateSettings(patch) {
  writeConfig(normalizeShareSettings(patch));
  return publicConfig();
}

function logout() {
  fs.rmSync(tokenPath(), { force: true });
  writeConfig({ login: '' });
  return publicConfig();
}

const ghFetch = (url, token, init = {}) => fetch(url.startsWith('https://') ? url : API + url, {
  ...init,
  headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'openVideo',
    Authorization: `Bearer ${token}`, ...init.headers },
});

async function ghJson(url, token, init) {
  const res = await ghFetch(url, token, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || `GitHub API ${res.status}`), { status: res.status });
  return body;
}

const postForm = (url, body) => fetch(url, {
  method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

/** GitHub device flow: show a code, user approves on github.com, we poll for the token. */
async function login(onCode) {
  const { githubClientId: clientId } = readConfig();
  if (!clientId) throw new Error('Enter the GitHub OAuth client ID (from the website\'s OAuth App) first.');
  const code = await postForm('https://github.com/login/device/code', { client_id: clientId, scope: 'public_repo' });
  if (code.error === 'device_flow_disabled') throw new Error('Device Flow is off for this OAuth App. Ask the site owner to tick "Enable Device Flow" in the GitHub OAuth App settings.');
  if (code.error) throw new Error(code.error_description || code.error);
  onCode({ userCode: code.user_code, url: code.verification_uri });
  shell.openExternal(code.verification_uri);

  let interval = (code.interval || 5) * 1000;
  const deadline = Date.now() + code.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const r = await postForm('https://github.com/login/oauth/access_token', {
      client_id: clientId, device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (r.access_token) {
      const user = await ghJson('/user', r.access_token);
      saveToken(r.access_token);
      writeConfig({ login: user.login });
      return publicConfig();
    }
    if (r.error === 'slow_down') interval += 5000;
    else if (r.error === 'access_denied') throw new Error('You clicked Cancel on GitHub. openVideo needs this permission to create your public openvideo-recordings repo. Click Connect GitHub to try again.');
    else if (r.error === 'expired_token') throw new Error('The code expired before it was approved. Click Connect GitHub to get a new one.');
    else if (r.error !== 'authorization_pending') throw new Error(r.error_description || r.error);
  }
  throw new Error('GitHub sign-in timed out. Try again.');
}

async function ensureRepo(token, owner) {
  const res = await ghFetch(`/repos/${owner}/${GH_REPO}`, token);
  if (res.ok) return;
  if (res.status !== 404) throw new Error(`GitHub API ${res.status} while checking ${owner}/${GH_REPO}`);
  // auto_init: releases need at least one commit to tag.
  await ghJson('/user/repos', token, { method: 'POST', body: JSON.stringify({
    name: GH_REPO, description: 'Videos recorded with openVideo. Public: anyone can watch them.',
    private: false, auto_init: true, has_issues: false, has_wiki: false, has_projects: false,
  }) });
}

async function toGithub(cfg, token, blob, type, title) {
  if (blob.size > GH_MAX_BYTES) throw new Error('GitHub only accepts files under 2 GB. Trim or split this recording first.');
  const owner = cfg.login;
  await ensureRepo(token, owner);
  const tag = crypto.randomBytes(12).toString('base64url'); // same 16-char id format the website validates
  const createRelease = () => ghJson(`/repos/${owner}/${GH_REPO}/releases`, token, {
    method: 'POST', body: JSON.stringify({ tag_name: tag, name: title, body: 'Recorded with openVideo.' }),
  });
  // A repo created a moment ago can briefly reject releases; retry a few times.
  let release;
  for (let attempt = 1; !release; attempt++) {
    try { release = await createRelease(); } catch (err) {
      if (attempt >= 4 || ![404, 409, 422].includes(err.status)) throw err;
      await sleep(1500 * attempt);
    }
  }
  const ext = type === 'video/webm' ? 'webm' : 'mp4';
  const up = await ghFetch(`https://uploads.github.com/repos/${owner}/${GH_REPO}/releases/${release.id}/assets?name=video.${ext}`, token, {
    method: 'POST', headers: { 'Content-Type': type }, body: blob,
  });
  if (!up.ok) {
    // Don't leave an empty release + tag behind.
    await ghFetch(`/repos/${owner}/${GH_REPO}/releases/${release.id}`, token, { method: 'DELETE' }).catch(() => {});
    await ghFetch(`/repos/${owner}/${GH_REPO}/git/refs/tags/${tag}`, token, { method: 'DELETE' }).catch(() => {});
    throw new Error(`GitHub upload failed (HTTP ${up.status})`);
  }
  return new URL(`/v/gh/${owner}/${tag}`, cfg.siteUrl).href;
}

// Turn GitHub API failures into something a non-developer can act on.
function explain(err) {
  if (err.status === 401) return new Error('Your GitHub connection expired or was revoked. Disconnect, then Connect GitHub again.');
  if (err.status === 403 || err.status === 404) {
    return new Error('GitHub refused: openVideo is missing permission to create your repo or upload to it. Disconnect, then Connect GitHub again and click Authorize.');
  }
  if (err.status === 422 && /name already exists/i.test(err.message)) {
    return new Error(`You already have a repo named ${GH_REPO} that openVideo can't use. Rename it on GitHub, then try again.`);
  }
  return err;
}

async function share(file, name) {
  const cfg = readConfig();
  const token = loadToken();
  if (!token) throw Object.assign(new Error('Connect GitHub first: open Sharing and click Connect GitHub.'), { needsSetup: true });
  const type = name.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4';
  const blob = await fs.openAsBlob(file, { type }); // streamed from disk, not loaded into memory
  const title = `Recording ${name.replace(/^openVideo /, '').replace(/\.\w+$/, '')}`;
  const url = await toGithub(cfg, token, blob, type, title).catch((err) => { throw explain(err); });
  writeConfig({ shares: { ...readConfig().shares, [name]: url } });
  return url;
}

// Star the openVideo repo. Only ever called from an explicit click on "Star".
async function starStatus() {
  const token = loadToken();
  if (!token) return { connected: false, starred: false, nudged: Boolean(readConfig().starNudged) };
  const res = await ghFetch(`/user/starred/${PROJECT_REPO}`, token).catch(() => null);
  return { connected: true, starred: res?.status === 204, nudged: Boolean(readConfig().starNudged) };
}

async function star() {
  const token = loadToken();
  if (!token) {
    await shell.openExternal(`https://github.com/${PROJECT_REPO}`);
    return { starred: false, opened: true };
  }
  const res = await ghFetch(`/user/starred/${PROJECT_REPO}`, token, { method: 'PUT', headers: { 'Content-Length': '0' } });
  if (res.status !== 204) throw new Error(`GitHub didn't accept the star (HTTP ${res.status})`);
  return { starred: true, opened: false };
}

const markStarNudged = () => { writeConfig({ starNudged: true }); };

module.exports = { publicConfig, updateSettings, login, logout, share, starStatus, star, markStarNudged };
