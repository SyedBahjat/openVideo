import type { Metadata } from 'next';
import VideoPage, { videoMetadata } from '../../../../VideoPage';

// /v/gh/<owner>/<repo>/<tag>: videos saved to any other openVideo repo (e.g. "a new repo just for this video").
export async function generateMetadata(props: PageProps<'/v/gh/[owner]/[ref]/[id]'>): Promise<Metadata> {
  const { owner, ref, id } = await props.params;
  return videoMetadata({ owner, repo: ref, tag: id });
}

export default async function Page(props: PageProps<'/v/gh/[owner]/[ref]/[id]'>) {
  const { owner, ref, id } = await props.params;
  return <VideoPage owner={owner} repo={ref} tag={id} />;
}
