# YT Video Queue

A personal, passkey-protected watch queue for YouTube.

- Add YouTube links into ordered **series**.
- Watch them **one by one**; the next video is queued automatically when one finishes.
- Progress (position + watched status) is saved, so you resume anywhere.
- Login is **passkey-only (WebAuthn)** — no passwords. Single-owner by default:
  only your passkey opens it.
- Static UI on **GitHub Pages**, data in **Turso**, a tiny API on **Cloudflare Workers**.

---

## Architecture

```
GitHub Pages (static: index.html, app.js, player.js)
        |  fetch() with Authorization: Bearer <session token>
        v
Cloudflare Worker  (holds Turso token + WebAuthn verification)
        |  @libsql/client/web over HTTPS
        v
Turso (libSQL)
```

GitHub Pages cannot keep secrets or verify WebAuthn signatures, so a small
serverless API is required. The API holds the Turso token and runs the passkey
verification; the browser only ever sees a session token.

```
yt-video-queue/
├─ frontend/                 # published to GitHub Pages
│  ├─ index.html
│  ├─ app.js                 # SPA controller (auth, dashboard, series)
│  ├─ player.js              # YouTube IFrame player + completion detection
│  ├─ styles.css
│  └─ config.js             # API_BASE_URL (written at deploy time)
├─ api/                      # Cloudflare Worker
│  ├─ src/index.ts           # router + CORS
│  ├─ src/auth.ts            # WebAuthn register/login + sessions
│  ├─ src/data.ts            # series + videos CRUD
│  ├─ src/session.ts         # opaque DB-backed sessions
│  ├─ src/db.ts              # libSQL client + schema DDL
│  ├─ src/util.ts
│  ├─ src/types.ts
│  ├─ wrangler.toml
│  └─ package.json
├─ schema.sql
└─ .github/workflows/        # deploy-pages.yml + deploy-api.yml
```

---

## Prerequisites

- A **GitHub** account (this repo).
- A free **Turso** account — https://turso.tech
- A free **Cloudflare** account — https://dash.cloudflare.com
- Node.js 20+ if you want to run the API locally.

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

You do not have to do anything here — the Worker creates the tables by itself
the first time it is called. But you can also do it manually if you prefer:

- **Automatic (default):** the Worker runs `CREATE TABLE IF NOT EXISTS ...` once
  per isolate, so the first request after a deploy sets everything up.
- **Manually:** `turso db shell yt-video-queue < schema.sql`
- **Or via the API:** `curl -X POST https://<your-worker>/admin/init -H 'content-type: application/json' -d '{"bootstrapSecret":"<BOOTSTRAP_SECRET>"}'`

### 2. Get your Cloudflare API token

Dashboard → My Profile → API Tokens → Create Token → template
**"Edit Cloudflare Workers"**. Note your **Account ID** (Workers overview page).

### 3. Set GitHub repository secrets and variables

Settings → **Secrets and variables** → **Actions**.

Secrets (Repository secrets):

| Name | Value |
|------|-------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `TURSO_DB_URL` | from step 1 |
| `TURSO_DB_AUTH_TOKEN` | from step 1 |
| `BOOTSTRAP_SECRET` | a long random string you choose (used once, for first enrolment) |

Variables (Repository **variables**):

| Name | Value |
|------|-------|
| `API_BASE_URL` | your Worker URL, e.g. `https://yt-video-queue-api.<your-subdomain>.workers.dev` |

> `API_BASE_URL` is public, so it is a **variable**, not a secret. It is injected
> into `frontend/config.js` at deploy time.

### 4. Deploy

- Push to `main` (or run the workflows manually from the Actions tab).
- `Deploy API to Cloudflare Workers` publishes the Worker and sets its secrets.
- `Deploy frontend to GitHub Pages` publishes `frontend/`.

Then, in repo **Settings → Pages**, set **Source = GitHub Actions** (first time only).

Your site will be at `https://<user>.github.io/yt-video-queue/`.

### 5. First login

1. Open the site. Since no passkey exists yet, the **Register this device** box appears.
2. Enter your `BOOTSTRAP_SECRET`, click **Register this device**, and create a
   passkey with Face ID / Touch ID / Windows Hello / PIN.
3. Registration now closes automatically — only that passkey can sign in.
4. **Enrol a second passkey** (e.g. your laptop) for safety: temporarily set the
   config flag `allow_reenroll = '1'` in the DB (`INSERT INTO app_config ...`),
   register again, then set it back to `'0'`. Or run with `AUTH_MODE=multi` while
   adding devices.

---

## Deploying the Worker manually (alternative to Actions)

```bash
cd api
npm install
npx wrangler login
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

Serve the frontend with any static server, e.g.:

```bash
cd frontend
python3 -m http.server 8000          # http://localhost:8000
```

Point `frontend/config.js` at `http://localhost:8787` while developing.
WebAuthn works on `http://localhost` (it counts as a secure context), so you can
test passkeys locally without TLS. When running locally, set `RP_ID =
"localhost"` and `EXPECTED_ORIGIN = "http://localhost:8000"` in `wrangler.toml`
(or via `[env.dev]`).

---

## Configuration notes

- **RP ID / origin.** Passkeys are bound to the domain. This repo is configured
  for a GitHub Pages **project site**, so `RP_ID = "pavnxet.github.io"` and
  `EXPECTED_ORIGIN = "https://pavnxet.github.io"`. If you use a custom domain,
  update both in `api/wrangler.toml`. Changing the domain later invalidates
  existing passkeys (you would re-enrol).
- **Single-owner mode.** `AUTH_MODE = "owner"` (default). One user, registration
  locked after the first passkey. Set `AUTH_MODE = "multi"` to allow multiple
  users later (schema already supports it).
- **Sessions.** Opaque random tokens; only their SHA-256 hash is stored in the
  `sessions` table. The raw token lives in the browser's `localStorage` and is
  sent as `Authorization: Bearer`. Log out clears it. Sessions last 30 days.

---

## API reference

Public:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | liveness |
| `POST` | `/admin/init` | apply schema (needs bootstrap secret) |
| `GET` | `/auth/status` | is registration open? |
| `POST` | `/auth/register/options` · `/auth/register/verify` | enrol a passkey |
| `POST` | `/auth/login/options` · `/auth/login/verify` | sign in |

Authenticated (Bearer token):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/auth/me` | current user |
| `POST` | `/auth/logout` | end session |
| `GET`/`POST` | `/series` | list / create series |
| `GET`/`PATCH`/`DELETE` | `/series/:id` | read / update / delete |
| `POST` | `/series/:id/videos` | add video(s) from URLs |
| `POST` | `/series/:id/reorder` | set order `{orderedIds:[...]}` |
| `PATCH`/`DELETE` | `/videos/:id` | update status/position, or delete |

---

## Security

- Turso token and bootstrap secret live only as Worker secrets — never in the
  repo or the browser.
- Parameterised SQL everywhere; ownership is checked on every series/video access.
- WebAuthn challenges are stored server-side and deleted after a single use
  (anti-replay); the signature counter is tracked (clone detection).
- CORS is locked to `EXPECTED_ORIGIN`.
- A Content-Security-Policy meta tag restricts scripts to self + YouTube + esm.sh.

Never commit `api/.dev.vars` or any real credential — `.gitignore` already
excludes it.

---

## Troubleshooting

- **"API_BASE_URL is not configured"** — set the `API_BASE_URL` repo variable and
  re-run the Pages workflow (or edit `frontend/config.js`).
- **Passkey prompt doesn't appear / fails** — make sure you are on `https://` (or
  `localhost`) and that `RP_ID` matches the site's domain.
- **`/auth/status` errors** — the Worker isn't deployed yet, or secrets are
  missing; check the Actions run for the API workflow.
- **Video won't auto-play next** — browsers may block autoplay; click **Next ▶**
  or use **Mark done & next**.
