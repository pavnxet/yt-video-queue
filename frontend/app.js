// app.js — the single-page controller: auth, dashboard, series, player queue.
import { API_BASE_URL } from './config.js';
import { QueuePlayer } from './player.js';
import { startRegistration, startAuthentication } from 'https://esm.sh/@simplewebauthn/browser@13';

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
  if (save) await save(value);
}

// ------------------------------------------------------------------- routing
async function init() {
  wireEvents();

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
    } catch {
      setToken('');
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
  try {
    const { series } = await api('/series');
    state.series = series;
  } catch (e) {
    if (e instanceof AuthError) return show('login-view');
    throw e;
  }
  const list = $('#series-list');
  list.innerHTML = '';
  if (!state.series.length) {
    list.appendChild(el('p', 'muted', 'No series yet. Create one above.'));
    return;
  }
  for (const s of state.series) list.appendChild(seriesCard(s));
}

function seriesCard(s) {
  const card = el('div', 'card glass series-card');
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
    await api('/series/' + s.id, { method: 'DELETE' });
    loadDashboard();
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
  show('series-view');
  renderSeries();
}

function activeVideos() {
  return state.videos.filter((v) => v.status !== 'done');
}

function renderSeries() {
  $('#series-title-heading').textContent = state.currentSeries.title;
  const done = state.videos.filter((v) => v.status === 'done').length;
  $('#series-progress').textContent = `${done} / ${state.videos.length} watched`;

  const active = activeVideos();
  const watched = state.videos.filter((v) => v.status === 'done');

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
}

function videoRow(v, index) {
  const li = el('li', 'video-item status-' + v.status);

  if (index != null) li.appendChild(el('span', 'idx', String(index)));

  const title = el('span', 'vtitle', v.title || v.youtubeId);
  title.title = v.title ? `${v.title} · ${v.youtubeId}` : v.youtubeId;
  li.appendChild(title);

  if (v.status === 'watching') li.appendChild(el('span', 'badge', 'watching'));

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

  const full = state.videos.slice();
  const i1 = full.findIndex((v) => v.id === active[ai].id);
  const i2 = full.findIndex((v) => v.id === active[aj].id);
  [full[i1], full[i2]] = [full[i2], full[i1]];
  state.videos = full;

  renderSeries();
  await api('/series/' + state.currentSeries.id + '/reorder', {
    method: 'POST',
    body: { orderedIds: full.map((v) => v.id) },
  });
}

async function toggleDone(v) {
  const next = v.status === 'done' ? 'todo' : 'done';
  await api('/videos/' + v.id, { method: 'PATCH', body: { status: next, resumeSeconds: 0 } });
  v.status = next;
  renderSeries();
}

async function removeVideo(id) {
  if (!confirm('Remove this video from the series?')) return;
  await api('/videos/' + id, { method: 'DELETE' });
  state.videos = state.videos.filter((v) => v.id !== id);
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

// -------------------------------------------------------------------- player
async function ensurePlayer() {
  if (player) return player;
  player = new QueuePlayer({
    elementId: 'yt-player',
    handlers: {
      onEnded: () => onVideoEnded(),
      onProgress: (t) => saveProgress(t),
      onError: (e) => console.warn('YouTube player error', e.data),
    },
  });
  await player.ready();
  return player;
}

function currentVideo() {
  return state.videos.find((v) => v.id === state.currentVideoId) || null;
}

function nextAfter(video) {
  const list = activeVideos();
  if (!video) return list[0] || null;
  const i = list.findIndex((x) => x.id === video.id);
  if (i === -1) return list[0] || null;
  return list[i + 1] || null;
}

function prevBefore(video) {
  const list = activeVideos();
  const i = list.findIndex((x) => x.id === (video && video.id));
  return i > 0 ? list[i - 1] : null;
}

async function openPlayer(videoId) {
  await ensurePlayer();
  show('player-view');
  const v = state.videos.find((x) => x.id === videoId);
  if (!v) return;
  await playVideo(v);
}

async function playVideo(v) {
  state.currentVideoId = v.id;
  $('#now-title').textContent = v.title || v.youtubeId;
  const list = activeVideos();
  const i = list.findIndex((x) => x.id === v.id);
  $('#now-progress').textContent = i === -1 ? '' : `${i + 1} of ${list.length}`;
  updateUpNext();
  await player.load(v);
}

function updateUpNext() {
  const n = nextAfter(currentVideo());
  $('#up-next').textContent = n
    ? 'Up next: ' + (n.title || n.youtubeId)
    : 'Up next: — end of series —';
}

async function saveProgress(t) {
  const v = currentVideo();
  if (!v) return;
  try {
    await api('/videos/' + v.id, { method: 'PATCH', body: { status: 'watching', resumeSeconds: t } });
    v.resumeSeconds = t;
    if (v.status !== 'done') v.status = 'watching';
  } catch {}
}

async function onVideoEnded() {
  const v = currentVideo();
  if (v) {
    try {
      await api('/videos/' + v.id, { method: 'PATCH', body: { status: 'done', resumeSeconds: 0 } });
      v.status = 'done';
      v.resumeSeconds = 0;
    } catch {}
  }
  const n = nextAfter(v);
  if (state.autoplay && n) {
    await playVideo(n);
  } else {
    updateUpNext();
  }
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
    await api('/series', { method: 'POST', body: { title, description: $('#series-desc').value.trim() } });
    $('#series-title').value = '';
    $('#series-desc').value = '';
    loadDashboard();
  };

  $('#add-videos-form').onsubmit = async (e) => {
    e.preventDefault();
    const urls = $('#video-links').value.trim();
    if (!urls) return;
    await api('/series/' + state.currentSeries.id + '/videos', { method: 'POST', body: { urls } });
    $('#video-links').value = '';
    openSeries(state.currentSeries.id);
  };

  $('#rename-series-btn').onclick = () => renameSeries();

  $('#back-to-dash').onclick = () => loadDashboard();
  $('#back-to-series').onclick = () => {
    if (player) player.pause();
    openSeries(state.currentSeries.id);
  };

  $('#play-btn').onclick = () => {
    const list = activeVideos();
    const v = list[0] || state.videos[0];
    if (v) openPlayer(v.id);
  };

  $('#prev-btn').onclick = () => goPrev();
  $('#next-btn').onclick = () => goNext();
  $('#mark-done-btn').onclick = () => onVideoEnded();
  $('#autoplay-toggle').onchange = (e) => {
    state.autoplay = e.target.checked;
  };

  // modal
  $('#modal-save').onclick = () => submitModal();
  $('#modal-cancel').onclick = () => closeModal();
  $('#modal').onclick = (e) => {
    if (e.target === $('#modal')) closeModal();
  };
  $('#modal-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitModal();
    } else if (e.key === 'Escape') {
      closeModal();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
  });
}

init();
