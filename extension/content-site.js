/**
 * Runs only on the configured queue site. It hands the signed-in session and
 * API URL to the extension's service worker; the token is then sent only to
 * that API in the Authorization header. No YouTube page can read it.
 */
const TOKEN_KEY = 'ytq_token';
const CONFIG_CACHE_MS = 60000;
let cachedApiBase = '';
let configCheckedAt = 0;
let lastSent = '';
let syncing = false;

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

async function readApiBase() {
  if (cachedApiBase && Date.now() - configCheckedAt < CONFIG_CACHE_MS) return cachedApiBase;
  configCheckedAt = Date.now();
  try {
    const res = await fetch(new URL('/yt-video-queue/config.js', location.origin).href, { cache: 'no-store' });
    if (!res.ok) return '';
    const text = await res.text();
    const m = text.match(/API_BASE_URL\s*=\s*["']([^"']+)["']/);
    cachedApiBase = m && m[1] && !m[1].includes('REPLACE_WITH') ? m[1].replace(/\/+$/, '') : '';
    return cachedApiBase;
  } catch { return ''; }
}

async function sync(force) {
  if (syncing) return;
  syncing = true;
  try {
    const token = readToken();
    const apiBaseUrl = await readApiBase();
    if (!apiBaseUrl) return; // never send a session without its matching API URL
    const fingerprint = token + '|' + apiBaseUrl;
    if (!force && fingerprint === lastSent) return;
    const result = await chrome.runtime.sendMessage({ type: 'site', token, apiBaseUrl });
    // A failed message must be retried rather than remembered as delivered.
    if (result && result.ok) lastSent = fingerprint;
  } catch { /* retry on the next tick */ }
  finally { syncing = false; }
}

sync(true);
// Same-tab localStorage changes do not emit a storage event, so poll the token;
// config.js itself is cached above and is not fetched every four seconds.
setInterval(() => sync(false), 4000);
window.addEventListener('focus', () => sync(false));
window.addEventListener('storage', (e) => { if (!e.key || e.key === TOKEN_KEY) sync(true); });
