'use client';

import { useEffect, useRef, useState } from 'react';
import { openBubble } from './bubble';
import { errMsg, fmtTime, mixAudio, pickMime, stopAll } from './media';

type Mode = 'screen+cam' | 'screen' | 'cam';
type Phase = 'setup' | 'recording' | 'review';
type Take = { blob: Blob; url: string; type: string };

const MODES: { id: Mode; label: string }[] = [
  { id: 'screen+cam', label: 'Screen + Cam' }, { id: 'screen', label: 'Screen' }, { id: 'cam', label: 'Cam only' },
];
const CHUNK_MS = 1000;

export default function Recorder({ hasDesktopSetup }: { hasDesktopSetup: boolean }) {
  const [mode, setMode] = useState<Mode>('screen+cam');
  const [camStream, setCamStream] = useState<MediaStream | null>(null);
  const [isBubbleOpen, setIsBubbleOpen] = useState(false);
  const [isMicOn, setIsMicOn] = useState(true);
  const [phase, setPhase] = useState<Phase>('setup');
  const [isPaused, setIsPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const recRef = useRef<MediaRecorder | null>(null);
  const closeBubbleRef = useRef<(() => void) | null>(null);

  const wantsCam = mode !== 'screen';

  // Camera preview whenever the mode uses the camera. Closing the stream also closes the bubble.
  useEffect(() => {
    if (!wantsCam) return;
    let stream: MediaStream | null = null;
    let isCancelled = false;
    navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } })
      .then((s) => { if (isCancelled) stopAll([s]); else { stream = s; setCamStream(s); } })
      .catch((e) => setError(`Camera unavailable: ${errMsg(e)}`));
    return () => {
      isCancelled = true;
      closeBubbleRef.current?.();
      if (stream) stopAll([stream]);
      setCamStream(null);
      setIsBubbleOpen(false);
    };
  }, [wantsCam]);

  useEffect(() => {
    if (phase !== 'recording' || isPaused) return;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase, isPaused]);

  async function handlePopBubble() {
    if (!camStream) return;
    setError('');
    try {
      closeBubbleRef.current = await openBubble(camStream, () => setIsBubbleOpen(false));
      setIsBubbleOpen(true);
    } catch (e) { setError(errMsg(e)); }
  }

  async function handleStart() {
    setError('');
    const streams: MediaStream[] = []; // streams we own and must stop (not the camera preview)
    try {
      let video: MediaStreamTrack;
      if (mode === 'cam') {
        if (!camStream) throw new Error('Waiting for the camera…');
        video = camStream.getVideoTracks()[0];
      } else {
        const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
        streams.push(display);
        video = display.getVideoTracks()[0];
      }
      if (isMicOn) streams.push(await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }));
      const { track: audio, ctx } = mixAudio(streams.flatMap((s) => s.getAudioTracks()));
      const { mime, type } = pickMime();

      const chunks: Blob[] = [];
      const rec = new MediaRecorder(new MediaStream(audio ? [video, audio] : [video]), { mimeType: mime, videoBitsPerSecond: 6_000_000 });
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stopAll(streams);
        void ctx?.close();
        const blob = new Blob(chunks, { type });
        setTake({ blob, type, url: URL.createObjectURL(blob) });
        setPhase('review');
      };
      video.addEventListener('ended', () => { if (rec.state !== 'inactive') rec.stop(); }); // browser "Stop sharing"
      rec.start(CHUNK_MS);
      recRef.current = rec;
      setElapsed(0);
      setIsPaused(false);
      setPhase('recording');
    } catch (e) {
      stopAll(streams);
      if (!(e instanceof DOMException && e.name === 'NotAllowedError')) setError(errMsg(e));
    }
  }

  function handlePause() {
    const rec = recRef.current;
    if (!rec) return;
    if (rec.state === 'recording') { rec.pause(); setIsPaused(true); } else if (rec.state === 'paused') { rec.resume(); setIsPaused(false); }
  }

  function handleStop() {
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
  }

  function handleReset() {
    if (take) URL.revokeObjectURL(take.url);
    setTake(null);
    setTitle('');
    setPhase('setup');
  }

  const needsBubble = mode === 'screen+cam' && !isBubbleOpen;
  const ext = take?.type === 'video/webm' ? 'webm' : 'mp4';

  return (
    <section className="card recorder" aria-labelledby="rec-h">
      <h2 id="rec-h" className="eyebrow">New recording</h2>

      {phase === 'setup' && (
        <>
          <div className="modes" role="radiogroup" aria-label="Recording mode">
            {MODES.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} onClick={() => setMode(m.id)}>{m.label}</button>
            ))}
          </div>
          {wantsCam && (
            <div className="cam-row">
              <video className="cam-preview" autoPlay muted playsInline ref={(el) => { if (el && el.srcObject !== camStream) el.srcObject = camStream; }} />
              {mode === 'screen+cam' && (
                <button type="button" className="ghost" onClick={handlePopBubble} disabled={!camStream || isBubbleOpen}>
                  {isBubbleOpen ? 'Bubble is floating ✓' : 'Pop out camera bubble'}
                </button>
              )}
            </div>
          )}
          <label className="check"><input type="checkbox" checked={isMicOn} onChange={(e) => setIsMicOn(e.target.checked)} /> Microphone</label>
          <button type="button" className="rec" onClick={handleStart} disabled={needsBubble || (mode === 'cam' && !camStream)}>
            <span className="dot" aria-hidden="true" />{needsBubble ? 'Pop out the bubble first' : 'Start recording'}
          </button>
          <p className="hint">You&apos;ll pick a screen, window or tab next. Tick &ldquo;share audio&rdquo; there to include sound.</p>
        </>
      )}

      {phase === 'recording' && (
        <div className="live">
          <span className={`live-dot${isPaused ? ' paused' : ''}`} aria-hidden="true" />
          <output className="timer">{fmtTime(elapsed)}</output>
          <button type="button" className="ghost" onClick={handlePause}>{isPaused ? 'Resume' : 'Pause'}</button>
          <button type="button" className="rec small" onClick={handleStop}>Stop</button>
        </div>
      )}

      {take && phase === 'review' && (
        <div className="review">
          <video src={take.url} controls className="player" />
          <input className="title-input" placeholder="Name it (used as the file name)" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="row">
            <a className="rec" href={take.url} download={`${title.trim() || 'openVideo recording'}.${ext}`}>Download</a>
            <button type="button" className="ghost" onClick={handleReset}>Discard</button>
          </div>
          <p className="hint">
            To get a share link: open the openVideo desktop app, click <b>Add video</b>, pick this file, then <b>Share</b>.
            It is saved to your own GitHub. {!hasDesktopSetup && 'Set up the desktop app first (steps on the right).'}
          </p>
        </div>
      )}

      {error && <p className="notice" role="alert">{error}</p>}
    </section>
  );
}
