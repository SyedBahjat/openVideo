import Link from 'next/link';
import { headers } from 'next/headers';
import { GH_REPO, type GhVideo } from '@/lib/github';
import { CopyLink } from './ClientActions';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en', { dateStyle: 'medium' });
const fmtSize = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${(b / 1e6).toFixed(1)} MB`);

type Props = { login: string; videos: GhVideo[] | null; loadError: boolean };

/** Setup guide (until the user's repo exists) + their videos, read from their own GitHub repo. */
export default async function YourVideos({ login, videos, loadError }: Props) {
  const h = await headers();
  const origin = `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host')}`;
  const repoUrl = `https://github.com/${login}/${GH_REPO}`;
  const isReady = videos !== null;
  const desktopUrl = process.env.DESKTOP_DOWNLOAD_URL;

  return (
    <section className="library" aria-labelledby="lib-h">
      {isReady ? (
        <p className="ready">✓ Saving to <a href={repoUrl} target="_blank" rel="noopener noreferrer">github.com/{login}/{GH_REPO}</a> <span className="tag">public</span></p>
      ) : (
        <div className="guide" aria-labelledby="guide-h">
          <h2 id="guide-h" className="eyebrow">Set up · about 2 minutes, once</h2>
          <ol className="steps">
            <li className="done"><div><b>Sign in with GitHub</b>: done, you&apos;re @{login}.</div></li>
            <li><div>
              <b>Install the openVideo desktop app</b> (macOS or Windows).{' '}
              {desktopUrl && <a href={desktopUrl}>Download it</a>}
            </div></li>
            <li><div>
              <b>Connect GitHub in the app:</b> open <i>Sharing</i> → <i>Connect GitHub</i>. Your browser opens GitHub with a
              short code; check it matches the app and click <i>Authorize</i>. GitHub will ask to let openVideo create public
              repositories. It uses that only for your <code>{GH_REPO}</code> repo.
            </div></li>
            <li><div>
              <b>Click Share on any recording.</b> The first share creates <code>github.com/{login}/{GH_REPO}</code> in your
              account and copies the link. Every later share is one click. Recorded in the browser? Use <i>Add video</i> in the app first.
            </div></li>
          </ol>
          <p className="notice">
            Your videos are stored in <b>your</b> GitHub account, not on openVideo&apos;s servers, and they cost you nothing.
            The repo is <b>public</b>: anyone who finds it can watch your videos. Don&apos;t record anything private.
          </p>
        </div>
      )}

      <div className="row-head">
        <h2 id="lib-h" className="eyebrow">Your videos</h2>
        {isReady && <a className="link" href={`${repoUrl}/releases`} target="_blank" rel="noopener noreferrer">Manage on GitHub →</a>}
      </div>
      {loadError && <p className="notice" role="alert">GitHub didn&apos;t answer just now. Reload in a minute.</p>}
      {isReady && videos.length === 0 && <p className="empty">Your repo is ready. Share a recording from the desktop app and it shows up here.</p>}
      {!isReady && !loadError && <p className="empty">Nothing yet. Finish the steps above.</p>}
      <ol className="list">
        {(videos ?? []).map((v) => {
          const path = `/v/gh/${login}/${v.tag}`;
          return (
            <li key={v.tag}>
              <Link className="title" href={path}>{v.title}</Link>
              <span className="meta">{fmtDate(v.createdAt)} · {fmtSize(v.size)}</span>
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
