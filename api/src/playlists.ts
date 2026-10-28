import type { Client, InStatement } from '@libsql/client/web';
import { nowIso, uuid } from './util';
import {
  fetchYouTubePlaylist, parsePlaylistId, requireYouTubeKey, YouTubeError,
  type YouTubePlaylist, type YouTubeVideo,
} from './youtube';

export const PLAYLIST_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LEASE_MS = 15 * 60 * 1000;

export interface PlaylistResult {
  added: number;
  durationsUpdated: number;
  unavailable: number;
  duplicates: number;
  syncedAt: string;
}

function existsClause(lease: string | null): string {
  return `EXISTS (SELECT 1 FROM series WHERE id = ?${lease ? ' AND playlist_sync_started_at = ?' : ''})`;
}

function leaseArgs(seriesId: string, lease: string | null): string[] {
  return lease ? [seriesId, lease] : [seriesId];
}

/** Append an absent video; previously removed IDs require an explicit restore. */
function insertVideo(seriesId: string, video: YouTubeVideo, lease: string | null, restoreRemoved = false): InStatement {
  return {
    sql: `INSERT INTO videos
            (id, series_id, position, youtube_id, source, url, image_url, site_name,
             embeddable, embed_url, title_auto, title, duration_seconds)
          SELECT ?, ?, COALESCE((SELECT MAX(position) + 1 FROM videos WHERE series_id = ?), 0),
                 ?, 'youtube', ?, ?, 'YouTube', 1, NULL, ?, ?, ?
          WHERE ${existsClause(lease)}
            AND NOT EXISTS (SELECT 1 FROM videos WHERE series_id = ? AND youtube_id = ?)
            ${restoreRemoved ? '' : 'AND NOT EXISTS (SELECT 1 FROM playlist_seen_videos WHERE series_id = ? AND youtube_id = ?)'}`,
    args: [
      uuid(), seriesId, seriesId, video.id,
      `https://www.youtube.com/watch?v=${video.id}`,
      `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`,
      video.title ? 0 : 1, video.title, video.durationSeconds,
      ...leaseArgs(seriesId, lease), seriesId, video.id, ...(restoreRemoved ? [] : [seriesId, video.id]),
    ],
  };
}

function rememberVideos(seriesId: string, videos: YouTubeVideo[], lease: string | null): InStatement[] {
  const statements: InStatement[] = [];
  // Bounded parameter count works on older SQLite/libSQL deployments too.
  for (let i = 0; i < videos.length; i += 200) {
    const ids = videos.slice(i, i + 200).map((v) => v.id);
    statements.push({
      sql: `INSERT OR IGNORE INTO playlist_seen_videos (series_id, youtube_id)
            SELECT ?, column1 FROM (VALUES ${ids.map(() => '(?)').join(',')})
            WHERE ${existsClause(lease)}`,
      args: [seriesId, ...ids, ...leaseArgs(seriesId, lease)],
    });
  }
  return statements;
}

/** Import is atomic: a failed lookup or write leaves no half-created series. */
export async function importPlaylist(
  client: Client,
  userId: string,
  input: string,
  apiKey: string | undefined,
  options: { title?: string; autoSync?: boolean } = {},
  fetcher: typeof fetch = fetch,
): Promise<PlaylistResult & { id: string }> {
  const playlistId = parsePlaylistId(input);
  if (!playlistId) throw new YouTubeError('Enter a valid YouTube playlist URL or ID.', 400);
  const playlist = await fetchYouTubePlaylist(playlistId, apiKey, fetcher);
  const id = uuid();
  const syncedAt = nowIso();
  const title = options.title?.trim().slice(0, 300) || playlist.title;
  const statements: InStatement[] = [{
    sql: `INSERT INTO series
            (id, user_id, title, description, position, playlist_id, playlist_auto_sync,
             playlist_checked_at, playlist_synced_at)
          VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM series WHERE user_id = ?), ?, ?, ?, ?)`,
    args: [id, userId, title, playlist.description, userId, playlistId, options.autoSync === false ? 0 : 1, syncedAt, syncedAt],
  }];
  statements.push(...playlist.videos.map((v) => insertVideo(id, v, null)));
  statements.push(...rememberVideos(id, playlist.videos, null));
  const results = await client.batch(statements, 'write');
  const added = results.slice(1, 1 + playlist.videos.length).reduce((sum, result) => sum + result.rowsAffected, 0);
  return { id, added, durationsUpdated: 0, unavailable: playlist.unavailable, duplicates: playlist.duplicates, syncedAt };
}

/**
 * Fetch every page first, then append only new IDs in one write transaction.
 * A lease stops simultaneous manual/automatic refreshes from racing. Existing
 * ordering, titles, watch state and videos removed from YouTube are untouched.
 */
export async function syncPlaylist(
  client: Client,
  seriesId: string,
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
  options: { restoreRemoved?: boolean } = {},
): Promise<PlaylistResult> {
  requireYouTubeKey(apiKey);
  const row = (await client.execute({ sql: 'SELECT playlist_id FROM series WHERE id = ?', args: [seriesId] })).rows[0];
  if (!row) throw new YouTubeError('Series not found.', 404);
  if (!row.playlist_id) throw new YouTubeError('This series is not linked to a YouTube playlist.', 400);
  const playlistId = String(row.playlist_id);
  const lease = nowIso();
  const staleBefore = new Date(Date.now() - LEASE_MS).toISOString();
  const locked = await client.execute({
    sql: `UPDATE series SET playlist_sync_started_at = ?, playlist_checked_at = ?
          WHERE id = ? AND playlist_id = ?
            AND (playlist_sync_started_at IS NULL OR playlist_sync_started_at < ?)`,
    args: [lease, lease, seriesId, playlistId, staleBefore],
  });
  if (!locked.rowsAffected) throw new YouTubeError('A playlist refresh is already in progress. Please try again shortly.', 409);

  try {
    const playlist: YouTubePlaylist = await fetchYouTubePlaylist(playlistId, apiKey, fetcher);
    const [existing, remembered] = await Promise.all([
      client.execute({ sql: 'SELECT youtube_id, duration_seconds FROM videos WHERE series_id = ? AND youtube_id IS NOT NULL', args: [seriesId] }),
      client.execute({ sql: 'SELECT youtube_id FROM playlist_seen_videos WHERE series_id = ?', args: [seriesId] }),
    ]);
    const existingIds = new Set(existing.rows.map((r) => String(r.youtube_id)));
    const seenIds = new Set(remembered.rows.map((r) => String(r.youtube_id)));
    const needsDuration = new Set(existing.rows.filter((r) => r.duration_seconds == null || Number(r.duration_seconds) <= 0)
      .map((r) => String(r.youtube_id)));
    const additions = playlist.videos.filter((v) => !existingIds.has(v.id) && (options.restoreRemoved || !seenIds.has(v.id)));
    const durationUpdates = playlist.videos.filter((v) => v.durationSeconds != null && needsDuration.has(v.id));
    const syncedAt = nowIso();
    const statements: InStatement[] = additions.map((v) => insertVideo(seriesId, v, lease, options.restoreRemoved));
    statements.push(...durationUpdates.map((v): InStatement => ({
      sql: `UPDATE videos SET duration_seconds = ?
            WHERE series_id = ? AND youtube_id = ? AND (duration_seconds IS NULL OR duration_seconds <= 0)
              AND ${existsClause(lease)}`,
      args: [v.durationSeconds, seriesId, v.id, ...leaseArgs(seriesId, lease)],
    })));
    statements.push(...rememberVideos(seriesId, playlist.videos, lease));
    statements.push({
      sql: `UPDATE series SET playlist_synced_at = ?, playlist_sync_error = NULL, playlist_sync_started_at = NULL
            WHERE id = ? AND playlist_sync_started_at = ?`,
      args: [syncedAt, seriesId, lease],
    });
    const results = await client.batch(statements, 'write');
    if (!results[results.length - 1].rowsAffected) {
      throw new YouTubeError('Series was deleted or the refresh expired. Please try again.', 409);
    }
    const added = results.slice(0, additions.length).reduce((sum, result) => sum + result.rowsAffected, 0);
    const durationsUpdated = results.slice(additions.length, additions.length + durationUpdates.length)
      .reduce((sum, result) => sum + result.rowsAffected, 0);
    return { added, durationsUpdated, unavailable: playlist.unavailable, duplicates: playlist.duplicates, syncedAt };
  } catch (e) {
    const message = e instanceof YouTubeError ? e.message : 'Playlist refresh failed. Please try again.';
    try {
      await client.execute({
        sql: 'UPDATE series SET playlist_sync_error = ?, playlist_sync_started_at = NULL WHERE id = ? AND playlist_sync_started_at = ?',
        args: [message, seriesId, lease],
      });
    } catch {
      // Keep the original error; a stale lease expires automatically.
    }
    throw e;
  }
}

/** Process the oldest due linked series per cron invocation, within free Worker limits. */
export async function syncOneDuePlaylist(client: Client, apiKey: string | undefined, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!apiKey?.trim()) return false;
  const dueBefore = new Date(Date.now() - PLAYLIST_SYNC_INTERVAL_MS).toISOString();
  const staleBefore = new Date(Date.now() - LEASE_MS).toISOString();
  const result = await client.execute({
    sql: `SELECT id FROM series
          WHERE playlist_id IS NOT NULL AND playlist_auto_sync = 1
            AND (playlist_checked_at IS NULL OR playlist_checked_at <= ?)
            AND (playlist_sync_started_at IS NULL OR playlist_sync_started_at < ?)
          ORDER BY COALESCE(playlist_checked_at, ''), id LIMIT 1`,
    args: [dueBefore, staleBefore],
  });
  if (!result.rows.length) return false;
  await syncPlaylist(client, String(result.rows[0].id), apiKey, fetcher);
  return true;
}
