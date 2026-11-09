// Liveness probe for uptime monitors and local process managers.
export function GET() {
  return Response.json({ ok: true });
}
