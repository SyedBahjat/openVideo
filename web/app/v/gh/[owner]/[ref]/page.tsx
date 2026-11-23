import type { Metadata } from 'next';
import { GH_REPO } from '@/lib/github';
import VideoPage, { videoMetadata } from '../../../VideoPage';

// Short links /v/gh/<owner>/<tag>: videos in the main openvideo-recordings repo.
export async function generateMetadata(props: PageProps<'/v/gh/[owner]/[ref]'>): Promise<Metadata> {
  const { owner, ref } = await props.params;
  return videoMetadata({ owner, repo: GH_REPO, tag: ref });
}

export default async function Page(props: PageProps<'/v/gh/[owner]/[ref]'>) {
  const { owner, ref } = await props.params;
  return <VideoPage owner={owner} repo={GH_REPO} tag={ref} />;
}
