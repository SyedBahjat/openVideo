# Security

Please report vulnerabilities **privately** through [GitHub security advisories](https://github.com/SyedBahjat/openVideo/security/advisories/new), not in public issues. You'll get a reply within a few days.

## What openVideo protects

- **GitHub tokens (desktop):** requested with the `public_repo` scope only, and stored encrypted with the OS keychain via Electron `safeStorage`. They're never written in plain text and never sent anywhere except `api.github.com` / `uploads.github.com`.
- **Website sessions:** a signed, `httpOnly`, `SameSite=Lax` cookie holding public profile fields only. The website never stores a GitHub token. OAuth uses a `state` cookie against CSRF.
- **File access (desktop):** the renderer can only name files inside the recordings folder. Names are validated against path traversal (`lib.js`, with tests).
- **Website headers:** a nonce-based Content-Security-Policy, HSTS, `X-Frame-Options: DENY`, `nosniff`, and a strict `Permissions-Policy`.

## Out of scope

Shared videos are stored in a **public** GitHub repo by design, so anyone can watch them. This is documented in both apps before the first share.
