# openVideo web

Next.js 16 site. Users sign in with GitHub, follow a short setup guide, record in the browser (and download), see their videos, and share links. **Videos are never stored here.** Each user's videos live in their own public GitHub repo, `<login>/openvideo-recordings`, uploaded by the desktop app.

## Who does what

| Who | Does | How often |
|---|---|---|
| Site owner (you) | Creates one GitHub OAuth App, fills in `.env.local`, deploys | Once |
| Each user | Clicks *Sign in with GitHub* → *Authorize*; in the desktop app, *Connect GitHub* → *Authorize* | Once |

No database: a watch link `/v/gh/<owner>/<tag>` points straight at the owner's GitHub release, and the session is a signed cookie holding public profile fields only (no GitHub token is kept).

## Setup

1. **GitHub OAuth App** (Settings → Developer settings → OAuth Apps → New):
   - Homepage: your site URL. Callback: `<site>/api/auth/callback`.
   - Tick **Enable Device Flow**. The desktop app signs in with the same client ID; device flow needs no secret.
2. `cp .env.example .env.local` and fill it in, then:
   ```sh
   npm install
   npm run dev     # http://localhost:3000
   npm test
   npm run build
   ```
3. Put the same client ID and the deployed site URL in the desktop app's [`config.js`](../config.js), or set `OPENVIDEO_GITHUB_CLIENT_ID` / `OPENVIDEO_SITE_URL` when building.

## Browser recording

`getDisplayMedia` + `MediaRecorder` (H.264/AAC MP4 where supported, otherwise WebM). A tab can't draw over other apps, so the camera bubble is a **Picture-in-Picture** window: Document PiP in Chrome/Edge, video PiP in Safari. Recordings are downloaded. To share one, use *Add video* → *Share* in the desktop app.

## Known limits

- **No uploads from the browser.** `uploads.github.com` blocks cross-origin uploads, so the website can't save to GitHub directly.
- **GitHub-hosted videos are served as `application/octet-stream`.** Chrome and Firefox play them; Safari is unverified.
- **Pages that list or play videos call the GitHub API.** It allows 60 requests/hour per server IP unless you set `GITHUB_TOKEN` (no scopes) for 5,000/hour. Results are cached.
- **The user's repo is public.** That's what keeps storage free and lets links play for anyone. Both apps say so before the first share.
- **GitHub can still throttle or remove repos with excessive bandwidth** under its Acceptable Use Policy (section 9).
