# YT Video Queue

**v1.7.0** — a personal, passkey-protected watch queue for YouTube, Telegram and
any other web video link.

Add links into ordered **series**, watch them **one by one**, and have the next
video queued automatically when one finishes. Progress is saved, so you resume
anywhere. Login is **passkey-only** (WebAuthn) — no passwords — and by default
only **your** passkey opens it.

- Static UI on **GitHub Pages**
- Data in **Turso** (libSQL)
- A tiny API on **Cloudflare Workers** that holds the secrets and verifies passkeys

---

## Features

**Watching**
- **Any source.** YouTube links play in the built-in player; Telegram posts
  (`t.me/…`) are embedded; any other web link opens in a new tab, because most
  sites refuse to be framed. Titles, thumbnails and site names are read from the
  page automatically.
- **Tap a title to open it at the source.** In the series list, each title is a
  link to its original page, so on a phone it hands off to the installed app — a
  YouTube title opens in the YouTube app, a Telegram title in Telegram, and so
  on. Private Telegram channels (`t.me/c/…`) cannot be embedded at all, so those
  go straight to the app instead of showing a broken frame.
- If a page can't be read — blocked, timed out, no title, a bot wall — the row is
  still named, from the link itself ("t.me · SomeChannel post 123"), and tagged
  **auto** so you know it was guessed and can rename it.
- Ordered series; the player walks the queue and auto-advances when a video ends.
- Resume where you left off — playback position is saved every few seconds.
- `Prev` / `Next`, and a **Mark done & next** button that always advances.
- **Auto-advance** toggle.
- Watched videos are kept in a collapsed **Watched (n)** section rather than
  being lost; replay, un-watch, rename or delete any of them.

**Series progress and insights**
- Progress bars on each series card and on the series page show the number and
  percentage watched, plus how many videos remain. **Continue watching** starts
  with an in-progress video when one exists.
- The series insights sidebar shows video counts, in-progress videos, total
  length, estimated watched time, remaining time, average length, longest video
  and source breakdown. Completed videos count as fully watched; the saved
  resume position contributes to watched time for unfinished videos.
- Time totals use **known durations only** and state how many videos are
  missing a duration. A YouTube video can get its duration during import, from
  **Find missing durations**, or when played. For any source, use the video's
  time button to set or clear its duration manually.

**Importing and syncing YouTube playlists**
- Import a public or unlisted YouTube playlist by URL or playlist ID; optionally
  override its title. Private playlists are not supported. Imports are limited
  to **500 playlist entries**, including duplicate and unavailable entries.
- Linked series have **Refresh playlist**, a source link, a last-synced time,
  error reporting and an auto-sync toggle. Automatic checks normally happen
  about every six hours, even when the app is closed.
- Sync appends new, available videos in playlist order. It never overwrites
  existing titles, custom durations, watch progress or ordering, and never
  removes a video just because it disappeared from YouTube. Duplicate entries
  are imported once; a video you remove from the series stays removed unless you
  choose **Restore removed**, which appends it again as unwatched. Private or
  unavailable videos are skipped and can be added on a later refresh if they
  become available.
- This feature and bulk YouTube duration lookup require the optional **YouTube
  Data API key** described below. Regular series, playback and manually set
  durations work without it.

**Organising**
- **Link to any series.** Every series has its own URL (`#/s/…`) — bookmark it,
  share it, and the browser back button works. The 🔗 Link button copies it.
- **Rename** any video or series.
- **Multi-select** (the *Select* button) with **Rename**, **Mark watched**,
  **Delete** and **Clear**.
- **Rename works like PowerRename**: *Search for* / *Replace with*, plus
  *Use regular expressions* (with `$1`, `$2` … and `$&` capture references),
  *Match all occurrences*, *Case sensitive* and *Enumerate items*.
  - Counters: `${}` (starts at 0), `${start=1}`, `${padding=3}`,
    `${increment=2}` — combine them with `;`, e.g. `${start=10;increment=2;padding=4}`.
  - Date & time: `$YYYY $YY $Y $MMMM $MMM $MM $M $DDDD $DDD $DD $D $HH $hh $TT $tt $mm $ss $fff`,
    and `$$` for a literal `$`.
  - Text formatting: lowercase / UPPERCASE / Title Case / Capitalize Each Word.
  - Older aliases `{title} {n} {1} {n:2} {total}` still work.
- A **live preview table** shows Original → Renamed with the changed part
  highlighted, a *Show only renamed* filter, a count, and a checkbox on every
  row so you can leave individual items out.
- **Undo** restores the previous titles after applying.
- Reorder with ↑ / ↓.

**Exporting a series as a playlist**
- **Open as YouTube playlist** — opens a temporary YouTube playlist of the series.
- **Copy links**, or download **.txt**, **.csv** or **.json**.
- Choose the scope: **all videos (watched + unwatched)**, unwatched only, or
  watched only.

**Look & feel**
- Claude-style warm theme: cream canvas, warm near-black dark mode, a single
  clay accent and serif headings. Light/dark/system toggle.
- **View modes** like Windows Explorer: thumbnail **grid**, **compact** rows with
  thumbnails, or a plain **list**.
- Real **thumbnails** on every row — the page's `og:image`, or the YouTube
  still, or a neutral tile.
- Responsive for phone, tablet and desktop.

---

## Browser extension

The unpacked Chrome extension in [`extension/`](extension/) adds a floating
YouTube save panel, a toolbar popup, `Alt+Q`, duplicate detection, and series
progress/time insights. Import a full public or unlisted playlist as a linked
series, refresh it or change auto-sync; alternatively, add only the videos
currently visible on the page to an existing series. Full playlist features
require this version of the Worker and the optional server-side YouTube API key.
See [extension/README.md](extension/README.md) for loading it unpacked, connection
setup, permissions and limits.

---

## Architecture

```
GitHub Pages (static: index.html, app.js, player.js)
        |  fetch() with Authorization: Bearer <session token>
        v
Cloudflare Worker  (holds the Turso token; verifies passkeys)
        |  @libsql/client/web over HTTPS
        v
Turso (libSQL)
```

GitHub Pages cannot keep secrets or verify WebAuthn signatures, so a small
serverless API is required. The browser only ever sees a short-lived session
token.

```
yt-video-queue/
├─ frontend/                 # published to GitHub Pages
│  ├─ index.html
│  ├─ app.js                 # SPA controller (auth, series, player, export)
│  ├─ player.js              # YouTube IFrame player + completion detection
│  ├─ analytics.mjs           # progress and watch-time calculations
│  ├─ styles.css
│  ├─ config.js             # API_BASE_URL (written at deploy time)
│  └─ vendor/               # simplewebauthn.js, vendored (~9 KB, no CDN)
├─ api/                      # Cloudflare Worker
│  ├─ src/index.ts           # router + CORS
│  ├─ src/auth.ts            # WebAuthn register/login + sessions
│  ├─ src/data.ts            # series + videos CRUD
│  ├─ src/playlists.ts       # atomic imports, sync leases and scheduled checks
│  ├─ src/durations.ts       # paged lookup of missing YouTube durations
│  ├─ src/youtube.ts         # YouTube Data API and duration parsing
│  ├─ src/meta.ts            # link classification, title/thumbnail lookup
│  ├─ src/session.ts         # opaque DB-backed sessions
│  ├─ src/db.ts              # libSQL client + schema (auto-created)
│  ├─ src/util.ts · types.ts
│  ├─ wrangler.toml
│  └─ package.json
├─ schema.sql
└─ .github/workflows/        # deploy-pages.yml + deploy-api.yml
```

---

## Performance

The first paint does as little as possible:

- **No third-party CDN.** The passkey helper is vendored at
  `frontend/vendor/simplewebauthn.js` (~9 KB) instead of being fetched from a
  CDN, and it is only loaded when you actually sign in.
- **YouTube's player script is loaded lazily.** It is a large third-party script
  and is now fetched only when you play a video, not on page load.
- **One API call at startup.** `GET /auth/status` reports both whether
  registration is open and whether your session is still valid, so a signed-in
  visitor makes a single round trip instead of two.
- **Preconnect to the Worker** is injected into the HTML at deploy time, so its
  TLS handshake overlaps the rest of the page load.
- Thumbnails use `loading="lazy"`, and every font is a system font — no webfonts.

The application styles, scripts and analytics helpers are served from the same
origin and cached by GitHub Pages.

---

## Setup

### 1. Create the Turso database

```bash
# install the Turso CLI: https://docs.turso.tech/cli/installation
turso auth login
turso db create yt-video-queue
turso db show yt-video-queue --url          # -> TURSO_DB_URL
turso db tokens create yt-video-queue       # -> TURSO_DB_AUTH_TOKEN
```

You do **not** need to create the tables by hand — the Worker creates them the
first time it is called. (You can also run `turso db shell yt-video-queue < schema.sql`
or `POST /admin/init` if you prefer.)

### 2. Get a Cloudflare API token

Dashboard → My Profile → API Tokens → Create Token → template
**"Edit Cloudflare Workers"**. Note your **Account ID** from Workers & Pages →
Account details.

### 3. Set GitHub secrets and variables

Settings → **Secrets and variables** → **Actions**.

Repository **secrets**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`TURSO_DB_URL`, `TURSO_DB_AUTH_TOKEN`, `BOOTSTRAP_SECRET` (a long random string
you choose; used once, for the first enrolment).

Repository **variables**: `API_BASE_URL` = your Worker URL, e.g.
`https://yt-video-queue-api.<your-subdomain>.workers.dev`.

> `API_BASE_URL` is public, so it is a **variable**, not a secret. It is injected
> into `frontend/config.js` at deploy time.

### Optional: enable YouTube playlist import

1. In Google Cloud, create/select a project, enable **YouTube Data API v3**, and
   create an API key. Restrict the key to the YouTube Data API. The Worker makes
   server-side requests, so do not restrict it to browser HTTP referrers.
2. Add the key as the repository Actions **secret** `YOUTUBE_API_KEY` (not a
   public variable). The API deployment workflow copies it to the Worker. If the
   repository secret is absent, the workflow leaves any existing Worker key
   unchanged. Alternatively, from `api/` run
   `npx wrangler secret put YOUTUBE_API_KEY` once.
3. Redeploy the Worker and the frontend. Paste a playlist URL on the dashboard.

The Worker uses the key only on the server. The YouTube API has a quota; large
or frequent playlist checks consume more requests. The Worker cron runs every
15 minutes and processes one due series per run. Each auto-enabled series is
eligible again six hours after its last attempt, so many linked series, failures
or platform delays can make checks less frequent. Manual refresh is available at
any time. An import/refresh that fails or exceeds 500 entries makes no partial
changes to the series.

### 4. Deploy

Push to `main` (or run the two workflows from the Actions tab). Then set
repo **Settings → Pages → Source = GitHub Actions** (first time only).

Your site will be at `https://<user>.github.io/yt-video-queue/`.

### 5. First login

1. Open the site. Since no passkey exists yet, the **Register this device** box appears.
2. Enter your `BOOTSTRAP_SECRET` and create a passkey with Face ID / Touch ID /
   Windows Hello / PIN. Registration then closes automatically.
3. **Enrol a second passkey** (a second device) so a lost phone is not a lockout:
   set `allow_reenroll = '1'` in `app_config`, register again, then set it back to `'0'`.

---

## Deploying the Worker manually (no Cloudflare token needed)

```bash
cd api
npm ci
npx wrangler login            # browser approval instead of a token
npx wrangler secret put TURSO_DB_URL
npx wrangler secret put TURSO_DB_AUTH_TOKEN
npx wrangler secret put BOOTSTRAP_SECRET
# Optional, for YouTube playlist import and duration lookup:
npx wrangler secret put YOUTUBE_API_KEY
npx wrangler deploy
```

`RP_ID`, `RP_NAME`, `EXPECTED_ORIGIN` live in `api/wrangler.toml` under `[vars]`.

---

## Local development

```bash
cd api
cp .dev.vars.example .dev.vars      # fill in TURSO_* / BOOTSTRAP_SECRET; optional YOUTUBE_API_KEY
npm ci
npm run dev                          # http://localhost:8787
```

Serve the frontend with any static server, point `frontend/config.js` at
`http://localhost:8787`, and set `RP_ID = "localhost"` /
`EXPECTED_ORIGIN = "http://localhost:8000"` in `wrangler.toml`. WebAuthn works on
`http://localhost` (it counts as a secure context).

### Tests

```bash
cd api
npm ci
npm run typecheck
npm test                             # playlist sync, migrations, analytics, extension and routing
npx wrangler deploy --dry-run         # validate the Worker bundle without deploying
```

Playlist tests use a local libSQL database and a mocked YouTube API, so they do
not require credentials or use YouTube quota. Wrangler's local dev server does
not run the production cron automatically; manual refresh works in local dev.

---

## Notes

- **RP ID / origin.** This repo is configured for a GitHub Pages **project site**:
  `RP_ID = "pavnxet.github.io"`, `EXPECTED_ORIGIN = "https://pavnxet.github.io"`.
  Passkeys are bound to the domain — if you move to a custom domain, update both
  in `api/wrangler.toml`, and re-enrol your passkeys.
- **Single-owner mode** (`AUTH_MODE = "owner"`). One user; registration locked
  after the first passkey. The schema already supports multi-user.
- **Sessions.** Opaque random tokens; only their SHA-256 hash is stored in the
  `sessions` table. The raw token lives in the browser's `localStorage` and is
  sent as `Authorization: Bearer`. Sessions last 30 days.
- **Sources.** A link is classified when it is added: a YouTube link keeps its
  video id; a `t.me` / `telegram.me` link is stored as a Telegram post and gets
  an embed URL; anything else is stored as a plain web link. Titles come from
  `og:title`, then `<title>`; thumbnails from `og:image`; YouTube titles come
  from the public oEmbed endpoint. With a YouTube API key configured, YouTube
  video IDs are also sent to the Data API to look up durations. Playlist import
  and sync use the Data API instead of fetching an arbitrary user-supplied URL.
- **Adding many links.** Each link costs one metadata lookup, so the frontend
  sends them in batches of 20. Links it cannot recognise are skipped and counted.
  The duration lookup uses one additional batched YouTube request when a key is
  configured. **Find missing durations** looks up YouTube videos in pages of
  up to 500; unavailable durations can also be entered manually.
- **Not embeddable on purpose.** Only YouTube and public Telegram posts are
  framed — private Telegram channels (`t.me/c/…`) and invite links are sent to
  the app instead. The CSP `frame-src` is kept narrow rather than opened to
  every host.

---

## Security

- The Turso token, bootstrap secret and optional YouTube API key live only as
  Worker secrets — never in the repo or the browser.
- Parameterised SQL everywhere; ownership is checked on every series/video access.
- WebAuthn challenges are stored server-side and deleted after a single use
  (anti-replay); the signature counter is tracked (clone detection).
- CORS is locked to `EXPECTED_ORIGIN`; a Content-Security-Policy meta tag
  restricts scripts, frames and images.
- All rendered text goes through `textContent`, so titles cannot inject HTML.
- Known gaps for a personal deployment: no rate limiting on the auth endpoints,
  and the session token is kept in `localStorage` (fine for a single-owner app,
  but it is readable by any script on the page — the CSP is what protects it).

Never commit `api/.dev.vars` or any real credential — `.gitignore` excludes it.

---

## Troubleshooting

- **"API_BASE_URL is not configured"** — set the `API_BASE_URL` repo variable and
  re-run the Pages workflow (or edit `frontend/config.js`).
- **A blank page with only the header and footer** — should no longer happen; if
  you see one, tell me which browser. From v1.4.1 the page always paints a
  *Loading…* state and then either the app or the login screen with a reason.
- **"Could not reach the API"** — the browser could not read a valid answer from
  the Worker. Check the Worker is deployed and that `API_BASE_URL` matches its
  URL. Some networks and privacy tools block `*.workers.dev`; if that is the
  case, put the Worker on a custom domain and update `API_BASE_URL`.
- **Passkey prompt doesn't appear / fails** — make sure you are on `https://` (or
  `localhost`) and that `RP_ID` matches the site's domain.
- **A video won't play** — it may be private, removed or region-blocked; press
  **Next** to skip, or tap the title to open it at the source.
- **"Channel with username @c not found" in the player** — that is Telegram
  refusing to embed a private-channel post. Those links are detected and open in
  the Telegram app instead; if you still see it, the link was added before v1.3,
  so remove and re-add it.
- **Playlist import says the key is not configured** — set the optional
  `YOUTUBE_API_KEY` Worker secret and enable YouTube Data API v3 in that Google
  Cloud project. Check quota and API restrictions if YouTube rejects requests.
- **A playlist doesn't sync** — it must be public or unlisted and have at most
  500 entries. Check the error and last-synced time in the series, then use
  **Refresh playlist**. Private/deleted videos are skipped. Cron checks can be
  delayed if many series are due.
- **Some watch times are missing** — unavailable or non-YouTube videos may not
  provide a duration. Use **Find missing durations**, play a YouTube video, or
  set a duration manually with the time button on its row.
- **Export button opens a broken YouTube page** — YouTube's temporary playlist
  holds about 50 videos; use the `.txt` / `.csv` / `.json` downloads for the rest.

---

## Version history

- **v1.7.0** — integrates the unpacked Chrome extension with linked-playlist
  import, refresh and auto-sync, series progress/time insights, current-position
  updates and duplicate-safe visible-video batching. Adds an indexed,
  authenticated YouTube lookup, session-handoff safeguards and extension tests.
- **v1.6.0** — progress bars and a detailed series insights sidebar; public or
  unlisted YouTube playlist import, manual and scheduled refresh, and optional
  API-backed duration lookup. Sync preserves edits and progress, skips duplicate
  or unavailable items, and does not restore videos deliberately removed from
  a series. Durations can also be entered manually, and playback fills missing
  YouTube durations. Adds migration, playlist and analytics tests.
- **v1.5.0** — **every series has its own link.** `#/s/<seriesId>` opens that
  series directly and `#/s/<seriesId>/v/<videoId>` opens a video inside it, so
  series can be bookmarked and shared. The hash is the single source of truth, so
  the browser's back and forward buttons work and a deep link opened while signed
  out is honoured after login. A new **🔗 Link** button copies the current
  series' URL, and deleting the series you are viewing returns you to the
  dashboard instead of leaving a dead link. Also: the startup "could not reach the
  API" message now names the actual reason and the URL it tried. New
  `tests/routing.test.js` (20 assertions).
- **v1.4.1** — robustness fix: startup can no longer leave a blank page. A
  loading state is painted immediately, the whole startup is wrapped so any
  failure lands on a visible screen with a message, API requests time out after
  12 s instead of hanging, a non-JSON or empty response is handled, and a
  trailing slash in `API_BASE_URL` is tolerated.
- **v1.4** — faster startup: the passkey helper is vendored locally instead of
  loaded from a CDN and is fetched only when signing in; the YouTube player
  script is loaded lazily; startup is one API call instead of two; a preconnect
  to the Worker is injected at deploy time.
- **v1.3** — titles in the series list are now links out to their source app
  (YouTube, Telegram, …); private Telegram channel posts are no longer embedded,
  and embeddable frames gained an "open in the app" fallback link.
- **v1.2** — PowerRename-style renaming: search/replace with regular expressions
  and capture groups, match-all, case sensitivity, enumerate counters, date/time
  variables, text formatting, a live preview table with per-item checkboxes and
  highlighted diffs, and undo.
- **v1.1** — multi-source: add Telegram posts and any web link alongside YouTube,
  with automatic titles/thumbnails and a graceful fallback name when a page
  cannot be read.
- **v1.0** — first complete release: passkey auth, series and video management,
  auto-advancing queue with resume, watched section, rename + bulk rename,
  thumbnail grid / compact / list views, playlist export, Claude-style theme,
  light/dark toggle, mobile + tablet layout.
