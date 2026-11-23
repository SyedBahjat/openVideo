import type { NextRequest } from 'next/server';
import { videoSource } from '@/lib/github';
import { readGithubToken } from '@/lib/session';

// Streams a video with the right Content-Type and byte-range support. Needed because GitHub serves release assets as
// application/octet-stream "attachment", which Safari (and every iOS browser) refuses to play. Chrome/Firefox load
// public videos straight from GitHub and never come here; Safari and private videos do.
// ponytail: bytes pass through this function, so Safari/private views use the host's bandwidth. If that grows,
// put a CDN rewrite in front or move storage to something that sets Content-Type.
const PASS = ['content-length', 'content-range', 'etag', 'last-modified'];

export async function GET(req: NextRequest, ctx: RouteContext<'/api/media/[owner]/[repo]/[id]'>) {
  const { owner, repo, id } = await ctx.params;
  const token = await readGithubToken();
  try {
    const src = await videoSource(owner, repo, id, token ?? undefined);
    if (!src) return new Response(token ? 'Not found, or you don\'t have access.' : 'Not found. If it\'s private, sign in to watch.', { status: 404 });
    const range = req.headers.get('range');
    const upstream = await fetch(src.url, { headers: range ? { Range: range } : {}, cache: 'no-store' });
    if (!upstream.ok && upstream.status !== 206) return new Response('GitHub didn\'t return the video.', { status: 502 });
    const headers = new Headers({ 'Content-Type': src.type, 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline',
      'Cache-Control': token ? 'private, no-store' : 'public, max-age=300' });
    for (const h of PASS) { const v = upstream.headers.get(h); if (v) headers.set(h, v); }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    console.error('[openVideo media]', err);
    return new Response('GitHub didn\'t answer. Try again in a minute.', { status: 502 });
  }
}
