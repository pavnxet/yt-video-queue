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
    // status endpoint failing usually means the API isn't reachable yet
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
  const el = $('#series-list');
  el.innerHTML = '';
  if (!state.series.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No series yet. Create one above.';
    el.appendChild(p);
    return;
  }
  for (const s of state.series) {
    const card = document.createElement('div');
    card.className = 'card series-card';

    const h = document.createElement('h3');
    h.textContent = s.title;
    card.appendChild(h);

    if (s.description) {
      const d = document.createElement('p');
      d.className = 'muted';
      d.textContent = s.description;
      card.appendChild(d);
    }

    const prog = document.createElement('p');
    prog.className = 'muted';
    prog.textContent = `${s.done} / ${s.total} watched`;
    card.appendChild(prog);

    const row = document.createElement('div');
    row.className = 'row-buttons';

    const open = document.createElement('button');
    open.className = 'primary';
    open.textContent = 'Open';
    open.onclick = () => openSeries(s.id);
    row.appendChild(open);

    const del = document.createElement('button');
    del.className = 'ghost';
    del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm(`Delete "${s.title}" and all its videos?`)) return;
      await api('/series/' + s.id, { method: 'DELETE' });
      loadDashboard();
    };
    row.appendChild(del);

    card.appendChild(row);
    el.appendChild(card);
  }
}

// -------------------------------------------------------------------- series
async function openSeries(id) {
  const data = await api('/series/' + id);
  state.currentSeries = data.series;
  state.videos = data.videos;
  show('series-view');
  renderSeries();
}

function renderSeries() {
  $('#series-title-heading').textContent = state.currentSeries.title;
  const done = state.videos.filter((v) => v.status === 'done').length;
  $('#series-progress').textContent = `${done} / ${state.videos.length} watched`;

  const ol = $('#video-list');
  ol.innerHTML = '';

  state.videos.forEach((v, i) => {
    const li = document.createElement('li');
    li.className = 'video-item status-' + v.status;

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i + 1);

    const title = document.createElement('span');
    title.className = 'vtitle';
    title.textContent = v.title || v.youtubeId;

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = v.status;

    const play = document.createElement('button');
    play.className = 'ghost';
    play.title = 'Play';
    play.textContent = '▶';
    play.onclick = () => openPlayer(v.id);

    const up = document.createElement('button');
    up.className = 'ghost';
    up.title = 'Move up';
    up.textContent = '↑';
    up.onclick = () => moveVideo(i, -1);

    const down = document.createElement('button');
    down.className = 'ghost';
    down.title = 'Move down';
    down.textContent = '↓';
    down.onclick = () => moveVideo(i, 1);

    const mark = document.createElement('button');
    mark.className = 'ghost';
    mark.title = v.status === 'done' ? 'Mark as not watched' : 'Mark as watched';
    mark.textContent = v.status === 'done' ? '↺' : '✓';
    mark.onclick = () => toggleDone(v);

    const del = document.createElement('button');
    del.className = 'ghost';
    del.title = 'Delete';
    del.textContent = '✕';
    del.onclick = () => removeVideo(v.id);

    li.append(idx, title, badge, play, up, down, mark, del);
    ol.appendChild(li);
  });
}

async function moveVideo(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= state.videos.length) return;
  const arr = state.videos.slice();
  [arr[i], arr[j]] = [arr[j], arr[i]];
  state.videos = arr;
  renderSeries();
  await api('/series/' + state.currentSeries.id + '/reorder', {
    method: 'POST',
    body: { orderedIds: arr.map((v) => v.id) },
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
  if (!video) return state.videos.find((x) => x.status !== 'done') || null;
  const i = state.videos.findIndex((x) => x.id === video.id);
  for (let k = i + 1; k < state.videos.length; k++) {
    if (state.videos[k].status !== 'done') return state.videos[k];
  }
  return null;
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
  const v = currentVideo();
  const i = state.videos.findIndex((x) => x.id === (v && v.id));
  if (i > 0) await playVideo(state.videos[i - 1]);
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
      const result = await api('/auth/login/verify', {
        method: 'POST',
        body: { ceremonyId, response: assertion },
      });
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
      const result = await api('/auth/register/verify', {
        method: 'POST',
        body: { ceremonyId, response: attestation },
      });
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
    await api('/series', {
      method: 'POST',
      body: { title, description: $('#series-desc').value.trim() },
    });
    $('#series-title').value = '';
    $('#series-desc').value = '';
    loadDashboard();
  };

  $('#add-videos-form').onsubmit = async (e) => {
    e.preventDefault();
    const urls = $('#video-links').value.trim();
    if (!urls) return;
    await api('/series/' + state.currentSeries.id + '/videos', {
      method: 'POST',
      body: { urls },
    });
    $('#video-links').value = '';
    openSeries(state.currentSeries.id);
  };

  $('#back-to-dash').onclick = () => loadDashboard();
  $('#back-to-series').onclick = () => {
    if (player) player.pause();
    openSeries(state.currentSeries.id);
  };

  $('#play-btn').onclick = () => {
    const v = state.videos.find((x) => x.status !== 'done') || state.videos[0];
    if (v) openPlayer(v.id);
  };

  $('#prev-btn').onclick = () => goPrev();
  $('#next-btn').onclick = () => goNext();
  $('#mark-done-btn').onclick = () => onVideoEnded();
  $('#autoplay-toggle').onchange = (e) => {
    state.autoplay = e.target.checked;
  };
}

init();
