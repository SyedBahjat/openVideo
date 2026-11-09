# Contributing to openVideo

Thanks for helping. This guide gets you from clone to pull request.

## Setup

```sh
git clone https://github.com/SyedBahjat/openVideo.git && cd openVideo
npm install && npm start             # desktop app
cd web && npm install && npm run dev # website on http://localhost:3000
```

The website needs `web/.env.local` (copy `web/.env.example`). For local sign-in, create a GitHub OAuth App with callback `http://localhost:3000/api/auth/callback`.

On macOS, give the dev build ("Electron") Screen Recording permission in System Settings → Privacy & Security, then restart it.

## Before you open a PR

```sh
npm test                                   # desktop
cd web && npm test && npx eslint . && npx next typegen && npx tsc --noEmit && npm run build
```

CI runs the same checks.

## Ground rules

- **Keep it small.** Prefer the platform (Chromium capture, `MediaRecorder`, Electron APIs) over new dependencies. Every dependency needs a reason in the PR.
- **Validate at trust boundaries.** Anything from a renderer, a URL, or GitHub gets checked in `lib.js` / `web/lib/validate.ts`, with a test.
- **Never log or commit tokens.** GitHub tokens stay encrypted on disk (desktop) and are never stored by the website.
- **Commit messages** use the [Conventional Commits](https://www.conventionalcommits.org/) style: `feat: …`, `fix: …`, `docs: …`.
- **UI changes** need a screenshot in the PR, in both light and dark themes.

## Where things live

| Path | What |
|---|---|
| `main.js` | windows, capture-source routing, writing chunks to disk, IPC |
| `renderer/` | panel, camera bubble, control bar, countdown, drawing overlay |
| `share.js` | GitHub device-flow sign-in and release uploads |
| `web/app/` | pages, the browser recorder, watch pages |
| `web/lib/` | session, GitHub API, validation |
