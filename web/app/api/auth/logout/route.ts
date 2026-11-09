import { clearSession } from '@/lib/session';

// POST so a cross-site <img src> cannot log people out.
export async function POST(req: Request) {
  await clearSession();
  return Response.redirect(new URL('/', req.url).href, 303);
}
