import { createClient, type Client } from '@libsql/client/web';
import type { Env } from './types';

// Cache the client per isolate (Workers reuse isolates across requests).
let cached: Client | null = null;
let cachedUrl = '';

// Every query gets a deadline. Without one a stalled connection to Turso makes
// the request hang until the *browser* gives up, which shows up in the Workers
// log as `outcome: canceled` with cpuTime 0 and no exception — impossible to
// debug. Failing in 5s instead turns that into a normal, readable error.
const DB_TIMEOUT_MS = 5000;

function guard<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${DB_TIMEOUT_MS}ms — the database did not answer`)),
      DB_TIMEOUT_MS,
    );
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Wrap a client so every execute/batch is bounded by DB_TIMEOUT_MS. */
function withTimeouts(client: Client): Client {
  const wrapped: Client = Object.create(client);
  wrapped.execute = ((stmt: Parameters<Client['execute']>[0]) =>
    guard(client.execute(stmt), 'db.execute')) as Client['execute'];
  wrapped.batch = ((stmts: Parameters<Client['batch']>[0], mode?: Parameters<Client['batch']>[1]) =>
    guard(client.batch(stmts, mode), 'db.batch')) as Client['batch'];
  return wrapped;
}

export function db(env: Env): Client {
  if (!cached || cachedUrl !== env.TURSO_DB_URL) {
    if (!env.TURSO_DB_URL || !env.TURSO_DB_AUTH_TOKEN) {
      throw new Error('TURSO_DB_URL / TURSO_DB_AUTH_TOKEN are not configured');
    }
    cached = withTimeouts(
      createClient({ url: env.TURSO_DB_URL, authToken: env.TURSO_DB_AUTH_TOKEN }),
    );
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
    playlist_id TEXT,
    playlist_auto_sync INTEGER NOT NULL DEFAULT 1,
    playlist_checked_at TEXT,
    playlist_synced_at TEXT,
    playlist_sync_error TEXT,
    playlist_sync_started_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_series_user ON series(user_id, position)`,
  VIDEOS_TABLE,
  `CREATE INDEX IF NOT EXISTS idx_videos_series ON videos(series_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_videos_youtube ON videos(youtube_id, series_id)`,
  // Remember imported IDs even if the user removes a video. A refresh should
  // add genuinely new uploads, not resurrect things deliberately removed.
  `CREATE TABLE IF NOT EXISTS playlist_seen_videos (
    series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    youtube_id TEXT NOT NULL,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (series_id, youtube_id)
  )`,
  `CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
];

// Bump when DDL or a migration changes, so deployed databases re-run init once.
const SCHEMA_VERSION = 3;

/** Read PRAGMA user_version, tolerating any driver that will not report it. */
async function schemaVersion(client: Client): Promise<number> {
  try {
    const res = await client.execute('PRAGMA user_version');
    return Number(res.rows[0]?.user_version ?? 0) || 0;
  } catch {
    return 0;
  }
}

export async function initSchema(env: Env): Promise<void> {
  const client = db(env);
  // Fast path: a fresh isolate used to re-run the whole DDL batch plus two
  // PRAGMA scans before it could answer anything — several extra round trips
  // on the very first request after a deploy or an idle period. One cheap read
  // skips all of it once the database is known to be current.
  if ((await schemaVersion(client)) >= SCHEMA_VERSION) return;

  // One remote transaction rather than a request per DDL statement. This also
  // leaves the Worker subrequest budget available for playlist imports.
  await client.batch(DDL, 'write');
  await migrateVideos(client);
  await migrateSeries(client);

  // Best effort: if the driver rejects the write we simply re-check next time.
  try {
    await client.execute(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } catch {
    /* not fatal */
  }
}

/** Add playlist columns to existing databases without disturbing their data. */
export async function migrateSeries(client: Client): Promise<void> {
  const info = await client.execute('PRAGMA table_info(series)');
  const cols = new Set(info.rows.map((r) => String(r.name)));
  const additions: Array<[string, string]> = [
    ['playlist_id', 'TEXT'],
    ['playlist_auto_sync', 'INTEGER NOT NULL DEFAULT 1'],
    ['playlist_checked_at', 'TEXT'],
    ['playlist_synced_at', 'TEXT'],
    ['playlist_sync_error', 'TEXT'],
    ['playlist_sync_started_at', 'TEXT'],
  ];
  for (const [name, definition] of additions) {
    if (cols.has(name)) continue;
    try {
      await client.execute(`ALTER TABLE series ADD COLUMN ${name} ${definition}`);
    } catch (e) {
      // Two new Worker isolates can race to migrate the same database. Only
      // ignore the specific duplicate-column race; real failures must surface.
      if (!/duplicate column name/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  }
  await client.execute(
    'CREATE INDEX IF NOT EXISTS idx_series_playlist_due ON series(playlist_auto_sync, playlist_checked_at)',
  );
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
export async function migrateVideos(client: Client): Promise<void> {
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
  await client.execute('CREATE INDEX IF NOT EXISTS idx_videos_youtube ON videos(youtube_id, series_id)');
}
