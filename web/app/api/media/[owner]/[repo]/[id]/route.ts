import type { NextRequest } from 'next/server';
import { signedVideoUrl } from '@/lib/github';
import { readGithubToken } from '@/lib/session';

// Private videos: never proxy the bytes. Check the viewer can read the repo (with their own token) and redirect to the
// short-lived signed URL GitHub hands out. The <video> element streams from GitHub's CDN directly.
// ponytail: GitHub signs the URL for about an hour; seeking a video left open longer than that needs a reload.
export async function GET(_req: NextRequest, ctx: RouteContext<'/api/media/[owner]/[repo]/[id]'>) {
  const { owner, repo, id } = await ctx.params;
  const token = await readGithubToken();
  if (!token) return new Response('Sign in to watch this private video.', { status: 401 });
  try {
    const url = await signedVideoUrl(owner, repo, id, token);
    if (!url) return new Response('Not found, or you don\'t have access.', { status: 404 });
    return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    console.error('[openVideo media]', err);
    return new Response('GitHub didn\'t answer. Try again in a minute.', { status: 502 });
  }
}
