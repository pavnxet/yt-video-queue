import type { Client } from '@libsql/client/web';
import { fetchYouTubeVideos, YouTubeError } from './youtube';

const BATCH_SIZE = 500;

/**
 * Fill a page of missing durations. An ID cursor keeps unavailable videos from
 * blocking later pages and stays stable as successful updates leave the result.
 */
export async function fillMissingDurations(
  client: Client,
  seriesId: string,
  apiKey: string | undefined,
  after = '',
  fetcher: typeof fetch = fetch,
): Promise<{ updated: number; attempted: number; nextCursor: string | null }> {
  if (after.length > 200) throw new YouTubeError('Invalid duration cursor.', 400);
  const result = await client.execute({
    sql: `SELECT id, youtube_id FROM videos WHERE series_id = ? AND youtube_id IS NOT NULL
          AND (duration_seconds IS NULL OR duration_seconds <= 0) AND id > ?
          ORDER BY id LIMIT ?`,
    args: [seriesId, after, BATCH_SIZE + 1],
  });
  const rows = result.rows.slice(0, BATCH_SIZE);
  if (!rows.length) return { updated: 0, attempted: 0, nextCursor: null };

  const details = await fetchYouTubeVideos(rows.map((row) => String(row.youtube_id)), apiKey, fetcher);
  const updates = rows.flatMap((row) => {
    const seconds = details.get(String(row.youtube_id))?.durationSeconds;
    return seconds ? [{
      sql: `UPDATE videos SET duration_seconds = ? WHERE id = ? AND series_id = ?
            AND (duration_seconds IS NULL OR duration_seconds <= 0)`,
      args: [seconds, String(row.id), seriesId],
    }] : [];
  });
  const writes = updates.length ? await client.batch(updates, 'write') : [];
  return {
    updated: writes.reduce((sum, row) => sum + row.rowsAffected, 0),
    attempted: rows.length,
    nextCursor: result.rows.length > BATCH_SIZE ? String(rows[rows.length - 1].id) : null,
  };
}
