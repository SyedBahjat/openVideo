import Link from 'next/link';
import { headers } from 'next/headers';
import { GH_REPO, watchPath, type GhVideo } from '@/lib/github';
import { CopyLink } from './ClientActions';
import { desktopDownloadUrl } from './StarButton';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en', { dateStyle: 'medium' });
const fmtSize = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${(b / 1e6).toFixed(1)} MB`);

type Props = { login: string; videos: GhVideo[] | null; loadError: boolean; showsPrivate: boolean };

/** Setup guide (until the user's repo exists) + their videos, read from their own GitHub repo. */
export default async function YourVideos({ login, videos, loadError, showsPrivate }: Props) {
  const h = await headers();
  const origin = `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host')}`;
  const repoUrl = `https://github.com/${login}/${GH_REPO}`;
  const isReady = videos !== null;
  const desktopUrl = desktopDownloadUrl();

  return (
    <section className="library" aria-labelledby="lib-h">
      {isReady ? (
        <p className="ready">
          ✓ Your videos live in your own GitHub repos.{' '}
          {showsPrivate ? <span className="tag">showing private videos too</span>
            : <a className="link" href="/api/auth/login?private=1">Show my private videos too</a>}
        </p>
      ) : (
        <div className="guide" aria-labelledby="guide-h">
          <h2 id="guide-h" className="eyebrow">Set up · about 2 minutes, once</h2>
          <ol className="steps">
            <li className="done"><div><b>Sign in with GitHub</b>: done, you&apos;re @{login}.</div></li>
            <li><div>
              <b>Install the openVideo desktop app</b> (macOS or Windows).{' '}
              <a href={desktopUrl}>Download it</a>
            </div></li>
            <li><div>
              <b>Connect GitHub in the app:</b> click <i>Share</i> on a recording, then <i>Connect GitHub</i>. Your browser opens
              GitHub with a short code; check it matches the app and click <i>Authorize</i>. openVideo only uses that access
              for the repos it creates for your videos.
            </div></li>
            <li><div>
              <b>Click Share on any recording.</b> Pick your main <code>{GH_REPO}</code> repo or a new repo just for that video,
              and choose <b>public</b> or <b>private</b>. The link is copied for you. Recorded in the browser? Use <i>Add video</i> in the app first.
            </div></li>
          </ol>
          <p className="notice">
            Your videos are stored in <b>your</b> GitHub account, not on openVideo&apos;s servers, and they cost you nothing.
            <b>Public</b> repos: anyone with the link can watch. <b>Private</b> repos: only people you give access to on GitHub can watch.
          </p>
        </div>
      )}

      <div className="row-head">
        <h2 id="lib-h" className="eyebrow">Your videos</h2>
        {isReady && <a className="link" href={`${repoUrl}/releases`} target="_blank" rel="noopener noreferrer">Manage {GH_REPO} on GitHub →</a>}
      </div>
      {loadError && <p className="notice" role="alert">GitHub didn&apos;t answer just now. Reload in a minute.</p>}
      {isReady && videos.length === 0 && <p className="empty">Your repo is ready. Share a recording from the desktop app and it shows up here.</p>}
      {!isReady && !loadError && <p className="empty">Nothing yet. Finish the steps above.</p>}
      <ol className="list">
        {(videos ?? []).map((v) => {
          const path = watchPath(login, v.repo, v.tag);
          return (
            <li key={`${v.repo}/${v.tag}`}>
              <Link className="title" href={path}>{v.title}</Link>
              <span className="meta">{v.private && <span className="tag">🔒 private</span>} {fmtDate(v.createdAt)} · {fmtSize(v.size)}{v.repo !== GH_REPO && ` · ${v.repo}`}</span>
              <span className="acts">
                <CopyLink url={`${origin}${path}`} />
                <a className="link" href={v.manageUrl} target="_blank" rel="noopener noreferrer" title="Rename or delete on GitHub">Edit</a>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
