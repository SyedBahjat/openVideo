import { cache } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { githubVideo, mediaPath, watchPath } from '@/lib/github';
import { readGithubToken } from '@/lib/session';
import { isValidRepo, isValidVideoRef } from '@/lib/validate';
import Watch from './Watch';

type Ref = { owner: string; repo: string; tag: string };

// One GitHub lookup per request, shared by the page and its metadata.
const load = cache(async (owner: string, repo: string, tag: string) => {
  const token = await readGithubToken();
  return { video: await githubVideo(owner, tag, repo, token ?? undefined), signedIn: Boolean(token) };
});

export async function videoMetadata({ owner, repo, tag }: Ref): Promise<Metadata> {
  if (!isValidVideoRef(owner, tag) || !isValidRepo(repo)) return { title: 'Video not found' };
  const { video } = await load(owner, repo, tag);
  return { title: video?.title ?? 'Private video', robots: video && !video.private ? undefined : { index: false } };
}

/** Public videos play for anyone. A private (or missing) one asks the viewer to sign in with GitHub first. */
export default async function VideoPage({ owner, repo, tag }: Ref) {
  if (!isValidVideoRef(owner, tag) || !isValidRepo(repo)) notFound();
  const { video, signedIn } = await load(owner, repo, tag);
  const path = watchPath(owner, repo, tag);
  if (!video) return <PrivateGate owner={owner} repo={repo} path={path} signedIn={signedIn} />;
  const storage = (
    <a href={`https://github.com/${owner}/${repo}/releases/tag/${tag}`} target="_blank" rel="noopener noreferrer">
      {video.private ? '🔒 private, stored on GitHub' : 'stored on GitHub'}
    </a>
  );
  // Safari and all iOS browsers (WebKit) won't play GitHub's octet-stream downloads; they go through /api/media.
  const ua = (await headers()).get('user-agent') ?? '';
  const webkitOnly = /AppleWebKit/.test(ua) && !/(Chrome|Chromium|Edg|OPR)\//.test(ua);
  const src = webkitOnly ? mediaPath(owner, repo, tag) : video.src;
  return <Watch title={video.title} by={owner} createdAt={video.createdAt} src={src} path={path} storage={storage} />;
}

function PrivateGate({ owner, repo, path, signedIn }: { owner: string; repo: string; path: string; signedIn: boolean }) {
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const login = `/api/auth/login?private=1&next=${encodeURIComponent(path)}`;
  return (
    <main className="watch gate">
      <header className="masthead">
        <Link href="/" className="wordmark">open<em>Video</em></Link>
      </header>
      <section className="gate-card">
        <p className="gate-lock" aria-hidden="true">🔒</p>
        {signedIn ? (
          <>
            <h1>You don&apos;t have access to this video</h1>
            <p>It&apos;s private, or it was deleted. Ask <b>@{owner}</b> to add your GitHub account to <a href={repoUrl}>{owner}/{repo}</a> (Settings → Collaborators), then reload this page.</p>
            <p className="row"><a className="ghost" href={login}>Sign in with a different GitHub account</a></p>
          </>
        ) : (
          <>
            <h1>This video is private</h1>
            <p>It&apos;s stored in a private GitHub repo, <b>{owner}/{repo}</b>. Sign in with GitHub to watch it. Only people with access to that repo can.</p>
            <p className="row"><a className="rec" href={login}><span className="dot" aria-hidden="true" />Sign in with GitHub to watch</a></p>
            <p className="hint">GitHub will ask to let openVideo read your repositories. It&apos;s used only to play private videos you already have access to, and it&apos;s forgotten after 8 hours. If this link is old, the video may also have been deleted.</p>
          </>
        )}
      </section>
    </main>
  );
}
