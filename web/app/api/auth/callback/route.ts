import { cookies } from 'next/headers';
import { env } from '@/lib/env';
import { githubUser } from '@/lib/github';
import { setSession, STATE_COOKIE } from '@/lib/session';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value;
  jar.delete(STATE_COOKIE);
  const home = (q = '') => Response.redirect(new URL(`/${q}`, req.url).href, 302);

  const code = url.searchParams.get('code');
  if (!code || !expected || url.searchParams.get('state') !== expected) return home('?error=login');

  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env('GITHUB_CLIENT_ID'), client_secret: env('GITHUB_CLIENT_SECRET'), code }),
    });
    const { access_token: token } = (await res.json()) as { access_token?: string };
    const user = token ? await githubUser(token) : null;
    if (!user) return home('?error=login');
    await setSession(user); // the token is dropped here on purpose
    return home();
  } catch (err) {
    console.error('[openVideo auth]', err);
    return home('?error=login');
  }
}
