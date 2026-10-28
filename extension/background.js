/**
 * YT Video Queue — Save
 * Service worker. The only place that talks to the YT Video Queue API.
 *
 * Everything the extension knows lives in chrome.storage.local on this machine:
 * your API base URL, your session token, your last-used series and a couple of
 * preferences. Nothing is sent anywhere except your own Worker.
 */

importScripts('shared.js');

const DEFAULTS = {
  apiBaseUrl: '',
  token: '',
  tokenSource: '', // 'site' or 'manual'; avoids clearing a manually entered session
  lastSeriesId: '',
  lastSeriesTitle: '',
  settings: {
    showPill: true,      // floating "Save to queue" button on YouTube
    recordResume: true   // remember the position you were at
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
  return String(u || '').trim().replace(/\/+$/, '');
}

// Never send a bearer token to an insecure remote origin or to a URL with
// credentials/query parameters. Local HTTP is useful for development only.
function normalizeApiBase(input) {
  const raw = trimUrl(input);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
        url.username || url.password || url.search || url.hash) return null;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { return null; }
}

function isExtensionPage(sender) {
  return typeof sender?.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

function isQueueSite(sender) {
  try {
    const url = new URL(sender?.url || '');
    return url.origin === 'https://pavnxet.github.io' &&
      (url.pathname === '/yt-video-queue' || url.pathname.startsWith('/yt-video-queue/'));
  } catch { return false; }
}

/** One place where every API call goes through. Returns a plain result object. */
async function api(path, opts = {}) {
  const cfg = await getConfig();
  const base = normalizeApiBase(cfg.apiBaseUrl);
  if (base === null) return { ok: false, error: 'Invalid API URL. Use HTTPS (or localhost for development).', needSetup: true };
  if (!base || !cfg.token) return { ok: false, error: 'Connect your queue in extension settings first.', needSetup: true };

  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Authorization: 'Bearer ' + cfg.token };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || API_TIMEOUT_MS);
  let res, text;
  try {
    res = await fetch(base + path, {
      method: opts.method || 'GET', headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal
    });
    text = await res.text();
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    return { ok: false, error: timedOut ? 'The API did not respond in time.' : 'Could not reach the API. Check the URL and host permission.' };
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (res.status === 401) {
    // A stale in-flight request must not erase a newer session handed off by
    // the site while the request was in progress.
    const latest = await getConfig();
    if (latest.token === cfg.token && normalizeApiBase(latest.apiBaseUrl) === base) {
      await chrome.storage.local.set({ token: '', tokenSource: '' });
    }
    return { ok: false, status: 401, error: 'Session expired. Open the queue site and sign in again.', unauthorized: true };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: (data && (data.error || data.detail)) || ('Request failed (' + res.status + ')') };
  }
  if (!data || typeof data !== 'object') return { ok: false, error: 'The API returned an invalid response.' };
  return { ok: true, status: res.status, data };
}

// ---------------------------------------------------------------- helpers

const youtubeIdFrom = YTQShared.videoIdFrom;

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
  return { ok: true, series: Array.isArray(r.data.series) ? r.data.series : [] };
}

async function createSeries(title, description) {
  const clean = String(title || '').trim();
  if (!clean) return { ok: false, error: 'Enter a series title.' };
  const r = await api('/series', { method: 'POST', body: { title: clean, description: description || '' } });
  if (!r.ok) return r;
  return r.data.id ? { ok: true, id: r.data.id } : { ok: false, error: 'The API did not return a series ID.' };
}

async function seriesVideos(seriesId) {
  if (!seriesId) return { ok: false, error: 'Pick a series first.' };
  const r = await api('/series/' + encodeURIComponent(seriesId));
  if (!r.ok) return r;
  if (!r.data.series || !Array.isArray(r.data.videos)) return { ok: false, error: 'The API returned an invalid series.' };
  return { ok: true, series: r.data.series, videos: r.data.videos };
}

async function testConnection() {
  const r = await listSeries();
  return r.ok ? { ok: true, seriesCount: r.series.length } : r;
}

/** Save one video with duplicate checking and an optional playback position. */
async function saveVideo({ seriesId, url, durationSeconds, resumeSeconds, title }) {
  const cfg = await getConfig();
  const sid = seriesId || cfg.lastSeriesId;
  if (!sid) return { ok: false, needSeries: true, error: 'Pick a series first.' };
  const vid = youtubeIdFrom(url);
  if (!vid) return { ok: false, error: 'That does not look like a YouTube video.' };

  const existing = await seriesVideos(sid);
  if (!existing.ok) return existing;
  const already = existing.videos.find((v) => v.youtubeId === vid);
  if (already) return {
    ok: false, duplicate: true, title: already.title || title || 'This video',
    seriesTitle: existing.series && existing.series.title,
  };

  const add = await api('/series/' + encodeURIComponent(sid) + '/videos', {
    method: 'POST', body: { url: 'https://www.youtube.com/watch?v=' + vid }, timeoutMs: 90000,
  });
  if (!add.ok) {
    if (!add.status || add.status >= 500) return { ...add, error: add.error + ' The save may have completed; check the series before retrying.' };
    return add;
  }
  const ids = Array.isArray(add.data.ids) ? add.data.ids : [];
  if (!ids.length) return { ok: false, error: 'Could not confirm whether the video was saved. Check the series before retrying.' };

  // Record the duration even when resume is disabled; it powers analytics.
  // Never overwrite a duration already found by the API or edited by the user.
  const patch = {};
  const duration = Math.round(Number(durationSeconds));
  const resume = Math.round(Number(resumeSeconds));
  if (Number.isFinite(duration) && duration > 0 && duration <= 31536000) {
    patch.durationSeconds = duration;
    patch.durationIfMissing = true;
  }
  if (cfg.settings.recordResume && Number.isFinite(resume) && resume > 0) {
    patch.resumeSeconds = resume;
    patch.status = 'watching';
  }
  let warning = '';
  if (Object.keys(patch).length) {
    const updated = await api('/videos/' + encodeURIComponent(ids[0]), { method: 'PATCH', body: patch });
    if (!updated.ok) warning = 'Video saved, but duration or position could not be recorded: ' + updated.error;
    else if (updated.data.updated === false) warning = 'Video saved, but its progress was not recorded because it was already marked watched.';
  }

  await chrome.storage.local.set({ lastSeriesId: sid, lastSeriesTitle: existing.series.title || cfg.lastSeriesTitle });
  badgeFlash('✓', '#2F7D5B');
  return { ok: true, added: Number(add.data.added) || ids.length, ids, seriesTitle: existing.series.title, warning };
}

/** Add the rendered playlist items to a series, excluding duplicates. */
async function saveMany({ seriesId, urls }) {
  const cfg = await getConfig();
  const sid = seriesId || cfg.lastSeriesId;
  if (!sid) return { ok: false, needSeries: true, error: 'Pick a series first.' };
  if (!Array.isArray(urls) || !urls.length) return { ok: false, error: 'No videos to save.' };
  const existing = await seriesVideos(sid);
  if (!existing.ok) return existing;
  const seen = new Set(existing.videos.map((v) => v.youtubeId).filter(Boolean));
  const list = [];
  let skipped = 0, duplicates = 0;
  for (const url of urls) {
    const id = youtubeIdFrom(url);
    if (!id) { skipped++; continue; }
    if (seen.has(id)) { duplicates++; continue; }
    seen.add(id);
    list.push('https://www.youtube.com/watch?v=' + id);
  }
  let added = 0;
  for (let i = 0; i < list.length; i += 20) {
    const r = await api('/series/' + encodeURIComponent(sid) + '/videos', {
      method: 'POST', body: { urls: list.slice(i, i + 20).join('\n') }, timeoutMs: 90000,
    });
    if (!r.ok) return { ...r, added, skipped, duplicates, error: `${r.error} (${added} confirmed in earlier batches. The failed batch may also have partially saved; check the series before retrying.)` };
    added += Number(r.data.added) || 0;
    skipped += Number(r.data.skipped) || 0;
  }
  await chrome.storage.local.set({ lastSeriesId: sid, lastSeriesTitle: existing.series.title || cfg.lastSeriesTitle });
  if (added) badgeFlash('+' + added, '#2F7D5B');
  return { ok: true, added, skipped, duplicates };
}

/** Import a whole public/unlisted playlist as a linked, auto-syncing series. */
async function importPlaylist({ url, title, autoSync }) {
  const playlistUrl = YTQShared.playlistUrl(url);
  if (!playlistUrl) return { ok: false, error: 'Open or enter a valid YouTube playlist URL.' };
  const r = await api('/series/import-playlist', {
    method: 'POST', body: { url: playlistUrl, title: String(title || '').trim(), autoSync: autoSync !== false }, timeoutMs: 180000,
  });
  if (!r.ok) {
    if (!r.status || r.status >= 500) return { ...r, error: r.error + ' If the request timed out, check your series before retrying.' };
    return r;
  }
  if (!r.data.id) return { ok: false, error: 'Could not confirm the import. Check your series before retrying.' };
  await chrome.storage.local.set({ lastSeriesId: r.data.id, lastSeriesTitle: '' });
  badgeFlash('✓', '#2F7D5B');
  return { ok: true, ...r.data };
}

async function refreshPlaylist({ seriesId, restoreRemoved }) {
  if (!seriesId) return { ok: false, error: 'Pick a linked series first.' };
  const r = await api('/series/' + encodeURIComponent(seriesId) + '/refresh-playlist', {
    method: 'POST', body: { restoreRemoved: restoreRemoved === true }, timeoutMs: 180000,
  });
  if (!r.ok && !r.status) return { ...r, error: r.error + ' The refresh may still complete; check the series before retrying.' };
  return r.ok ? { ok: true, ...r.data } : r;
}

async function setAutoSync({ seriesId, enabled }) {
  if (!seriesId || typeof enabled !== 'boolean') return { ok: false, error: 'Pick a linked series first.' };
  const r = await api('/series/' + encodeURIComponent(seriesId), { method: 'PATCH', body: { autoSync: enabled } });
  return r.ok ? { ok: true } : r;
}

/** One indexed lookup; fall back to older Workers that predate the endpoint. */
async function findVideo(youtubeId) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(youtubeId || ''))) return { ok: true, found: false, matches: [] };
  const r = await api('/videos/lookup?youtubeId=' + encodeURIComponent(youtubeId));
  if (r.ok) {
    const matches = Array.isArray(r.data.matches) ? r.data.matches : [];
    return { ok: true, found: matches.length > 0, matches };
  }
  if (r.status !== 404) return r;
  const list = await listSeries();
  if (!list.ok) return list;
  const matches = [];
  for (let i = 0; i < list.series.length; i += 5) {
    const got = await Promise.all(list.series.slice(i, i + 5).map((s) => seriesVideos(s.id)));
    for (const item of got) {
      if (!item.ok) {
        if (item.status === 404) continue;
        return item; // do not incorrectly claim the video is absent on an API failure
      }
      for (const video of item.videos.filter((v) => v.youtubeId === youtubeId)) {
        matches.push({ seriesId: item.series.id, seriesTitle: item.series.title, video });
      }
    }
  }
  return { ok: true, found: matches.length > 0, matches };
}

/** Update a queued video's status, resume position or missing duration. */
async function patchVideo({ videoId, status, resumeSeconds, durationSeconds }) {
  if (!videoId) return { ok: false, error: 'No video id.' };
  const body = {};
  if (status != null) {
    if (!['todo', 'watching', 'done'].includes(status)) return { ok: false, error: 'Invalid watch status.' };
    body.status = status;
  }
  if (typeof resumeSeconds === 'number' && Number.isFinite(resumeSeconds)) body.resumeSeconds = Math.max(0, Math.round(resumeSeconds));
  const duration = Math.round(Number(durationSeconds));
  if (Number.isFinite(duration) && duration > 0 && duration <= 31536000) {
    body.durationSeconds = duration;
    body.durationIfMissing = true;
  }
  if (!Object.keys(body).length) return { ok: false, error: 'Nothing to update.' };
  const r = await api('/videos/' + encodeURIComponent(videoId), { method: 'PATCH', body });
  if (!r.ok) return r;
  if (r.data.updated === false) return { ok: false, error: 'This video is already watched. Refresh its status before saving progress.' };
  return { ok: true };
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
          const requested = msg.patch && typeof msg.patch === 'object' ? msg.patch : {};
          const patch = {};
          for (const key of ['apiBaseUrl', 'token', 'lastSeriesId', 'lastSeriesTitle', 'settings']) {
            if (Object.prototype.hasOwnProperty.call(requested, key)) patch[key] = requested[key];
          }
          const sensitive = Object.prototype.hasOwnProperty.call(patch, 'apiBaseUrl') || Object.prototype.hasOwnProperty.call(patch, 'token');
          if (sensitive && !isExtensionPage(sender)) {
            sendResponse({ ok: false, error: 'Connection settings can only be changed in the extension.' });
            break;
          }
          const current = await getConfig();
          if (Object.prototype.hasOwnProperty.call(patch, 'apiBaseUrl')) {
            const normalized = normalizeApiBase(patch.apiBaseUrl);
            if (normalized === null) { sendResponse({ ok: false, error: 'Use an HTTPS API URL, or localhost for development.' }); break; }
            patch.apiBaseUrl = normalized;
            if (normalized !== normalizeApiBase(current.apiBaseUrl)) {
              if (!Object.prototype.hasOwnProperty.call(requested, 'lastSeriesId')) patch.lastSeriesId = '';
              if (!Object.prototype.hasOwnProperty.call(requested, 'lastSeriesTitle')) patch.lastSeriesTitle = '';
              if (!Object.prototype.hasOwnProperty.call(patch, 'token')) {
                patch.token = '';
                patch.tokenSource = '';
              }
            }
          }
          if (Object.prototype.hasOwnProperty.call(requested, 'token')) {
            patch.token = typeof requested.token === 'string' ? requested.token.trim() : '';
            const sameSiteSession = current.tokenSource === 'site' && patch.token === current.token &&
              (!Object.prototype.hasOwnProperty.call(patch, 'apiBaseUrl') || patch.apiBaseUrl === normalizeApiBase(current.apiBaseUrl));
            patch.tokenSource = patch.token ? (sameSiteSession ? 'site' : 'manual') : '';
          }
          if (patch.settings) patch.settings = { ...current.settings, ...patch.settings };
          const cfg = await setConfig(patch);
          sendResponse({ ok: true, apiBaseUrl: cfg.apiBaseUrl, hasToken: !!cfg.token, settings: cfg.settings, lastSeriesId: cfg.lastSeriesId });
          break;
        }
        case 'clearToken':
          if (!isExtensionPage(sender)) { sendResponse({ ok: false, error: 'Only the extension can clear its session.' }); break; }
          await chrome.storage.local.set({ token: '', tokenSource: '' });
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
        case 'importPlaylist':
          sendResponse(await importPlaylist(msg));
          break;
        case 'refreshPlaylist':
          sendResponse(await refreshPlaylist(msg));
          break;
        case 'setAutoSync':
          sendResponse(await setAutoSync(msg));
          break;
        case 'findVideo':
          sendResponse(await findVideo(msg.youtubeId));
          break;
        case 'patchVideo':
          sendResponse(await patchVideo(msg));
          break;
        case 'site': {
          if (!isQueueSite(sender)) { sendResponse({ ok: false, error: 'Untrusted queue site.' }); break; }
          const base = normalizeApiBase(msg.apiBaseUrl);
          if (!base) { sendResponse({ ok: false, error: 'Queue site API URL is unavailable or invalid.' }); break; }
          const current = await getConfig();
          const token = typeof msg.token === 'string' ? msg.token.trim() : '';
          const patch = {};
          if (token) {
            // Always update the URL and token together, never pair a session
            // from one deployment with another deployment's API URL.
            patch.apiBaseUrl = base;
            patch.token = token;
            patch.tokenSource = 'site';
            if (base !== normalizeApiBase(current.apiBaseUrl)) {
              patch.lastSeriesId = '';
              patch.lastSeriesTitle = '';
            }
          } else if (current.tokenSource === 'site' && normalizeApiBase(current.apiBaseUrl) === base) {
            patch.token = '';
            patch.tokenSource = '';
          } else if (!current.token && !current.apiBaseUrl) {
            patch.apiBaseUrl = base;
          }
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
