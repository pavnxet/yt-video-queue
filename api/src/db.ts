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

// videos carries every source: YouTube (youtube_id set), Telegram (embeddable
// via embed_url) and plain web links (opened in a new tab).
const VIDEOS_TABLE = `CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    youtube_id TEXT,
    source TEXT NOT NULL DEFAULT 'youtube',
    url TEXT,
    image_url TEXT,
    site_name TEXT,
    embeddable INTEGER NOT NULL DEFAULT 0,
    embed_url TEXT,
    title_auto INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    duration_seconds INTEGER,
    status TEXT NOT NULL DEFAULT 'todo',
    resume_seconds INTEGER NOT NULL DEFAULT 0,
    watched_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

/** DDL statements — mirrors schema.sql, applied on the first request. */
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
  VIDEOS_TABLE,
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
  await migrateVideos(client);
}

// Run the DDL at most once per isolate (the first request after a deploy creates
// any missing tables and applies the migration). On failure we clear the cache
// so the next request retries instead of caching a broken state forever.
let schemaInitPromise: Promise<void> | null = null;

export function ensureSchema(env: Env): Promise<void> {
  if (!schemaInitPromise) {
    schemaInitPromise = initSchema(env).catch((e) => {
      schemaInitPromise = null;
      throw e;
    });
  }
  return schemaInitPromise;
}

/**
 * v1.0 stored only YouTube rows, with youtube_id NOT NULL. SQLite cannot drop a
 * NOT NULL constraint, so databases created before v1.1 are rebuilt once here —
 * existing rows keep their ids, titles and watch state, and gain a url.
 */
async function migrateVideos(client: Client): Promise<void> {
  const info = await client.execute('PRAGMA table_info(videos)');
  const cols = info.rows.map((r) => String(r.name));
  if (cols.length === 0 || cols.includes('source')) return; // fresh or already migrated

  const newTable = VIDEOS_TABLE.replace(/CREATE TABLE IF NOT EXISTS videos\s*\(/, 'CREATE TABLE videos_new (');
  await client.execute(newTable);
  await client.execute(
    `INSERT INTO videos_new
       (id, series_id, position, youtube_id, source, url, image_url, site_name,
        embeddable, embed_url, title_auto, title, duration_seconds, status,
        resume_seconds, watched_at, created_at)
     SELECT id, series_id, position, youtube_id, 'youtube',
            'https://www.youtube.com/watch?v=' || youtube_id,
            NULL, 'YouTube', 1, NULL, 0,
            title, duration_seconds, status, resume_seconds, watched_at, created_at
     FROM videos`,
  );
  await client.execute('DROP TABLE videos');
  await client.execute('ALTER TABLE videos_new RENAME TO videos');
  await client.execute('CREATE INDEX IF NOT EXISTS idx_videos_series ON videos(series_id, position)');
}
