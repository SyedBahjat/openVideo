import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GH_REPO, githubVideo } from '@/lib/github';
import Watch from '../../../Watch';

const load = cache(githubVideo); // validates owner + tag before calling GitHub

export async function generateMetadata(props: PageProps<'/v/gh/[owner]/[id]'>): Promise<Metadata> {
  const { owner, id } = await props.params;
  const v = await load(owner, id);
  return { title: v?.title ?? 'Video not found' };
}

// Video bytes stream straight from GitHub's release CDN; this server only renders the page.
export default async function Page(props: PageProps<'/v/gh/[owner]/[id]'>) {
  const { owner, id } = await props.params;
  const v = await load(owner, id);
  if (!v) notFound();
  const storage = (
    <a href={`https://github.com/${owner}/${GH_REPO}/releases/tag/${id}`} target="_blank" rel="noopener noreferrer">stored on GitHub</a>
  );
  return <Watch title={v.title} by={owner} createdAt={v.createdAt} src={v.src} path={`/v/gh/${owner}/${id}`} storage={storage} />;
}
