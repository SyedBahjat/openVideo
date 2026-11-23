import type { User } from './session';
import { GH_OWNER_RE, isValidRepo, isValidVideoRef } from './validate';

// Every user's videos live in THEIR OWN repos, created by the desktop app: the main openvideo-recordings repo and any
// repo tagged with the "openvideo" topic. Each can be public or private.
export const GH_REPO = 'openvideo-recordings';
const TOPIC = 'openvideo';
const API = 'https://api.github.com';
const BASE_HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'openVideo' };

// ponytail: unauthenticated GitHub API = 60 req/h per server IP; set GITHUB_TOKEN (no scopes) for 5000/h.
function serverHeaders(): Record<string, string> {
  const h: Record<string, string> = { ...BASE_HEADERS };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

// A viewer's own token (private videos) is never cached across users.
const viewerInit = (token: string): RequestInit => ({ headers: { ...BASE_HEADERS, Authorization: `Bearer ${token}` }, cache: 'no-store' });

export async function githubUser(token: string): Promise<User | null> {
  const res = await fetch(`${API}/user`, { headers: { ...BASE_HEADERS, Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) return null;
  const u = (await res.json()) as { id: number; login: string; avatar_url: string };
  return { uid: String(u.id), login: u.login, avatar: u.avatar_url };
}

interface Release {
  tag_name: string;
  name: string | null;
  created_at: string; // the tagged commit's date: for openVideo repos that's when the repo was created
  published_at: string | null; // when the video was shared
  html_url: string;
  assets: { name: string; size: number; url: string; browser_download_url: string }[];
}

export interface GhVideo {
  repo: string;
  private: boolean;
  tag: string;
  title: string;
  src: string;
  createdAt: string;
  size: number;
  manageUrl: string;
}

const videoAsset = (rel: Release) => rel.assets.find((a) => /\.(mp4|webm)$/i.test(a.name));

/** Path that plays a video; private ones go through /api/media, which hands out a fresh short-lived GitHub link. */
export const mediaPath = (owner: string, repo: string, tag: string) => `/api/media/${owner}/${repo}/${tag}`;
export const watchPath = (owner: string, repo: string, tag: string) => (repo === GH_REPO ? `/v/gh/${owner}/${tag}` : `/v/gh/${owner}/${repo}/${tag}`);

function toVideo(rel: Release, owner: string, repo: string, isPrivate: boolean): GhVideo | null {
  const asset = videoAsset(rel);
  if (!asset) return null;
  return { repo, private: isPrivate, tag: rel.tag_name, title: rel.name || 'openVideo recording',
    src: isPrivate ? mediaPath(owner, repo, rel.tag_name) : asset.browser_download_url,
    createdAt: rel.published_at ?? rel.created_at, size: asset.size, manageUrl: rel.html_url };
}

async function release(owner: string, repo: string, tag: string, token?: string): Promise<Release | null> {
  const init: RequestInit = token ? viewerInit(token) : { headers: serverHeaders(), next: { revalidate: 300 } };
  const res = await fetch(`${API}/repos/${owner}/${repo}/releases/tags/${tag}`, init);
  if (res.status === 404 || (token && res.status === 403)) return null;
  if (!res.ok) throw new Error(`GitHub API ${res.status} while loading ${owner}/${repo}/${tag}`);
  return (await res.json()) as Release;
}

/**
 * A public video loads for anyone. Without a token a private one looks exactly like a missing one (GitHub answers 404),
 * so pass the viewer's token to try again as them. Returns null if it doesn't exist or they can't see it.
 */
export async function githubVideo(owner: string, tag: string, repo: string = GH_REPO, token?: string): Promise<GhVideo | null> {
  if (!isValidVideoRef(owner, tag) || !isValidRepo(repo)) return null;
  const pub = await release(owner, repo, tag);
  if (pub) return toVideo(pub, owner, repo, false);
  if (!token) return null;
  const priv = await release(owner, repo, tag, token);
  return priv ? toVideo(priv, owner, repo, true) : null;
}

/**
 * Where to fetch a video's bytes from: the public download URL, or for a private video the viewer's signed URL.
 * `type` comes from the file name, because GitHub labels every release asset application/octet-stream.
 */
export async function videoSource(owner: string, repo: string, tag: string, token?: string): Promise<{ url: string; type: string } | null> {
  if (!isValidVideoRef(owner, tag) || !isValidRepo(repo)) return null;
  const pub = await release(owner, repo, tag);
  const asset = pub && videoAsset(pub);
  const type = (name: string) => (/\.webm$/i.test(name) ? 'video/webm' : 'video/mp4');
  if (asset) return { url: asset.browser_download_url, type: type(asset.name) };
  if (!token) return null;
  const priv = await release(owner, repo, tag, token);
  const pa = priv && videoAsset(priv);
  const signed = pa && (await signedVideoUrl(owner, repo, tag, token));
  return pa && signed ? { url: signed, type: type(pa.name) } : null;
}

/** GitHub redirects an authorised asset download to a signed URL that expires after about an hour. */
export async function signedVideoUrl(owner: string, repo: string, tag: string, token: string): Promise<string | null> {
  if (!isValidVideoRef(owner, tag) || !isValidRepo(repo)) return null;
  const rel = await release(owner, repo, tag, token);
  const asset = rel && videoAsset(rel);
  if (!asset) return null;
  const res = await fetch(asset.url, {
    headers: { ...BASE_HEADERS, Accept: 'application/octet-stream', Authorization: `Bearer ${token}` }, redirect: 'manual', cache: 'no-store',
  });
  return res.headers.get('location');
}

interface Repo { name: string; private: boolean; topics?: string[]; owner: { login: string } }

const MAX_REPOS = 20; // ponytail: one releases call per repo; paginate if people make hundreds of video repos

/**
 * All of the owner's openVideo videos, newest first. With the owner's own token (they signed in for private videos)
 * private repos are included. null = no openVideo repo yet (never shared from the desktop app).
 */
export async function githubVideos(owner: string, token?: string): Promise<GhVideo[] | null> {
  if (!GH_OWNER_RE.test(owner)) return null;
  const init: RequestInit = token ? viewerInit(token) : { headers: serverHeaders(), next: { revalidate: 30 } };
  const listUrl = token ? `${API}/user/repos?affiliation=owner&sort=created&per_page=100` : `${API}/users/${owner}/repos?sort=created&per_page=100`;
  const res = await fetch(listUrl, init);
  if (!res.ok) throw new Error(`GitHub API ${res.status} while listing ${owner}'s repos`);
  const repos = ((await res.json()) as Repo[])
    .filter((r) => r.owner.login.toLowerCase() === owner.toLowerCase() && (r.name === GH_REPO || (r.topics ?? []).includes(TOPIC)))
    .slice(0, MAX_REPOS);
  if (!repos.length) return null;
  const lists = await Promise.all(repos.map(async (r) => {
    const rr = await fetch(`${API}/repos/${owner}/${r.name}/releases?per_page=100`, init);
    if (!rr.ok) return [];
    return ((await rr.json()) as Release[]).map((rel) => toVideo(rel, owner, r.name, r.private));
  }));
  return lists.flat().filter((v): v is GhVideo => v !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
