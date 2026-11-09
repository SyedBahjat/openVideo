// Pure input validation, no Next/Node imports, so it is unit-testable with `node --test`.

export const ID_RE = /^[A-Za-z0-9_-]{16}$/; // release tags created by the desktop app
export const GH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const isValidVideoRef = (owner: string, tag: string): boolean => GH_OWNER_RE.test(owner) && ID_RE.test(tag);
