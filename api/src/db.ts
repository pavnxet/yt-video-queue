import { createClient, type Client } from '@libsql/client/web';
import type { Env } from './types';

// Cache the client per isolate (Workers reuse isolates across requests).
let cached: Client | null = null;
let cachedUrl = '';

export function db(env: Env): Client {
  if (!cached || cachedUrl !== env.TURSO_DB_URL) {
    if (!env.TURSO_DB_URL || !env.TURSO_DB_AUTH_TOKEN) {
      throw new Error('TURSO_DB_URL / TURSO_DB_AUTH_TOKEN are not configured');
    }
    cached = createClient({ url: env.TURSO_DB_URL, authToken: env.TURSO_DB_AUTH_TOKEN });
    cachedUrl = env.TURSO_DB_URL;
  }
  return cached;
}

/** DDL statements — mirrors schema.sql, applied by POST /admin/init. */
export const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT,
    is_owner INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    device_label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id TEXT PRIMARY KEY,
    challenge TEXT NOT NULL,
    user_id TEXT,
    kind TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS series (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_series_user ON series(user_id, position)`,
  `CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    youtube_id TEXT NOT NULL,
    title TEXT,
    duration_seconds INTEGER,
    status TEXT NOT NULL DEFAULT 'todo',
    resume_seconds INTEGER NOT NULL DEFAULT 0,
    watched_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_videos_series ON videos(series_id, position)`,
  `CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
];

export async function initSchema(env: Env): Promise<void> {
  const client = db(env);
  for (const stmt of DDL) {
    await client.execute(stmt);
  }
}
