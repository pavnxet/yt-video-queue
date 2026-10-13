# YT Video Queue

**v1.3** — a personal, passkey-protected watch queue for YouTube, Telegram and
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

**Organising**
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
│  ├─ styles.css
│  └─ config.js             # API_BASE_URL (written at deploy time)
├─ api/                      # Cloudflare Worker
│  ├─ src/index.ts           # router + CORS
│  ├─ src/auth.ts            # WebAuthn register/login + sessions
│  ├─ src/data.ts            # series + videos CRUD
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
npm install
npx wrangler login            # browser approval instead of a token
npx wrangler secret put TURSO_DB_URL
npx wrangler secret put TURSO_DB_AUTH_TOKEN
npx wrangler secret put BOOTSTRAP_SECRET
npx wrangler deploy
```

`RP_ID`, `RP_NAME`, `EXPECTED_ORIGIN` live in `api/wrangler.toml` under `[vars]`.

---

## Local development

```bash
cd api
cp .dev.vars.example .dev.vars      # fill in TURSO_* and BOOTSTRAP_SECRET
npm install
npm run dev                          # http://localhost:8787
```

Serve the frontend with any static server, point `frontend/config.js` at
`http://localhost:8787`, and set `RP_ID = "localhost"` /
`EXPECTED_ORIGIN = "http://localhost:8000"` in `wrangler.toml`. WebAuthn works on
`http://localhost` (it counts as a secure context).

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
  from the public oEmbed endpoint. Nothing is sent anywhere except a plain GET
  to the page you pasted.
- **Adding many links.** Each link costs one metadata lookup, so the frontend
  sends them in batches of 20. Links it cannot recognise are skipped and counted.
- **Not embeddable on purpose.** Only YouTube and public Telegram posts are
  framed — private Telegram channels (`t.me/c/…`) and invite links are sent to
  the app instead. The CSP `frame-src` is kept narrow rather than opened to
  every host.

---

## Security

- The Turso token and bootstrap secret live only as Worker secrets — never in the
  repo or the browser.
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
- **Passkey prompt doesn't appear / fails** — make sure you are on `https://` (or
  `localhost`) and that `RP_ID` matches the site's domain.
- **A video won't play** — it may be private, removed or region-blocked; press
  **Next** to skip, or tap the title to open it at the source.
- **"Channel with username @c not found" in the player** — that is Telegram
  refusing to embed a private-channel post. Those links are detected and open in
  the Telegram app instead; if you still see it, the link was added before v1.3,
  so remove and re-add it.
- **Export button opens a broken YouTube page** — YouTube's temporary playlist
  holds about 50 videos; use the `.txt` / `.csv` / `.json` downloads for the rest.

---

## Version history

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
