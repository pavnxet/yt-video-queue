// app.js — the single-page controller: auth, dashboard, series, player queue.
// v1.4
import { API_BASE_URL } from './config.js';
import { QueuePlayer } from './player.js';

// The passkey helper is ~9 KB and is only needed to sign in, so it is loaded on
// demand rather than on every page view. It is vendored locally — no CDN.
let passkeyLib = null;
function passkeys() {
  if (!passkeyLib) passkeyLib = import('./vendor/simplewebauthn.js');
  return passkeyLib;
}

const VERSION = '1.4.1';
const TOKEN_KEY = 'ytq_token';
const VIEWS = ['loading-view', 'login-view', 'dashboard-view', 'series-view', 'player-view'];

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
  bulkExcluded: new Set(),
};

const $ = (sel) => document.querySelector(sel);

function show(id) {
  for (const v of VIEWS) {
    const el = $('#' + v);
    if (el) el.hidden = v !== id;
  }
}

// ---------------------------------------------------------------- routing
// Every series gets its own link:   #/s/<seriesId>
// A video inside it:                #/s/<seriesId>/v/<videoId>
// The hash is the single source of truth for navigation, so the browser's back
// and forward buttons work and any series can be bookmarked or shared.
function seriesHash(id) { return '#/s/' + encodeURIComponent(id); }
function videoHash(seriesId, videoId) { return seriesHash(seriesId) + '/v/' + encodeURIComponent(videoId); }

function parseHash() {
  const parts = (location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 's' && parts[1]) {
    return {
      seriesId: decodeURIComponent(parts[1]),
      videoId: parts[2] === 'v' && parts[3] ? decodeURIComponent(parts[3]) : null,
    };
  }
  return { seriesId: null, videoId: null };
}

async function applyRoute() {
  if (!state.user) return; // not signed in yet — enterApp() will call us again
  const r = parseHash();
  if (!r.seriesId) {
    await loadDashboard();
    return;
  }
  try {
    if (!state.currentSeries || state.currentSeries.id !== r.seriesId) {
      await openSeries(r.seriesId);
    } else {
      show('series-view');
    }
    if (r.videoId) await showPlayer(r.videoId);
  } catch (e) {
    toast('Could not open that series — it may have been deleted.');
    if (location.hash !== '#/') location.hash = '#/';
    else await loadDashboard();
  }
}

function goHome() {
  if (!location.hash || location.hash === '#/') { loadDashboard().catch(() => {}); return; }
  location.hash = '#/';
}

function goToSeries(id) {
  const target = seriesHash(id);
  if (location.hash === target) { openSeries(id).catch(() => {}); return; }
  location.hash = target;
}

window.addEventListener('hashchange', () => { applyRoute().catch(() => {}); });

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

  // Never let a stalled request freeze the UI.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let res;
  try {
    res = await fetch(API_BASE_URL.replace(/\/+$/, '') + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    throw e && e.name === 'AbortError' ? new Error('the API did not respond in time') : e;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    setToken('');
    show('login-view');
    throw new AuthError('unauthorized');
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null; // a non-JSON body (a proxy or error page) is treated as no data
  }
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

// What to call the button that hands a link over to its own app.
function openLabel(v) {
  if (v.source === 'youtube') return 'Open in YouTube';
  if (v.source === 'telegram') return 'Open in Telegram';
  return 'Open link';
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

  // Whatever happens from here on, end up on a visible screen — never a blank
  // page with no explanation.
  try {
    await startApp();
  } catch (e) {
    console.error('startup failed', e);
    showLoginError('Could not start the app: ' + (e && e.message ? e.message : e));
  }
}

function showLoginError(message) {
  show('login-view');
  const err = $('#login-error');
  if (err) err.textContent = message;
}

async function startApp() {
  // Paint something immediately so the page is never empty while we wait.
  show('loading-view');

  if (!API_BASE_URL || API_BASE_URL.includes('REPLACE_WITH')) {
    showLoginError(
      'API_BASE_URL is not configured. Set the API_BASE_URL repository variable and re-run the Pages workflow.',
    );
    return;
  }

  // A single round trip: /auth/status also reports whether our token is still
  // valid, so a signed-in visitor makes one API call at startup, not two.
  let status = null;
  let statusError = null;
  try {
    status = await api('/auth/status');
  } catch (e) {
    statusError = e;
    console.warn('status check failed', e);
  }
  const info = status && typeof status === 'object' ? status : {};
  $('#register-block').hidden = !info.registrationOpen;

  if (info.user) {
    state.user = info.user;
    enterApp();
    return;
  }

  if (token) setToken(''); // the stored session is no longer valid
  show('login-view');
  if (!status) {
    const err = $('#login-error');
    if (err) {
      // Say exactly what failed and where we looked, so this is diagnosable
      // without opening devtools.
      const reason = statusError && statusError.message ? statusError.message : 'no response';
      err.textContent =
        'Could not reach the API — ' + reason + '.\n' +
        'Tried: ' + API_BASE_URL.replace(/\/+$/, '') + '/auth/status\n' +
        'If that URL opens in a new tab, the Worker is fine and this network (VPN, '
        + 'ad-blocker or DNS filter) is blocking *.workers.dev.';
      err.style.whiteSpace = 'pre-line';
    }
  }
}

function enterApp() {
  $('#user-bar').hidden = false;
  $('#user-name').textContent = state.user?.username || 'owner';
  // Honour a deep link (#/s/<id>) if there is one, otherwise show the dashboard.
  applyRoute().catch((e) => toast('Could not load: ' + (e.message || e)));
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
  open.onclick = () => goToSeries(s.id);
  row.appendChild(open);

  const del = el('button', 'ghost', 'Delete');
  del.onclick = async () => {
    if (!confirm(`Delete "${s.title}" and all its videos?`)) return;
    try {
      await api('/series/' + s.id, { method: 'DELETE' });
      if (state.currentSeries && state.currentSeries.id === s.id) {
        state.currentSeries = null;
        state.videos = [];
        goHome();
      } else {
        await loadDashboard();
      }
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
      if (e.target.closest('button, input, a')) return;
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

  const label = v.title || v.youtubeId || v.url || 'Untitled';
  const link = v.url || (v.youtubeId ? `https://www.youtube.com/watch?v=${v.youtubeId}` : null);
  let title;
  if (link && !state.selectMode) {
    // clicking the title hands the link to the source app (YouTube, Telegram, …)
    title = document.createElement('a');
    title.className = 'vtitle link';
    title.href = link;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    title.textContent = label;
  } else {
    title = el('span', 'vtitle', label);
  }
  title.title = [v.title, link].filter(Boolean).join(' · ');
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

// ---- bulk rename, PowerRename-style ---------------------------------------
function padNum(n, width) {
  const neg = n < 0;
  let s = String(Math.abs(n));
  while (s.length < width) s = '0' + s;
  return (neg ? '-' : '') + s;
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const WEEKDAYS_SHORT = WEEKDAYS.map((d) => d.slice(0, 3));

// Longest token first, so $MMMM is not eaten by $MM.
const DATE_TOKENS = ['YYYY','YY','Y','MMMM','MMM','MM','M','DDDD','DDD','DD','D','HH','hh','TT','tt','H','h','mm','m','ss','s','fff','ff','f'];

function dateValues(d) {
  const h12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  return {
    YYYY: padNum(d.getFullYear(), 4), YY: padNum(d.getFullYear() % 100, 2), Y: String(d.getFullYear() % 10),
    MMMM: MONTHS[d.getMonth()], MMM: MONTHS_SHORT[d.getMonth()],
    MM: padNum(d.getMonth() + 1, 2), M: String(d.getMonth() + 1),
    DDDD: WEEKDAYS[d.getDay()], DDD: WEEKDAYS_SHORT[d.getDay()],
    DD: padNum(d.getDate(), 2), D: String(d.getDate()),
    HH: padNum(h12, 2), H: String(h12), hh: padNum(d.getHours(), 2), h: String(d.getHours()),
    TT: d.getHours() < 12 ? 'AM' : 'PM', tt: d.getHours() < 12 ? 'am' : 'pm',
    mm: padNum(d.getMinutes(), 2), m: String(d.getMinutes()),
    ss: padNum(d.getSeconds(), 2), s: String(d.getSeconds()),
    fff: padNum(d.getMilliseconds(), 3), ff: padNum(d.getMilliseconds(), 2).slice(0, 2), f: String(Math.floor(d.getMilliseconds() / 100)),
  };
}

// Expand ${counter} and $date tokens inside the Replace text.
function expandReplace(tpl, ctx) {
  let out = String(tpl).replace(/\$\$/g, '\u0000'); // $$ is an escaped literal $

  const vals = dateValues(ctx.date);
  for (const tok of DATE_TOKENS) out = out.split('$' + tok).join(vals[tok]);

  // ${}  ${start=X}  ${padding=X}  ${increment=X}   (combine with ;)
  // As in PowerRename, these only work when "Enumerate items" is ticked.
  if (ctx.enumerate) out = out.replace(/\$\{([^}]*)\}/g, (_, body) => {
    const o = { start: 0, increment: 1, padding: 1 };
    for (const part of String(body).split(';')) {
      const m = part.trim().match(/^(\w+)\s*=\s*(-?\d+)$/);
      if (m) o[m[1].toLowerCase()] = parseInt(m[2], 10);
    }
    return padNum(o.start + ctx.index * o.increment, o.padding);
  });

  // aliases kept from earlier versions so old patterns still work
  out = out
    .replace(/\{(?:n|i|index|num|no)(?:\s*:\s*(\d+))?\}/gi, (_, w) => padNum(ctx.index + 1, w ? +w : 1))
    .replace(/\{(\d+)(?:\s*:\s*(\d+))?\}/g, (_, b, w) => padNum(parseInt(b, 10) + ctx.index, w ? +w : 1))
    .replace(/\{title\}/gi, () => ctx.original)
    .replace(/\{id\}/gi, () => ctx.id || '')
    .replace(/\{total\}/gi, () => String(ctx.total));

  return out.split('\u0000').join('$');
}

// Expand $1 / $& / $$ ourselves so a literal $ in the text is never misread.
function substitute(tpl, match) {
  return tpl.replace(/\$(\$|&|\d{1,2})/g, (_, g) => {
    if (g === '$') return '$';
    if (g === '&') return match[0];
    const i = parseInt(g, 10);
    return match[i] == null ? '' : match[i];
  });
}

function replaceAll(source, search, tpl, all, caseSensitive) {
  if (!search) return source;
  const hay = caseSensitive ? source : source.toLowerCase();
  const needle = caseSensitive ? search : search.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const pos = hay.indexOf(needle, i);
    if (pos === -1) break;
    out += source.slice(i, pos) + tpl;
    i = pos + needle.length;
    if (!all) break;
  }
  return out + source.slice(i);
}

function replaceRegex(source, pattern, tpl, all, caseSensitive) {
  let re;
  try {
    re = new RegExp(pattern, (all ? 'g' : '') + (caseSensitive ? '' : 'i'));
  } catch {
    return null; // invalid pattern
  }
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(source)) !== null) {
    out += source.slice(last, m.index) + substitute(tpl, m);
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
    if (!re.global) break;
  }
  return out + source.slice(last);
}

function applyFormat(s, mode) {
  if (mode === 'lower') return s.toLowerCase();
  if (mode === 'upper') return s.toUpperCase();
  if (mode === 'title') return s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  if (mode === 'capitalize') return s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
  return s;
}

function bulkConfig() {
  return {
    search: $('#bulk-search').value,
    replace: $('#bulk-replace').value,
    regex: $('#opt-regex').checked,
    all: $('#opt-all').checked,
    caseSensitive: $('#opt-case').checked,
    enumerate: $('#opt-enum').checked,
    format: $('#bulk-format').value,
  };
}

// Work out the new title for every selected item, in order. The counter only
// advances for items that actually change, like PowerRename does.
function computeBulkPlan() {
  const items = bulkItems();
  const cfg = bulkConfig();
  const date = new Date();
  let counter = 0;

  const rows = items.map((v) => {
    const original = v.title || v.youtubeId || v.url || '';
    let renamed = null;
    let error = null;

    if (cfg.search) {
      const tpl = expandReplace(cfg.replace, {
        index: counter, date, original, id: v.youtubeId, total: items.length, enumerate: cfg.enumerate,
      });
      renamed = cfg.regex
        ? replaceRegex(original, cfg.search, tpl, cfg.all, cfg.caseSensitive)
        : replaceAll(original, cfg.search, tpl, cfg.all, cfg.caseSensitive);
      if (renamed === null) error = 'That is not a valid regular expression.';
      else {
        renamed = applyFormat(renamed, cfg.format);
        if (renamed !== original) counter++;
      }
    } else if (cfg.replace) {
      // no search text: the replacement becomes the whole title
      renamed = applyFormat(
        expandReplace(cfg.replace, { index: counter, date, original, id: v.youtubeId, total: items.length, enumerate: cfg.enumerate }),
        cfg.format,
      );
      counter++;
    }
    return { v, original, renamed, error };
  });

  return { rows, cfg };
}

// Highlight only the part that changed, building nodes (never innerHTML).
function appendDiff(td, a, b) {
  if (a === b) {
    td.textContent = b;
    return;
  }
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  td.appendChild(document.createTextNode(b.slice(0, p)));
  const mid = b.slice(p, b.length - s);
  if (mid) {
    const mark = document.createElement('mark');
    mark.textContent = mid;
    td.appendChild(mark);
  }
  if (s) td.appendChild(document.createTextNode(b.slice(b.length - s)));
}

function bulkRowEl(row, isChanged) {
  const tr = document.createElement('tr');
  if (!isChanged) tr.className = 'unchanged';

  const tdPick = document.createElement('td');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'pick';
  cb.checked = !state.bulkExcluded.has(row.v.id);
  cb.disabled = !isChanged;
  cb.setAttribute('aria-label', 'Include this item');
  cb.onchange = () => {
    if (cb.checked) state.bulkExcluded.delete(row.v.id);
    else state.bulkExcluded.add(row.v.id);
    renderBulkRows();
  };
  tdPick.appendChild(cb);
  tr.appendChild(tdPick);

  tr.appendChild(el('td', 'orig', row.original));

  const tdNew = document.createElement('td');
  tdNew.className = 'new';
  if (row.error) tdNew.textContent = row.original;
  else appendDiff(tdNew, row.original, row.renamed || '');
  tr.appendChild(tdNew);

  return tr;
}

function renderBulkRows() {
  const { rows } = computeBulkPlan();
  const tbody = $('#bulk-rows');
  tbody.innerHTML = '';
  const onlyChanged = $('#bulk-only-changed').checked;

  let changed = 0;
  let shown = 0;
  for (const row of rows) {
    const isChanged = !row.error && row.renamed !== row.original;
    if (isChanged && !state.bulkExcluded.has(row.v.id)) changed++;
    if (onlyChanged && !isChanged) continue;
    shown++;
    tbody.appendChild(bulkRowEl(row, isChanged));
  }

  if (!shown) {
    const tr = document.createElement('tr');
    const td = el('td', 'muted', rows.length ? 'No changes — nothing matches.' : 'Nothing selected.');
    td.colSpan = 3;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  $('#bulk-count').textContent = `${changed} of ${rows.length} will be renamed`;

  const cfg = bulkConfig();
  const bad = rows.find((r) => r.error);
  const needsEnum = /\$\{/.test(cfg.replace) && !cfg.enumerate;
  const warn = $('#bulk-warn');
  warn.hidden = !bad && !needsEnum;
  warn.textContent = bad
    ? bad.error
    : needsEnum
      ? 'Tick "Enumerate items" for ${...} counters to be used.'
      : '';
}

const BULK_MRU_KEY = 'ytq_bulk_mru';

function saveBulkMru(cfg) {
  try {
    localStorage.setItem(BULK_MRU_KEY, JSON.stringify(cfg));
  } catch {
    /* storage may be unavailable */
  }
}

function openBulkRename() {
  const items = bulkItems();
  if (!items.length) return;
  $('#bulk-sub').textContent = `${items.length} selected item${items.length > 1 ? 's' : ''}.`;
  state.bulkExcluded = new Set();

  let recent = null;
  try {
    recent = JSON.parse(localStorage.getItem(BULK_MRU_KEY) || 'null');
  } catch {
    recent = null;
  }
  $('#bulk-search').value = recent ? recent.search || '' : '';
  $('#bulk-replace').value = recent ? recent.replace || '' : '';
  $('#opt-regex').checked = !!(recent && recent.regex);
  $('#opt-all').checked = recent ? recent.all !== false : true;
  $('#opt-case').checked = !!(recent && recent.caseSensitive);
  $('#opt-enum').checked = !!(recent && recent.enumerate);
  $('#bulk-format').value = recent && recent.format ? recent.format : 'none';
  $('#bulk-only-changed').checked = false;

  renderBulkRows();
  $('#bulk-modal').hidden = false;
  setTimeout(() => $('#bulk-search').focus(), 30);
}

function closeBulkRename() {
  $('#bulk-modal').hidden = true;
}

let lastUndo = null;

function offerUndo(entries) {
  lastUndo = entries;
  $('#undo-text').textContent = `Renamed ${entries.length} item${entries.length > 1 ? 's' : ''}.`;
  $('#undo-bar').hidden = false;
}

async function undoRename() {
  const entries = lastUndo;
  if (!entries) return;
  lastUndo = null;
  $('#undo-bar').hidden = true;

  let failed = 0;
  await Promise.all(
    entries.map(async (e) => {
      try {
        await api('/videos/' + e.id, { method: 'PATCH', body: { title: e.title == null ? '' : e.title } });
        const v = state.videos.find((x) => x.id === e.id);
        if (v) v.title = e.title == null ? null : e.title;
      } catch {
        failed += 1;
      }
    }),
  );
  renderSeries();
  toast(failed ? `${failed} could not be restored.` : 'Rename undone.');
}

async function applyBulkRename() {
  const { rows, cfg } = computeBulkPlan();
  const targets = rows.filter((r) => !r.error && r.renamed !== r.original && !state.bulkExcluded.has(r.v.id));
  if (!targets.length) {
    closeBulkRename();
    toast('Nothing to rename.');
    return;
  }
  saveBulkMru(cfg);

  const btn = $('#bulk-apply');
  btn.disabled = true;
  btn.textContent = 'Applying…';
  const undo = [];
  let failed = 0;
  try {
    await Promise.all(
      targets.map(async (r) => {
        try {
          await api('/videos/' + r.v.id, { method: 'PATCH', body: { title: r.renamed } });
          undo.push({ id: r.v.id, title: r.v.title });
          r.v.title = r.renamed || null;
          r.v.titleAuto = false;
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
  if (undo.length) offerUndo(undo);
  if (failed) toast(`${failed} of ${targets.length} could not be renamed.`);
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
function showPlayerMode(mode, v) {
  const frame = $('#frame-player');
  const fallback = $('#frame-fallback');
  $('#yt-player').hidden = mode !== 'yt';
  frame.hidden = mode !== 'frame';
  $('#external-player').hidden = mode !== 'external';

  if (mode === 'frame') {
    frame.src = v.embedUrl || v.url;
    const open = $('#frame-open');
    open.href = v.url || '#';
    open.textContent = openLabel(v) + ' ↗';
    fallback.hidden = false;
  } else {
    if (frame.getAttribute('src')) frame.removeAttribute('src');
    fallback.hidden = true;
  }

  if (mode === 'external') {
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
    const open = $('#ext-open');
    open.href = v.url || '#';
    open.textContent = openLabel(v) + ' ↗';
    $('#now-progress').textContent =
      v.source === 'telegram'
        ? 'Telegram will not show this post inside another app, so it opens in Telegram.'
        : 'Opens in a new tab — mark it done here when you have finished.';
  }
}

async function showPlayer(videoId) {
  const v = state.videos.find((x) => x.id === videoId);
  if (!v) { show('series-view'); return; }
  // show the view first: the YouTube player needs a laid-out container to size itself
  show('player-view');
  await playVideo(v);
}

// Keep the URL in step with the player, then show it.
async function openPlayer(videoId) {
  if (!state.currentSeries) { await showPlayer(videoId); return; }
  const target = videoHash(state.currentSeries.id, videoId);
  if (location.hash === target) { await showPlayer(videoId); return; }
  location.hash = target; // hashchange -> applyRoute -> showPlayer
}

async function playVideo(v) {
  state.currentVideoId = v.id;
  $('#now-title').textContent = v.title || v.url || v.youtubeId || 'Untitled';
  const list = activeVideos();
  const i = list.findIndex((x) => x.id === v.id);
  $('#now-progress').textContent = i === -1 ? '' : `${i + 1} of ${list.length}`;
  updateUpNext();

  if (v.source === 'youtube' && v.youtubeId) {
    showPlayerMode('yt', v);
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
  if (v.embeddable && (v.embedUrl || v.url)) showPlayerMode('frame', v);
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
      const { startAuthentication } = await passkeys();
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
      const { startRegistration } = await passkeys();
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

  const copyLinkBtn = $('#copy-series-link');
  if (copyLinkBtn) {
    copyLinkBtn.onclick = async () => {
      if (!state.currentSeries) return;
      const url = location.origin + location.pathname + seriesHash(state.currentSeries.id);
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copied: ' + url);
      } catch {
        toast(url);
      }
    };
  }

  $('#back-to-dash').onclick = () => {
    pauseYt();
    goHome();
  };
  $('#back-to-series').onclick = () => {
    pauseYt();
    if (state.currentSeries) goToSeries(state.currentSeries.id);
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
  ['#bulk-search', '#bulk-replace'].forEach((s) => $(s).addEventListener('input', renderBulkRows));
  ['#opt-regex', '#opt-all', '#opt-case', '#opt-enum', '#bulk-only-changed'].forEach((s) =>
    $(s).addEventListener('change', renderBulkRows),
  );
  $('#bulk-format').addEventListener('change', renderBulkRows);
  $('#bulk-modal').onclick = (e) => {
    if (e.target === $('#bulk-modal')) closeBulkRename();
  };

  // undo the last rename
  $('#undo-btn').onclick = () => undoRename();
  $('#undo-dismiss').onclick = () => {
    lastUndo = null;
    $('#undo-bar').hidden = true;
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
