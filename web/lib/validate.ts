// Pure input validation, no Next/Node imports, so it is unit-testable with `node --test`.

export const ID_RE = /^[A-Za-z0-9_-]{16}$/; // release tags created by the desktop app
export const GH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const isValidVideoRef = (owner: string, tag: string): boolean => GH_OWNER_RE.test(owner) && ID_RE.test(tag);

// GitHub repo names: letters, digits, - _ . (never "." or ".." alone).
export const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const isValidRepo = (repo: string): boolean => REPO_RE.test(repo) && repo !== '.' && repo !== '..';

// Where the login flow may send people back to: only watch pages, never another site.
export const isSafeNext = (next: string): boolean => /^\/v\/gh\/[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+){1,2}$/.test(next);
