// app.js — the single-page controller: auth, dashboard, series, player queue.
// v1.0
import { API_BASE_URL } from './config.js';
import { QueuePlayer } from './player.js';
import { startRegistration, startAuthentication } from 'https://esm.sh/@simplewebauthn/browser@13';

const VERSION = '1.1';
const TOKEN_KEY = 'ytq_token';
const VIEWS = ['login-view', 'dashboard-view', 'series-view', 'player-view'];

let token = localStorage.getItem(TOKEN_KEY) || '';
let player = null;

const state = {
  user: null,
  series: [],
  currentSeries: null,
  videos: [],
  currentVideoId: null,
  autoplay: true,
  view: 'compact',
  selectMode: false,
  selected: new Set(),
};

const $ = (sel) => document.querySelector(sel);

function show(id) {
  for (const v of VIEWS) {
    const el = $('#' + v);
    if (el) el.hidden = v !== id;
  }
}

class AuthError extends Error {}

function setToken(t) {
  token = t || '';
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

// -------------------------------------------------------------------- toast
let toastTimer = null;

function toast(message) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 4200);
}

// ---------------------------------------------------------------- API client
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(API_BASE_URL.replace(/\/+$/, '') + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    setToken('');
    show('login-view');
    throw new AuthError('unauthorized');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = data && data.error ? data.error : 'HTTP ' + res.status;
    throw new Error(data && data.detail ? msg + ': ' + data.detail : msg);
  }
  return data;
}

// -------------------------------------------------------------- small helpers
function iconBtn(label, title, onClick) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function indexInSeries(video) {
  return state.videos.findIndex((x) => x.id === video.id);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// neutral tile shown when a page has no thumbnail we can use
const PLACEHOLDER_IMG =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#c2c0b6"/><path d="M138 68l48 22-48 22z" fill="#faf9f5"/></svg>',
  );

// -------------------------------------------------------------------- theme
// 'light' | 'dark' | absent (absent = follow the system, like Claude does)
const THEME_KEY = 'ytq_theme';

function resolveTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('#theme-toggle');
  if (btn) {
    btn.textContent = theme === 'dark' ? '☀' : '☾';
    btn.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    btn.setAttribute('aria-label', btn.title);
  }
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

function initTheme() {
  applyTheme(resolveTheme());
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (!localStorage.getItem(THEME_KEY)) applyTheme(resolveTheme());
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

// --------------------------------------------------------------------- view
// Windows-Explorer-style view modes: thumbnail grid, compact rows, or a list.
const VIEW_KEY = 'ytq_view';
const VIEW_MODES = ['grid', 'compact', 'list'];

function applyView() {
  document.documentElement.dataset.view = state.view;
  document.querySelectorAll('.view-btn').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
  });
}

function initView() {
  const stored = localStorage.getItem(VIEW_KEY);
  if (VIEW_MODES.includes(stored)) state.view = stored;
  applyView();
}

function setView(view) {
  if (!VIEW_MODES.includes(view)) return;
  state.view = view;
  localStorage.setItem(VIEW_KEY, view);
  applyView();
}

// -------------------------------------------------------------------- modal
let modalSave = null;

function openModal({ heading, value, placeholder, onSave }) {
  $('#modal-title').textContent = heading;
  const input = $('#modal-input');
  input.value = value || '';
  input.placeholder = placeholder || '';
  modalSave = onSave;
  $('#modal').hidden = false;
  setTimeout(() => input.focus(), 30);
}

function closeModal() {
  $('#modal').hidden = true;
  modalSave = null;
}

async function submitModal() {
  const save = modalSave;
  const value = $('#modal-input').value;
  closeModal();
  if (!save) return;
  try {
    await save(value);
  } catch (e) {
    toast('Could not save: ' + (e.message || e));
  }
}

// ------------------------------------------------------------------- routing
async function init() {
  initTheme();
  initView();
  wireEvents();
  const ver = $('#app-version');
  if (ver) ver.textContent = 'v' + VERSION;

  if (!API_BASE_URL || API_BASE_URL.includes('REPLACE_WITH')) {
    show('login-view');
    $('#login-error').textContent =
      'API_BASE_URL is not configured. Set it in frontend/config.js (or the repo variable API_BASE_URL).';
    return;
  }

  let status = { registrationOpen: true, ownerRegistered: false };
  try {
    status = await api('/auth/status');
  } catch (e) {
    console.warn('status check failed', e);
  }
  $('#register-block').hidden = !status.registrationOpen;

  if (token) {
    try {
      const me = await api('/auth/me');
      state.user = me.user;
      enterApp();
      return;
    } catch (e) {
      if (!(e instanceof AuthError)) console.warn('session check failed', e);
    }
  }
  show('login-view');
}

function enterApp() {
  $('#user-bar').hidden = false;
  $('#user-name').textContent = state.user?.username || 'owner';
  loadDashboard();
}

// ---------------------------------------------------------------- dashboard
async function loadDashboard() {
  show('dashboard-view');
  const { series } = await api('/series');
  state.series = series;
  const list = $('#series-list');
  list.innerHTML = '';
  if (!state.series.length) {
    list.appendChild(el('p', 'muted', 'No series yet. Create one above.'));
    return;
  }
  for (const s of state.series) list.appendChild(seriesCard(s));
}

function seriesCard(s) {
  const card = el('div', 'card series-card');
  card.appendChild(el('h3', null, s.title));
  if (s.description) card.appendChild(el('p', 'muted', s.description));
  card.appendChild(el('p', 'muted', `${s.done} / ${s.total} watched`));

  const row = el('div', 'row-buttons');

  const open = el('button', 'primary', 'Open');
  open.onclick = () => openSeries(s.id);
  row.appendChild(open);

  const del = el('button', 'ghost', 'Delete');
  del.onclick = async () => {
    if (!confirm(`Delete "${s.title}" and all its videos?`)) return;
    try {
      await api('/series/' + s.id, { method: 'DELETE' });
      await loadDashboard();
    } catch (e) {
      toast('Could not delete: ' + (e.message || e));
    }
  };
  row.appendChild(del);

  card.appendChild(row);
  return card;
}

// -------------------------------------------------------------------- series
async function openSeries(id) {
  const data = await api('/series/' + id);
  state.currentSeries = data.series;
  state.videos = data.videos;
  state.selected.clear();
  show('series-view');
  renderSeries();
}

function activeVideos() {
  return state.videos.filter((v) => v.status !== 'done');
}

function watchedVideos() {
  return state.videos.filter((v) => v.status === 'done');
}

function renderSeries() {
  $('#series-title-heading').textContent = state.currentSeries.title;
  const watched = watchedVideos();
  $('#series-progress').textContent = `${watched.length} / ${state.videos.length} watched`;

  const active = activeVideos();

  const ol = $('#video-list');
  ol.innerHTML = '';
  if (!active.length) {
    ol.appendChild(
      el('li', 'empty', state.videos.length ? 'All caught up — nothing queued.' : 'No videos yet. Paste some links above.'),
    );
  }
  active.forEach((v, i) => ol.appendChild(videoRow(v, i + 1)));

  const wl = $('#watched-list');
  wl.innerHTML = '';
  watched.forEach((v) => wl.appendChild(videoRow(v, null)));
  $('#watched-summary').textContent = `Watched (${watched.length})`;
  $('#watched-section').hidden = watched.length === 0;

  updateSelectionBar();
}

function videoRow(v, index) {
  const li = el('li', 'video-item status-' + v.status);
  if (state.selected.has(v.id)) li.classList.add('selected');

  if (state.selectMode) {
    li.classList.add('selectable');
    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'pick';
    pick.checked = state.selected.has(v.id);
    pick.setAttribute('aria-label', 'Select video');
    pick.onchange = () => toggleSelect(v.id, pick.checked);
    li.appendChild(pick);
    // tapping anywhere on the row also toggles it (handy on touch)
    li.onclick = (e) => {
      if (e.target.closest('button, input')) return;
      toggleSelect(v.id, !state.selected.has(v.id));
    };
  }

  // Thumbnail: the page's og:image, else the YouTube still, else a neutral tile.
  const thumb = document.createElement('img');
  thumb.className = 'thumb';
  thumb.loading = 'lazy';
  thumb.decoding = 'async';
  thumb.alt = '';
  thumb.src =
    v.imageUrl || (v.youtubeId ? `https://i.ytimg.com/vi/${v.youtubeId}/mqdefault.jpg` : PLACEHOLDER_IMG);
  thumb.onerror = () => thumb.classList.add('is-missing');
  li.appendChild(thumb);

  const main = el('div', 'vmain');
  if (index != null) main.appendChild(el('span', 'idx', String(index)));

  const title = el('span', 'vtitle', v.title || v.youtubeId || v.url || 'Untitled');
  title.title = [v.title, v.url || v.youtubeId].filter(Boolean).join(' · ');
  main.appendChild(title);

  if (v.status === 'watching') main.appendChild(el('span', 'badge', 'watching'));
  if (v.source && v.source !== 'youtube') {
    main.appendChild(el('span', 'src-chip', v.siteName || hostOf(v.url) || v.source));
  }
  if (v.titleAuto) main.appendChild(el('span', 'auto-tag', 'auto'));
  li.appendChild(main);

  const actions = el('div', 'row-actions');
  actions.appendChild(iconBtn('▶', 'Play', () => openPlayer(v.id)));
  actions.appendChild(iconBtn('✎', 'Rename', () => renameVideo(v)));

  if (index != null) {
    actions.appendChild(iconBtn('↑', 'Move up', () => moveVideo(v.id, -1)));
    actions.appendChild(iconBtn('↓', 'Move down', () => moveVideo(v.id, 1)));
  }

  actions.appendChild(
    iconBtn(
      v.status === 'done' ? '↺' : '✓',
      v.status === 'done' ? 'Mark as not watched' : 'Mark as watched',
      () => toggleDone(v),
    ),
  );
  actions.appendChild(iconBtn('✕', 'Delete', () => removeVideo(v.id)));

  li.appendChild(actions);
  return li;
}

async function moveVideo(id, dir) {
  const active = activeVideos();
  const ai = active.findIndex((v) => v.id === id);
  const aj = ai + dir;
  if (ai < 0 || aj < 0 || aj >= active.length) return;

  const previous = state.videos.slice();
  const full = state.videos.slice();
  const i1 = full.findIndex((v) => v.id === active[ai].id);
  const i2 = full.findIndex((v) => v.id === active[aj].id);
  [full[i1], full[i2]] = [full[i2], full[i1]];
  state.videos = full;
  renderSeries();

  try {
    await api('/series/' + state.currentSeries.id + '/reorder', {
      method: 'POST',
      body: { orderedIds: full.map((v) => v.id) },
    });
  } catch (e) {
    state.videos = previous; // put it back if the server rejected the order
    renderSeries();
    toast('Could not reorder: ' + (e.message || e));
  }
}

async function toggleDone(v) {
  const next = v.status === 'done' ? 'todo' : 'done';
  try {
    await api('/videos/' + v.id, { method: 'PATCH', body: { status: next, resumeSeconds: 0 } });
  } catch (e) {
    return toast('Could not update: ' + (e.message || e));
  }
  v.status = next;
  if (next === 'done') v.watchedAt = new Date().toISOString();
  renderSeries();
}

async function removeVideo(id) {
  if (!confirm('Remove this video from the series?')) return;
  try {
    await api('/videos/' + id, { method: 'DELETE' });
  } catch (e) {
    return toast('Could not delete: ' + (e.message || e));
  }
  if (state.currentVideoId === id) {
    state.currentVideoId = null;
    pauseYt();
    $('#now-title').textContent = '';
    $('#now-progress').textContent = '';
  }
  state.videos = state.videos.filter((v) => v.id !== id);
  state.selected.delete(id);
  renderSeries();
}

function renameVideo(v) {
  openModal({
    heading: 'Rename video',
    value: v.title || '',
    placeholder: v.youtubeId,
    onSave: async (value) => {
      const title = value.trim();
      await api('/videos/' + v.id, { method: 'PATCH', body: { title } });
      v.title = title || null;
      renderSeries();
    },
  });
}

function renameSeries() {
  const s = state.currentSeries;
  if (!s) return;
  openModal({
    heading: 'Rename series',
    value: s.title,
    placeholder: 'Series title',
    onSave: async (value) => {
      const title = value.trim();
      if (!title) return;
      await api('/series/' + s.id, { method: 'PATCH', body: { title } });
      s.title = title;
      renderSeries();
    },
  });
}

// ------------------------------------------------------- selection & bulk
function bulkItems() {
  return state.videos.filter((v) => state.selected.has(v.id));
}

function updateSelectionBar() {
  const bar = $('#selection-bar');
  const n = state.selected.size;
  bar.hidden = !(state.selectMode && n > 0);
  $('#selection-count').textContent = `${n} selected`;
}

function toggleSelect(id, on) {
  if (on) state.selected.add(id);
  else state.selected.delete(id);
  renderSeries();
}

function setSelectMode(on) {
  state.selectMode = on;
  if (!on) state.selected.clear();
  $('#select-toggle').setAttribute('aria-pressed', String(on));
  renderSeries();
}

// ---- bulk rename ----------------------------------------------------------
function padNum(n, width) {
  let s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
}

// Recognised number tokens: {n} {i} {index} {num} {no}, or a literal start
// number like {1} / {5}. Add ":2" to zero-pad, e.g. {n:2} -> 01, 02.
const BULK_TOKEN_RE = /\{(?:n|i|index|num|no|total|title|id)(?::\d+)?\}/i;
const BULK_NUM_RE = /\{\d+(?::\d+)?\}/;

function bulkComputeTitle(v, index, total) {
  const find = $('#bulk-find').value;
  const repl = $('#bulk-replace').value;
  const pattern = $('#bulk-pattern').value;
  const start = parseInt($('#bulk-start').value, 10) || 0;

  let base = v.title || v.youtubeId;
  if (find) base = base.split(find).join(repl);
  if (!pattern) return base;

  return pattern
    // {n:2} / {i:3} -> zero-padded sequence from the Start number
    .replace(/\{(n|i|index|num|no)\s*:\s*(\d+)\}/gi, (_, _t, w) => padNum(start + index, +w))
    // {1:2} / {5:3} -> zero-padded sequence from that literal number
    .replace(/\{(\d+)\s*:\s*(\d+)\}/g, (_, b, w) => padNum(parseInt(b, 10) + index, +w))
    // {n} / {i} -> the Start number field, counting up
    .replace(/\{(?:n|i|index|num|no)\}/gi, () => String(start + index))
    // {1} / {5} -> that number, counting up
    .replace(/\{(\d+)\}/g, (_, b) => String(parseInt(b, 10) + index))
    .replace(/\{total\}/gi, () => String(total))
    .replace(/\{title\}/gi, () => base)
    .replace(/\{id\}/gi, () => v.youtubeId);
}

function renderBulkPreview() {
  const items = bulkItems();
  const ol = $('#bulk-preview');
  ol.innerHTML = '';
  items.slice(0, 3).forEach((v, i) => {
    ol.appendChild(el('li', null, bulkComputeTitle(v, i, items.length)));
  });
  if (items.length > 3) ol.appendChild(el('li', 'muted', `…and ${items.length - 3} more`));

  // Warn if the pattern has no placeholder at all — every title would be identical.
  const pattern = $('#bulk-pattern').value;
  const hasToken = BULK_TOKEN_RE.test(pattern) || BULK_NUM_RE.test(pattern);
  const warn = $('#bulk-warn');
  warn.hidden = !(pattern && !hasToken);
  warn.textContent = warn.hidden
    ? ''
    : 'This pattern has no placeholder, so every selected video would get the same title. Use {n}, or {1} to number them.';
}

function openBulkRename() {
  const items = bulkItems();
  if (!items.length) return;
  $('#bulk-sub').textContent = `Renaming ${items.length} selected video${items.length > 1 ? 's' : ''}.`;
  $('#bulk-find').value = '';
  $('#bulk-replace').value = '';
  $('#bulk-pattern').value = '';
  $('#bulk-start').value = '1';
  renderBulkPreview();
  $('#bulk-modal').hidden = false;
  setTimeout(() => $('#bulk-find').focus(), 30);
}

function closeBulkRename() {
  $('#bulk-modal').hidden = true;
}

async function applyBulkRename() {
  const items = bulkItems();
  const total = items.length;
  if (!total) return;
  const titles = items.map((v, i) => bulkComputeTitle(v, i, total));

  const btn = $('#bulk-apply');
  btn.disabled = true;
  btn.textContent = 'Applying…';
  let failed = 0;
  try {
    await Promise.all(
      items.map(async (v, i) => {
        try {
          await api('/videos/' + v.id, { method: 'PATCH', body: { title: titles[i] } });
          v.title = titles[i] || null;
        } catch {
          failed += 1;
        }
      }),
    );
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply';
  }
  closeBulkRename();
  state.selected.clear();
  state.selectMode = false;
  $('#select-toggle').setAttribute('aria-pressed', 'false');
  renderSeries();
  if (failed) toast(`${failed} of ${total} titles could not be saved.`);
  else toast(`Renamed ${total} video${total > 1 ? 's' : ''}.`);
}

async function bulkMarkWatched() {
  const items = bulkItems();
  if (!items.length) return;
  let failed = 0;
  await Promise.all(
    items.map(async (v) => {
      try {
        await api('/videos/' + v.id, { method: 'PATCH', body: { status: 'done', resumeSeconds: 0 } });
        v.status = 'done';
        v.resumeSeconds = 0;
      } catch {
        failed += 1;
      }
    }),
  );
  state.selected.clear();
  renderSeries();
  if (failed) toast(`${failed} of ${items.length} could not be updated.`);
}

async function bulkDelete() {
  const items = bulkItems();
  if (!items.length) return;
  if (!confirm(`Remove ${items.length} video${items.length > 1 ? 's' : ''} from this series?`)) return;
  let failed = 0;
  const gone = new Set();
  await Promise.all(
    items.map(async (v) => {
      try {
        await api('/videos/' + v.id, { method: 'DELETE' });
        gone.add(v.id);
      } catch {
        failed += 1;
      }
    }),
  );
  state.videos = state.videos.filter((v) => !gone.has(v.id));
  state.selected.clear();
  renderSeries();
  if (failed) toast(`${failed} of ${items.length} could not be deleted.`);
}

// -------------------------------------------------------------------- export
function exportItems() {
  const scope = $('#export-scope').value;
  if (scope === 'queue') return activeVideos();
  if (scope === 'watched') return watchedVideos();
  return state.videos.slice();
}

const watchUrl = (v) => 'https://www.youtube.com/watch?v=' + v.youtubeId;

function openExport() {
  if (!state.videos.length) return toast('Nothing to export yet.');
  $('#export-sub').textContent = state.currentSeries.title;
  renderExportInfo();
  $('#export-modal').hidden = false;
}

function closeExport() {
  $('#export-modal').hidden = true;
}

function renderExportInfo() {
  const items = exportItems();
  $('#export-count').textContent = `${items.length} video${items.length === 1 ? '' : 's'} will be exported.`;
  $('#export-note').textContent =
    items.length > 50
      ? 'YouTube opens at most about 50 videos as a temporary playlist; the file downloads still include all of them.'
      : '';
}

function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function safeFileName(s) {
  const clean = String(s || 'playlist')
    .replace(/[^\w\-. ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return clean || 'playlist';
}

async function exportCopy() {
  const items = exportItems();
  if (!items.length) return;
  const text = items.map(watchUrl).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${items.length} link${items.length > 1 ? 's' : ''}.`);
  } catch {
    downloadText(safeFileName(state.currentSeries.title) + '.txt', text + '\n');
    toast('Clipboard blocked — downloaded a .txt instead.');
  }
}

function exportTxt() {
  const items = exportItems();
  const lines = items.map((v) => watchUrl(v) + (v.title ? '  ' + v.title : ''));
  downloadText(safeFileName(state.currentSeries.title) + '.txt', lines.join('\n') + '\n');
}

function exportCsv() {
  const items = exportItems();
  const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const rows = [['position', 'title', 'youtube_id', 'url', 'status', 'watched_at']];
  items.forEach((v) =>
    rows.push([
      indexInSeries(v) + 1,
      v.title || '',
      v.youtubeId,
      watchUrl(v),
      v.status,
      v.watchedAt || '',
    ]),
  );
  downloadText(
    safeFileName(state.currentSeries.title) + '.csv',
    rows.map((r) => r.map(esc).join(',')).join('\n') + '\n',
    'text/csv',
  );
}

function exportJson() {
  const items = exportItems();
  const payload = {
    app: 'yt-video-queue',
    version: VERSION,
    exportedAt: new Date().toISOString(),
    series: { title: state.currentSeries.title, description: state.currentSeries.description || null },
    videos: items.map((v) => ({
      position: indexInSeries(v) + 1,
      title: v.title || null,
      youtubeId: v.youtubeId,
      url: watchUrl(v),
      status: v.status,
      resumeSeconds: v.resumeSeconds,
      watchedAt: v.watchedAt || null,
    })),
  };
  downloadText(safeFileName(state.currentSeries.title) + '.json', JSON.stringify(payload, null, 2), 'application/json');
}

function exportOpenPlaylist() {
  const items = exportItems();
  if (!items.length) return;
  const ids = items.slice(0, 50).map((v) => v.youtubeId).join(',');
  window.open('https://www.youtube.com/watch_videos?video_ids=' + ids, '_blank', 'noopener');
}

// -------------------------------------------------------------------- player
async function ensurePlayer() {
  if (player) return player;
  player = new QueuePlayer({
    elementId: 'yt-player',
    handlers: {
      onEnded: () => onVideoEnded(),
      onProgress: (t) => saveProgress(t),
      onError: () => {
        $('#now-progress').textContent =
          "This video can't be played — it may be private, removed or blocked in your region. Press Next to skip.";
      },
    },
  });
  await player.ready();
  return player;
}

function currentVideo() {
  return state.videos.find((v) => v.id === state.currentVideoId) || null;
}

// The next video still to watch, after `video` in the series order. Falls back
// to the first remaining one so playback never gets stuck, and returns null
// only when nothing is left.
function nextAfter(video) {
  const list = activeVideos();
  if (!list.length) return null;
  if (!video) return list[0];
  const pos = indexInSeries(video);
  const after = list.find((x) => indexInSeries(x) > pos);
  return after || list[0];
}

function prevBefore(video) {
  const list = activeVideos();
  if (!video || !list.length) return null;
  const pos = indexInSeries(video);
  const before = list.filter((x) => indexInSeries(x) < pos);
  return before.length ? before[before.length - 1] : null;
}

function pauseYt() {
  if (player) player.pause();
}

// three ways to watch: the YouTube player, a generic iframe (Telegram), or an
// external card for sites that refuse to be framed
function showPlayerMode(mode, arg) {
  const frame = $('#frame-player');
  $('#yt-player').hidden = mode !== 'yt';
  frame.hidden = mode !== 'frame';
  $('#external-player').hidden = mode !== 'external';

  if (mode === 'frame') {
    frame.src = arg;
  } else if (frame.getAttribute('src')) {
    frame.removeAttribute('src');
  }

  if (mode === 'external') {
    const v = arg;
    $('#ext-site').textContent = v.siteName || hostOf(v.url) || '';
    $('#ext-title').textContent = v.title || v.url || '';
    const img = $('#ext-image');
    if (v.imageUrl) {
      img.src = v.imageUrl;
      img.hidden = false;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
    }
    $('#ext-open').href = v.url || '#';
    $('#now-progress').textContent = 'Opens in a new tab — mark it done here when you have finished.';
  }
}

async function openPlayer(videoId) {
  // show the view first: the YouTube player needs a laid-out container to size itself
  show('player-view');
  const v = state.videos.find((x) => x.id === videoId);
  if (!v) return;
  await playVideo(v);
}

async function playVideo(v) {
  state.currentVideoId = v.id;
  $('#now-title').textContent = v.title || v.url || v.youtubeId || 'Untitled';
  const list = activeVideos();
  const i = list.findIndex((x) => x.id === v.id);
  $('#now-progress').textContent = i === -1 ? '' : `${i + 1} of ${list.length}`;
  updateUpNext();

  if (v.source === 'youtube' && v.youtubeId) {
    showPlayerMode('yt');
    try {
      await ensurePlayer();
    } catch {
      $('#now-progress').textContent = 'Could not load the YouTube player. Check your connection and try again.';
      return;
    }
    await player.load(v);
    return;
  }

  pauseYt();
  if (v.embeddable && (v.embedUrl || v.url)) showPlayerMode('frame', v.embedUrl || v.url);
  else showPlayerMode('external', v);
}

function updateUpNext() {
  const n = nextAfter(currentVideo());
  $('#up-next').textContent = n ? 'Up next: ' + (n.title || n.youtubeId) : 'Up next: — end of series —';
}

async function saveProgress(t) {
  const v = currentVideo();
  if (!v) return;
  try {
    await api('/videos/' + v.id, { method: 'PATCH', body: { status: 'watching', resumeSeconds: t } });
    v.resumeSeconds = t;
    if (v.status !== 'done') v.status = 'watching';
  } catch {
    /* progress saving is best-effort */
  }
}

async function markDone(v) {
  if (!v) return;
  try {
    await api('/videos/' + v.id, { method: 'PATCH', body: { status: 'done', resumeSeconds: 0 } });
    v.status = 'done';
    v.resumeSeconds = 0;
    v.watchedAt = new Date().toISOString();
  } catch {
    /* ignore — the UI still advances */
  }
  renderSeries(); // keep the (hidden) series list in sync with what we just watched
}

async function onVideoEnded() {
  const v = currentVideo();
  const n = nextAfter(v);
  await markDone(v);
  if (state.autoplay && n) await playVideo(n);
  else updateUpNext();
}

// the "Mark done & next" button always advances, regardless of autoplay
async function markDoneAndAdvance() {
  const v = currentVideo();
  const n = nextAfter(v);
  await markDone(v);
  if (n) await playVideo(n);
  else updateUpNext();
}

async function goPrev() {
  const p = prevBefore(currentVideo());
  if (p) await playVideo(p);
}

async function goNext() {
  const n = nextAfter(currentVideo());
  if (n) await playVideo(n);
}

// -------------------------------------------------------------- event wiring
function closeTopModal() {
  if (!$('#bulk-modal').hidden) return closeBulkRename();
  if (!$('#export-modal').hidden) return closeExport();
  if (!$('#modal').hidden) return closeModal();
}

function wireEvents() {
  $('#login-btn').onclick = async () => {
    const err = $('#login-error');
    err.textContent = '';
    try {
      const { ceremonyId, options } = await api('/auth/login/options', { method: 'POST' });
      const assertion = await startAuthentication({ optionsJSON: options });
      const result = await api('/auth/login/verify', { method: 'POST', body: { ceremonyId, response: assertion } });
      setToken(result.token);
      state.user = result.user;
      enterApp();
    } catch (e) {
      err.textContent = 'Login failed: ' + (e.message || e);
    }
  };

  $('#register-btn').onclick = async () => {
    const err = $('#login-error');
    err.textContent = '';
    try {
      const bootstrapSecret = $('#bootstrap-secret').value;
      const { ceremonyId, options } = await api('/auth/register/options', {
        method: 'POST',
        body: { bootstrapSecret },
      });
      const attestation = await startRegistration({ optionsJSON: options });
      const result = await api('/auth/register/verify', { method: 'POST', body: { ceremonyId, response: attestation } });
      setToken(result.token);
      state.user = result.user;
      enterApp();
    } catch (e) {
      err.textContent = 'Registration failed: ' + (e.message || e);
    }
  };

  $('#logout-btn').onclick = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {}
    setToken('');
    location.reload();
  };

  $('#create-series-form').onsubmit = async (e) => {
    e.preventDefault();
    const title = $('#series-title').value.trim();
    if (!title) return;
    try {
      await api('/series', { method: 'POST', body: { title, description: $('#series-desc').value.trim() } });
      $('#series-title').value = '';
      $('#series-desc').value = '';
      await loadDashboard();
    } catch (err) {
      toast('Could not create series: ' + (err.message || err));
    }
  };

  $('#add-videos-form').onsubmit = async (e) => {
    e.preventDefault();
    const raw = $('#video-links').value.trim();
    if (!raw) return;
    const tokens = raw.split(/[\s,]+/).filter(Boolean);
    if (!tokens.length) return;
    const btn = e.submitter;
    if (btn) btn.disabled = true;
    let added = 0;
    let skipped = 0;
    try {
      // Send in batches: each link costs a metadata lookup, and the Worker has a
      // per-request subrequest budget, so a big paste is split up.
      const BATCH = 20;
      for (let i = 0; i < tokens.length; i += BATCH) {
        const chunk = tokens.slice(i, i + BATCH).join('\n');
        const res = await api('/series/' + state.currentSeries.id + '/videos', {
          method: 'POST',
          body: { urls: chunk },
        });
        added += res && res.added ? res.added : 0;
        skipped += res && res.skipped ? res.skipped : 0;
      }
      $('#video-links').value = '';
      await openSeries(state.currentSeries.id);
      toast(`Added ${added} item${added === 1 ? '' : 's'}${skipped ? ` · skipped ${skipped}` : ''}.`);
    } catch (err) {
      toast('Could not add: ' + (err.message || err));
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  $('#rename-series-btn').onclick = () => renameSeries();
  $('#export-btn').onclick = () => openExport();

  $('#back-to-dash').onclick = () => {
    pauseYt();
    loadDashboard().catch((e) => toast('Could not load: ' + (e.message || e)));
  };
  $('#back-to-series').onclick = () => {
    pauseYt();
    openSeries(state.currentSeries.id).catch((e) => toast('Could not load: ' + (e.message || e)));
  };

  $('#play-btn').onclick = () => {
    const list = activeVideos();
    const v = list[0] || state.videos[0];
    if (v) openPlayer(v.id);
  };

  $('#prev-btn').onclick = () => goPrev();
  $('#next-btn').onclick = () => goNext();
  $('#mark-done-btn').onclick = () => markDoneAndAdvance();
  $('#autoplay-toggle').onchange = (e) => {
    state.autoplay = e.target.checked;
  };

  // theme
  const themeBtn = $('#theme-toggle');
  if (themeBtn) themeBtn.onclick = toggleTheme;

  // view mode switcher
  document.querySelectorAll('.view-btn').forEach((b) => {
    b.onclick = () => setView(b.dataset.view);
  });

  // selection & bulk actions
  $('#select-toggle').onclick = () => setSelectMode(!state.selectMode);
  $('#bulk-clear-btn').onclick = () => {
    state.selected.clear();
    renderSeries();
  };
  $('#bulk-rename-btn').onclick = () => openBulkRename();
  $('#bulk-watch-btn').onclick = () => bulkMarkWatched();
  $('#bulk-delete-btn').onclick = () => bulkDelete();
  $('#bulk-cancel').onclick = () => closeBulkRename();
  $('#bulk-apply').onclick = () => applyBulkRename();
  ['#bulk-find', '#bulk-replace', '#bulk-pattern', '#bulk-start'].forEach((s) =>
    $(s).addEventListener('input', renderBulkPreview),
  );
  $('#bulk-modal').onclick = (e) => {
    if (e.target === $('#bulk-modal')) closeBulkRename();
  };

  // export
  $('#export-close').onclick = () => closeExport();
  $('#export-scope').onchange = () => renderExportInfo();
  $('#export-open').onclick = () => exportOpenPlaylist();
  $('#export-copy').onclick = () => exportCopy();
  $('#export-txt').onclick = () => exportTxt();
  $('#export-csv').onclick = () => exportCsv();
  $('#export-json').onclick = () => exportJson();
  $('#export-modal').onclick = (e) => {
    if (e.target === $('#export-modal')) closeExport();
  };

  // rename modal
  $('#modal-save').onclick = () => submitModal();
  $('#modal-cancel').onclick = () => closeModal();
  $('#modal').onclick = (e) => {
    if (e.target === $('#modal')) closeModal();
  };
  $('#modal-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitModal();
    }
  });

  // one Escape handler for every dialog
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTopModal();
  });
}

// Any promise we forgot to catch still reaches the user instead of vanishing.
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof AuthError) {
    e.preventDefault();
    return;
  }
  console.error('Unhandled error', e.reason);
  toast(e.reason && e.reason.message ? e.reason.message : 'Something went wrong.');
});

init();
