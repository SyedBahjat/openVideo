// Browser recording helpers shared by the recorder.

const MIMES: ReadonlyArray<readonly [string, string]> = [
  ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'], // H.264 + AAC plays everywhere
  ['video/mp4', 'video/mp4'],
  ['video/webm;codecs=vp9,opus', 'video/webm'],
  ['video/webm', 'video/webm'],
];

export function pickMime(): { mime: string; type: string } {
  const hit = MIMES.find(([m]) => MediaRecorder.isTypeSupported(m));
  if (!hit) throw new Error('This browser cannot record video.');
  return { mime: hit[0], type: hit[1] };
}

/** MediaRecorder takes one audio track, so mic + tab/system audio get mixed first. */
export function mixAudio(tracks: MediaStreamTrack[]): { track?: MediaStreamTrack; ctx?: AudioContext } {
  if (tracks.length <= 1) return { track: tracks[0] };
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  tracks.forEach((t) => ctx.createMediaStreamSource(new MediaStream([t])).connect(dest));
  return { track: dest.stream.getAudioTracks()[0], ctx };
}

export const stopAll = (streams: MediaStream[]) => streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
