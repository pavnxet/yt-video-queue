/* Toolbar popup: playlist import, selected-series insights and quick actions. */
const SITE_URL = 'https://pavnxet.github.io/yt-video-queue/';
const $ = (selector) => document.querySelector(selector);
const el = Object.fromEntries([
  'status', 'setup', 'saveCard', 'playlistCard', 'noVideo', 'thumb', 'vtitle', 'vsub',
  'playlistTitle', 'importAutoSync', 'importPlaylist', 'playlistMsg', 'series', 'newToggle',
  'newrow', 'newname', 'create', 'save', 'queuedActions', 'savePosition', 'markWatched',
  'videoStatus', 'msg', 'seriesList', 'insights', 'progressLabel', 'progressPercent',
  'progressBar', 'remainingTime', 'totalTime', 'watchedTime', 'inProgress', 'durationCoverage',
  'linkedTools', 'syncStatus', 'autoSync', 'refreshPlaylist', 'restorePlaylist', 'openSeries',
  'settings', 'openSettings', 'openSite', 'refresh', 'openQueue', 'lastSaved', 'togglePill', 'resetPill',
].map((id) => [id, $('#' + id)]));

let state = { apiBaseUrl: '', hasToken: false, lastSeriesId: '', settings: {} };
let currentVideo = null;
let currentPlaylist = '';
let selectedSeries = null;
let selectedVideo = null;
let seriesList = [];
let detailRequest = 0;

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(r || { ok: false, error: 'No response' });
      });
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}
function message(target, text, kind = '') { target.textContent = text || ''; target.className = 'msg ' + kind; }
function connected() { return !!(state.apiBaseUrl && state.hasToken); }
function fmtClock(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}

async function activeContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { video: null, playlist: '' };
  const playlist = YTQShared.playlistUrl(tab.url || '');
  if (!tab.id || !YTQShared.videoIdFrom(tab.url || '')) return { video: null, playlist };
  try {
    const info = await chrome.tabs.sendMessage(tab.id, { type: 'getVideoInfo' });
    const id = info && YTQShared.videoIdFrom(info.url);
    return { video: id && id === info.videoId ? info : null, playlist };
  } catch { return { video: null, playlist }; }
}

function renderStatus() {
  const ok = connected();
  el.status.textContent = ok ? 'Connected' : 'Not connected';
  el.status.className = 'sub ' + (ok ? 'ok' : 'warn');
  el.setup.hidden = ok;
  el.importPlaylist.disabled = !ok;
}

function renderContext() {
  el.saveCard.hidden = !currentVideo;
  el.playlistCard.hidden = !currentPlaylist;
  el.noVideo.hidden = !!(currentVideo || currentPlaylist);
  if (currentVideo) {
    el.vtitle.textContent = currentVideo.title || 'Untitled video';
    el.vsub.textContent = [currentVideo.channel, currentVideo.durationSeconds ? fmtClock(currentVideo.durationSeconds) : ''].filter(Boolean).join(' · ') || 'YouTube';
    if (currentVideo.thumbnail) { el.thumb.src = currentVideo.thumbnail; el.thumb.hidden = false; }
    else { el.thumb.removeAttribute('src'); el.thumb.hidden = true; }
  }
}

function renderSeriesList() {
  el.seriesList.replaceChildren();
  for (const series of seriesList) {
    const item = document.createElement('li');
    if (series.id === el.series.value) item.classList.add('active');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'series-choice';
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = series.title + (series.playlistId ? ' · playlist' : '');
    const count = document.createElement('span');
    count.className = 'st';
    count.textContent = `${series.done}/${series.total}`;
    button.append(name, count);
    button.addEventListener('click', async () => {
      el.series.value = series.id;
      await chooseSeries();
    });
    item.appendChild(button);
    el.seriesList.appendChild(item);
  }
  if (!seriesList.length) {
    const item = document.createElement('li');
    item.className = 'muted';
    item.textContent = 'No series yet.';
    el.seriesList.appendChild(item);
  }
}

async function renderSeries(preferred) {
  const prior = preferred || el.series.value || state.lastSeriesId;
  if (!connected()) {
    detailRequest++;
    selectedSeries = null; selectedVideo = null;
    seriesList = [];
    el.series.replaceChildren(new Option('Connect to see your series', ''));
    el.series.disabled = true;
    el.save.hidden = !currentVideo;
    el.save.disabled = true;
    el.insights.hidden = true;
    el.queuedActions.hidden = true;
    el.videoStatus.hidden = true;
    renderSeriesList();
    return;
  }
  const r = await send({ type: 'series' });
  if (!r.ok) {
    detailRequest++;
    selectedSeries = null; selectedVideo = null;
    message(el.msg, r.error || 'Could not load series.', 'err');
    el.series.disabled = true; el.save.disabled = true; el.insights.hidden = true;
    el.queuedActions.hidden = true; el.videoStatus.hidden = true;
    return;
  }
  seriesList = r.series || [];
  el.series.replaceChildren();
  if (!seriesList.length) {
    detailRequest++;
    selectedSeries = null; selectedVideo = null;
    el.series.appendChild(new Option('No series yet — create one', ''));
    el.series.disabled = true;
    el.save.hidden = !currentVideo; el.save.disabled = true;
    el.newrow.hidden = false;
    el.insights.hidden = true; el.queuedActions.hidden = true; el.videoStatus.hidden = true;
    renderSeriesList();
    return;
  }
  for (const series of seriesList) el.series.appendChild(new Option(`${series.title} · ${series.done}/${series.total}`, series.id));
  if (seriesList.some((series) => series.id === prior)) el.series.value = prior;
  el.series.disabled = false;
  renderSeriesList();
  await loadSelectedSeries();
}

async function chooseSeries() {
  const id = el.series.value;
  state.lastSeriesId = id;
  await send({ type: 'setConfig', patch: { lastSeriesId: id } });
  el.lastSaved.textContent = 'Default series set';
  renderSeriesList();
  await loadSelectedSeries();
}

async function loadSelectedSeries() {
  const id = el.series.value;
  const request = ++detailRequest;
  if (!id) { el.insights.hidden = true; return; }
  const r = await send({ type: 'seriesVideos', seriesId: id });
  if (request !== detailRequest || el.series.value !== id) return;
  if (!r.ok) {
    selectedSeries = null; selectedVideo = null;
    el.insights.hidden = true; el.save.disabled = true; el.queuedActions.hidden = true;
    message(el.msg, r.error || 'Could not load series.', 'err');
    return;
  }
  selectedSeries = r.series;
  const stats = YTQShared.seriesStats(r.videos);
  el.insights.hidden = false;
  el.progressLabel.textContent = `${stats.watched} / ${stats.total} watched · ${stats.remaining} left`;
  el.progressPercent.textContent = `${stats.percent}%`;
  el.progressBar.value = stats.percent;
  el.progressBar.setAttribute('aria-valuetext', stats.total ? `${stats.watched} of ${stats.total} watched; ${stats.remaining} remaining` : 'No videos yet');
  el.remainingTime.textContent = stats.known ? `Remaining: ${YTQShared.formatDuration(stats.remainingSeconds)}` : 'Remaining: —';
  el.totalTime.textContent = stats.known ? `Total: ${YTQShared.formatDuration(stats.totalSeconds)}` : 'Total: —';
  el.watchedTime.textContent = stats.known ? `Estimated watched: ${YTQShared.formatDuration(stats.watchedSeconds)}` : 'Estimated watched: —';
  el.inProgress.textContent = stats.inProgress ? `${stats.inProgress} in progress` : '';
  el.durationCoverage.textContent = stats.total ? `${stats.known} of ${stats.total} durations known${stats.unknown ? '; unknown lengths excluded' : ''}.` : 'Add videos to see watch time.';
  const playlist = r.series.playlist;
  el.linkedTools.hidden = !playlist;
  if (playlist) {
    el.autoSync.checked = !!playlist.autoSync;
    const date = playlist.lastSyncedAt ? new Date(playlist.lastSyncedAt) : null;
    const synced = date && !Number.isNaN(date.getTime()) ? `Last synced ${date.toLocaleString()}` : 'Not synced yet';
    el.syncStatus.textContent = playlist.lastError ? `Last refresh failed: ${playlist.lastError}` : `${synced} · ${playlist.autoSync ? 'checks roughly every 6 hours' : 'auto-sync off'}`;
  }
  selectedVideo = currentVideo ? r.videos.find((v) => v.youtubeId === currentVideo.videoId) || null : null;
  el.save.hidden = !currentVideo;
  el.save.disabled = !currentVideo || !!selectedVideo;
  el.save.textContent = selectedVideo ? 'Already in this series' : 'Save video to series';
  el.queuedActions.hidden = !selectedVideo;
  el.videoStatus.hidden = !selectedVideo;
  if (selectedVideo) {
    el.videoStatus.textContent = selectedVideo.status === 'done' ? 'This video is marked watched.' :
      `In this series${selectedVideo.resumeSeconds ? ` · saved at ${fmtClock(selectedVideo.resumeSeconds)}` : ''}.`;
    el.savePosition.hidden = selectedVideo.status === 'done';
    el.markWatched.textContent = selectedVideo.status === 'done' ? 'Mark unwatched' : 'Mark watched';
  }
}

el.series.addEventListener('change', chooseSeries);
el.newToggle.addEventListener('click', () => { el.newrow.hidden = !el.newrow.hidden; if (!el.newrow.hidden) el.newname.focus(); });
el.create.addEventListener('click', async () => {
  const title = el.newname.value.trim();
  if (!title) { message(el.msg, 'Enter a series name.', 'warn'); return; }
  el.create.disabled = true;
  const r = await send({ type: 'createSeries', title });
  el.create.disabled = false;
  if (!r.ok) { message(el.msg, r.error || 'Could not create series.', 'err'); return; }
  el.newname.value = ''; el.newrow.hidden = true;
  state.lastSeriesId = r.id;
  await send({ type: 'setConfig', patch: { lastSeriesId: r.id } });
  await renderSeries(r.id);
  message(el.msg, 'Series created.', 'ok');
});

el.save.addEventListener('click', async () => {
  if (!currentVideo || !el.series.value) return;
  const id = el.series.value;
  el.save.disabled = true; message(el.msg, 'Saving…');
  const r = await send({ type: 'save', seriesId: id, url: currentVideo.url, durationSeconds: currentVideo.durationSeconds, resumeSeconds: currentVideo.currentTime });
  if (!r.ok) { el.save.disabled = false; message(el.msg, r.duplicate ? `Already in “${r.seriesTitle || 'this series'}”.` : r.error || 'Could not save.', r.duplicate ? 'warn' : 'err'); return; }
  state.lastSeriesId = id;
  await renderSeries(id);
  message(el.msg, r.warning || `Saved to “${r.seriesTitle || 'your queue'}”.`, r.warning ? 'warn' : 'ok');
});

el.savePosition.addEventListener('click', async () => {
  if (!selectedVideo || !currentVideo || selectedVideo.status === 'done') return;
  const context = await activeContext();
  if (!context.video || context.video.videoId !== currentVideo.videoId) { message(el.msg, 'The active video changed. Refresh the popup.', 'warn'); return; }
  currentVideo = context.video;
  if (!(currentVideo.currentTime > 0)) { message(el.msg, 'Play the video first to save a position.', 'warn'); return; }
  el.savePosition.disabled = true;
  const r = await send({ type: 'patchVideo', videoId: selectedVideo.id, status: 'watching', resumeSeconds: currentVideo.currentTime, durationSeconds: selectedVideo.durationSeconds ? undefined : currentVideo.durationSeconds });
  el.savePosition.disabled = false;
  if (!r.ok) { message(el.msg, r.error || 'Could not save position.', 'err'); return; }
  await loadSelectedSeries();
  message(el.msg, `Position saved at ${fmtClock(currentVideo.currentTime)}.`, 'ok');
});

el.markWatched.addEventListener('click', async () => {
  if (!selectedVideo) return;
  const toDone = selectedVideo.status !== 'done';
  el.markWatched.disabled = true;
  const r = await send({ type: 'patchVideo', videoId: selectedVideo.id, status: toDone ? 'done' : 'todo', resumeSeconds: 0 });
  el.markWatched.disabled = false;
  if (!r.ok) { message(el.msg, r.error || 'Could not update video.', 'err'); return; }
  await renderSeries(el.series.value);
  message(el.msg, toDone ? 'Marked watched.' : 'Marked unwatched.', 'ok');
});

el.importPlaylist.addEventListener('click', async () => {
  if (!currentPlaylist) return;
  el.importPlaylist.disabled = true; message(el.playlistMsg, 'Importing the full playlist…');
  const r = await send({ type: 'importPlaylist', url: currentPlaylist, title: el.playlistTitle.value, autoSync: el.importAutoSync.checked });
  el.importPlaylist.disabled = false;
  if (!r.ok) { message(el.playlistMsg, r.error || 'Could not import playlist.', 'err'); return; }
  state.lastSeriesId = r.id;
  await renderSeries(r.id);
  message(el.playlistMsg, `Imported ${r.added || 0} videos${r.unavailable ? ` · ${r.unavailable} unavailable` : ''}${r.duplicates ? ` · ${r.duplicates} duplicates skipped` : ''}.`, 'ok');
});

async function refreshLinked(restoreRemoved) {
  if (!selectedSeries?.playlist) return;
  if (restoreRemoved && !confirm('Re-add removed videos still in this playlist as unwatched?')) return;
  const id = selectedSeries.id;
  el.refreshPlaylist.disabled = true; el.restorePlaylist.disabled = true;
  message(el.msg, restoreRemoved ? 'Restoring…' : 'Refreshing playlist…');
  const r = await send({ type: 'refreshPlaylist', seriesId: id, restoreRemoved });
  el.refreshPlaylist.disabled = false; el.restorePlaylist.disabled = false;
  if (el.series.value === id) await renderSeries(id);
  if (!r.ok) { message(el.msg, r.error || 'Could not refresh playlist.', 'err'); return; }
  message(el.msg, `${r.added || 0} videos added${r.unavailable ? ` · ${r.unavailable} unavailable` : ''}.`, 'ok');
}
el.refreshPlaylist.addEventListener('click', () => refreshLinked(false));
el.restorePlaylist.addEventListener('click', () => refreshLinked(true));
el.autoSync.addEventListener('change', async () => {
  if (!selectedSeries?.playlist) return;
  const id = selectedSeries.id, enabled = el.autoSync.checked;
  el.autoSync.disabled = true;
  const r = await send({ type: 'setAutoSync', seriesId: id, enabled });
  el.autoSync.disabled = false;
  if (!r.ok) { if (el.series.value === id) el.autoSync.checked = !enabled; message(el.msg, r.error || 'Could not update auto-sync.', 'err'); return; }
  if (el.series.value === id) await loadSelectedSeries();
  message(el.msg, enabled ? 'Automatic checks enabled.' : 'Automatic checks paused.', 'ok');
});
el.openSeries.addEventListener('click', () => { if (el.series.value) chrome.tabs.create({ url: SITE_URL + '#/s/' + encodeURIComponent(el.series.value) }); });

function renderPillToggle() { el.togglePill.textContent = state.settings?.showPill === false ? 'Show pill' : 'Hide pill'; }
el.togglePill.addEventListener('click', async () => {
  const next = state.settings?.showPill === false;
  await send({ type: 'setConfig', patch: { settings: { showPill: next } } });
  state.settings = { ...(state.settings || {}), showPill: next };
  renderPillToggle(); el.lastSaved.textContent = next ? 'Pill shown' : 'Pill hidden';
});
el.resetPill.addEventListener('click', async () => {
  await chrome.storage.local.remove(['pillPos', 'pillHidden', 'panelPos']);
  await send({ type: 'setConfig', patch: { settings: { showPill: true } } });
  state.settings = { ...(state.settings || {}), showPill: true };
  renderPillToggle(); el.lastSaved.textContent = 'Pill reset';
});
el.refresh.addEventListener('click', () => boot(false));
el.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());
el.openSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
el.openSite.addEventListener('click', () => chrome.tabs.create({ url: SITE_URL }));
el.openQueue.addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: SITE_URL }); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || (!changes.token && !changes.apiBaseUrl)) return;
  if (changes.token) state.hasToken = !!changes.token.newValue;
  if (changes.apiBaseUrl) state.apiBaseUrl = changes.apiBaseUrl.newValue || '';
  renderStatus();
  renderSeries();
});

async function boot(first) {
  const st = await send({ type: 'state' });
  if (st.ok) state = { ...state, ...st };
  renderStatus(); renderPillToggle();
  const context = await activeContext();
  currentVideo = context.video; currentPlaylist = context.playlist;
  if (first) {
    const { pendingSave } = await chrome.storage.local.get('pendingSave');
    if (pendingSave) {
      await chrome.storage.local.remove('pendingSave');
      const id = YTQShared.videoIdFrom(pendingSave);
      if (id) currentVideo = { videoId: id, url: pendingSave, title: 'Link from the page', channel: '', durationSeconds: 0, currentTime: 0, thumbnail: '' };
    }
  }
  renderContext();
  await renderSeries();
}
boot(true);
