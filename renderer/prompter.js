/* global ov, PrompterCore */
// The floating script. One position (`pos` = next word to read) drives every mode:
// voice moves it when what you say matches the script, auto-scroll moves it on a timer, manual only via keys/clicks.
const core = PrompterCore;
const $ = (id) => document.getElementById(id);
const MOD = ov.platform === 'darwin' ? '⌃⌥' : 'Ctrl+Alt+';
const MODE_LABEL = { voice: 'Voice', auto: 'Auto', manual: 'Manual' };
const NUDGE = 8; // words per ↑/↓

let settings = core.DEFAULTS;
let script = null; // last rendered script text
let wordEls = [];
let words = [];
let pos = 0;
let running = false;
let timer = null;
let recState = 'stopped';
let speech = { state: '', message: '' };

// ---------- rendering
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // textContent only: scripts are user text
  return e;
}

function render() {
  const blocks = core.parseScript(settings.script);
  const frag = document.createDocumentFragment();
  wordEls = [];
  let para = null;
  for (const b of blocks) {
    if (b.type === 'break') { para = null; continue; }
    if (b.type !== 'spoken') { frag.append(el('div', b.type === 'heading' ? 'tp-heading' : 'tp-cue', b.text)); para = null; continue; }
    if (!para) { para = el('p'); frag.append(para); }
    for (const part of b.parts) {
      if (part.cue) { para.append(el('span', 'tp-cue-inline', part.text), ' '); continue; }
      for (const tok of part.text.split(/\s+/).filter(Boolean)) {
        const span = el('span', '', tok);
        if (core.normalize(tok)) { span.className = 'w'; span.dataset.i = String(wordEls.length); wordEls.push(span); }
        para.append(span, ' ');
      }
    }
  }
  words = core.scriptWords(blocks); // same tokens, same order as wordEls
  if (!wordEls.length) {
    frag.append(el('p', 'tp-empty', 'No script yet. Write or import one in openVideo → Teleprompter.'));
  }
  $('text').replaceChildren(frag);
  pos = Math.min(pos, Math.max(0, wordEls.length - 1));
  paint(0, wordEls.length);
  requestAnimationFrame(() => scrollToPos(false));
}

function paint(from, to) {
  for (let i = Math.max(0, from); i < Math.min(wordEls.length, to); i++) {
    wordEls[i].classList.toggle('past', i < pos);
    wordEls[i].classList.toggle('now', i === pos);
  }
}

function scrollToPos(smooth = true) {
  const w = wordEls[pos];
  if (!w) return;
  const view = $('view');
  view.scrollTo({ top: Math.max(0, w.offsetTop - view.clientHeight * 0.3), behavior: smooth ? 'smooth' : 'auto' });
}

function setPos(next) {
  const n = Math.max(0, Math.min(next, wordEls.length - 1));
  if (n === pos || !wordEls.length) return;
  const old = pos;
  pos = n;
  paint(Math.min(old, n), Math.max(old, n) + 1);
  scrollToPos();
  if (settings.mode === 'auto' && running && pos >= wordEls.length - 1) setRunning(false); // reached the end
  status();
}

// ---------- running (listening / auto-scrolling)
function setRunning(on) {
  running = Boolean(on) && settings.mode !== 'manual' && wordEls.length > 0;
  clearInterval(timer);
  timer = null;
  if (running && settings.mode === 'auto') timer = setInterval(() => setPos(pos + 1), 60_000 / settings.wpm);
  if (running) speech = { state: '', message: '' };
  ov.tp.listen(running && settings.mode === 'voice');
  status();
}

function status() {
  const { mode } = settings;
  let text = 'Paused';
  let live = false;
  if (mode === 'manual') text = 'Manual';
  else if (running && mode === 'auto') { text = `Auto-scroll · ${settings.wpm} wpm`; live = true; }
  else if (running && mode === 'voice') {
    text = speech.state === 'listening' ? 'Listening' : 'Starting microphone…';
    live = speech.state === 'listening';
  }
  if (wordEls.length) text += ` · ${pos + 1}/${wordEls.length}`;
  $('status').textContent = text;
  $('dot').classList.toggle('live', live);
  $('b-run').textContent = running ? '❚❚' : '▶';
  $('b-run').setAttribute('aria-label', running ? 'Pause' : 'Start');
  $('b-run').title = `${running ? 'Pause' : 'Start'} (${MOD}Space)`;
  $('b-run').disabled = mode === 'manual';
  hint();
}

function hint() {
  const h = $('hint');
  h.replaceChildren();
  h.classList.toggle('warn', Boolean(speech.message));
  if (speech.message) {
    h.append(speech.message);
    if (speech.state === 'denied') {
      const b = el('button', 'tp-link', 'Open Settings');
      b.addEventListener('click', () => ov.tp.speechSettings());
      h.append(' ', b);
      if (settings.clickThrough) h.append(` (${MOD}L to unlock)`);
    }
    return;
  }
  h.textContent = settings.clickThrough
    ? `Click-through on · ${MOD}L unlock · ${MOD}Space ${running ? 'pause' : 'start'} · ${MOD}↑↓ nudge · ${MOD}0 restart · ${MOD}T hide`
    : `Unlocked: drag the top bar to move, edges to resize, click a word to jump · ${MOD}L lock`;
}

// ---------- settings from openVideo
function applySettings(next) {
  const prev = settings;
  settings = next;
  const root = document.documentElement.style;
  root.setProperty('--tp-size', `${settings.fontSize}px`);
  root.setProperty('--tp-alpha', String(settings.opacity / 100));
  document.body.classList.toggle('locked', settings.clickThrough);
  $('b-mode').textContent = MODE_LABEL[settings.mode];
  $('speed').hidden = settings.mode !== 'auto';
  $('wpm').textContent = `${settings.wpm} wpm`;
  $('b-lock').textContent = settings.clickThrough ? 'Unlock' : 'Lock';
  $('b-lock').title = `${settings.clickThrough ? 'Let me click it' : 'Click-through: clicks go to the app behind'} (${MOD}L)`;
  if (settings.script !== script) { script = settings.script; render(); }
  else if (prev.fontSize !== settings.fontSize) requestAnimationFrame(() => scrollToPos(false));
  if (prev.mode !== settings.mode) {
    speech = { state: '', message: '' };
    setRunning(running || recState === 'recording');
  } else if (settings.mode === 'auto' && prev.wpm !== settings.wpm) setRunning(running);
  else status();
}

const set = (partial) => ov.tp.set(partial);
const cycleMode = () => set({ mode: core.MODES[(core.MODES.indexOf(settings.mode) + 1) % core.MODES.length] });

const actions = {
  toggle: () => setRunning(!running),
  back: () => setPos(pos - NUDGE),
  forward: () => setPos(pos + NUDGE),
  restart: () => { setPos(0); scrollToPos(); },
  bigger: () => set({ fontSize: settings.fontSize + 4 }),
  smaller: () => set({ fontSize: settings.fontSize - 4 }),
};

// ---------- events
ov.tp.onSettings(applySettings);
ov.tp.onKey((a) => actions[a]?.());
ov.tp.onSpeech((msg) => {
  if (msg.type === 'heard') {
    if (running && settings.mode === 'voice') setPos(core.follow(words, pos, msg.words));
    return;
  }
  if (msg.state === 'stopped') { if (settings.mode === 'voice') running = false; status(); return; } // helper exited on its own
  speech = { state: msg.state, message: msg.state === 'listening' ? '' : msg.message };
  if (msg.state !== 'listening') running = false;
  status();
});
ov.tp.onRec((next) => {
  if (next === 'recording' && recState !== 'recording') {
    if (recState === 'stopped' && settings.rewindOnRecord) { setPos(0); scrollToPos(); }
    setRunning(true);
  } else if (next !== 'recording') setRunning(false);
  recState = next;
});

$('b-run').addEventListener('click', actions.toggle);
$('b-restart').addEventListener('click', actions.restart);
$('b-mode').addEventListener('click', cycleMode);
$('b-slower').addEventListener('click', () => set({ wpm: settings.wpm - 10 }));
$('b-faster').addEventListener('click', () => set({ wpm: settings.wpm + 10 }));
$('b-smaller').addEventListener('click', actions.smaller);
$('b-bigger').addEventListener('click', actions.bigger);
$('b-lock').addEventListener('click', () => set({ clickThrough: !settings.clickThrough }));
$('b-close').addEventListener('click', () => ov.tp.close());
$('text').addEventListener('click', (e) => {
  const i = e.target.closest?.('.w')?.dataset.i;
  if (i !== undefined) setPos(Number(i));
});
addEventListener('keydown', (e) => {
  const map = { ' ': 'toggle', ArrowUp: 'back', ArrowDown: 'forward', 0: 'restart', '=': 'bigger', '+': 'bigger', '-': 'smaller' };
  if (e.key === 'Escape') { ov.tp.close(); return; }
  if (map[e.key]) { e.preventDefault(); actions[map[e.key]](); }
});
addEventListener('resize', () => scrollToPos(false));

(async () => {
  const { settings: s, state } = await ov.tp.get();
  applySettings(s);
  if (state.rec === 'recording' || state.rec === 'paused') {
    if (settings.rewindOnRecord) setPos(0);
    recState = state.rec;
    setRunning(state.rec === 'recording');
  } else {
    setRunning(settings.mode === 'voice'); // voice: listen right away so you can rehearse; auto waits for Start or a recording
  }
})();
