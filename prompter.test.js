const test = require('node:test');
const assert = require('node:assert');
const core = require('./renderer/prompter-core');

const words = (t) => core.scriptWords(core.parseScript(t));

test('parseScript: headings, cues, breaks and markdown quotes', () => {
  const b = core.parseScript('# Intro\n\n> Hi, I am **Sam**.\n[smile]\n*(open the app)*\nThis is [pause] it.\n\n\n---');
  assert.deepStrictEqual(b.map((x) => x.type), ['heading', 'break', 'spoken', 'cue', 'cue', 'spoken']);
  assert.strictEqual(b[0].text, 'Intro');
  assert.strictEqual(b[3].text, 'smile');
  assert.strictEqual(b[4].text, 'open the app');
  assert.deepStrictEqual(b[2].parts, [{ cue: false, text: 'Hi, I am Sam.' }]);
  assert.deepStrictEqual(b[5].parts.map((p) => p.cue), [false, true, false]);
});

test('scriptWords skips cues and punctuation', () => {
  assert.deepStrictEqual(words('Hello, world! [wave] — Bye.'), ['hello', 'world', 'bye']);
});

test('follow moves forward on a matching phrase', () => {
  const w = words('Hi I am Muhammad and I build data pipelines with Snowflake and Streamlit');
  assert.strictEqual(core.follow(w, 0, ['hi', 'I', 'am']), 3);
  assert.strictEqual(core.follow(w, 3, ['am', 'Muhammad', 'and', 'I', 'build']), 7);
  // misspelt by the recognizer, still matches
  assert.strictEqual(core.follow(w, 7, ['pipelines', 'with', 'snowflake', 'and', 'streamlite']), 13);
});

test('follow never jumps backwards or on noise', () => {
  const w = words('one two three four five six seven eight nine ten');
  assert.strictEqual(core.follow(w, 6, ['one', 'two']), 6);
  assert.strictEqual(core.follow(w, 2, ['banana', 'kiwi']), 2);
  assert.strictEqual(core.follow(w, 2, []), 2);
  // too far ahead (outside the look-ahead window) is ignored
  const long = words(Array.from({ length: 60 }, (_, i) => `w${i}x`).join(' '));
  assert.strictEqual(core.follow(long, 0, ['w40x', 'w41x']), 0);
});

test('scriptHints picks capitalised names once', () => {
  assert.deepStrictEqual(core.scriptHints('Snowflake and Streamlit. Snowflake again, then GKE.'), ['Snowflake', 'Streamlit', 'GKE']);
});

test('sanitizeSettings clamps, defaults and rejects junk', () => {
  const s = core.sanitizeSettings({ mode: 'evil', wpm: 9999, fontSize: '40', opacity: null, clickThrough: 'yes',
    script: 42, bounds: { x: 1, y: 2, width: 10, height: 10 } });
  assert.strictEqual(s.mode, 'voice');
  assert.strictEqual(s.wpm, 260);
  assert.strictEqual(s.fontSize, 40);
  assert.strictEqual(s.opacity, core.DEFAULTS.opacity);
  assert.strictEqual(s.clickThrough, true);
  assert.strictEqual(s.script, '');
  assert.strictEqual(s.bounds, null);
  assert.strictEqual(core.sanitizeSettings({ script: 'x'.repeat(300_000) }).script.length, 200_000);
  assert.deepStrictEqual(core.sanitizeSettings({ bounds: { x: 5.4, y: 6, width: 800, height: 240 } }).bounds,
    { x: 5, y: 6, width: 800, height: 240 });
});
