/* YT Video Queue — Save · popup */

const SITE_URL = 'https://pavnxet.github.io/yt-video-queue/';

const $ = (s) => document.querySelector(s);
const el = {
  status: $('#status'), setup: $('#setup'), saveCard: $('#saveCard'), noVideo: $('#noVideo'),
  thumb: $('#thumb'), vtitle: $('#vtitle'), vsub: $('#vsub'),
  series: $('#series'), newrow: $('#newrow'), newname: $('#newname'), create: $('#create'),
  save: $('#save'), msg: $('#msg'), seriesList: $('#seriesList'),
  settings: $('#settings'), openSettings: $('#openSettings'), openSite: $('#openSite'),
  refresh: $('#refresh'), openQueue: $('#openQueue'), lastSaved: $('#lastSaved')
};

let state = { apiBaseUrl: '', hasToken: false, lastSeriesId: '', lastSeriesTitle: '', settings: {} };
let currentVideo = null;

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(r || { ok: false, error: 'No response' });
    });
  });
}

function setMsg(text, kind) { el.msg.textContent = text || ''; el.msg.className = 'msg ' + (kind || ''); }

function fmtDur(sec) {
  sec = Math.round(sec || 0);
  if (!sec) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}

function connected() { return !!(state.apiBaseUrl && state.hasToken); }

// ------------------------------------------------------------------ tabs

async function activeVideo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/youtube\.com/.test(tab.url || '')) return null;
  try {
    const info = await chrome.tabs.sendMessage(tab.id, { type: 'getVideoInfo' });
    return info && info.videoId ? info : null;
  } catch {
    return null; // content script not ready yet (page loaded before install)
  }
}

// ------------------------------------------------------------------ render

function renderStatus() {
  if (connected()) {
    el.status.textContent = 'Connected';
    el.status.className = 'sub ok';
    el.setup.hidden = true;
  } else {
    el.status.textContent = 'Not connected';
    el.status.className = 'sub warn';
    el.setup.hidden = false;
  }
}

function renderVideo() {
  if (!currentVideo) {
    el.saveCard.hidden = true;
    el.noVideo.hidden = false;
    return;
  }
  el.noVideo.hidden = true;
  el.saveCard.hidden = false;
  el.vtitle.textContent = currentVideo.title || 'Untitled video';
  el.vsub.textContent = [currentVideo.channel, fmtDur(currentVideo.durationSeconds)].filter(Boolean).join(' · ') || 'YouTube';
  el.thumb.src = currentVideo.thumbnail || '';
}

async function renderSeries() {
  if (!connected()) {
    el.seriesList.innerHTML = '<li class="muted">Connect to see your series.</li>';
    el.series.innerHTML = '';
    el.series.disabled = true;
    el.save.disabled = true;
    return;
  }
  el.seriesList.innerHTML = '<li class="muted">Loading…</li>';
  const r = await send({ type: 'series' });
  if (!r || !r.ok) {
    el.seriesList.innerHTML = `<li class="muted">${escapeHtml(r && r.error ? r.error : 'Could not load series.')}</li>`;
    el.series.innerHTML = '';
    el.series.disabled = true;
    el.save.disabled = true;
    return;
  }
  const list = r.series || [];

  // dropdown
  if (!list.length) {
    el.series.innerHTML = '<option value="">No series yet — create one</option>';
    el.series.disabled = true;
    el.save.disabled = true;
    el.newrow.hidden = false;
  } else {
    el.series.disabled = false;
    el.save.disabled = false;
    el.series.innerHTML = list.map((s) => `<option value="${s.id}">${escapeHtml(s.title)} · ${s.done}/${s.total}</option>`).join('');
    if (state.lastSeriesId && list.some((s) => s.id === state.lastSeriesId)) el.series.value = state.lastSeriesId;
    el.newrow.hidden = true;
  }

  // list
  el.seriesList.innerHTML = list.length
    ? list.map((s) => `<li data-id="${s.id}" class="${s.id === state.lastSeriesId ? 'active' : ''}">
         <span class="nm">${escapeHtml(s.title)}</span>
         <span class="st">${s.done}/${s.total}</span>
       </li>`).join('')
    : '<li class="muted">No series yet.</li>';

  el.seriesList.querySelectorAll('li[data-id]').forEach((li) => {
    li.addEventListener('click', async () => {
      const id = li.getAttribute('data-id');
      await send({ type: 'setConfig', patch: { lastSeriesId: id } });
      state.lastSeriesId = id;
      el.series.value = id;
      el.seriesList.querySelectorAll('li').forEach((x) => x.classList.toggle('active', x === li));
      el.lastSaved.textContent = 'Default series set';
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ------------------------------------------------------------------ actions

el.save.addEventListener('click', async () => {
  if (!currentVideo) return;
  const seriesId = el.series.value;
  if (!seriesId) { setMsg('Create a series first.', 'warn'); return; }
  el.save.disabled = true;
  setMsg('Saving…');
  const r = await send({
    type: 'save', seriesId, url: currentVideo.url,
    durationSeconds: currentVideo.durationSeconds, resumeSeconds: currentVideo.currentTime
  });
  el.save.disabled = false;
  if (r && r.ok) {
    setMsg(`Saved to “${r.seriesTitle || 'your queue'}”.`, 'ok');
    el.lastSaved.textContent = 'Saved ✓';
    await renderSeries();
  } else if (r && r.duplicate) {
    setMsg(`Already in “${r.seriesTitle || 'that series'}”.`, 'warn');
  } else {
    setMsg('Could not save: ' + (r && r.error ? r.error : 'unknown'), 'err');
  }
});

el.create.addEventListener('click', async () => {
  const name = (el.newname.value || '').trim();
  if (!name) { setMsg('Type a name first.', 'warn'); return; }
  el.create.disabled = true;
  const r = await send({ type: 'createSeries', title: name });
  el.create.disabled = false;
  if (!r || !r.ok) { setMsg('Could not create: ' + (r && r.error ? r.error : 'unknown'), 'err'); return; }
  el.newname.value = '';
  state.lastSeriesId = r.id;
  await send({ type: 'setConfig', patch: { lastSeriesId: r.id } });
  setMsg('Series created.', 'ok');
  await renderSeries();
  el.series.value = r.id;
});

el.refresh.addEventListener('click', async () => { await boot(false); });
el.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());
el.openSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
el.openSite.addEventListener('click', () => chrome.tabs.create({ url: SITE_URL }));
el.openQueue.addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: SITE_URL }); });

// ------------------------------------------------------------------ boot

async function boot(first) {
  const st = await send({ type: 'state' });
  if (st && st.ok) state = { ...state, ...st };
  renderStatus();

  // A link queued from the right-click menu while no series was set.
  if (first) {
    const { pendingSave } = await chrome.storage.local.get('pendingSave');
    if (pendingSave) {
      await chrome.storage.local.remove('pendingSave');
      currentVideo = { videoId: (pendingSave.match(/[?&]v=([A-Za-z0-9_-]{11})/) || [])[1] || 'link', url: pendingSave, title: 'Link from the page', channel: '', durationSeconds: 0, currentTime: 0, thumbnail: '' };
    }
  }
  if (!currentVideo) currentVideo = await activeVideo();
  renderVideo();
  await renderSeries();
}

boot(true);
