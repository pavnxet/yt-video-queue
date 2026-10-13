import { db } from './db';
import { json, fail, uuid, parseYouTubeId, nowIso } from './util';
import type { Env, SessionUser } from './types';

// ---- ownership helpers ----------------------------------------------------

async function ownSeries(env: Env, userId: string, seriesId: string) {
  const res = await db(env).execute({
    sql: 'SELECT * FROM series WHERE id = ? AND user_id = ?',
    args: [seriesId, userId],
  });
  return res.rows[0] ?? null;
}

async function ownVideo(env: Env, userId: string, videoId: string) {
  const res = await db(env).execute({
    sql: `SELECT v.*, s.user_id AS owner
          FROM videos v JOIN series s ON s.id = v.series_id
          WHERE v.id = ?`,
    args: [videoId],
  });
  const row = res.rows[0];
  if (!row || String(row.owner) !== userId) return null;
  return row;
}

async function safeJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function videoJson(v: any) {
  return {
    id: String(v.id),
    seriesId: String(v.series_id),
    position: Number(v.position),
    youtubeId: String(v.youtube_id),
    title: v.title == null ? null : String(v.title),
    durationSeconds: v.duration_seconds == null ? null : Number(v.duration_seconds),
    status: String(v.status),
    resumeSeconds: Number(v.resume_seconds ?? 0),
    watchedAt: v.watched_at == null ? null : String(v.watched_at),
  };
}

async function fetchTitle(youtubeId: string): Promise<string | null> {
  try {
    const url =
      'https://www.youtube.com/oembed?url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + youtubeId) +
      '&format=json';
    const r = await fetch(url);
    if (!r.ok) return null;
    const j: any = await r.json();
    return typeof j.title === 'string' ? j.title : null;
  } catch {
    return null;
  }
}

// ---- series ---------------------------------------------------------------

export async function listSeries(env: Env, user: SessionUser): Promise<Response> {
  const res = await db(env).execute({
    sql: `SELECT s.id, s.title, s.description, s.position,
            (SELECT COUNT(*) FROM videos v WHERE v.series_id = s.id) AS total,
            (SELECT COUNT(*) FROM videos v WHERE v.series_id = s.id AND v.status = 'done') AS done
          FROM series s
          WHERE s.user_id = ?
          ORDER BY s.position, s.created_at`,
    args: [user.id],
  });
  return json({
    series: res.rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      description: r.description == null ? null : String(r.description),
      position: Number(r.position),
      total: Number(r.total),
      done: Number(r.done),
    })),
  });
}

export async function createSeries(request: Request, env: Env, user: SessionUser): Promise<Response> {
  const body = await safeJson(request);
  const title = String(body.title || '').trim();
  if (!title) return fail('Title is required.');
  const id = uuid();
  const posRes = await db(env).execute({
    sql: 'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM series WHERE user_id = ?',
    args: [user.id],
  });
  const position = Number(posRes.rows[0]?.p ?? 0);
  await db(env).execute({
    sql: 'INSERT INTO series (id, user_id, title, description, position) VALUES (?, ?, ?, ?, ?)',
    args: [id, user.id, title, body.description ? String(body.description) : null, position],
  });
  return json({ id }, 201);
}

export async function getSeries(env: Env, user: SessionUser, seriesId: string): Promise<Response> {
  const s = await ownSeries(env, user.id, seriesId);
  if (!s) return fail('Series not found.', 404);
  const vres = await db(env).execute({
    sql: 'SELECT * FROM videos WHERE series_id = ? ORDER BY position, created_at',
    args: [seriesId],
  });
  return json({
    series: {
      id: String(s.id),
      title: String(s.title),
      description: s.description == null ? null : String(s.description),
    },
    videos: vres.rows.map(videoJson),
  });
}

export async function patchSeries(request: Request, env: Env, user: SessionUser, seriesId: string): Promise<Response> {
  const s = await ownSeries(env, user.id, seriesId);
  if (!s) return fail('Series not found.', 404);
  const body = await safeJson(request);
  const fields: string[] = [];
  const args: any[] = [];
  if (typeof body.title === 'string') {
    fields.push('title = ?');
    args.push(body.title.trim());
  }
  if (typeof body.description === 'string') {
    fields.push('description = ?');
    args.push(body.description);
  }
  if (typeof body.position === 'number') {
    fields.push('position = ?');
    args.push(Math.floor(body.position));
  }
  if (!fields.length) return fail('Nothing to update.');
  fields.push("updated_at = datetime('now')");
  args.push(seriesId);
  await db(env).execute({ sql: `UPDATE series SET ${fields.join(', ')} WHERE id = ?`, args });
  return json({ ok: true });
}

export async function deleteSeries(env: Env, user: SessionUser, seriesId: string): Promise<Response> {
  const s = await ownSeries(env, user.id, seriesId);
  if (!s) return fail('Series not found.', 404);
  await db(env).execute({ sql: 'DELETE FROM videos WHERE series_id = ?', args: [seriesId] });
  await db(env).execute({ sql: 'DELETE FROM series WHERE id = ?', args: [seriesId] });
  return json({ ok: true });
}

// ---- videos ---------------------------------------------------------------

export async function addVideos(request: Request, env: Env, user: SessionUser, seriesId: string): Promise<Response> {
  const s = await ownSeries(env, user.id, seriesId);
  if (!s) return fail('Series not found.', 404);

  const body = await safeJson(request);
  const inputs: string[] = [];
  if (typeof body.url === 'string') inputs.push(body.url);
  if (typeof body.youtubeId === 'string') inputs.push(body.youtubeId);
  if (typeof body.urls === 'string') inputs.push(body.urls);
  if (Array.isArray(body.urls)) for (const u of body.urls) if (typeof u === 'string') inputs.push(u);
  if (!inputs.length) return fail('No links provided.');

  const parsed: string[] = [];
  for (const raw of inputs) {
    for (const piece of raw.split(/[\s,]+/)) {
      if (!piece) continue;
      const ytId = parseYouTubeId(piece);
      if (ytId) parsed.push(ytId);
    }
  }
  if (!parsed.length) return fail('No valid YouTube links found.');

  const posRes = await db(env).execute({
    sql: 'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM videos WHERE series_id = ?',
    args: [seriesId],
  });
  let position = Number(posRes.rows[0]?.p ?? 0);

  const created: string[] = [];
  for (const ytId of parsed) {
    const id = uuid();
    const title = await fetchTitle(ytId); // best-effort, non-fatal
    await db(env).execute({
      sql: 'INSERT INTO videos (id, series_id, position, youtube_id, title) VALUES (?, ?, ?, ?, ?)',
      args: [id, seriesId, position++, ytId, title],
    });
    created.push(id);
  }
  return json({ added: created.length, ids: created }, 201);
}

export async function reorderVideos(request: Request, env: Env, user: SessionUser, seriesId: string): Promise<Response> {
  const s = await ownSeries(env, user.id, seriesId);
  if (!s) return fail('Series not found.', 404);
  const body = await safeJson(request);
  const ordered: string[] = Array.isArray(body.orderedIds) ? body.orderedIds.map(String) : [];
  if (!ordered.length) return fail('orderedIds is required.');

  const res = await db(env).execute({ sql: 'SELECT id FROM videos WHERE series_id = ?', args: [seriesId] });
  const set = new Set(res.rows.map((r) => String(r.id)));
  for (const id of ordered) if (!set.has(id)) return fail('Unknown video id in list.');

  for (let i = 0; i < ordered.length; i++) {
    await db(env).execute({ sql: 'UPDATE videos SET position = ? WHERE id = ?', args: [i, ordered[i]] });
  }
  return json({ ok: true });
}

export async function patchVideo(request: Request, env: Env, user: SessionUser, videoId: string): Promise<Response> {
  const v = await ownVideo(env, user.id, videoId);
  if (!v) return fail('Video not found.', 404);

  const body = await safeJson(request);
  const fields: string[] = [];
  const args: any[] = [];

  if (typeof body.status === 'string') {
    if (!['todo', 'watching', 'done'].includes(body.status)) return fail('Invalid status.');
    fields.push('status = ?');
    args.push(body.status);
    if (body.status === 'done') {
      fields.push('watched_at = ?');
      args.push(nowIso());
    } else {
      fields.push('watched_at = NULL');
    }
  }
  if (typeof body.resumeSeconds === 'number') {
    fields.push('resume_seconds = ?');
    args.push(Math.max(0, Math.floor(body.resumeSeconds)));
  }
  if (typeof body.title === 'string') {
    fields.push('title = ?');
    args.push(body.title);
  }
  if (typeof body.durationSeconds === 'number') {
    fields.push('duration_seconds = ?');
    args.push(Math.floor(body.durationSeconds));
  }
  if (!fields.length) return fail('Nothing to update.');

  args.push(videoId);
  await db(env).execute({ sql: `UPDATE videos SET ${fields.join(', ')} WHERE id = ?`, args });
  return json({ ok: true });
}

export async function deleteVideo(env: Env, user: SessionUser, videoId: string): Promise<Response> {
  const v = await ownVideo(env, user.id, videoId);
  if (!v) return fail('Video not found.', 404);
  await db(env).execute({ sql: 'DELETE FROM videos WHERE id = ?', args: [videoId] });
  return json({ ok: true });
}
