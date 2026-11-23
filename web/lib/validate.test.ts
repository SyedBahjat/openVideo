import test from 'node:test';
import assert from 'node:assert';
import { isSafeNext, isValidRepo, isValidVideoRef } from './validate.ts';

test('accepts a real owner + desktop tag', () => {
  assert.ok(isValidVideoRef('octo-cat', 'gFhtsJjPDURbbpOw'));
});

test('blocks path tricks in owner and tag', () => {
  for (const [owner, tag] of [['../x', 'gFhtsJjPDURbbpOw'], ['a/b', 'gFhtsJjPDURbbpOw'], ['-lead', 'gFhtsJjPDURbbpOw'],
    ['a'.repeat(40), 'gFhtsJjPDURbbpOw'], ['', 'gFhtsJjPDURbbpOw'], ['octocat', '../releases'], ['octocat', 'short'],
    ['octocat', 'gFhtsJjPDURbbpO/']]) {
    assert.ok(!isValidVideoRef(owner, tag), `${owner} ${tag}`);
  }
});

test('repo names: GitHub style only', () => {
  for (const ok of ['openvideo-recordings', 'team.demos_2026']) assert.ok(isValidRepo(ok), ok);
  for (const bad of ['', '.', '..', 'a/b', '../x', 'x'.repeat(101), 'has space']) assert.ok(!isValidRepo(bad), bad);
});

test('login only returns to watch pages on this site', () => {
  assert.ok(isSafeNext('/v/gh/octocat/gFhtsJjPDURbbpOw'));
  assert.ok(isSafeNext('/v/gh/octocat/team-videos/gFhtsJjPDURbbpOw'));
  for (const bad of ['https://evil.com', '//evil.com', '/v/gh/../../x', '/api/auth/logout', '/v/gh/a/b/c/d', '/']) {
    assert.ok(!isSafeNext(bad), bad);
  }
});
