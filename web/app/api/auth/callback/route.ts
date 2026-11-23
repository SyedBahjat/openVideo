import { cookies } from 'next/headers';
import { env } from '@/lib/env';
import { githubUser } from '@/lib/github';
import { NEXT_COOKIE, setGithubToken, setSession, STATE_COOKIE } from '@/lib/session';
import { isSafeNext } from '@/lib/validate';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value;
  jar.delete(STATE_COOKIE);
  const next = jar.get(NEXT_COOKIE)?.value ?? '';
  jar.delete(NEXT_COOKIE);
  const home = (q = '') => Response.redirect(new URL(`/${q}`, req.url).href, 302);

  const code = url.searchParams.get('code');
  if (!code || !expected || url.searchParams.get('state') !== expected) return home('?error=login');

  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env('GITHUB_CLIENT_ID'), client_secret: env('GITHUB_CLIENT_SECRET'), code }),
    });
    const { access_token: token, scope = '' } = (await res.json()) as { access_token?: string; scope?: string };
    const user = token ? await githubUser(token) : null;
    if (!user) return home('?error=login');
    await setSession(user);
    // Keep the token only if the viewer granted private-repo access to watch a private video; otherwise drop it.
    if (scope.split(/[ ,]/).includes('repo')) await setGithubToken(token as string);
    return isSafeNext(next) ? Response.redirect(new URL(next, req.url).href, 302) : home();
  } catch (err) {
    console.error('[openVideo auth]', err);
    return home('?error=login');
  }
}
