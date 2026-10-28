import type { Env } from './types';
import { json, fail, errorMessage, timingSafeEqual, throttle, clientIp } from './util';
import { getSessionUser, bearer } from './session';
import { db, initSchema, ensureSchema } from './db';
import { syncOneDuePlaylist } from './playlists';
import { YouTubeError } from './youtube';
import * as auth from './auth';
import * as data from './data';

// The browser aborts its own request after 12s. Answering before that with a
// real error beats being killed at the edge, which only logs `canceled`.
const REQUEST_DEADLINE_MS = 10_000;

// Every body this API accepts is small: a title, a list of links, an assertion.
// 512 KB is far above the largest legitimate request and far below anything
// worth buffering.
const MAX_BODY_BYTES = 512 * 1024;

class RequestTimeout extends Error {}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RequestTimeout(`no response after ${ms}ms`)), ms);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Refuse an oversized body before anything reads it into memory.
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_BODY_BYTES) {
      return json({ error: 'Request body too large.' }, 413, cors);
    }

    let res: Response;
    try {
      res = await withDeadline(route(request, env), REQUEST_DEADLINE_MS);
    } catch (e) {
      if (e instanceof RequestTimeout) {
        console.error('Deadline exceeded:', request.method, new URL(request.url).pathname);
        res = json(
          { error: 'The API took too long to answer. Please try again.', retry: true },
          504,
          { 'Retry-After': '2' },
        );
      } else {
        console.error(e);
        res = json({ error: 'Internal server error', detail: errorMessage(e) }, 500);
      }
    }

    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    // A JSON API should never be sniffed as another type, and a response that
    // carries a session token must not be stored by any cache along the way.
    headers.set('X-Content-Type-Options', 'nosniff');
    if (new URL(request.url).pathname.startsWith('/auth/')) {
      headers.set('Cache-Control', 'no-store');
      headers.set('Pragma', 'no-cache');
    }
    return new Response(res.body, { status: res.status, headers });
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      if (!env.YOUTUBE_API_KEY?.trim()) return;
      await ensureSchema(env);
      await syncOneDuePlaylist(db(env), env.YOUTUBE_API_KEY);
    })().catch((e) => {
      // YouTube errors are sanitised; never log an API URL containing the key.
      console.error('Scheduled playlist refresh failed:', e instanceof YouTubeError ? e.message : 'unexpected error');
    }));
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();
  const seg = path.split('/').filter(Boolean);

  if (path === '/' || path === '/health') {
    return json({ ok: true, service: 'yt-video-queue-api' });
  }

  // Make sure the database schema exists. This runs once per Worker isolate,
  // so the first request after a deploy creates any missing tables.
  await ensureSchema(env);

  // --- setup (protected by bootstrap secret) ---
  if (seg[0] === 'admin' && seg[1] === 'init' && method === 'POST') {
    return adminInit(request, env);
  }

  // --- public auth ---
  if (seg[0] === 'auth') {
    if (seg[1] === 'status' && seg.length === 2 && method === 'GET') return auth.statusHandler(request, env);
    if (seg[1] === 'register' && seg[2] === 'options' && method === 'POST') return auth.registerOptions(request, env);
    if (seg[1] === 'register' && seg[2] === 'verify' && method === 'POST') return auth.registerVerify(request, env);
    if (seg[1] === 'login' && seg[2] === 'options' && method === 'POST') return auth.loginOptions(request, env);
    if (seg[1] === 'login' && seg[2] === 'verify' && method === 'POST') return auth.loginVerify(request, env);
    if (seg[1] === 'logout' && seg.length === 2 && method === 'POST') return auth.logout(request, env);
    if (seg[1] === 'me' && seg.length === 2 && method === 'GET') return auth.me(request, env);
    return fail('Not found', 404);
  }

  // --- everything below requires a session ---
  const user = await getSessionUser(env, bearer(request));
  if (!user) return fail('Unauthorized', 401);

  if (seg[0] === 'series') {
    if (seg.length === 2 && seg[1] === 'import-playlist' && method === 'POST') {
      return data.importPlaylistSeries(request, env, user);
    }
    if (seg.length === 1) {
      if (method === 'GET') return data.listSeries(env, user);
      if (method === 'POST') return data.createSeries(request, env, user);
    }
    if (seg.length === 2) {
      const id = seg[1];
      if (method === 'GET') return data.getSeries(env, user, id);
      if (method === 'PATCH') return data.patchSeries(request, env, user, id);
      if (method === 'DELETE') return data.deleteSeries(env, user, id);
    }
    if (seg.length === 3 && seg[2] === 'videos' && method === 'POST') {
      return data.addVideos(request, env, user, seg[1]);
    }
    if (seg.length === 3 && seg[2] === 'reorder' && method === 'POST') {
      return data.reorderVideos(request, env, user, seg[1]);
    }
    if (seg.length === 3 && seg[2] === 'refresh-playlist' && method === 'POST') {
      return data.refreshPlaylist(request, env, user, seg[1]);
    }
    if (seg.length === 3 && seg[2] === 'refresh-durations' && method === 'POST') {
      return data.refreshDurations(request, env, user, seg[1]);
    }
  }

  if (seg[0] === 'videos' && seg[1] === 'lookup' && seg.length === 2 && method === 'GET') {
    return data.lookupYouTubeVideo(env, user, url.searchParams.get('youtubeId') || '');
  }

  if (seg[0] === 'videos' && seg.length === 2) {
    const id = seg[1];
    if (method === 'PATCH') return data.patchVideo(request, env, user, id);
    if (method === 'DELETE') return data.deleteVideo(env, user, id);
  }

  return fail('Not found', 404);
}

async function adminInit(request: Request, env: Env): Promise<Response> {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  // The schema endpoint is secret-guarded and publicly reachable: constant-time
  // compare, and only a few attempts a minute per client.
  if (!throttle('admin-init:' + clientIp(request), 10, 60_000)) {
    return fail('Too many attempts. Please wait a minute and try again.', 429);
  }
  if (!env.BOOTSTRAP_SECRET ||
      !(await timingSafeEqual(String(body.bootstrapSecret || ''), env.BOOTSTRAP_SECRET))) {
    return fail('Invalid bootstrap secret.', 403);
  }
  await initSchema(env);
  return json({ ok: true, schemaApplied: true });
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const allowed = (env.EXPECTED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  const allow = allowed.includes(origin) ? origin : allowed[0] || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
