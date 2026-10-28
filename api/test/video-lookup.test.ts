import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { DDL, migrateSeries, migrateVideos } from '../src/db';
import { lookupVideoRows } from '../src/video-lookup';

test('indexed YouTube lookup returns only the signed-in user’s matches in queue order', async () => {
  const db = createClient({ url: 'file::memory:' });
  try {
    await db.batch(DDL, 'write');
    await migrateSeries(db);
    await migrateVideos(db);
    await db.batch([
      "INSERT INTO users (id, username) VALUES ('alice', 'alice')",
      "INSERT INTO users (id, username) VALUES ('bob', 'bob')",
      "INSERT INTO series (id, user_id, title, position) VALUES ('late', 'alice', 'Later', 2)",
      "INSERT INTO series (id, user_id, title, position) VALUES ('early', 'alice', 'Earlier', 1)",
      "INSERT INTO series (id, user_id, title, position) VALUES ('private', 'bob', 'Private', 0)",
      "INSERT INTO videos (id, series_id, position, youtube_id) VALUES ('v1', 'late', 0, 'abcdefghijk')",
      "INSERT INTO videos (id, series_id, position, youtube_id) VALUES ('v2', 'early', 1, 'abcdefghijk')",
      "INSERT INTO videos (id, series_id, position, youtube_id) VALUES ('v3', 'early', 0, 'abcdefghijk')",
      "INSERT INTO videos (id, series_id, position, youtube_id) VALUES ('secret', 'private', 0, 'abcdefghijk')",
      "INSERT INTO videos (id, series_id, position, youtube_id) VALUES ('other', 'early', 2, '12345678901')",
    ], 'write');
    const rows = await lookupVideoRows(db, 'alice', 'abcdefghijk');
    assert.deepEqual(rows.map((row) => [row.id, row.series_title]), [['v3', 'Earlier'], ['v2', 'Earlier'], ['v1', 'Later']]);
    assert.deepEqual((await lookupVideoRows(db, 'bob', 'abcdefghijk')).map((row) => row.id), ['secret']);
    assert.equal((await lookupVideoRows(db, 'nobody', 'abcdefghijk')).length, 0);
    const indexes = await db.execute('PRAGMA index_list(videos)');
    assert.ok(indexes.rows.some((row) => row.name === 'idx_videos_youtube'));
  } finally { db.close(); }
});

test('legacy video-table rebuild preserves rows and recreates the lookup index', async () => {
  const db = createClient({ url: 'file::memory:' });
  try {
    await db.execute('CREATE TABLE series (id TEXT PRIMARY KEY)');
    await db.execute("INSERT INTO series (id) VALUES ('s')");
    await db.execute(`CREATE TABLE videos (
      id TEXT PRIMARY KEY, series_id TEXT NOT NULL, position INTEGER NOT NULL,
      youtube_id TEXT NOT NULL, title TEXT, duration_seconds INTEGER,
      status TEXT, resume_seconds INTEGER, watched_at TEXT, created_at TEXT
    )`);
    await db.execute("INSERT INTO videos VALUES ('v', 's', 0, 'abcdefghijk', 'Old', 90, 'watching', 30, NULL, '2020-01-01')");
    await db.execute('CREATE INDEX idx_videos_youtube ON videos(youtube_id, series_id)');
    await migrateVideos(db);
    const rows = (await db.execute('SELECT youtube_id, source, status, resume_seconds FROM videos')).rows;
    assert.deepEqual(rows.map((row) => [row.youtube_id, row.source, row.status, row.resume_seconds]), [['abcdefghijk', 'youtube', 'watching', 30]]);
    assert.ok((await db.execute('PRAGMA index_list(videos)')).rows.some((row) => row.name === 'idx_videos_youtube'));
  } finally { db.close(); }
});
