import { db } from './db';
import { randomToken, sha256Hex, nowIso } from './util';
import type { Env, SessionUser } from './types';

const SESSION_DAYS = 30;

/** Create a session and return the raw token (only the hash is stored). */
export async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await db(env).execute({
    sql: 'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)',
    args: [id, userId, expires],
  });
  return token;
}

export async function getSessionUser(env: Env, token: string): Promise<SessionUser | null> {
  if (!token) return null;
  const id = await sha256Hex(token);
  const res = await db(env).execute({
    sql: `SELECT u.id, u.username, u.display_name, s.expires_at
          FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = ?`,
    args: [id],
  });
  const row = res.rows[0];
  if (!row) return null;
  if (String(row.expires_at) < nowIso()) {
    await db(env).execute({ sql: 'DELETE FROM sessions WHERE id = ?', args: [id] });
    return null;
  }
  return {
    id: String(row.id),
    username: String(row.username),
    display_name: row.display_name == null ? null : String(row.display_name),
  };
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  if (!token) return;
  const id = await sha256Hex(token);
  await db(env).execute({ sql: 'DELETE FROM sessions WHERE id = ?', args: [id] });
}

/** Read a bearer token from the Authorization header. */
export function bearer(request: Request): string {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}
