// Share links for the desktop app. Videos go to the user's OWN GitHub repos as release assets (free, up to 2 GB per
// file): the main <login>/openvideo-recordings repo, or any repo openVideo created (tagged with the "openvideo" topic),
// public or private. The link points at the website's /v/gh watch page; private videos ask viewers to sign in.
// Sign-in is GitHub's device flow, so the app never needs a client secret.
const { app, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SITE_URL, GITHUB_CLIENT_ID } = require('./config');

const GH_REPO = 'openvideo-recordings';
const PROJECT_REPO = 'SyedBahjat/openVideo'; // this app's own repo, for the Star button
const API = 'https://api.github.com';
const GH_MAX_BYTES = 2e9; // release asset limit
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfgPath = () => path.join(app.getPath('userData'), 'share-config.json');
const tokenPath = () => path.join(app.getPath('userData'), 'github-token.bin');
const TOPIC = 'openvideo'; // marks repos openVideo created, so the app can offer them again
const DEFAULTS = {
  login: '',
  scopes: '', // OAuth scopes granted ("public_repo" or "repo")
  dest: { kind: 'main', repo: GH_REPO, private: false }, // last destination picked in the share sheet
  shares: {}, // recording file name -> share URL
  privateShares: {}, // recording file name -> true when it went to a private repo
};
const { repoNameOk, newRepoName } = require('./lib');

function readConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) }; } catch { return { ...DEFAULTS }; }
}
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.writeFileSync(cfgPath(), JSON.stringify(next, null, 2));
  return next;
}

// The token is encrypted with the OS keychain (Keychain on macOS, DPAPI on Windows); never stored in plain text.
// On macOS every decrypt may show a keychain prompt ("openVideo Safe Storage"), so only decrypt when a GitHub call
// actually needs the token, and keep it in memory for the rest of the session.
let cachedToken = null;

function saveToken(token) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('The OS keychain is unavailable, so the GitHub token cannot be stored safely.');
  fs.writeFileSync(tokenPath(), safeStorage.encryptString(token), { mode: 0o600 });
  cachedToken = token;
}
function loadToken() {
  if (cachedToken) return cachedToken;
  try { cachedToken = safeStorage.decryptString(fs.readFileSync(tokenPath())); } catch { cachedToken = null; }
  return cachedToken;
}
const hasToken = () => fs.existsSync(tokenPath()); // no decrypt, so no keychain prompt

function publicConfig() {
  const { login, shares, privateShares, dest, scopes } = readConfig();
  return { configured: Boolean(SITE_URL && GITHUB_CLIENT_ID), login, shares, privateShares, dest, connected: hasToken(), repo: GH_REPO,
    canPrivate: /(^|[\s,])repo($|[\s,])/.test(scopes) };
}

function logout() {
  cachedToken = null;
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
let activeLogin = null; // { cancelled } for the sign-in in progress

function cancelLogin() {
  if (activeLogin) activeLogin.cancelled = true;
}

async function login(onCode, { wantPrivate = false } = {}) {
  const clientId = GITHUB_CLIENT_ID;
  if (!clientId) throw new Error('Sharing isn\'t set up in this build of openVideo.');
  const attempt = { cancelled: false };
  activeLogin = attempt;
  // "repo" (private repos) is only requested when the user picks Private; everyone else keeps the narrower scope.
  const code = await postForm('https://github.com/login/device/code', { client_id: clientId, scope: wantPrivate ? 'repo' : 'public_repo' });
  if (code.error === 'Not Found' || code.error === 'incorrect_client_credentials') {
    throw new Error('GitHub doesn\'t recognise this build\'s app ID. Please update openVideo.');
  }
  if (code.error === 'device_flow_disabled') throw new Error('Device Flow is off for this OAuth App. Ask the site owner to tick "Enable Device Flow" in the GitHub OAuth App settings.');
  if (code.error) throw new Error(code.error_description || code.error);
  onCode({ userCode: code.user_code, url: code.verification_uri });
  shell.openExternal(code.verification_uri);

  let interval = (code.interval || 5) * 1000;
  const deadline = Date.now() + code.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    if (attempt.cancelled) throw new Error('Cancelled');
    const r = await postForm('https://github.com/login/oauth/access_token', {
      client_id: clientId, device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (r.access_token) {
      const user = await ghJson('/user', r.access_token);
      saveToken(r.access_token);
      writeConfig({ login: user.login, scopes: r.scope || '' });
      return publicConfig();
    }
    if (r.error === 'slow_down') interval += 5000;
    else if (r.error === 'access_denied') throw new Error('You clicked Cancel on GitHub. openVideo needs this permission to create your public openvideo-recordings repo. Click Connect GitHub to try again.');
    else if (r.error === 'expired_token') throw new Error('The code expired before it was approved. Click Connect GitHub to get a new one.');
    else if (r.error !== 'authorization_pending') throw new Error(r.error_description || r.error);
  }
  throw new Error('GitHub sign-in timed out. Try again.');
}

/** Use the repo if it exists (it keeps its own visibility), otherwise create it. Returns { private }. */
async function ensureRepo(token, owner, repo, wantPrivate) {
  const res = await ghFetch(`/repos/${owner}/${repo}`, token);
  if (res.ok) {
    const r = await res.json();
    if (repo !== GH_REPO && !(r.topics || []).includes(TOPIC)) {
      throw new Error(`You already have a repo called ${repo} that openVideo didn't create. Pick another name.`);
    }
    return { private: Boolean(r.private) };
  }
  if (res.status !== 404) throw new Error(`GitHub API ${res.status} while checking ${owner}/${repo}`);
  // auto_init: releases need at least one commit to tag.
  const created = await ghJson('/user/repos', token, { method: 'POST', body: JSON.stringify({
    name: repo, private: Boolean(wantPrivate), auto_init: true, has_issues: false, has_wiki: false, has_projects: false,
    description: wantPrivate ? 'Videos recorded with openVideo. Private: only people with access can watch.'
      : 'Videos recorded with openVideo. Public: anyone with the link can watch.',
  }) });
  await ghFetch(`/repos/${owner}/${repo}/topics`, token, { method: 'PUT', body: JSON.stringify({ names: [TOPIC] }) }).catch(() => {});
  return { private: Boolean(created.private) };
}

/** The user's openVideo repos (main one + any tagged "openvideo"), newest first, for the share sheet. */
async function listRepos() {
  const token = loadToken();
  if (!token) return [];
  const cfg = readConfig();
  const visibility = publicConfig().canPrivate ? 'all' : 'public';
  const repos = await ghJson(`/user/repos?affiliation=owner&visibility=${visibility}&sort=created&per_page=100`, token);
  return repos
    .filter((r) => r.owner?.login === cfg.login && (r.name === GH_REPO || (r.topics || []).includes(TOPIC)))
    .map((r) => ({ name: r.name, private: Boolean(r.private) }));
}

async function toGithub(cfg, token, blob, type, title, repo, wantPrivate) {
  if (blob.size > GH_MAX_BYTES) throw new Error('GitHub only accepts files under 2 GB. Trim or split this recording first.');
  const owner = cfg.login;
  const { private: isPrivate } = await ensureRepo(token, owner, repo, wantPrivate);
  const tag = crypto.randomBytes(12).toString('base64url'); // same 16-char id format the website validates
  const createRelease = () => ghJson(`/repos/${owner}/${repo}/releases`, token, {
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
  const up = await ghFetch(`https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=video.${ext}`, token, {
    method: 'POST', headers: { 'Content-Type': type }, body: blob,
  });
  if (!up.ok) {
    // Don't leave an empty release + tag behind.
    await ghFetch(`/repos/${owner}/${repo}/releases/${release.id}`, token, { method: 'DELETE' }).catch(() => {});
    await ghFetch(`/repos/${owner}/${repo}/git/refs/tags/${tag}`, token, { method: 'DELETE' }).catch(() => {});
    throw new Error(`GitHub upload failed (HTTP ${up.status})`);
  }
  // The main repo keeps the original short link format; other repos carry their name in the link.
  return { isPrivate, url: new URL(repo === GH_REPO ? `/v/gh/${owner}/${tag}` : `/v/gh/${owner}/${repo}/${tag}`, SITE_URL).href };
}

// Turn GitHub API failures into something a non-developer can act on.
function explain(err) {
  if (err.status === 401) return new Error('Your GitHub connection expired or was revoked. Disconnect, then Connect GitHub again.');
  if (err.status === 403 || err.status === 404) {
    return new Error('GitHub refused: openVideo is missing permission to create your repo or upload to it. Disconnect, then Connect GitHub again and click Authorize.');
  }
  if (err.status === 422 && /name already exists/i.test(err.message)) {
    return new Error('A repo with that name already exists on your GitHub. Pick another name.');
  }
  return err;
}

/**
 * dest: { kind: 'main' | 'existing' | 'new', repo, private }. 'main' = openvideo-recordings.
 * Trust boundary: dest comes from the renderer, so the repo name is validated here.
 */
async function share(file, name, dest = readConfig().dest) {
  const cfg = readConfig();
  const token = loadToken();
  if (!SITE_URL) throw new Error('Sharing isn\'t set up in this build of openVideo.');
  if (!token) throw new Error('Connect GitHub first.');
  const kind = ['main', 'existing', 'new'].includes(dest?.kind) ? dest.kind : 'main';
  const repo = kind === 'main' ? GH_REPO : String(dest.repo || '');
  if (!repoNameOk(repo)) throw new Error('Repo names can use letters, numbers, - _ and . (up to 100 characters).');
  const wantPrivate = Boolean(dest?.private);
  if (wantPrivate && !publicConfig().canPrivate) {
    throw new Error('NEED_PRIVATE'); // the panel turns this into the "Allow private repos" step
  }
  const type = name.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4';
  const blob = await fs.openAsBlob(file, { type }); // streamed from disk, not loaded into memory
  const title = `Recording ${name.replace(/^openVideo /, '').replace(/\.\w+$/, '')}`;
  const { url, isPrivate } = await toGithub(cfg, token, blob, type, title, repo, wantPrivate).catch((err) => { throw explain(err); });
  const now = readConfig();
  writeConfig({
    shares: { ...now.shares, [name]: url },
    privateShares: { ...now.privateShares, [name]: isPrivate },
    dest: { kind: kind === 'new' ? 'existing' : kind, repo, private: isPrivate }, // next time, offer the same repo
  });
  return url;
}

// Star the openVideo repo. Only ever called from an explicit click on "Star".
// Read from local config (no GitHub call, no keychain prompt at launch).
function starStatus() {
  const cfg = readConfig();
  return { connected: hasToken(), starred: Boolean(cfg.starred), nudged: Boolean(cfg.starNudged) };
}

async function star() {
  const token = loadToken();
  if (!token) {
    await shell.openExternal(`https://github.com/${PROJECT_REPO}`);
    return { starred: false, opened: true };
  }
  const res = await ghFetch(`/user/starred/${PROJECT_REPO}`, token, { method: 'PUT', headers: { 'Content-Length': '0' } });
  if (res.status !== 204) throw new Error(`GitHub didn't accept the star (HTTP ${res.status})`);
  writeConfig({ starred: true });
  return { starred: true, opened: false };
}

const markStarNudged = () => { writeConfig({ starNudged: true }); };

module.exports = { GH_REPO, newRepoName, publicConfig, login, cancelLogin, logout, share, listRepos, starStatus, star, markStarNudged };
