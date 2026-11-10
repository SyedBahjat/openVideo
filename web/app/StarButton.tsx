export const PROJECT_REPO = 'SyedBahjat/openVideo';
export const PROJECT_URL = `https://github.com/${PROJECT_REPO}`;
export const desktopDownloadUrl = () => process.env.DESKTOP_DOWNLOAD_URL || `${PROJECT_URL}/releases/latest`;

async function starCount(): Promise<number | null> {
  try {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'openVideo' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${PROJECT_REPO}`, { headers, next: { revalidate: 3600 } });
    if (!res.ok) return null;
    return ((await res.json()) as { stargazers_count: number }).stargazers_count;
  } catch {
    return null; // the button still works without a count
  }
}

/** "★ Star on GitHub · 42": links to the repo; starring itself happens on GitHub. */
export default async function StarButton({ compact = false }: { compact?: boolean }) {
  const count = await starCount();
  return (
    <a className={`star${compact ? ' compact' : ''}`} href={PROJECT_URL} target="_blank" rel="noopener noreferrer"
      aria-label={`Star openVideo on GitHub${count !== null ? ` (${count} stars)` : ''}`}>
      <span aria-hidden="true">★</span> {compact ? 'Star' : 'Star on GitHub'}
      {count !== null && count > 0 && <span className="star-count">{count.toLocaleString('en')}</span>}
    </a>
  );
}
