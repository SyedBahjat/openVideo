import test from 'node:test';
import assert from 'node:assert';
import { isValidVideoRef } from './validate.ts';

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
