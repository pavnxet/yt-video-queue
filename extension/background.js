/**
 * YT Video Queue — Save
 * Service worker. The only place that talks to the YT Video Queue API.
 *
 * Everything the extension knows lives in chrome.storage.local on this machine:
 * your API base URL, your session token, your last-used series and a couple of
 * preferences. Nothing is sent anywhere except your own Worker.
 */

const DEFAULTS = {
  apiBaseUrl: '',
  token: '',
  lastSeriesId: '',
  lastSeriesTitle: '',
  settings: {
    showPill: true,      // floating "Save to queue" button on YouTube
    recordResume: true,  // remember the position you were at
    confirmDupes: true   // warn instead of silently skipping duplicates
  }
};

const API_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------- storage

async function getConfig() {
  const raw = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return {
    ...DEFAULTS,
    ...raw,
    settings: { ...DEFAULTS.settings, ...(raw.settings || {}) }
  };
}

async function setConfig(patch) {
  await chrome.storage.local.set(patch);
  return getConfig();
}

// ---------------------------------------------------------------- api

function trimUrl(u) {
  return String(u || '').replace(/\/+$/, '');
}

/** One place where every API call goes through. Returns a plain result object. */
async function api(path, opts = {}) {
  const cfg = await getConfig();
  const base = trimUrl(cfg.apiBaseUrl);
  if (!base) return { ok: false, error: 'No API URL set. Open the extension settings.', needSetup: true };

  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };
  if (cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(base + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    const timedOut = e && e.name === 'AbortError';
    return { ok: false, error: timedOut ? 'The API did not respond in time.' : ('Could not reach the API. ' + (e && e.message ? e.message : '')) };
  }
  clearTimeout(timer);

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (res.status === 401) {
    await chrome.storage.local.set({ token: '' });
    return { ok: false, status: 401, error: 'Session expired. Open the queue site and sign in again.', unauthorized: true };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: (data && (data.error || data.detail)) || ('Request failed (' + res.status + ')') };
  }
  return { ok: true, status: res.status, data };
}

// ---------------------------------------------------------------- helpers

function youtubeIdFrom(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || '';
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
  } catch { /* not a url */ }
  const bare = String(url).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(bare)) return bare;
  return '';
}

function badgeFlash(text, color) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: color || '#D97757' });
    chrome.action.setBadgeText({ text });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3500);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- core actions

async function listSeries() {
  const r = await api('/series');
  if (!r.ok) return r;
  return { ok: true, series: (r.data && r.data.series) || [] };
}

async function createSeries(title, description) {
  const r = await api('/series', { method: 'POST', body: { title, description: description || '' } });
  if (!r.ok) return r;
  return { ok: true, id: r.data && r.data.id };
}

async function seriesVideos(seriesId) {
  const r = await api('/series/' + encodeURIComponent(seriesId));
  if (!r.ok) return r;
  return { ok: true, series: r.data.series, videos: r.data.videos || [] };
}

async function testConnection() {
  const r = await api('/series');
  if (!r.ok) return r;
  return { ok: true, seriesCount: (r.data && r.data.series ? r.data.series.length : 0) };
}

/**
 * Save one video. Dedupe-aware, and optionally records the duration and the
 * position you were at so you can resume later.
 */
async function saveVideo({ seriesId, url, durationSeconds, resumeSeconds, title }) {
  const cfg = await getConfig();
  const sid = seriesId || cfg.lastSeriesId;
  if (!sid) return { ok: false, needSeries: true, error: 'Pick a series first.' };

  const vid = youtubeIdFrom(url);
  if (!vid) return { ok: false, error: 'That does not look like a YouTube video.' };

  // Duplicate check: is this video already in the chosen series?
  const existing = await seriesVideos(sid);
  if (!existing.ok) return existing;
  const already = existing.videos.find((v) => v.youtubeId === vid);
  if (already) {
    return {
      ok: false,
      duplicate: true,
      title: already.title || title || 'This video',
      seriesTitle: existing.series && existing.series.title
    };
  }

  const add = await api('/series/' + encodeURIComponent(sid) + '/videos', { method: 'POST', body: { url } });
  if (!add.ok) return add;
  const ids = (add.data && add.data.ids) || [];

  // Remember duration + resume position on the freshly added row.
  if (cfg.settings.recordResume && ids.length) {
    const patch = {};
    if (typeof durationSeconds === 'number' && durationSeconds > 0) patch.durationSeconds = Math.round(durationSeconds);
    if (typeof resumeSeconds === 'number' && resumeSeconds > 0) patch.resumeSeconds = Math.round(resumeSeconds);
    if (Object.keys(patch).length) {
      await api('/videos/' + encodeURIComponent(ids[0]), { method: 'PATCH', body: patch });
    }
  }

  await chrome.storage.local.set({ lastSeriesId: sid, lastSeriesTitle: (existing.series && existing.series.title) || cfg.lastSeriesTitle });
  badgeFlash('✓', '#2F7D5B');
  return { ok: true, added: (add.data && add.data.added) || ids.length, ids, seriesTitle: existing.series && existing.series.title };
}

/** Save many links at once (a playlist, or a paste). Server batches metadata. */
async function saveMany({ seriesId, urls }) {
  const cfg = await getConfig();
  const sid = seriesId || cfg.lastSeriesId;
  if (!sid) return { ok: false, needSeries: true, error: 'Pick a series first.' };
  const list = (urls || []).filter(Boolean);
  if (!list.length) return { ok: false, error: 'No videos to save.' };

  let added = 0, skipped = 0;
  for (let i = 0; i < list.length; i += 20) {
    const chunk = list.slice(i, i + 20).join('\n');
    const r = await api('/series/' + encodeURIComponent(sid) + '/videos', { method: 'POST', body: { urls: chunk } });
    if (!r.ok) return r;
    added += (r.data && r.data.added) || 0;
    skipped += (r.data && r.data.skipped) || 0;
  }
  badgeFlash('+' + added, '#2F7D5B');
  return { ok: true, added, skipped };
}

// ---------------------------------------------------------------- message router

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'state': {
          const cfg = await getConfig();
          sendResponse({
            ok: true,
            apiBaseUrl: cfg.apiBaseUrl,
            hasToken: !!cfg.token,
            lastSeriesId: cfg.lastSeriesId,
            lastSeriesTitle: cfg.lastSeriesTitle,
            settings: cfg.settings
          });
          break;
        }
        case 'setConfig': {
          const patch = { ...(msg.patch || {}) };
          if (patch.settings) {
            const cfg = await getConfig();
            patch.settings = { ...cfg.settings, ...patch.settings };
          }
          const cfg = await setConfig(patch);
          sendResponse({ ok: true, apiBaseUrl: cfg.apiBaseUrl, hasToken: !!cfg.token, settings: cfg.settings, lastSeriesId: cfg.lastSeriesId });
          break;
        }
        case 'clearToken':
          await chrome.storage.local.set({ token: '' });
          sendResponse({ ok: true });
          break;
        case 'test':
          sendResponse(await testConnection());
          break;
        case 'series':
          sendResponse(await listSeries());
          break;
        case 'createSeries':
          sendResponse(await createSeries(msg.title, msg.description));
          break;
        case 'seriesVideos':
          sendResponse(await seriesVideos(msg.seriesId));
          break;
        case 'save':
          sendResponse(await saveVideo(msg));
          break;
        case 'saveMany':
          sendResponse(await saveMany(msg));
          break;
        case 'site': {
          // From the queue site's content script: pick up the token + API URL.
          const patch = {};
          if (msg.apiBaseUrl) patch.apiBaseUrl = trimUrl(msg.apiBaseUrl);
          if (msg.token) patch.token = msg.token;
          if (Object.keys(patch).length) await setConfig(patch);
          sendResponse({ ok: true, saved: Object.keys(patch) });
          break;
        }
        case 'openOptions':
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: 'Unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    }
  })();
  return true; // keep the channel open for the async reply
});

// ---------------------------------------------------------------- context menu

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'ytq-save-link',
      title: 'Save link to YT Video Queue',
      contexts: ['link']
    });
    chrome.contextMenus.create({
      id: 'ytq-save-page',
      title: 'Save this video to YT Video Queue',
      contexts: ['page'],
      documentUrlPatterns: ['*://*.youtube.com/*']
    });
  });
}

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'ytq-save-link' ? info.linkUrl : (info.pageUrl || (tab && tab.url));
  if (!url) return;
  const cfg = await getConfig();
  if (!cfg.lastSeriesId) {
    // Nothing chosen yet — remember it and send the user to the popup.
    await chrome.storage.local.set({ pendingSave: url });
    try { await chrome.action.openPopup(); } catch { chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') }); }
    return;
  }
  const r = await saveVideo({ url });
  if (!r.ok && r.duplicate) badgeFlash('!', '#B4791F');
  if (!r.ok && !r.duplicate) badgeFlash('×', '#C0392B');
});

// ---------------------------------------------------------------- keyboard shortcut

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-current-video') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/youtube\.com/.test(tab.url || '')) { badgeFlash('×', '#C0392B'); return; }
  try {
    const info = await chrome.tabs.sendMessage(tab.id, { type: 'getVideoInfo' });
    if (!info || !info.url) { badgeFlash('×', '#C0392B'); return; }
    const cfg = await getConfig();
    if (!cfg.lastSeriesId) {
      await chrome.storage.local.set({ pendingSave: info.url });
      try { await chrome.action.openPopup(); } catch { chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') }); }
      return;
    }
    const r = await saveVideo({ url: info.url, durationSeconds: info.durationSeconds, resumeSeconds: info.currentTime });
    if (!r.ok && r.duplicate) badgeFlash('!', '#B4791F');
    if (!r.ok && !r.duplicate) badgeFlash('×', '#C0392B');
  } catch {
    badgeFlash('×', '#C0392B');
  }
});
