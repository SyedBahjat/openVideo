// Teleprompter logic shared by the main process (settings) and the prompter window (script + voice following).
// Plain script: loaded with <script> in the renderer (defines window.PrompterCore) and require()d by Node.
(function (root) {
  const MODES = ['voice', 'auto', 'manual'];
  const DEFAULTS = Object.freeze({
    script: '', mode: 'voice', wpm: 140, fontSize: 34, opacity: 88,
    clickThrough: true, autoOpen: true, rewindOnRecord: true, bounds: null,
  });
  const MAX_SCRIPT = 200_000;

  const normalize = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');

  function editDistance(a, b) {
    if (!a.length || !b.length) return Math.max(a.length, b.length);
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) {
        next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      row = next;
    }
    return row[b.length];
  }

  // Speech engines mangle names and endings ("Streamlit" -> "streamlite"), so match loosely.
  function similar(a, b) {
    if (a === b) return true;
    const n = Math.min(a.length, b.length);
    if (n >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
    return n >= 5 && editDistance(a, b) <= 1;
  }

  // Script format: blank line = paragraph break, "# Title" = section heading, "[note]" or "*(note)*" = a cue
  // shown small and never tracked (inline [notes] too). A leading "> " is stripped, so Markdown scripts work as-is.
  function parseScript(text) {
    const blocks = [];
    const push = (b) => {
      if (b.type === 'break' && (!blocks.length || blocks[blocks.length - 1].type === 'break')) return;
      blocks.push(b);
    };
    for (const raw of String(text).split(/\r?\n/)) {
      let line = raw.trim();
      if (!line || /^(-{3,}|\*{3,})$/.test(line)) { push({ type: 'break' }); continue; }
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) { push({ type: 'heading', text: heading[1].replace(/[*`_]/g, '') }); continue; }
      if (/^\[[^\]]*\]$/.test(line) || /^\*\(.*\)\*$/.test(line) || /^\(.*\)$/.test(line)) {
        push({ type: 'cue', text: line.replace(/^\*?[[(]|[\])]\*?$/g, '') });
        continue;
      }
      line = line.replace(/^>\s?/, '').replace(/\*\*|`/g, '');
      if (!line) { push({ type: 'break' }); continue; }
      const parts = line.split(/(\[[^\]]*\])/).filter(Boolean)
        .map((p) => (/^\[.*\]$/.test(p) ? { cue: true, text: p.slice(1, -1) } : { cue: false, text: p }));
      push({ type: 'spoken', parts });
    }
    while (blocks.length && blocks[blocks.length - 1].type === 'break') blocks.pop();
    return blocks;
  }

  // Normalized, trackable words in reading order (what voice following and auto-scroll step through).
  function scriptWords(blocks) {
    const words = [];
    for (const b of blocks) {
      if (b.type !== 'spoken') continue;
      for (const p of b.parts) {
        if (p.cue) continue;
        for (const tok of p.text.split(/\s+/)) { const n = normalize(tok); if (n) words.push(n); }
      }
    }
    return words;
  }

  /**
   * Align the last few heard words with the script just ahead of `pos` and return the new position
   * (index of the next word to read). Only moves forward, and only when the match is convincing.
   */
  function follow(words, pos, heard) {
    const tail = heard.map(normalize).filter(Boolean).slice(-4);
    if (!tail.length || !words.length) return pos;
    const lo = Math.max(0, pos - 2);
    const hi = Math.min(words.length - 1, pos + 18);
    let best = -1;
    let bestScore = 0;
    for (let end = lo; end <= hi; end++) {
      if (!similar(tail[tail.length - 1], words[end])) continue;
      let score = 0;
      for (let k = 0; k < tail.length && end - k >= 0; k++) {
        if (similar(tail[tail.length - 1 - k], words[end - k])) score++;
      }
      if (score > bestScore || (score === bestScore && Math.abs(end - pos) < Math.abs(best - pos))) {
        best = end;
        bestScore = score;
      }
    }
    if (best < 0) return pos;
    const confident = bestScore >= 2 || tail.length === 1 || (words[best].length >= 5 && best <= pos + 3);
    return confident && best + 1 > pos ? best + 1 : pos;
  }

  // Capitalized words (names, products) help the recognizer spell them the way the script does.
  function scriptHints(text, limit = 100) {
    const seen = new Set();
    for (const m of String(text).matchAll(/\b[A-Z][\p{L}\p{N}]{2,}\b/gu)) {
      seen.add(m[0]);
      if (seen.size >= limit) break;
    }
    return [...seen];
  }

  const num = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
  const clamp = (v, lo, hi, d) => (Number.isFinite(num(v)) ? Math.min(hi, Math.max(lo, Math.round(num(v)))) : d);
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);

  // Trust boundary: settings arrive from renderers and from a JSON file on disk.
  function sanitizeSettings(input, base = DEFAULTS) {
    const s = input && typeof input === 'object' ? input : {};
    const b = s.bounds;
    const okBounds = b && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k]))
      && b.width >= 300 && b.height >= 120;
    return {
      script: typeof s.script === 'string' ? s.script.slice(0, MAX_SCRIPT) : base.script,
      mode: MODES.includes(s.mode) ? s.mode : base.mode,
      wpm: clamp(s.wpm, 60, 260, base.wpm),
      fontSize: clamp(s.fontSize, 18, 96, base.fontSize),
      opacity: clamp(s.opacity, 30, 100, base.opacity),
      clickThrough: bool(s.clickThrough, base.clickThrough),
      autoOpen: bool(s.autoOpen, base.autoOpen),
      rewindOnRecord: bool(s.rewindOnRecord, base.rewindOnRecord),
      bounds: okBounds ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : base.bounds,
    };
  }

  const api = { MODES, DEFAULTS, normalize, similar, parseScript, scriptWords, follow, scriptHints, sanitizeSettings };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PrompterCore = api;
})(typeof window === 'undefined' ? globalThis : window);
