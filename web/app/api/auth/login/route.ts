import { cookies } from 'next/headers';
import { env } from '@/lib/env';
import { STATE_COOKIE } from '@/lib/session';

// GitHub OAuth (web flow). No scopes: the website only needs the public profile for identity.
export async function GET(req: Request) {
  const state = crypto.randomUUID();
  (await cookies()).set(STATE_COOKIE, state, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 600,
  });
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', env('GITHUB_CLIENT_ID'));
  url.searchParams.set('redirect_uri', new URL('/api/auth/callback', req.url).href);
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'true');
  return Response.redirect(url.href, 302);
}
