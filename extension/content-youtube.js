/**
 * YT Video Queue — Save
 * Runs on YouTube. Adds a small floating "Save to queue" pill and an inline
 * panel with a series picker, so you can queue a video without leaving the page.
 *
 * The UI lives in a shadow root, so YouTube's own stylesheet can never leak in
 * and ours can never leak out.
 */

(() => {
  if (window.__ytqSaveLoaded) return;
  window.__ytqSaveLoaded = true;

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Styrene B", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .pill, .panel { color: #1F1E1D; }
    .pill {
      position: fixed; right: 22px; bottom: 22px; z-index: 2147483000;
      display: flex; align-items: center; gap: 8px;
      padding: 11px 16px; border-radius: 999px; cursor: pointer;
      background: #D97757; color: #fff; font-size: 13.5px; font-weight: 700;
      border: 1px solid #D97757; box-shadow: 0 8px 26px rgba(31,30,29,.28);
      transition: transform .15s ease, background .2s ease;
      user-select: none;
    }
    .pill:hover { background: #C15F3C; border-color: #C15F3C; transform: translateY(-1px); }
    .pill[hidden] { display: none; }
    .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #fff; opacity: .9; }

    .panel {
      position: fixed; right: 22px; bottom: 76px; z-index: 2147483001;
      width: 320px; background: #fff; border: 1px solid #E8E6DF; border-radius: 16px;
      box-shadow: 0 20px 50px rgba(31,30,29,.24); overflow: hidden;
      display: none;
    }
    .panel[data-open="1"] { display: block; }
    .head { display: flex; align-items: center; justify-content: space-between;
      padding: 12px 14px; background: #F5F4EE; border-bottom: 1px solid #E8E6DF; }
    .head h3 { margin: 0; font-family: Copernicus, "Source Serif 4", Georgia, serif;
      font-size: 14px; font-weight: 600; color: #1F1E1D; }
    .x { background: none; border: none; cursor: pointer; color: #87867F; font-size: 16px; line-height: 1; padding: 2px 4px; }
    .x:hover { color: #1F1E1D; }
    .body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
    .row { display: flex; gap: 10px; align-items: flex-start; }
    .thumb { width: 84px; height: 48px; border-radius: 8px; object-fit: cover; background: #F0EEE7; flex: 0 0 auto; border: 1px solid #E8E6DF; }
    .meta { min-width: 0; flex: 1; }
    .title { font-size: 12.5px; font-weight: 600; line-height: 1.35; color: #1F1E1D;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .sub { font-size: 11px; color: #87867F; margin-top: 2px; }
    label { font-size: 11px; font-weight: 700; color: #575653; display: block; margin-bottom: 4px; letter-spacing: .02em; }
    select, input[type=text] {
      width: 100%; padding: 9px 10px; font-size: 12.5px; color: #1F1E1D; background: #fff;
      border: 1px solid #D9D6CC; border-radius: 9px; outline: none;
    }
    select:focus, input:focus { border-color: #D97757; box-shadow: 0 0 0 3px rgba(217,119,87,.28); }
    .btn { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid #D9D6CC;
      background: #fff; color: #1F1E1D; font-size: 12.5px; font-weight: 700; cursor: pointer; }
    .btn:hover { border-color: #D97757; color: #8A3F24; }
    .btn.primary { background: #D97757; border-color: #D97757; color: #fff; }
    .btn.primary:hover { background: #C15F3C; border-color: #C15F3C; color: #fff; }
    .btn:disabled { opacity: .55; cursor: not-allowed; }
    .btn.ghost { background: #F5F4EE; }
    .foot { display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 9px 14px; background: #F5F4EE; border-top: 1px solid #E8E6DF; font-size: 11px; color: #575653; }
    .foot a { color: #8A3F24; text-decoration: none; font-weight: 600; }
    .foot a:hover { text-decoration: underline; }
    .msg { font-size: 11.5px; line-height: 1.4; min-height: 16px; }
    .msg.ok { color: #2F7D5B; } .msg.warn { color: #B4791F; } .msg.err { color: #C0392B; } .msg.muted { color: #87867F; }
    .newrow { display: none; gap: 6px; }
    .newrow[data-open="1"] { display: flex; }
    .newrow input { flex: 1; }
    .newrow button { flex: 0 0 auto; width: auto; padding: 9px 12px; }
    .toast {
      position: fixed; right: 22px; bottom: 22px; z-index: 2147483002;
      background: #232220; color: #F5F3EC; padding: 10px 14px; border-radius: 12px;
      font-size: 12.5px; font-weight: 600; box-shadow: 0 12px 34px rgba(0,0,0,.35);
      opacity: 0; transform: translateY(8px); transition: all .25s ease; pointer-events: none;
    }
    .toast[data-show="1"] { opacity: 1; transform: translateY(0); }
  `;

  const SITE_URL = 'https://pavnxet.github.io/yt-video-queue/';

  const host = document.createElement('div');
  host.id = 'ytq-save-root';
  host.style.all = 'initial';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLES;
  root.appendChild(style);

  const pill = document.createElement('div');
  pill.className = 'pill';
  pill.innerHTML = '<span class="dot"></span><span>Save to queue</span>';
  pill.title = 'Save this video to your YT Video Queue (Alt+Q)';

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="head"><h3>Save to queue</h3><button class="x" title="Close">✕</button></div>
    <div class="body">
      <div class="row">
        <img class="thumb" alt="">
        <div class="meta">
          <div class="title"></div>
          <div class="sub"></div>
        </div>
      </div>
      <div>
        <label>Series</label>
        <select class="series"></select>
      </div>
      <div class="newrow">
        <input type="text" class="newname" placeholder="New series name">
        <button class="btn primary create">Create</button>
      </div>
      <button class="btn primary save">Save to queue</button>
      <button class="btn playlist" hidden></button>
      <div class="msg muted">Ready.</div>
    </div>
    <div class="foot">
      <span class="who">Not connected</span>
      <a href="${SITE_URL}" target="_blank" rel="noopener">Open queue ↗</a>
    </div>
  `;

  const toast = document.createElement('div');
  toast.className = 'toast';

  root.appendChild(pill);
  root.appendChild(panel);
  root.appendChild(toast);

  const $ = (sel) => panel.querySelector(sel);
  const els = {
    thumb: $('.thumb'), title: $('.title'), sub: $('.sub'),
    series: $('.series'), newrow: $('.newrow'), newname: $('.newname'),
    create: $('.create'), save: $('.save'), playlist: $('.playlist'),
    msg: $('.msg'), who: $('.who'), close: $('.x')
  };

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

  function setMsg(text, kind) {
    els.msg.textContent = text || '';
    els.msg.className = 'msg ' + (kind || 'muted');
  }

  function showToast(text) {
    toast.textContent = text;
    toast.dataset.show = '1';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.dataset.show = '0'; }, 2600);
  }

  // ------------------------------------------------------------ page info

  function videoId() {
    try {
      const u = new URL(location.href);
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    } catch { /* ignore */ }
    return '';
  }

  function videoInfo() {
    const vid = videoId();
    if (!vid) return null;
    const el = document.querySelector('video');
    const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.style-scope.ytd-watch-metadata');
    let title = (titleEl && titleEl.textContent || '').trim();
    if (!title) title = document.title.replace(/\s*-\s*YouTube\s*$/, '').trim();
    const chanEl = document.querySelector('#owner #channel-name a, ytd-channel-name a, #channel-name a');
    const channel = (chanEl && chanEl.textContent || '').trim();
    return {
      videoId: vid,
      url: 'https://www.youtube.com/watch?v=' + vid,
      title,
      channel,
      durationSeconds: el && isFinite(el.duration) ? el.duration : 0,
      currentTime: el && isFinite(el.currentTime) ? el.currentTime : 0,
      thumbnail: 'https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg'
    };
  }

  function playlistInfo() {
    const panelEl = document.querySelector('ytd-playlist-panel-renderer#playlist');
    if (!panelEl) return null;
    const items = panelEl.querySelectorAll('ytd-playlist-panel-video-renderer');
    if (!items || items.length < 2) return null;
    const urls = [];
    items.forEach((it) => {
      const a = it.querySelector('a#wc-endpoint, a[href*="watch?v="]');
      if (!a) return;
      const m = (a.getAttribute('href') || '').match(/[?&]v=([A-Za-z0-9_-]{11})/);
      if (m) urls.push('https://www.youtube.com/watch?v=' + m[1]);
    });
    const unique = [...new Set(urls)];
    return unique.length > 1 ? { count: unique.length, urls: unique } : null;
  }

  // ------------------------------------------------------------ UI state

  let cfg = { apiBaseUrl: '', hasToken: false, lastSeriesId: '', lastSeriesTitle: '', settings: { showPill: true } };

  function applyVisibility() {
    pill.hidden = !(cfg.settings && cfg.settings.showPill);
    if (pill.hidden) panel.dataset.open = '0';
  }

  async function refreshState() {
    const r = await send({ type: 'state' });
    if (r && r.ok) {
      cfg = { ...cfg, ...r };
      applyVisibility();
      const connected = !!(cfg.apiBaseUrl && cfg.hasToken);
      els.who.textContent = connected ? 'Connected' : 'Not connected';
    }
  }

  async function loadSeries(selectId) {
    els.series.innerHTML = '<option>Loading…</option>';
    const r = await send({ type: 'series' });
    if (!r || !r.ok) {
      els.series.innerHTML = '';
      els.series.disabled = true;
      els.save.disabled = true;
      setMsg(r && r.needSetup ? 'Open the extension settings and connect.' : ('Could not load series: ' + (r && r.error ? r.error : 'unknown')), 'err');
      return;
    }
    els.series.disabled = false;
    els.save.disabled = false;
    const list = r.series || [];
    if (!list.length) {
      els.series.innerHTML = '<option value="">No series yet — create one below</option>';
      els.newrow.dataset.open = '1';
      return;
    }
    els.series.innerHTML = list.map((s) =>
      `<option value="${s.id}">${escapeHtml(s.title)} · ${s.done}/${s.total}</option>`).join('');
    const pick = selectId || cfg.lastSeriesId;
    if (pick && list.some((s) => s.id === pick)) els.series.value = pick;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fillPanel() {
    const info = videoInfo();
    if (!info) return false;
    els.title.textContent = info.title || 'Untitled video';
    els.sub.textContent = [info.channel, info.durationSeconds ? formatDur(info.durationSeconds) : ''].filter(Boolean).join(' · ');
    els.thumb.src = info.thumbnail;
    const pl = playlistInfo();
    if (pl) {
      els.playlist.hidden = false;
      els.playlist.textContent = `Save all ${pl.count} videos in this playlist`;
    } else {
      els.playlist.hidden = true;
    }
    return true;
  }

  function formatDur(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
  }

  async function openPanel() {
    if (!fillPanel()) { showToast('Open a YouTube video first.'); return; }
    panel.dataset.open = '1';
    await refreshState();
    if (!(cfg.apiBaseUrl && cfg.hasToken)) {
      setMsg('Not connected yet. Open the extension settings (right-click the icon) and paste your API URL, or visit your queue site once.', 'warn');
      els.save.disabled = true;
      els.series.disabled = true;
      return;
    }
    els.save.disabled = false;
    setMsg('Ready.', 'muted');
    await loadSeries();
  }

  // ------------------------------------------------------------ actions

  pill.addEventListener('click', openPanel);
  els.close.addEventListener('click', () => { panel.dataset.open = '0'; });

  els.create.addEventListener('click', async () => {
    const name = (els.newname.value || '').trim();
    if (!name) { setMsg('Type a name for the new series.', 'warn'); return; }
    els.create.disabled = true;
    const r = await send({ type: 'createSeries', title: name });
    els.create.disabled = false;
    if (!r || !r.ok) { setMsg('Could not create: ' + (r && r.error ? r.error : 'unknown'), 'err'); return; }
    els.newname.value = '';
    els.newrow.dataset.open = '0';
    setMsg('Series created.', 'ok');
    await send({ type: 'setConfig', patch: { lastSeriesId: r.id } });
    await loadSeries(r.id);
  });

  els.save.addEventListener('click', async () => {
    const info = videoInfo();
    if (!info) { setMsg('No video on this page.', 'warn'); return; }
    const seriesId = els.series.value;
    if (!seriesId) { setMsg('Pick or create a series first.', 'warn'); return; }
    els.save.disabled = true;
    setMsg('Saving…', 'muted');
    const r = await send({
      type: 'save',
      seriesId,
      url: info.url,
      durationSeconds: info.durationSeconds,
      resumeSeconds: info.currentTime
    });
    els.save.disabled = false;
    if (r && r.ok) {
      setMsg(`Saved to “${r.seriesTitle || 'your queue'}”.`, 'ok');
      showToast('✓ Added to your queue');
      await send({ type: 'setConfig', patch: { lastSeriesId: seriesId } });
    } else if (r && r.duplicate) {
      setMsg(`Already in “${r.seriesTitle || 'this series'}”.`, 'warn');
      showToast('Already in that series');
    } else {
      setMsg('Could not save: ' + (r && r.error ? r.error : 'unknown'), 'err');
      showToast('Save failed');
    }
  });

  els.playlist.addEventListener('click', async () => {
    const pl = playlistInfo();
    if (!pl) return;
    const seriesId = els.series.value;
    if (!seriesId) { setMsg('Pick or create a series first.', 'warn'); return; }
    els.playlist.disabled = true;
    setMsg(`Saving ${pl.count} videos…`, 'muted');
    const r = await send({ type: 'saveMany', seriesId, urls: pl.urls });
    els.playlist.disabled = false;
    if (r && r.ok) {
      setMsg(`Added ${r.added}${r.skipped ? `, skipped ${r.skipped}` : ''}.`, 'ok');
      showToast(`✓ Added ${r.added} videos`);
    } else {
      setMsg('Could not save playlist: ' + (r && r.error ? r.error : 'unknown'), 'err');
    }
  });

  // ------------------------------------------------------------ lifecycle

  document.documentElement.appendChild(host);

  // Keep the panel in step with YouTube's single-page navigation.
  let lastHref = location.href;
  function onNav() {
    if (location.href === lastHref) { if (panel.dataset.open === '1') fillPanel(); return; }
    lastHref = location.href;
    panel.dataset.open = '0';
    setTimeout(() => { if (panel.dataset.open === '1') openPanel(); }, 400);
  }
  window.addEventListener('yt-navigate-finish', onNav);
  window.addEventListener('yt-page-data-updated', onNav);
  const mo = new MutationObserver(() => { clearTimeout(mo._t); mo._t = setTimeout(onNav, 500); });
  mo.observe(document.body, { childList: true, subtree: true });

  // React to setting changes made in the popup/options.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      cfg.settings = { ...cfg.settings, ...(changes.settings.newValue || {}) };
      applyVisibility();
    }
  });

  // The service worker asks for this when Alt+Q is pressed.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'getVideoInfo') { sendResponse(videoInfo()); return true; }
    if (msg && msg.type === 'openPanel') { openPanel(); sendResponse({ ok: true }); return true; }
    return false;
  });

  refreshState();
})();
