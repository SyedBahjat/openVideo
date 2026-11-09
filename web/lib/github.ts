import type { User } from './session';
import { GH_OWNER_RE, isValidVideoRef } from './validate';

// Every user's videos live in THEIR OWN public repo, created by the desktop app on first share.
export const GH_REPO = 'openvideo-recordings';
const API = 'https://api.github.com';
const BASE_HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'openVideo' };

// ponytail: unauthenticated GitHub API = 60 req/h per server IP; set GITHUB_TOKEN (no scopes) for 5000/h.
function serverHeaders(): Record<string, string> {
  const h: Record<string, string> = { ...BASE_HEADERS };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

export async function githubUser(token: string): Promise<User | null> {
  const res = await fetch(`${API}/user`, { headers: { ...BASE_HEADERS, Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) return null;
  const u = (await res.json()) as { id: number; login: string; avatar_url: string };
  return { uid: String(u.id), login: u.login, avatar: u.avatar_url };
}

interface Release {
  tag_name: string;
  name: string | null;
  created_at: string;
  html_url: string;
  assets: { name: string; size: number; browser_download_url: string }[];
}

export interface GhVideo {
  tag: string;
  title: string;
  src: string;
  createdAt: string;
  size: number;
  manageUrl: string;
}

function toVideo(rel: Release): GhVideo | null {
  const asset = rel.assets.find((a) => /\.(mp4|webm)$/i.test(a.name));
  if (!asset) return null;
  return { tag: rel.tag_name, title: rel.name || 'openVideo recording', src: asset.browser_download_url,
    createdAt: rel.created_at, size: asset.size, manageUrl: rel.html_url };
}

export async function githubVideo(owner: string, tag: string): Promise<GhVideo | null> {
  if (!isValidVideoRef(owner, tag)) return null;
  const res = await fetch(`${API}/repos/${owner}/${GH_REPO}/releases/tags/${tag}`, { headers: serverHeaders(), next: { revalidate: 300 } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${res.status} while loading ${owner}/${tag}`);
  return toVideo((await res.json()) as Release);
}

/** null = the user hasn't set up their repo yet (never shared from the desktop app). */
export async function githubVideos(owner: string): Promise<GhVideo[] | null> {
  if (!GH_OWNER_RE.test(owner)) return null;
  const res = await fetch(`${API}/repos/${owner}/${GH_REPO}/releases?per_page=100`, { headers: serverHeaders(), next: { revalidate: 30 } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${res.status} while listing ${owner}'s videos`);
  return ((await res.json()) as Release[]).map(toVideo).filter((v): v is GhVideo => v !== null);
}
