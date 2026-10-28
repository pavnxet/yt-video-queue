import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, type Client } from '@libsql/client';
import { DDL, migrateSeries } from '../src/db';
import { importPlaylist, syncOneDuePlaylist, syncPlaylist } from '../src/playlists';
import { fetchYouTubePlaylist, parsePlaylistId, parseYouTubeDuration, YouTubeError } from '../src/youtube';

const PLAYLIST = 'PL1234567890';
const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const C = 'ccccccccccc';
const MISSING = 'ddddddddddd';

async function database(): Promise<Client> {
  const client = createClient({ url: 'file::memory:' });
  for (const statement of DDL) await client.execute(statement);
  await migrateSeries(client);
  await client.execute({ sql: "INSERT INTO users (id, username) VALUES (?, ?)", args: ['owner', 'owner'] });
  return client;
}

function mockYouTube(ids: string[], opts: { missing?: string[]; failPage?: number; onPlaylist?: () => Promise<void> } = {}) {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'www.googleapis.com');
    const resource = url.pathname.split('/').pop()!;
    requests.push(resource);
    if (resource === 'playlists') {
      if (opts.onPlaylist) await opts.onPlaylist();
      return Response.json({ items: [{ snippet: { title: 'An excellent course', description: 'Course description' } }] });
    }
    if (resource === 'playlistItems') {
      const page = Number(url.searchParams.get('pageToken') || 0);
      if (opts.failPage === page) return new Response('failed', { status: 503 });
      const slice = ids.slice(page * 50, (page + 1) * 50);
      return Response.json({
        items: slice.map((id) => ({ contentDetails: { videoId: id } })),
        ...(ids.length > (page + 1) * 50 ? { nextPageToken: String(page + 1) } : {}),
      });
    }
    if (resource === 'videos') {
      const requested = (url.searchParams.get('id') || '').split(',');
      return Response.json({ items: requested.filter((id) => !opts.missing?.includes(id)).map((id) => ({
        id, snippet: { title: 'Title ' + id }, contentDetails: { duration: 'PT1H2M3S' },
      })) });
    }
    throw new Error('Unexpected endpoint');
  }) as typeof fetch;
  return { fetcher, requests };
}

const count = async (client: Client, table: string) => Number((await client.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);

test('playlist URLs are restricted to real YouTube hosts and duration parsing handles unknowns', () => {
  assert.equal(parsePlaylistId(PLAYLIST), PLAYLIST);
  assert.equal(parsePlaylistId(`https://www.youtube.com/watch?v=${A}&list=${PLAYLIST}`), PLAYLIST);
  assert.equal(parsePlaylistId(`https://youtu.be/${A}?list=${PLAYLIST}`), PLAYLIST);
  assert.equal(parsePlaylistId(`youtube.com/playlist?list=${PLAYLIST}`), PLAYLIST);
  assert.equal(parsePlaylistId(`https://youtube.com.evil.test/playlist?list=${PLAYLIST}`), null);
  assert.equal(parsePlaylistId('https://youtube.com/watch?v=' + A), null);
  assert.equal(parsePlaylistId('javascript:alert(1)'), null);
  assert.equal(parseYouTubeDuration('PT1H2M3S'), 3723);
  assert.equal(parseYouTubeDuration('P1DT2H3M4S'), 93784);
  assert.equal(parseYouTubeDuration('PT42S'), 42);
  assert.equal(parseYouTubeDuration('PT0S'), null);
  assert.equal(parseYouTubeDuration('garbage'), null);
});

test('missing keys and inaccessible playlists return useful, secret-safe errors', async () => {
  const neverFetch = (async () => { throw new Error('must not fetch'); }) as typeof fetch;
  await assert.rejects(fetchYouTubePlaylist(PLAYLIST, undefined, neverFetch),
    (e: unknown) => e instanceof YouTubeError && e.status === 503 && /YOUTUBE_API_KEY/.test(e.message));
  const notFound = (async () => Response.json({ items: [] })) as typeof fetch;
  await assert.rejects(fetchYouTubePlaylist(PLAYLIST, 'secret-key', notFound),
    (e: unknown) => e instanceof YouTubeError && e.status === 404 && !e.message.includes('secret-key'));
  const forbidden = (async () => new Response('upstream secret-key', { status: 403 })) as typeof fetch;
  await assert.rejects(fetchYouTubePlaylist(PLAYLIST, 'secret-key', forbidden),
    (e: unknown) => e instanceof YouTubeError && e.status === 502 && !e.message.includes('secret-key'));
  const networkError = (async () => { throw new Error('https://example.test/?key=secret-key'); }) as typeof fetch;
  await assert.rejects(fetchYouTubePlaylist(PLAYLIST, 'secret-key', networkError),
    (e: unknown) => e instanceof YouTubeError && !e.message.includes('secret-key'));
});

test('playlist retrieval follows pages, deduplicates and excludes unavailable videos', async () => {
  const ids = Array.from({ length: 51 }, (_, i) => String(i).padStart(11, '0'));
  const mock = mockYouTube([...ids, ids[0], MISSING], { missing: [MISSING] });
  const result = await fetchYouTubePlaylist(PLAYLIST, 'test-key', mock.fetcher);
  assert.equal(result.videos.length, 51);
  assert.equal(result.duplicates, 1);
  assert.equal(result.unavailable, 1);
  assert.deepEqual(result.videos.map((v) => v.id), ids);
  assert.equal(result.videos[0].durationSeconds, 3723);
  assert.equal(mock.requests.filter((x) => x === 'playlistItems').length, 2);
  assert.equal(mock.requests.filter((x) => x === 'videos').length, 2);
});

test('import is atomic and includes metadata, durations and sync settings', async () => {
  const db = await database();
  try {
    await assert.rejects(importPlaylist(db, 'owner', PLAYLIST, 'key', {}, mockYouTube([A], { failPage: 0 }).fetcher));
    assert.equal(await count(db, 'series'), 0);
    const result = await importPlaylist(db, 'owner', PLAYLIST, 'key', { title: 'My course' }, mockYouTube([A, B]).fetcher);
    assert.equal(result.added, 2);
    const series = (await db.execute('SELECT * FROM series')).rows[0];
    assert.equal(series.title, 'My course');
    assert.equal(series.description, 'Course description');
    assert.equal(series.playlist_id, PLAYLIST);
    assert.equal(series.playlist_auto_sync, 1);
    const videos = (await db.execute('SELECT * FROM videos ORDER BY position')).rows;
    assert.deepEqual(videos.map((v) => v.youtube_id), [A, B]);
    assert.equal(videos[0].duration_seconds, 3723);
    assert.equal(await count(db, 'playlist_seen_videos'), 2);
  } finally { db.close(); }
});

test('a 500-entry playlist imports in order; larger playlists fail without partial writes', async () => {
  const db = await database();
  try {
    const ids = Array.from({ length: 501 }, (_, i) => String(i).padStart(11, '0'));
    await assert.rejects(importPlaylist(db, 'owner', PLAYLIST, 'key', {}, mockYouTube(ids).fetcher),
      (e: unknown) => e instanceof YouTubeError && e.status === 400 && /500/.test(e.message));
    assert.equal(await count(db, 'series'), 0);
    const result = await importPlaylist(db, 'owner', PLAYLIST, 'key', {}, mockYouTube(ids.slice(0, 500)).fetcher);
    assert.equal(result.added, 500);
    const rows = (await db.execute('SELECT youtube_id, position FROM videos ORDER BY position')).rows;
    assert.equal(rows.length, 500);
    assert.equal(rows[0].youtube_id, ids[0]);
    assert.equal(rows[499].youtube_id, ids[499]);
    assert.equal(rows[499].position, 499);
  } finally { db.close(); }
});

test('refresh appends only new videos and preserves progress, ordering, edits and removals', async () => {
  const db = await database();
  try {
    const { id } = await importPlaylist(db, 'owner', PLAYLIST, 'key', {}, mockYouTube([A, B]).fetcher);
    await db.execute({ sql: "UPDATE videos SET title = 'Custom title', status = 'done', duration_seconds = 999, position = 7 WHERE series_id = ? AND youtube_id = ?", args: [id, A] });
    await db.execute({ sql: 'DELETE FROM videos WHERE series_id = ? AND youtube_id = ?', args: [id, B] });
    const result = await syncPlaylist(db, id, 'key', mockYouTube([B, A, C, A, MISSING], { missing: [MISSING] }).fetcher);
    assert.equal(result.added, 1);
    assert.equal(result.unavailable, 1);
    assert.equal(result.duplicates, 1);
    const rows = (await db.execute({ sql: 'SELECT * FROM videos WHERE series_id = ? ORDER BY position', args: [id] })).rows;
    assert.deepEqual(rows.map((v) => v.youtube_id), [A, C]);
    assert.equal(rows[0].title, 'Custom title');
    assert.equal(rows[0].status, 'done');
    assert.equal(rows[0].duration_seconds, 999);
    assert.equal(rows[0].position, 7);
    assert.equal(rows[1].position, 8);
    assert.equal(await count(db, 'playlist_seen_videos'), 3);
    assert.equal((await syncPlaylist(db, id, 'key', mockYouTube([B, A, C]).fetcher)).added, 0);
    const restored = await syncPlaylist(db, id, 'key', mockYouTube([B, A, C]).fetcher, { restoreRemoved: true });
    assert.equal(restored.added, 1);
    const restoredRows = (await db.execute('SELECT youtube_id, status FROM videos ORDER BY position')).rows;
    assert.deepEqual(restoredRows.map((v) => v.youtube_id), [A, C, B]);
    assert.equal(restoredRows[2].status, 'todo');
    await db.execute({ sql: 'DELETE FROM videos WHERE series_id = ? AND youtube_id = ?', args: [id, B] });
    assert.equal((await syncPlaylist(db, id, 'key', mockYouTube([B, A, C]).fetcher)).added, 0);
  } finally { db.close(); }
});

test('refresh fills missing durations and can add videos that become available later', async () => {
  const db = await database();
  try {
    const { id, unavailable } = await importPlaylist(db, 'owner', PLAYLIST, 'key', {}, mockYouTube([A, B], { missing: [B] }).fetcher);
    assert.equal(unavailable, 1);
    await db.execute({ sql: 'UPDATE videos SET duration_seconds = NULL WHERE series_id = ? AND youtube_id = ?', args: [id, A] });
    const result = await syncPlaylist(db, id, 'key', mockYouTube([A, B]).fetcher);
    assert.equal(result.added, 1);
    assert.equal(result.durationsUpdated, 1);
    const rows = (await db.execute('SELECT youtube_id, duration_seconds FROM videos ORDER BY position')).rows;
    assert.deepEqual(rows.map((r) => [r.youtube_id, r.duration_seconds]), [[A, 3723], [B, 3723]]);
  } finally { db.close(); }
});

test('failed later page leaves the series unchanged and records a retryable error', async () => {
  const db = await database();
  try {
    const { id } = await importPlaylist(db, 'owner', PLAYLIST, 'key', {}, mockYouTube([A]).fetcher);
    const before = (await db.execute({ sql: 'SELECT playlist_synced_at FROM series WHERE id = ?', args: [id] })).rows[0].playlist_synced_at;
    const many = Array.from({ length: 51 }, (_, i) => String(i).padStart(11, '0'));
    await assert.rejects(syncPlaylist(db, id, 'key', mockYouTube(many, { failPage: 1 }).fetcher));
    assert.equal(await count(db, 'videos'), 1);
    const row = (await db.execute({ sql: 'SELECT * FROM series WHERE id = ?', args: [id] })).rows[0];
    assert.equal(row.playlist_synced_at, before);
    assert.equal(row.playlist_sync_started_at, null);
    assert.match(String(row.playlist_sync_error), /YouTube/);
    assert.equal((await syncPlaylist(db, id, 'key', mockYouTube([A, B]).fetcher)).added, 1);
  } finally { db.close(); }
});

test('concurrent refreshes are locked; a stale lease can be recovered', async () => {
  const db = await database();
  try {
    const { id } = await importPlaylist(db, 'owner', PLAYLIST, 'key', {}, mockYouTube([A]).fetcher);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const first = syncPlaylist(db, id, 'key', mockYouTube([A, B], { onPlaylist: async () => { started(); await gate; } }).fetcher);
    await entered;
    await assert.rejects(syncPlaylist(db, id, 'key', mockYouTube([A, B]).fetcher), (e: unknown) => e instanceof YouTubeError && e.status === 409);
    release();
    assert.equal((await first).added, 1);
    await db.execute({ sql: "UPDATE series SET playlist_sync_started_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", args: [id] });
    assert.equal((await syncPlaylist(db, id, 'key', mockYouTube([A, B, C]).fetcher)).added, 1);
  } finally { db.close(); }
});

test('scheduled sync respects due time and opt-out', async () => {
  const db = await database();
  try {
    const { id } = await importPlaylist(db, 'owner', PLAYLIST, 'key', { autoSync: false }, mockYouTube([A]).fetcher);
    await db.execute({ sql: "UPDATE series SET playlist_checked_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", args: [id] });
    assert.equal(await syncOneDuePlaylist(db, 'key', mockYouTube([A, B]).fetcher), false);
    await db.execute({ sql: 'UPDATE series SET playlist_auto_sync = 1 WHERE id = ?', args: [id] });
    assert.equal(await syncOneDuePlaylist(db, undefined, mockYouTube([A, B]).fetcher), false);
    assert.equal(await syncOneDuePlaylist(db, 'key', mockYouTube([A, B]).fetcher), true);
    assert.equal(await count(db, 'videos'), 2);
    assert.equal(await syncOneDuePlaylist(db, 'key', mockYouTube([A, B]).fetcher), false);
  } finally { db.close(); }
});

test('existing series table migrates without losing data', async () => {
  const db = createClient({ url: 'file::memory:' });
  try {
    await db.execute('CREATE TABLE series (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
    await db.execute("INSERT INTO series VALUES ('old', 'Saved series')");
    await migrateSeries(db);
    await migrateSeries(db); // idempotent
    const row = (await db.execute('SELECT * FROM series')).rows[0];
    assert.equal(row.title, 'Saved series');
    assert.equal(row.playlist_id, null);
    assert.equal(row.playlist_auto_sync, 1);
  } finally { db.close(); }
});
