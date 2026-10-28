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
  playlist_id  TEXT,                           -- linked YouTube playlist, if any
  playlist_auto_sync INTEGER NOT NULL DEFAULT 1,
  playlist_checked_at TEXT,                    -- last attempt (ISO UTC)
  playlist_synced_at  TEXT,                    -- last successful sync (ISO UTC)
  playlist_sync_error TEXT,
  playlist_sync_started_at TEXT,                -- short-lived sync lease
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_series_user ON series(user_id, position);

-- A video = one YouTube item inside a series.
CREATE TABLE IF NOT EXISTS videos (
  id                TEXT PRIMARY KEY,           -- uuid (our id)
  series_id         TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,           -- order within the series
  youtube_id        TEXT,                       -- set for YouTube videos
  source            TEXT NOT NULL DEFAULT 'youtube', -- youtube | telegram | web
  url               TEXT,                       -- canonical link for the source
  image_url         TEXT,                       -- thumbnail (og:image or ytimg)
  site_name         TEXT,
  embeddable        INTEGER NOT NULL DEFAULT 0, -- can it play in an iframe?
  embed_url         TEXT,
  title_auto        INTEGER NOT NULL DEFAULT 0, -- title guessed from the URL
  title             TEXT,
  duration_seconds  INTEGER,
  status            TEXT NOT NULL DEFAULT 'todo',   -- todo | watching | done
  resume_seconds    INTEGER NOT NULL DEFAULT 0,
  watched_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Databases created before v1.1 (youtube_id NOT NULL, no source/url) are rebuilt
-- automatically by the Worker on its first request after the upgrade.
CREATE INDEX IF NOT EXISTS idx_videos_series ON videos(series_id, position);
CREATE INDEX IF NOT EXISTS idx_videos_youtube ON videos(youtube_id, series_id);

-- Keeps deliberately removed playlist videos from being re-added on refresh.
CREATE TABLE IF NOT EXISTS playlist_seen_videos (
  series_id     TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  youtube_id    TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (series_id, youtube_id)
);
-- Existing databases receive the playlist columns and due index automatically
-- from the Worker on first request; CREATE TABLE IF NOT EXISTS cannot migrate them.

-- Small key/value config so settings can change without a redeploy.
CREATE TABLE IF NOT EXISTS app_config (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
