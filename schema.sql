-- yt-video-queue — Turso (libSQL) schema
-- Apply with:  turso db shell <your-db> < schema.sql
-- (or call the API endpoint POST /admin/init with your bootstrap secret)

PRAGMA foreign_keys = ON;

-- One row in single-owner mode. Kept as a table so multi-user is a later switch.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,               -- uuid
  username      TEXT UNIQUE NOT NULL,           -- 'owner'
  display_name  TEXT,
  is_owner      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Passkey credentials. `id` is the base64url credential ID returned by WebAuthn.
CREATE TABLE IF NOT EXISTS credentials (
  id            TEXT PRIMARY KEY,               -- credentialID (base64url)
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    TEXT NOT NULL,                  -- base64url(COSE public key)
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,                           -- JSON array, e.g. ["internal","hybrid"]
  device_label  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);

-- Login sessions. `id` is sha256(token) — the raw token only ever lives in the client.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Short-lived WebAuthn challenges, consumed exactly once (anti-replay).
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id          TEXT PRIMARY KEY,                 -- ceremony id (random)
  challenge   TEXT NOT NULL,
  user_id     TEXT,
  kind        TEXT NOT NULL,                    -- 'register' | 'login'
  expires_at  TEXT NOT NULL
);

-- A series = an ordered watch list.
CREATE TABLE IF NOT EXISTS series (
  id           TEXT PRIMARY KEY,                -- uuid
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_series_user ON series(user_id, position);

-- A video = one YouTube item inside a series.
CREATE TABLE IF NOT EXISTS videos (
  id                TEXT PRIMARY KEY,           -- uuid (our id)
  series_id         TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,           -- order within the series
  youtube_id        TEXT NOT NULL,              -- 11-char YouTube video id
  title             TEXT,
  duration_seconds  INTEGER,
  status            TEXT NOT NULL DEFAULT 'todo',   -- todo | watching | done
  resume_seconds    INTEGER NOT NULL DEFAULT 0,
  watched_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_videos_series ON videos(series_id, position);

-- Small key/value config so settings can change without a redeploy.
CREATE TABLE IF NOT EXISTS app_config (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
