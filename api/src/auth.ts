import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { db } from './db';
import {
  json,
  fail,
  uuid,
  randomToken,
  nowIso,
  fromBase64url,
  base64url,
  errorMessage,
} from './util';
import { createSession, getSessionUser, deleteSession, bearer } from './session';
import type { Env } from './types';

const OWNER_USERNAME = 'owner';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// ---- config helpers -------------------------------------------------------

async function getConfig(env: Env, key: string): Promise<string | null> {
  try {
    const res = await db(env).execute({ sql: 'SELECT value FROM app_config WHERE key = ?', args: [key] });
    const row = res.rows[0];
    return row ? String(row.value) : null;
  } catch (e) {
    // A database whose first migration has not landed yet must read as "not
    // configured" — that gives the login screen its "register first" message
    // instead of a 500.
    if (/no such table/i.test(errorMessage(e))) return null;
    throw e;
  }
}

async function setConfig(env: Env, key: string, value: string): Promise<void> {
  await db(env).execute({
    sql: `INSERT INTO app_config (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
}

async function ownerUser(env: Env) {
  const res = await db(env).execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [OWNER_USERNAME] });
  return res.rows[0] ?? null;
}

async function safeJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// ---- challenge storage (consumed once, anti-replay) -----------------------

async function saveChallenge(env: Env, kind: string, challenge: string, userId: string | null): Promise<string> {
  const id = randomToken(18);
  await db(env).execute({
    sql: 'INSERT INTO webauthn_challenges (id, challenge, user_id, kind, expires_at) VALUES (?, ?, ?, ?, ?)',
    args: [id, challenge, userId, kind, new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()],
  });
  return id;
}

async function takeChallenge(
  env: Env,
  id: string,
  kind: string,
): Promise<{ challenge: string; user_id: string | null } | null> {
  if (!id) return null;
  const res = await db(env).execute({ sql: 'SELECT * FROM webauthn_challenges WHERE id = ?', args: [id] });
  const row = res.rows[0];
  // Always delete, even on failure — a challenge is single-use.
  await db(env).execute({ sql: 'DELETE FROM webauthn_challenges WHERE id = ?', args: [id] });
  if (!row) return null;
  if (String(row.kind) !== kind) return null;
  if (String(row.expires_at) < nowIso()) return null;
  return { challenge: String(row.challenge), user_id: row.user_id == null ? null : String(row.user_id) };
}

// ---- endpoints ------------------------------------------------------------

// GET /auth/status — public. One call answers everything the page needs on load:
// whether registration is open, and whether the caller's session is still valid,
// so startup costs a single round trip instead of two.
export async function statusHandler(request: Request, env: Env): Promise<Response> {
  // Sequential on purpose: two queries run concurrently against one libSQL
  // client is not worth the risk, and the browser still makes a single call.
  const ownerRegistered = (await getConfig(env, 'owner_registered')) === '1';
  const token = bearer(request);
  const user = token ? await getSessionUser(env, token) : null;
  const authMode = env.AUTH_MODE || 'owner';
  return json({
    authMode,
    ownerRegistered,
    registrationOpen: authMode !== 'owner' || !ownerRegistered,
    user: user || null,
  });
}

/** POST /auth/register/options */
export async function registerOptions(request: Request, env: Env): Promise<Response> {
  const body = await safeJson(request);
  const authMode = env.AUTH_MODE || 'owner';
  const ownerRegistered = (await getConfig(env, 'owner_registered')) === '1';

  if (authMode === 'owner') {
    const allowReenroll = (await getConfig(env, 'allow_reenroll')) === '1';
    if (ownerRegistered && !allowReenroll) {
      return fail('Registration is closed. Only the owner passkey can sign in.', 403);
    }
    const provided = String(body.bootstrapSecret || '');
    if (!env.BOOTSTRAP_SECRET || provided !== env.BOOTSTRAP_SECRET) {
      return fail('Invalid bootstrap secret.', 403);
    }
  }

  let user = await ownerUser(env);
  if (!user) {
    const id = uuid();
    await db(env).execute({
      sql: 'INSERT INTO users (id, username, display_name, is_owner) VALUES (?, ?, ?, 1)',
      args: [id, OWNER_USERNAME, 'Owner'],
    });
    user = await ownerUser(env);
  }
  const userId = String(user!.id);

  const credRes = await db(env).execute({
    sql: 'SELECT id, transports FROM credentials WHERE user_id = ?',
    args: [userId],
  });
  const excludeCredentials = credRes.rows.map((r) => ({
    id: String(r.id),
    transports: r.transports ? JSON.parse(String(r.transports)) : undefined,
  }));

  const options = await generateRegistrationOptions({
    rpName: env.RP_NAME || 'YT Video Queue',
    rpID: env.RP_ID,
    userName: OWNER_USERNAME,
    userDisplayName: 'Owner',
    attestationType: 'none',
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
  });

  const ceremonyId = await saveChallenge(env, 'register', options.challenge, userId);
  return json({ ceremonyId, options });
}

/** POST /auth/register/verify */
export async function registerVerify(request: Request, env: Env): Promise<Response> {
  const body = await safeJson(request);
  const taken = await takeChallenge(env, String(body.ceremonyId || ''), 'register');
  if (!taken || !taken.user_id) return fail('Registration session expired. Please try again.', 400);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: taken.challenge,
      expectedOrigin: env.EXPECTED_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
      expectedRPID: env.RP_ID,
      requireUserVerification: false,
    });
  } catch (e) {
    return fail('Registration verification failed: ' + errorMessage(e), 400);
  }
  if (!verification.verified || !verification.registrationInfo) {
    return fail('Registration not verified.', 400);
  }

  const { credential } = verification.registrationInfo;
  const userId = taken.user_id;
  await db(env).execute({
    sql: `INSERT OR REPLACE INTO credentials
          (id, user_id, public_key, counter, transports, device_label, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      credential.id,
      userId,
      base64url(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? body.response?.response?.transports ?? []),
      null,
      nowIso(),
    ],
  });

  await setConfig(env, 'owner_registered', '1');
  await setConfig(env, 'allow_reenroll', '0');

  const token = await createSession(env, userId);
  return json({ verified: true, token, user: { id: userId, username: OWNER_USERNAME } });
}

/** POST /auth/login/options */
export async function loginOptions(env: Env): Promise<Response> {
  const ownerRegistered = (await getConfig(env, 'owner_registered')) === '1';
  if (!ownerRegistered) {
    return fail('No passkey registered yet. Register this device first.', 409);
  }
  const options = await generateAuthenticationOptions({
    rpID: env.RP_ID,
    allowCredentials: [], // discoverable credentials — user picks the passkey
    userVerification: 'preferred',
  });
  const ceremonyId = await saveChallenge(env, 'login', options.challenge, null);
  return json({ ceremonyId, options });
}

/** POST /auth/login/verify */
export async function loginVerify(request: Request, env: Env): Promise<Response> {
  const body = await safeJson(request);
  const taken = await takeChallenge(env, String(body.ceremonyId || ''), 'login');
  if (!taken) return fail('Login session expired. Please try again.', 400);

  const credId = String(body.response?.id || '');
  const credRes = await db(env).execute({ sql: 'SELECT * FROM credentials WHERE id = ?', args: [credId] });
  const cred = credRes.rows[0];
  if (!cred) return fail('This passkey is not registered on this site.', 400);

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: taken.challenge,
      expectedOrigin: env.EXPECTED_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
      expectedRPID: env.RP_ID,
      credential: {
        id: String(cred.id),
        publicKey: fromBase64url(String(cred.public_key)),
        counter: Number(cred.counter),
        transports: cred.transports ? JSON.parse(String(cred.transports)) : undefined,
      },
      requireUserVerification: false,
    });
  } catch (e) {
    return fail('Login verification failed: ' + errorMessage(e), 400);
  }
  if (!verification.verified) return fail('Login not verified.', 400);

  await db(env).execute({
    sql: 'UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?',
    args: [verification.authenticationInfo.newCounter, nowIso(), String(cred.id)],
  });

  const token = await createSession(env, String(cred.user_id));
  return json({ verified: true, token, user: { id: String(cred.user_id) } });
}

/** POST /auth/logout */
export async function logout(request: Request, env: Env): Promise<Response> {
  await deleteSession(env, bearer(request));
  return json({ ok: true });
}

/** GET /auth/me */
export async function me(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(env, bearer(request));
  if (!user) return fail('Unauthorized', 401);
  const credRes = await db(env).execute({
    sql: 'SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?',
    args: [user.id],
  });
  return json({ user, credentialCount: Number(credRes.rows[0]?.n ?? 0) });
}
