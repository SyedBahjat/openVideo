import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { env } from './env';

export interface User {
  uid: string;
  login: string;
  avatar: string;
}

const COOKIE = 'ov_session';
export const STATE_COOKIE = 'ov_oauth_state';
const MAX_AGE_S = 60 * 60 * 24 * 30;

function key(): Uint8Array {
  const secret = env('SESSION_SECRET');
  if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return new TextEncoder().encode(secret);
}

// The session only holds public profile fields. The web flow never keeps a GitHub token.
export async function setSession(user: User): Promise<void> {
  const jwt = await new SignJWT({ ...user }).setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt().setExpirationTime(`${MAX_AGE_S}s`).sign(key());
  (await cookies()).set(COOKIE, jwt, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: MAX_AGE_S,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function readSession(): Promise<User | null> {
  const jwt = (await cookies()).get(COOKIE)?.value;
  if (!jwt) return null;
  try {
    const { payload } = await jwtVerify(jwt, key(), { algorithms: ['HS256'] });
    const { uid, login, avatar } = payload as Record<string, unknown>;
    return typeof uid === 'string' && typeof login === 'string'
      ? { uid, login, avatar: typeof avatar === 'string' ? avatar : '' } : null;
  } catch {
    return null; // expired or tampered
  }
}
