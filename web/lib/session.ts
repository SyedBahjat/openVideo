import { EncryptJWT, SignJWT, jwtDecrypt, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { env } from './env';

export interface User {
  uid: string;
  login: string;
  avatar: string;
}

const COOKIE = 'ov_session';
export const STATE_COOKIE = 'ov_oauth_state';
export const NEXT_COOKIE = 'ov_next';
const TOKEN_COOKIE = 'ov_gh';
const TOKEN_MAX_AGE_S = 60 * 60 * 8;
const MAX_AGE_S = 60 * 60 * 24 * 30;

function key(): Uint8Array {
  const secret = env('SESSION_SECRET');
  if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return new TextEncoder().encode(secret);
}

// The session only holds public profile fields. A GitHub token is kept ONLY when a viewer signs in to watch a
// private video: then it sits in its own encrypted, httpOnly cookie for 8 hours, and never reaches page JavaScript.
export async function setSession(user: User): Promise<void> {
  const jwt = await new SignJWT({ ...user }).setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt().setExpirationTime(`${MAX_AGE_S}s`).sign(key());
  (await cookies()).set(COOKIE, jwt, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: MAX_AGE_S,
  });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
  jar.delete(TOKEN_COOKIE);
}

// A separate key for encryption, derived from the same secret (never reuse one key for signing and encrypting).
async function tokenKey(): Promise<Uint8Array> {
  key(); // same length check
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ov-gh-token:${env('SESSION_SECRET')}`));
  return new Uint8Array(digest);
}

export async function setGithubToken(token: string): Promise<void> {
  const jwe = await new EncryptJWT({ t: token }).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt().setExpirationTime(`${TOKEN_MAX_AGE_S}s`).encrypt(await tokenKey());
  (await cookies()).set(TOKEN_COOKIE, jwe, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: TOKEN_MAX_AGE_S,
  });
}

export async function readGithubToken(): Promise<string | null> {
  const jwe = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (!jwe) return null;
  try {
    const { payload } = await jwtDecrypt(jwe, await tokenKey());
    return typeof payload.t === 'string' ? payload.t : null;
  } catch {
    return null; // expired or tampered
  }
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
