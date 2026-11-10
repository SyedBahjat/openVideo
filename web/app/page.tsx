import Image from 'next/image';
import { githubVideos, type GhVideo } from '@/lib/github';
import { readSession } from '@/lib/session';
import Recorder from './Recorder';
import StarButton, { desktopDownloadUrl } from './StarButton';
import YourVideos from './YourVideos';

export default async function Home(props: PageProps<'/'>) {
  const user = await readSession();
  const { error } = await props.searchParams;
  const desktopUrl = desktopDownloadUrl();

  if (!user) {
    return (
      <main className="landing">
        <p className="wordmark big">open<em>Video</em></p>
        <h1>Record your screen and face.<br />Send a link.</h1>
        <p className="lede">Open-source async video. Your recordings are stored in your own GitHub account, so they&apos;re free and they stay yours.</p>
        {error === 'login' && <p className="notice" role="alert">GitHub sign-in didn&apos;t complete. Try again.</p>}
        <div className="row">
          <a className="rec" href="/api/auth/login"><span className="dot" aria-hidden="true" />Sign in with GitHub</a>
          <a className="ghost" href={desktopUrl}>Get the desktop app</a>
          <StarButton />
        </div>
        <p className="hint">Free and open source (MIT). If it helps you, a star helps other people find it.</p>
      </main>
    );
  }

  let videos: GhVideo[] | null = null;
  let loadError = false;
  try {
    videos = await githubVideos(user.login);
  } catch (err) {
    console.error('[openVideo videos]', err);
    loadError = true;
  }

  return (
    <>
      <header className="masthead wrap">
        <span className="wordmark">open<em>Video</em></span>
        <div className="who">
          <StarButton compact />
          {user.avatar && <Image src={user.avatar} alt="" width={28} height={28} className="avatar" unoptimized />}
          <span>@{user.login}</span>
          <form action="/api/auth/logout" method="post"><button type="submit" className="link">Sign out</button></form>
        </div>
      </header>
      <main className="wrap dash">
        <Recorder hasDesktopSetup={videos !== null} />
        <YourVideos login={user.login} videos={videos} loadError={loadError} />
      </main>
    </>
  );
}
