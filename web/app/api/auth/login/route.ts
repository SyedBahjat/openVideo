import { cookies } from 'next/headers';
import { env } from '@/lib/env';
import { NEXT_COOKIE, STATE_COOKIE } from '@/lib/session';
import { isSafeNext } from '@/lib/validate';

// GitHub OAuth (web flow). Normally no scopes: the website only needs the public profile for identity.
// ?private=1 asks for "repo" so a viewer can watch a private video they have access to; ?next= returns them to it.
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const state = crypto.randomUUID();
  const jar = await cookies();
  const short = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', maxAge: 600 };
  jar.set(STATE_COOKIE, state, short);
  const next = params.get('next') ?? '';
  if (isSafeNext(next)) jar.set(NEXT_COOKIE, next, short); else jar.delete(NEXT_COOKIE);
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', env('GITHUB_CLIENT_ID'));
  url.searchParams.set('redirect_uri', new URL('/api/auth/callback', req.url).href);
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'true');
  if (params.get('private') === '1') url.searchParams.set('scope', 'repo');
  return Response.redirect(url.href, 302);
}
