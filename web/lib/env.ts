/** Read a required env var or fail with a message that names it. */
export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. See web/.env.example.`);
  return v;
}
