import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { DDL, migrateSeries } from '../src/db';
import { fillMissingDurations } from '../src/durations';
import { YouTubeError } from '../src/youtube';

test('duration lookup pages past unavailable videos and preserves concurrent edits', async () => {
  const db = createClient({ url: 'file::memory:' });
  try {
    await db.batch(DDL, 'write');
    await migrateSeries(db);
    await db.execute("INSERT INTO users (id, username) VALUES ('owner', 'owner')");
    await db.execute("INSERT INTO series (id, user_id, title) VALUES ('s', 'owner', 'Test')");
    const ids = Array.from({ length: 505 }, (_, i) => String(i).padStart(11, '0'));
    await db.batch(ids.map((youtubeId, i) => ({
      sql: 'INSERT INTO videos (id, series_id, position, youtube_id) VALUES (?, ?, ?, ?)',
      args: ['v' + String(i).padStart(4, '0'), 's', i, youtubeId],
    })), 'write');

    await assert.rejects(fillMissingDurations(db, 's', undefined),
      (e: unknown) => e instanceof YouTubeError && e.status === 503);
    let manualEdit = false;
    const fetcher = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (!manualEdit) {
        manualEdit = true;
        await db.execute("UPDATE videos SET duration_seconds = 777 WHERE id = 'v0005'");
      }
      return Response.json({ items: (url.searchParams.get('id') || '').split(',')
        .filter((id) => !ids.slice(0, 3).includes(id))
        .map((id) => ({ id, snippet: { title: id }, contentDetails: { duration: 'PT2M' } })) });
    }) as typeof fetch;

    const first = await fillMissingDurations(db, 's', 'key', '', fetcher);
    assert.deepEqual(first, { updated: 496, attempted: 500, nextCursor: 'v0499' });
    const second = await fillMissingDurations(db, 's', 'key', first.nextCursor!, fetcher);
    assert.deepEqual(second, { updated: 5, attempted: 5, nextCursor: null });
    const edited = (await db.execute("SELECT duration_seconds FROM videos WHERE id = 'v0005'")).rows[0];
    assert.equal(edited.duration_seconds, 777);
    const unknown = (await db.execute('SELECT COUNT(*) AS n FROM videos WHERE duration_seconds IS NULL')).rows[0];
    assert.equal(unknown.n, 3);
  } finally { db.close(); }
});
