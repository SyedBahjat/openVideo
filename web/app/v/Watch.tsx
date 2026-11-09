import Link from 'next/link';
import { headers } from 'next/headers';
import { CopyLink } from '../ClientActions';

type Props = { title: string; by: string; createdAt: string; src: string; path: string; storage: React.ReactNode };

/** Watch page for a video stored in its owner's GitHub. */
export default async function Watch({ title, by, createdAt, src, path, storage }: Props) {
  const h = await headers();
  const url = `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host')}${path}`;
  return (
    <main className="watch">
      <header className="masthead">
        <Link href="/" className="wordmark">open<em>Video</em></Link>
      </header>
      <video className="player" src={src} controls playsInline preload="metadata" />
      <div className="watch-meta">
        <div>
          <h1>{title}</h1>
          <p className="meta">
            {by && <>by <a href={`https://github.com/${by}`} target="_blank" rel="noopener noreferrer">@{by}</a> · </>}
            {new Date(createdAt).toLocaleDateString('en', { dateStyle: 'long' })} · {storage}
          </p>
        </div>
        <CopyLink url={url} />
      </div>
    </main>
  );
}
