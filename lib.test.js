const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { resolveInside, recordingName } = require('./lib');

test('resolveInside accepts plain recording names', () => {
  assert.strictEqual(resolveInside('/r', 'a b.mp4'), path.join('/r', 'a b.mp4'));
});

test('resolveInside rejects traversal, separators and other types', () => {
  for (const bad of ['../x.mp4', '/etc/x.mp4', 'a/b.mp4', 'a\\b.mp4', '..', 'x.sh', '', null, 42]) {
    assert.throws(() => resolveInside('/r', bad), /Invalid/, String(bad));
  }
});

test('recordingName is sortable and filesystem-safe', () => {
  const n = recordingName(new Date(2026, 0, 2, 3, 4, 5), '.mp4');
  assert.strictEqual(n, 'openVideo 2026-01-02 at 03.04.05.mp4');
  assert.doesNotMatch(n, /[:/\\]/);
  assert.throws(() => recordingName(new Date(), '.exe'));
});

const { normalizeShareSettings } = require('./lib');

test('normalizeShareSettings keeps valid fields and drops unknown ones', () => {
  assert.deepStrictEqual(
    normalizeShareSettings({ siteUrl: 'https://ov.example/path?x=1', storage: 'cloud', githubClientId: ' Iv1.abc ', shares: { evil: 1 } }),
    { siteUrl: 'https://ov.example', githubClientId: 'Iv1.abc' },
  );
  assert.deepStrictEqual(normalizeShareSettings({ siteUrl: 'http://localhost:3000' }), { siteUrl: 'http://localhost:3000' });
  assert.deepStrictEqual(normalizeShareSettings(null), {});
});

test('normalizeShareSettings rejects unsafe values', () => {
  for (const bad of [{ siteUrl: 'http://evil.example' }, { siteUrl: 'javascript:alert(1)' }, { siteUrl: 'nope' },
    { githubClientId: 'a b' }]) {
    assert.throws(() => normalizeShareSettings(bad), Error, JSON.stringify(bad));
  }
});

test('desktop GitHub tags match the website id format', () => {
  const tag = require('node:crypto').randomBytes(12).toString('base64url');
  assert.match(tag, /^[A-Za-z0-9_-]{16}$/);
});
