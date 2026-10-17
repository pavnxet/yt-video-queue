/**
 * YT Video Queue — Save
 * Runs on your queue site (pavnxet.github.io/yt-video-queue).
 *
 * It quietly hands the extension two things it needs: the session token the
 * site already keeps in localStorage, and the API base URL from config.js.
 * Nothing else is read, and nothing leaves your machine.
 */

const TOKEN_KEY = 'ytq_token';

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

async function readApiBase() {
  try {
    const res = await fetch('./config.js', { cache: 'no-store' });
    if (!res.ok) return '';
    const text = await res.text();
    const m = text.match(/API_BASE_URL\s*=\s*["']([^"']+)["']/);
    if (m && m[1] && !m[1].includes('REPLACE_WITH')) return m[1].replace(/\/+$/, '');
  } catch { /* ignore */ }
  return '';
}

let lastSent = '';

async function sync(force) {
  const token = readToken();
  const apiBaseUrl = await readApiBase();
  const fingerprint = token + '|' + apiBaseUrl;
  if (!force && fingerprint === lastSent) return;
  if (!token && !apiBaseUrl) return;
  lastSent = fingerprint;
  try {
    await chrome.runtime.sendMessage({ type: 'site', token, apiBaseUrl });
  } catch { /* the worker may be asleep; it will retry on the next tick */ }
}

sync(true);

// The token changes when you sign in or out, and the page does not reload.
setInterval(() => sync(false), 4000);
window.addEventListener('focus', () => sync(false));
window.addEventListener('storage', (e) => { if (!e.key || e.key === TOKEN_KEY) sync(true); });
