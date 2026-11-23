/* global ov, PrompterCore */
// Panel section: write/import the script and choose how the teleprompter behaves. Settings live in the main
// process (saved to disk) and are pushed back here and to the teleprompter window on every change.
(() => {
  const core = PrompterCore;
  const q = (s) => document.querySelector(s);
  const IS_MAC = ov.platform === 'darwin';
  const keysText = (k) => core.shortcutKeys(k, ov.platform).join(' + ');
  const MODE_NOTE = {
    voice: IS_MAC
      ? 'Moves along as you speak, using on-device speech recognition (nothing leaves your Mac). macOS asks for Speech Recognition access the first time.'
      : 'Beta: moves along as you speak, using Windows speech recognition (Settings → Time & language → Speech). If it can\'t start, use Auto-scroll.',
    auto: 'Scrolls at a steady speed. Starts when recording starts and pauses when you pause.',
    manual: `Doesn't move by itself. Use ${keysText('↑')} / ${keysText('↓')}, or unlock it and click the word you're on.`,
  };
  const KEYS = [
    ['Space', 'Start / pause'], ['↑ ↓', 'Back / forward a bit'], ['0', 'Back to the start'],
    ['L', 'Lock / unlock (click-through)'], ['T', 'Hide / show'], ['V', 'Show in / hide from the recording'], ['= −', 'Bigger / smaller text'],
  ];

  let settings = core.DEFAULTS;
  let state = { open: false };
  let typing = null;

  const set = (partial) => ov.tp.set(partial).catch((err) => notice(String(err.message || err)));
  const notice = (msg) => { const n = q('#notice'); n.hidden = !msg; n.textContent = msg || ''; };

  function count(text) {
    const n = core.scriptWords(core.parseScript(text)).length;
    if (!n) return 'No script yet';
    const wpm = settings.mode === 'auto' ? settings.wpm : 140;
    const secs = Math.round((n / wpm) * 60);
    return `${n} words · about ${secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60 ? `${secs % 60} s` : ''}` : `${secs} s`} to read`;
  }

  function render() {
    const s = settings;
    if (document.activeElement !== q('#tp-script')) q('#tp-script').value = s.script;
    q('#tp-count').textContent = count(q('#tp-script').value);
    document.querySelectorAll('[data-tp-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tpMode === s.mode)));
    q('#tp-mode-note').textContent = MODE_NOTE[s.mode];
    q('#tp-wpm-field').hidden = s.mode !== 'auto';
    for (const [id, val, fmt] of [['wpm', s.wpm, (v) => `${v} wpm`], ['size', s.fontSize, (v) => `${v} px`], ['opacity', s.opacity, (v) => `${v}%`]]) {
      q(`#tp-${id}`).value = val;
      q(`#tp-${id}-out`).textContent = fmt(val);
    }
    q('#tp-through').checked = s.clickThrough;
    q('#tp-auto').checked = s.autoOpen;
    q('#tp-quick').checked = s.autoOpen;
    q('#tp-rewind').checked = s.rewindOnRecord;
    renderState();
  }

  function renderState() {
    const btn = q('#tp-open');
    btn.replaceChildren();
    if (state.open) { const dot = document.createElement('span'); dot.className = 'on'; btn.append(dot, 'Close teleprompter'); }
    else btn.append('Open teleprompter');
    btn.classList.toggle('is-open', state.open);
    const note = q('#tp-open-note');
    note.replaceChildren();
    if (state.open && !state.visible) {
      const b = document.createElement('button');
      b.className = 'pill-btn ghost';
      b.textContent = 'Show it again';
      b.addEventListener('click', () => ov.tp.show(true).then((s) => { state = s; renderState(); }));
      note.append(b, ` It's hidden (${keysText('T')} toggles it).`);
    }
    q('#tp-capture').checked = Boolean(state.showInRecording);
    q('#tp-sum').textContent = state.open ? 'Open now' : settings.script.trim() ? count(settings.script).split(' · ')[0] : 'Your script, hidden from the video';
  }

  // ---------- wiring
  q('#tp-script').addEventListener('input', (e) => {
    q('#tp-count').textContent = count(e.target.value);
    q('#tp-saved').textContent = '';
    clearTimeout(typing);
    typing = setTimeout(async () => { await set({ script: e.target.value }); q('#tp-saved').textContent = 'Saved'; }, 400);
  });
  q('#tp-import').addEventListener('click', async () => {
    try {
      const s = await ov.tp.importScript();
      if (s) { q('#tp-script').value = s.script; render(); q('#tp-saved').textContent = 'Imported'; }
    } catch (err) { notice(`Couldn't import: ${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`); }
  });
  q('#tp-clear').addEventListener('click', () => {
    if (!q('#tp-script').value || !confirmClear()) return;
    q('#tp-script').value = '';
    set({ script: '' });
  });
  // Native confirm() is fine here: the panel is a normal window. Keep it simple.
  function confirmClear() { return window.confirm('Clear the whole script?'); }

  document.querySelectorAll('[data-tp-mode]').forEach((b) => b.addEventListener('click', () => set({ mode: b.dataset.tpMode })));
  q('#tp-wpm').addEventListener('input', (e) => set({ wpm: Number(e.target.value) }));
  q('#tp-size').addEventListener('input', (e) => set({ fontSize: Number(e.target.value) }));
  q('#tp-opacity').addEventListener('input', (e) => set({ opacity: Number(e.target.value) }));
  q('#tp-through').addEventListener('change', (e) => set({ clickThrough: e.target.checked }));
  q('#tp-auto').addEventListener('change', (e) => set({ autoOpen: e.target.checked }));
  q('#tp-quick').addEventListener('change', (e) => {
    if (e.target.checked && !settings.script.trim()) { e.target.checked = false; q('#tab-prompter').click(); q('#tp-script').focus(); notice('Write or paste your script first.'); return; }
    set({ autoOpen: e.target.checked });
  });
  q('#tp-edit').addEventListener('click', (e) => { e.preventDefault(); q('#tab-prompter').click(); q('#tp-script').focus(); });
  q('#tp-rewind').addEventListener('change', (e) => set({ rewindOnRecord: e.target.checked }));
  q('#tp-capture').addEventListener('change', async (e) => { state = await ov.tp.showInRecording(e.target.checked); renderState(); });
  q('#tp-open').addEventListener('click', async () => {
    if (!state.open && !q('#tp-script').value.trim()) { q('#tp-script').focus(); notice('Write or import your script first.'); return; }
    clearTimeout(typing);
    await set({ script: q('#tp-script').value }); // don't open on a stale script
    state = await (state.open ? ov.tp.close() : ov.tp.open());
    renderState();
  });

  q('#tp-keys').replaceChildren(...KEYS.flatMap(([k, what]) => {
    const dt = document.createElement('dt');
    core.shortcutKeys(k, ov.platform).forEach((key, i) => {
      if (i) dt.append('+');
      const kbd = document.createElement('kbd');
      kbd.textContent = key;
      dt.append(kbd);
    });
    const dd = document.createElement('dd');
    dd.textContent = what;
    return [dt, dd];
  }));

  ov.tp.onSettings((s) => { settings = s; render(); });
  ov.tp.onState((s) => { state = s; renderState(); });
  ov.tp.get().then(({ settings: s, state: st }) => { settings = s; state = st; render(); });
})();
