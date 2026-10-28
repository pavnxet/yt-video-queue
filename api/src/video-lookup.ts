import type { Client } from '@libsql/client/web';

/** Keep ownership filtering in the query so lookup never exposes another user's videos. */
export async function lookupVideoRows(client: Client, userId: string, youtubeId: string) {
  const result = await client.execute({
    sql: `SELECT v.*, s.title AS series_title
          FROM videos v JOIN series s ON s.id = v.series_id
          WHERE v.youtube_id = ? AND s.user_id = ?
          ORDER BY s.position, s.created_at, v.position, v.created_at`,
    args: [youtubeId, userId],
  });
  return result.rows;
}
