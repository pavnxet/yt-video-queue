/**
 * YT Video Queue — Save
 * Runs on YouTube. A glass "Save to queue" pill you can drag anywhere, hide when
 * you want the video unobstructed, and reopen with a slim restore handle. The
 * panel that opens from it is glass too, is draggable by its header, knows
 * whether the video is already queued, can resume where you left off, mark it
 * watched, and peek at what's next in the series.
 *
 * Everything lives in a shadow root, so YouTube's stylesheet can never leak in.
 */

(() => {
  if (window.__ytqSaveLoaded) return;
  window.__ytqSaveLoaded = true;

  const SITE_URL = 'https://pavnxet.github.io/yt-video-queue/';
  const POS_KEY = 'pillPos';
  const PANEL_POS_KEY = 'panelPos';
  const HIDDEN_KEY = 'pillHidden';

  // Every surface is glass: translucent + blurred, with a light hairline edge
  // and an inner highlight, so the video keeps showing through.
  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Styrene B", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    [hidden] { display: none !important; }

    /* ---- the glass pill ---- */
    .pill {
      position: fixed; z-index: 2147483000;
      display: flex; align-items: center; gap: 8px;
      padding: 10px 13px 10px 15px; border-radius: 999px;
      background: rgba(22, 20, 19, 0.36);
      -webkit-backdrop-filter: blur(18px) saturate(185%);
      backdrop-filter: blur(18px) saturate(185%);
      border: 1px solid rgba(255, 255, 255, 0.22);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.18);
      color: #F7F5F0; font-size: 13px; font-weight: 700; letter-spacing: .01em;
      cursor: grab; user-select: none; touch-action: none;
      transition: background .2s ease, border-color .2s ease, box-shadow .2s ease;
    }
    .pill:hover { background: rgba(22, 20, 19, 0.52); border-color: rgba(255,255,255,.34); }
    .pill.dragging { cursor: grabbing; transition: none; }
    .pill[hidden] { display: none; }
    .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #E08A6B; flex: 0 0 auto; box-shadow: 0 0 8px rgba(224,138,107,.8); }
    .pill.saved .dot { background: #6FBF97; box-shadow: 0 0 8px rgba(111,191,151,.8); }
    .pill .label { text-shadow: 0 1px 3px rgba(0, 0, 0, .5); white-space: nowrap; }
    .pill .x {
      width: 18px; height: 18px; border-radius: 50%; border: 1px solid rgba(255,255,255,.18); cursor: pointer;
      background: rgba(255,255,255,.16); color: #F7F5F0; font-size: 11px; line-height: 1;
      display: none; align-items: center; justify-content: center; padding: 0; margin-left: 2px;
    }
    .pill:hover .x { display: flex; }
    .pill .x:hover { background: rgba(255,255,255,.30); }

    /* ---- slim restore handle when the pill is hidden ---- */
    .handle {
      position: fixed; z-index: 2147483000;
      width: 30px; height: 30px; border-radius: 50%;
      background: rgba(22, 20, 19, 0.34);
      -webkit-backdrop-filter: blur(16px) saturate(170%);
      backdrop-filter: blur(16px) saturate(170%);
      border: 1px solid rgba(255, 255, 255, 0.20);
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255,255,255,.16);
      color: #F7F5F0; font-size: 13px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      opacity: .5; transition: opacity .2s ease, background .2s ease;
    }
    .handle:hover { opacity: 1; background: rgba(22, 20, 19, 0.6); }
    .handle[hidden] { display: none; }

    /* ---- the glass panel ---- */
    .panel {
      position: fixed; z-index: 2147483001; width: 330px; max-width: calc(100vw - 16px);
      /* default corner: never let an unpositioned frame show top-left */
      right: 22px; bottom: 76px;
      background: rgba(250, 249, 245, 0.62);
      -webkit-backdrop-filter: blur(30px) saturate(190%);
      backdrop-filter: blur(30px) saturate(190%);
      border: 1px solid rgba(255, 255, 255, 0.55);
      border-radius: 16px;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.65);
      overflow: hidden; color: #1F1E1D; display: none;
    }
    .panel[data-open="1"] { display: block; animation: ytq-pop .18s ease-out; }
    @keyframes ytq-pop { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .panel[data-open="1"] { animation: none; } }
    .panel.dragging { transition: none; }

    .head {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 12px 14px; cursor: grab;
      background: rgba(255, 255, 255, 0.34);
      -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(255, 255, 255, 0.45);
      touch-action: none; user-select: none;
    }
    .head:active { cursor: grabbing; }
    .head h3 { margin: 0; font-family: Copernicus, "Source Serif 4", Georgia, serif; font-size: 14px; font-weight: 600; text-shadow: 0 1px 0 rgba(255,255,255,.5); }
    .head .grip { cursor: grab; color: #87867F; font-size: 13px; letter-spacing: -1px; }
    .x2 { background: rgba(255,255,255,.4); border: 1px solid rgba(255,255,255,.5); border-radius: 50%;
      width: 20px; height: 20px; cursor: pointer; color: #575653; font-size: 11px; line-height: 1; padding: 0; }
    .x2:hover { background: rgba(255,255,255,.75); color: #1F1E1D; }

    .body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; max-height: 62vh; overflow-y: auto; }
    .row { display: flex; gap: 10px; align-items: flex-start; }
    .thumb { width: 88px; height: 50px; border-radius: 8px; object-fit: cover; background: rgba(255,255,255,.4); flex: 0 0 auto; border: 1px solid rgba(255,255,255,.55); }
    .meta { min-width: 0; flex: 1; }
    .title { font-size: 12.5px; font-weight: 600; line-height: 1.35; color: #1F1E1D;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .sub { font-size: 11px; color: #6B6A64; margin-top: 2px; }
    label { font-size: 11px; font-weight: 700; color: #575653; display: block; margin-bottom: 4px; letter-spacing: .02em; }

    select, input[type=text] {
      width: 100%; padding: 9px 10px; font-size: 12.5px; color: #1F1E1D;
      background: rgba(255, 255, 255, 0.6);
      -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.7); border-radius: 9px; outline: none; font-family: inherit;
    }
    select:focus, input:focus { border-color: #D97757; box-shadow: 0 0 0 3px rgba(217,119,87,.28); }

    .btn {
      width: 100%; padding: 10px 12px; border-radius: 10px;
      background: rgba(255, 255, 255, 0.5);
      -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.65);
      color: #1F1E1D; font-size: 12.5px; font-weight: 700; cursor: pointer; font-family: inherit;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.5);
    }
    .btn:hover { border-color: #D97757; color: #8A3F24; background: rgba(255,255,255,.68); }
    .btn.primary { background: rgba(217, 119, 87, 0.9); border-color: rgba(255,255,255,.35); color: #fff;
      box-shadow: 0 4px 14px rgba(217,119,87,.35), inset 0 1px 0 rgba(255,255,255,.28); }
    .btn.primary:hover { background: rgba(193, 95, 60, 0.95); border-color: rgba(255,255,255,.45); color: #fff; }
    .btn:disabled { opacity: .55; cursor: not-allowed; }
    .btn.sm { padding: 7px 10px; font-size: 11.5px; width: auto; }
    .btnrow { display: flex; gap: 6px; }
    .btnrow .btn { width: auto; flex: 1; }
    .insights { display: flex; flex-direction: column; gap: 7px; padding: 9px 10px; border: 1px solid rgba(255,255,255,.65); border-radius: 10px; background: rgba(255,255,255,.35); }
    .statline { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: #575653; }
    .statline strong { color: #8A3F24; }
    .meter { height: 6px; border-radius: 9px; overflow: hidden; background: rgba(31,30,29,.16); }
    .meter > span { display: block; height: 100%; background: #D97757; border-radius: inherit; }
    .hint { color: #575653; font-size: 11px; line-height: 1.4; }
    .checkline { display: flex; align-items: center; gap: 6px; margin: 0; }
    .checkline input { accent-color: #C15F3C; }
    .linked { display: flex; flex-direction: column; gap: 7px; border-top: 1px solid rgba(255,255,255,.5); padding-top: 7px; }

    .status {
      border-radius: 10px; padding: 9px 11px; font-size: 11.5px; line-height: 1.45;
      background: rgba(47, 125, 91, 0.16);
      -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
      border: 1px solid rgba(47, 125, 91, 0.34); color: #276b4e;
    }
    .status b { color: #1f5940; }

    .peek {
      border: 1px solid rgba(255, 255, 255, 0.55); border-radius: 10px; overflow: hidden;
      background: rgba(255, 255, 255, 0.28);
      -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
    }
    .peek h4 { margin: 0; padding: 8px 11px; font-size: 11px; font-weight: 700; color: #575653;
      background: rgba(255, 255, 255, 0.32); border-bottom: 1px solid rgba(255,255,255,.45);
      text-transform: uppercase; letter-spacing: .05em; }
    .peek ul { list-style: none; margin: 0; padding: 0; max-height: 150px; overflow-y: auto; }
    .peek li { display: flex; gap: 8px; align-items: center; padding: 7px 11px; font-size: 12px; cursor: pointer;
      border-bottom: 1px solid rgba(255,255,255,.35); }
    .peek li:last-child { border-bottom: none; }
    .peek li:hover { background: rgba(217, 119, 87, 0.18); }
    .peek li .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .peek li .d { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 10.5px; color: #6B6A64; }

    .foot {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 9px 14px; font-size: 11px; color: #575653;
      background: rgba(255, 255, 255, 0.28);
      -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
      border-top: 1px solid rgba(255, 255, 255, 0.45);
    }
    .foot a { color: #8A3F24; text-decoration: none; font-weight: 600; }
    .foot a:hover { text-decoration: underline; }

    .msg { font-size: 11.5px; line-height: 1.45; min-height: 15px; color: #6B6A64; }
    .msg.ok { color: #2F7D5B; } .msg.warn { color: #9a6512; } .msg.err { color: #C0392B; }

    .newrow { display: none; gap: 6px; }
    .newrow[data-open="1"] { display: flex; }
    .newrow input { flex: 1; }
    .newrow button { flex: 0 0 auto; width: auto; }

    .toast {
      position: fixed; z-index: 2147483002; padding: 10px 14px; border-radius: 12px;
      background: rgba(22, 20, 19, 0.62);
      -webkit-backdrop-filter: blur(18px) saturate(180%); backdrop-filter: blur(18px) saturate(180%);
      border: 1px solid rgba(255,255,255,.18);
      color: #F7F5F0; font-size: 12.5px; font-weight: 600;
      box-shadow: 0 12px 34px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.14);
      opacity: 0; transform: translateY(8px); transition: all .25s ease; pointer-events: none;
    }
    .toast[data-show="1"] { opacity: 1; transform: translateY(0); }

    /* graceful fallback where blur is unavailable — keep it readable */
    @supports not ((backdrop-filter: blur(2px)) or (-webkit-backdrop-filter: blur(2px))) {
      .pill { background: rgba(22,20,19,0.88); }
      .handle { background: rgba(22,20,19,0.88); opacity: .85; }
      .panel { background: #FAF9F5; }
      .head, .foot { background: #F5F4EE; }
      select, input[type=text], .btn { background: #FFFFFF; }
      .peek, .peek h4 { background: #FFFFFF; }
      .toast { background: rgba(22,20,19,0.95); }
    }
  `;

  const host = document.createElement('div');
  host.id = 'ytq-save-root';
  host.style.all = 'initial';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLES;
  root.appendChild(style);

  const pill = document.createElement('div');
  pill.className = 'pill';
  pill.innerHTML = '<span class="dot"></span><span class="label">Save to queue</span><button class="x" title="Hide (you can bring it back)">✕</button>';

  const handle = document.createElement('div');
  handle.className = 'handle';
  handle.textContent = '＋';
  handle.title = 'Show the “Save to queue” button';
  handle.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="head">
      <h3>Save to queue</h3>
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="grip" title="Drag to move">⣿</span>
        <button class="x2" title="Close">✕</button>
      </div>
    </div>
    <div class="body">
      <div class="row video-meta">
        <img class="thumb" alt="">
        <div class="meta"><div class="title"></div><div class="sub"></div></div>
      </div>
      <div class="playlist-tools" hidden>
        <div class="hint">Import the full playlist as a new linked, auto-syncing series. Requires a YouTube API key on your Worker; 500 entries maximum.</div>
        <div class="btnrow"><button class="btn sm import-playlist">Import full playlist</button><button class="btn sm playlist" hidden></button></div>
      </div>

      <div class="status" hidden></div>

      <div>
        <label>Series</label>
        <select class="series"></select>
      </div>
      <button class="btn sm new-toggle">+ Create a series</button>
      <div class="newrow">
        <input type="text" class="newname" placeholder="New series name" aria-label="New series name">
        <button class="btn primary create">Create</button>
      </div>
      <div class="insights" hidden>
        <div class="statline"><span class="progress-label"></span><strong class="progress-percent"></strong></div>
        <div class="meter" role="progressbar" aria-label="Series completion" aria-valuemin="0" aria-valuemax="100"><span></span></div>
        <div class="statline"><span class="time-remaining"></span><span class="time-total"></span></div>
        <div class="hint duration-coverage"></div>
        <div class="linked" hidden>
          <div class="hint sync-status"></div>
          <label class="checkline"><input class="auto-sync" type="checkbox"> Auto-sync playlist</label>
          <div class="btnrow"><button class="btn sm refresh-playlist">Refresh playlist</button><button class="btn sm restore-playlist">Restore removed</button></div>
        </div>
      </div>
      <button class="btn primary save">Save to queue</button>

      <div class="btnrow queued" hidden>
        <button class="btn sm resume" hidden>▶ Resume</button>
        <button class="btn sm save-position">Save position</button>
        <button class="btn sm watched">Mark watched</button>
      </div>

      <div class="peek" hidden>
        <h4 class="peekTitle">Next in this series</h4>
        <ul class="peekList"></ul>
      </div>

      <div class="msg">Ready.</div>
    </div>
    <div class="foot">
      <span class="who">Not connected</span>
      <a href="${SITE_URL}" target="_blank" rel="noopener">Open queue ↗</a>
    </div>
  `;

  const toast = document.createElement('div');
  toast.className = 'toast';

  root.appendChild(pill);
  root.appendChild(handle);
  root.appendChild(panel);
  root.appendChild(toast);

  const $ = (s) => panel.querySelector(s);
  const els = {
    body: $('.body'), videoMeta: $('.video-meta'), thumb: $('.thumb'), title: $('.title'), sub: $('.sub'),
    status: $('.status'), series: $('.series'), newrow: $('.newrow'), newname: $('.newname'), newToggle: $('.new-toggle'),
    create: $('.create'), save: $('.save'), queued: $('.queued'), resume: $('.resume'),
    savePosition: $('.save-position'), watched: $('.watched'), playlistTools: $('.playlist-tools'),
    importPlaylist: $('.import-playlist'), playlist: $('.playlist'), peek: $('.peek'),
    insights: $('.insights'), progressLabel: $('.progress-label'), progressPercent: $('.progress-percent'),
    meter: $('.meter'), meterFill: $('.meter span'), timeRemaining: $('.time-remaining'), timeTotal: $('.time-total'),
    durationCoverage: $('.duration-coverage'), linked: $('.linked'), syncStatus: $('.sync-status'),
    autoSync: $('.auto-sync'), refreshPlaylist: $('.refresh-playlist'), restorePlaylist: $('.restore-playlist'),
    peekTitle: $('.peekTitle'), peekList: $('.peekList'),
    msg: $('.msg'), who: $('.who'), close: $('.x2'), head: $('.head')
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

  const setMsg = (t, k) => { els.msg.textContent = t || ''; els.msg.className = 'msg ' + (k || ''); };
  const errText = (e) => (e && e.message) ? e.message : String(e || 'unknown error');
  function showToast(text) {
    toast.textContent = text;
    toast.dataset.show = '1';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.dataset.show = '0'; }, 2600);
  }

  function fmtDur(sec) {
    sec = Math.round(sec || 0);
    if (!sec) return '';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
  }

  // ------------------------------------------------------------ page info

  function videoId() {
    return YTQShared.videoIdFrom(location.href);
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
      videoId: vid, url: 'https://www.youtube.com/watch?v=' + vid, title, channel,
      durationSeconds: el && isFinite(el.duration) ? el.duration : 0,
      currentTime: el && isFinite(el.currentTime) ? el.currentTime : 0,
      thumbnail: 'https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg'
    };
  }

  function playlistInfo() {
    const url = YTQShared.playlistUrl(location.href);
    if (!url) return null;
    const ids = new Set();
    document.querySelectorAll('ytd-playlist-panel-video-renderer, ytd-playlist-video-renderer').forEach((item) => {
      const link = item.querySelector('a#wc-endpoint, a#thumbnail, a[href*="watch?v="]');
      const id = link && YTQShared.videoIdFrom(link.href);
      if (id) ids.add(id);
    });
    const urls = [...ids].map((id) => 'https://www.youtube.com/watch?v=' + id);
    return { url, count: urls.length, urls };
  }

  // ------------------------------------------------------------ position & visibility

  let pos = null;       // pill {left, top} once dragged
  let panelPos = null;  // panel {left, top} once dragged by its header
  let hidden = false;
  let cfg = { apiBaseUrl: '', hasToken: false, lastSeriesId: '', settings: { showPill: true } };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function place(el, w, h) {
    if (pos) {
      el.style.left = clamp(pos.left, 4, Math.max(4, innerWidth - w - 4)) + 'px';
      el.style.top = clamp(pos.top, 4, Math.max(4, innerHeight - h - 4)) + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
    } else {
      el.style.right = '22px'; el.style.bottom = '22px';
      el.style.left = 'auto'; el.style.top = 'auto';
    }
  }

  function applyVisibility() {
    const enabled = !(cfg.settings && cfg.settings.showPill === false);
    pill.hidden = hidden || !enabled;
    handle.hidden = !(hidden && enabled);
    if (pill.hidden && panel.dataset.open === '1') panel.dataset.open = '0';
    if (!pill.hidden) place(pill, pill.offsetWidth || 150, pill.offsetHeight || 38);
    if (!handle.hidden) place(handle, 30, 30);
  }

  function positionPanel() {
    const pw = panel.offsetWidth || 330;
    const ph = panel.offsetHeight || 420;

    // If the user has dragged the panel, keep it exactly where they put it.
    if (panelPos) {
      panel.style.left = clamp(panelPos.left, 8, Math.max(8, innerWidth - pw - 8)) + 'px';
      panel.style.top = clamp(panelPos.top, 8, Math.max(8, innerHeight - ph - 8)) + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      return;
    }

    const r = pill.getBoundingClientRect();
    const left = clamp(r.right - pw, 8, Math.max(8, innerWidth - pw - 8));
    panel.style.left = left + 'px';
    panel.style.right = 'auto';

    // Pick the roomier side (this depends only on the pill, never on the panel's
    // height, so the choice cannot flip while content loads), anchor that edge,
    // then cap the scrollable body to the space available. The panel therefore
    // always fits on screen and never has to move once it is shown.
    const spaceAbove = r.top - 12;
    const spaceBelow = innerHeight - r.bottom - 12;
    const above = spaceAbove >= spaceBelow;
    const CHROME = 96; // header + footer

    if (above) {
      panel.style.bottom = (innerHeight - r.top + 10) + 'px';
      panel.style.top = 'auto';
    } else {
      panel.style.top = (r.bottom + 10) + 'px';
      panel.style.bottom = 'auto';
    }
    els.body.style.maxHeight = Math.max(180, (above ? spaceAbove : spaceBelow) - CHROME) + 'px';
  }

  // ------------------------------------------------------------ dragging

  function makeDraggable(el, opts = {}) {
    const { onTap, handleSel, onMoved } = opts;
    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;

    el.addEventListener('pointerdown', (e) => {
      if (handleSel && !(e.target.closest && e.target.closest(handleSel))) return;
      if (e.target.closest && e.target.closest('button')) return; // never drag from a button
      const r = el.getBoundingClientRect();
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      el.classList.add('dragging');
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });

    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      const r = el.getBoundingClientRect();
      const next = {
        left: clamp(ox + dx, 4, Math.max(4, innerWidth - r.width - 4)),
        top: clamp(oy + dy, 4, Math.max(4, innerHeight - r.height - 4))
      };
      el.style.left = next.left + 'px';
      el.style.top = next.top + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
      if (onMoved) onMoved(next);
      e.preventDefault();
    });

    const finish = async (e) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (moved) {
        const r = el.getBoundingClientRect();
        const finalPos = { left: r.left, top: r.top };
        if (el === pill) { pos = finalPos; await chrome.storage.local.set({ [POS_KEY]: finalPos }); }
        if (el === panel) { panelPos = finalPos; await chrome.storage.local.set({ [PANEL_POS_KEY]: finalPos }); }
      } else if (onTap) {
        onTap();
      }
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
  }

  // A rejected openPanel() must never vanish silently: report it in the panel.
  makeDraggable(pill, {
    onTap: () => { openPanel().catch((e) => setMsg('Could not open the panel: ' + errText(e), 'err')); }
  });
  makeDraggable(handle, {
    onTap: () => { hidden = false; chrome.storage.local.set({ [HIDDEN_KEY]: false }); applyVisibility(); }
  });
  // The panel drags by its header (the grip / title bar), never by a button.
  makeDraggable(panel, { handleSel: '.head' });

  pill.querySelector('.x').addEventListener('click', async (e) => {
    e.stopPropagation();
    hidden = true;
    panel.dataset.open = '0';
    await chrome.storage.local.set({ [HIDDEN_KEY]: true });
    applyVisibility();
    showToast('Hidden — click ＋ to bring it back');
  });

  handle.addEventListener('click', async () => {
    hidden = false;
    await chrome.storage.local.set({ [HIDDEN_KEY]: false });
    applyVisibility();
  });

  els.close.addEventListener('click', () => { panel.dataset.open = '0'; });

  // ------------------------------------------------------------ queued state

  let queued = null;
  let queuedMatches = [];
  let lookupError = '';
  let selectedPlaylist = null;
  let detailRequest = 0;
  let lookupRequest = 0;

  function renderQueued() {
    queued = queuedMatches.find((match) => match.seriesId === els.series.value) || queuedMatches[0] || null;
    const info = videoInfo();
    const inSelected = queuedMatches.some((match) => match.seriesId === els.series.value);
    els.save.hidden = !info;
    els.save.disabled = !info || !els.series.value || inSelected;
    if (queued) {
      pill.classList.add('saved');
      pill.querySelector('.label').textContent = 'In ' + (queued.seriesTitle || 'queue');
      els.status.hidden = false;
      const st = queued.video.status || 'todo';
      const resume = queued.video.resumeSeconds || 0;
      els.status.textContent = `In ${queued.seriesTitle || 'queue'} · ${st === 'done' ? 'watched' : st === 'watching' ? 'watching' : 'to watch'}`
        + (resume ? ` · last at ${fmtDur(resume)}` : '') + (queuedMatches.length > 1 ? ` · in ${queuedMatches.length} series` : '');
      els.queued.hidden = false;
      els.resume.hidden = !resume;
      els.savePosition.hidden = st === 'done';
      els.watched.textContent = st === 'done' ? 'Mark unwatched' : 'Mark watched';
      els.save.textContent = inSelected ? 'Already in this series' : 'Save to selected series';
    } else {
      pill.classList.remove('saved');
      pill.querySelector('.label').textContent = 'Save to queue';
      els.status.hidden = !lookupError;
      els.status.textContent = lookupError ? 'Could not check whether this video is already queued.' : '';
      els.queued.hidden = true;
      els.resume.hidden = true;
      els.save.textContent = 'Save to queue';
    }
  }

  async function checkQueued() {
    const info = videoInfo();
    const request = ++lookupRequest;
    if (!info || !(cfg.apiBaseUrl && cfg.hasToken)) { queuedMatches = []; lookupError = ''; renderQueued(); return; }
    const r = await send({ type: 'findVideo', youtubeId: info.videoId });
    if (request !== lookupRequest || videoId() !== info.videoId) return;
    lookupError = r && !r.ok ? r.error || 'Could not check queued videos.' : '';
    queuedMatches = r && r.ok && Array.isArray(r.matches) ? r.matches : [];
    renderQueued();
  }

  // ------------------------------------------------------------ panel

  function fillPanel() {
    const info = videoInfo();
    const pl = playlistInfo();
    if (!info && !pl) return false;
    els.videoMeta.hidden = !info;
    els.save.hidden = !info;
    if (info) {
      els.title.textContent = info.title || 'Untitled video';
      els.sub.textContent = [info.channel, fmtDur(info.durationSeconds)].filter(Boolean).join(' · ');
      els.thumb.src = info.thumbnail;
    }
    els.playlistTools.hidden = !pl;
    els.playlist.hidden = !pl || !pl.count;
    if (pl && pl.count) els.playlist.textContent = `Save ${pl.count} visible`;
    return true;
  }

  async function refreshState() {
    const r = await send({ type: 'state' });
    if (r && r.ok) {
      cfg = { ...cfg, ...r };
      els.who.textContent = (cfg.apiBaseUrl && cfg.hasToken) ? 'Connected' : 'Not connected';
      applyVisibility();
    }
  }

  async function loadSeries(selectId) {
    els.series.replaceChildren(new Option('Loading…', ''));
    const r = await send({ type: 'series' });
    if (!r || !r.ok) {
      els.series.replaceChildren(new Option('Could not load series', ''));
      els.series.disabled = true; els.save.disabled = true; els.insights.hidden = true;
      setMsg(r && r.needSetup ? 'Open extension settings and connect.' : ('Could not load series: ' + (r && r.error ? r.error : 'unknown')), 'err');
      return null;
    }
    const list = Array.isArray(r.series) ? r.series : [];
    els.series.replaceChildren();
    if (!list.length) {
      els.series.appendChild(new Option('No series yet — create one below', ''));
      els.series.disabled = true; els.save.disabled = true; els.insights.hidden = true; els.peek.hidden = true;
      els.newrow.dataset.open = '1';
      return list;
    }
    for (const series of list) els.series.appendChild(new Option(`${series.title} · ${series.done}/${series.total}`, series.id));
    els.series.disabled = false;
    const pick = selectId || cfg.lastSeriesId || (queued && queued.seriesId);
    if (pick && list.some((series) => series.id === pick)) els.series.value = pick;
    renderQueued();
    return list;
  }

  async function loadSeriesDetail() {
    const seriesId = els.series.value;
    const request = ++detailRequest;
    if (!seriesId) { els.peek.hidden = true; els.insights.hidden = true; return true; }
    const r = await send({ type: 'seriesVideos', seriesId });
    if (request !== detailRequest || els.series.value !== seriesId) return false;
    if (!r || !r.ok) {
      els.peek.hidden = true; els.insights.hidden = true; selectedPlaylist = null;
      setMsg(r?.error || 'Could not load series progress.', 'err');
      return false;
    }
    const stats = YTQShared.seriesStats(r.videos);
    els.insights.hidden = false;
    els.progressLabel.textContent = `${stats.watched}/${stats.total} watched · ${stats.remaining} left`;
    els.progressPercent.textContent = `${stats.percent}%`;
    els.meterFill.style.width = `${stats.percent}%`;
    els.meter.setAttribute('aria-valuenow', String(stats.percent));
    els.meter.setAttribute('aria-valuetext', `${stats.watched} of ${stats.total} watched; ${stats.remaining} remaining`);
    els.timeRemaining.textContent = stats.known ? `Remaining: ${YTQShared.formatDuration(stats.remainingSeconds)}` : 'Remaining: —';
    els.timeTotal.textContent = stats.known ? `Total: ${YTQShared.formatDuration(stats.totalSeconds)}` : 'Total: —';
    els.durationCoverage.textContent = stats.total ? `${stats.known} of ${stats.total} durations known${stats.unknown ? '; unknown lengths excluded' : ''}.` : 'Add videos to see watch time.';
    selectedPlaylist = r.series.playlist || null;
    els.linked.hidden = !selectedPlaylist;
    if (selectedPlaylist) {
      els.autoSync.checked = !!selectedPlaylist.autoSync;
      const date = selectedPlaylist.lastSyncedAt ? new Date(selectedPlaylist.lastSyncedAt) : null;
      const synced = date && !Number.isNaN(date.getTime()) ? `Last synced ${date.toLocaleString()}` : 'Not synced yet';
      els.syncStatus.textContent = selectedPlaylist.lastError ? `Last refresh failed: ${selectedPlaylist.lastError}` : `${synced} · ${selectedPlaylist.autoSync ? 'checks roughly every 6 hours' : 'auto-sync off'}`;
    }
    const next = r.videos.filter((v) => v.status !== 'done').slice(0, 5);
    els.peek.hidden = !next.length;
    els.peekTitle.textContent = `Next in ${r.series.title || 'this series'}`;
    els.peekList.replaceChildren();
    for (const video of next) {
      const li = document.createElement('li');
      const title = document.createElement('span'); title.className = 't'; title.textContent = video.title || 'Untitled';
      li.appendChild(title);
      if (video.durationSeconds) {
        const duration = document.createElement('span'); duration.className = 'd'; duration.textContent = fmtDur(video.durationSeconds); li.appendChild(duration);
      }
      const id = video.youtubeId || YTQShared.videoIdFrom(video.url);
      if (/^[A-Za-z0-9_-]{11}$/.test(id || '')) {
        li.tabIndex = 0; li.setAttribute('role', 'link');
        const open = () => { location.href = 'https://www.youtube.com/watch?v=' + id; };
        li.addEventListener('click', open);
        li.addEventListener('keydown', (event) => { if (event.key === 'Enter') open(); });
      }
      els.peekList.appendChild(li);
    }
    return true;
  }

  async function openPanel() {
    if (!fillPanel()) { showToast('Open a YouTube video or playlist first.'); return; }
    panel.dataset.open = '1';
    positionPanel();

    // Every step below is isolated on purpose. A throw anywhere in here used to
    // abandon the rest of the sequence, leaving the panel half-built: the
    // "already queued" row drawn, the series dropdown empty, and the message
    // line still showing the static "Ready." with no hint of what failed.
    try {
      await refreshState();
    } catch (e) {
      setMsg('Could not read extension settings: ' + errText(e), 'err');
    }

    if (!(cfg.apiBaseUrl && cfg.hasToken)) {
      queuedMatches = []; lookupError = ''; selectedPlaylist = null;
      els.insights.hidden = true; els.peek.hidden = true;
      try { renderQueued(); } catch { /* cosmetic only */ }
      els.series.replaceChildren(new Option('Connect to see your series', ''));
      setMsg('Not connected yet. Open extension settings or sign in on your queue site.', 'warn');
      els.save.disabled = true; els.series.disabled = true; els.importPlaylist.disabled = true;
      positionPanel();
      return;
    }
    els.importPlaylist.disabled = false;

    try {
      await checkQueued();
    } catch (e) {
      lookupError = 'Could not check whether this video is already queued.';
      try { renderQueued(); } catch { /* cosmetic only */ }
    }

    let list = null;
    try {
      list = await loadSeries();
    } catch (e) {
      // Never leave a blank dropdown behind — say what happened instead.
      els.series.replaceChildren(new Option('Could not load series', ''));
      els.series.disabled = true;
      els.save.disabled = true;
      setMsg('Could not load series: ' + errText(e), 'err');
    }

    let detailOk = false;
    if (list) {
      try {
        detailOk = await loadSeriesDetail();
      } catch (e) {
        setMsg('Could not load series progress: ' + errText(e), 'err');
      }
    }

    if (list && detailOk) setMsg(lookupError || (queued ? 'Already in your queue.' : 'Ready.'), lookupError ? 'warn' : queued ? 'ok' : 'muted');
    positionPanel();
    requestAnimationFrame(positionPanel);
  }

  // ------------------------------------------------------------ actions

  els.series.addEventListener('change', async () => {
    cfg.lastSeriesId = els.series.value;
    await send({ type: 'setConfig', patch: { lastSeriesId: els.series.value } });
    renderQueued();
    await loadSeriesDetail();
  });
  els.newToggle.addEventListener('click', () => { els.newrow.dataset.open = els.newrow.dataset.open === '1' ? '0' : '1'; });

  els.create.addEventListener('click', async () => {
    const name = (els.newname.value || '').trim();
    if (!name) { setMsg('Type a name for the new series.', 'warn'); return; }
    els.create.disabled = true;
    const r = await send({ type: 'createSeries', title: name });
    els.create.disabled = false;
    if (!r || !r.ok) { setMsg('Could not create: ' + (r && r.error ? r.error : 'unknown'), 'err'); return; }
    els.newname.value = ''; els.newrow.dataset.open = '0';
    cfg.lastSeriesId = r.id;
    await send({ type: 'setConfig', patch: { lastSeriesId: r.id } });
    await loadSeries(r.id); await loadSeriesDetail();
    setMsg('Series created.', 'ok');
  });

  els.save.addEventListener('click', async () => {
    const info = videoInfo();
    if (!info) { setMsg('No video on this page.', 'warn'); return; }
    const seriesId = els.series.value;
    if (!seriesId) { setMsg('Pick or create a series first.', 'warn'); return; }
    els.save.disabled = true; setMsg('Saving…', 'muted');
    const r = await send({ type: 'save', seriesId, url: info.url, durationSeconds: info.durationSeconds, resumeSeconds: info.currentTime });
    if (r && r.ok) {
      cfg.lastSeriesId = seriesId;
      await checkQueued(); await loadSeries(seriesId); await loadSeriesDetail();
      setMsg(r.warning || `Saved to “${r.seriesTitle || 'your queue'}”.`, r.warning ? 'warn' : 'ok');
      showToast(r.warning ? 'Saved, but progress needs attention' : '✓ Added to your queue');
    } else if (r && r.duplicate) {
      await checkQueued();
      setMsg(`Already in “${r.seriesTitle || 'this series'}”.`, 'warn');
      showToast('Already in that series');
    } else {
      renderQueued();
      setMsg('Could not save: ' + (r && r.error ? r.error : 'unknown'), 'err');
      showToast('Save failed');
    }
  });

  els.resume.addEventListener('click', () => {
    if (!queued) return;
    const v = document.querySelector('video');
    if (v && queued.video.resumeSeconds) {
      v.currentTime = queued.video.resumeSeconds;
      v.play().catch(() => {});
      showToast('Resumed at ' + fmtDur(queued.video.resumeSeconds));
    }
  });

  els.savePosition.addEventListener('click', async () => {
    const info = videoInfo();
    if (!queued || queued.video.status === 'done' || !info) return;
    if (!(info.currentTime > 0)) { setMsg('Play the video first to save a position.', 'warn'); return; }
    els.savePosition.disabled = true;
    const r = await send({ type: 'patchVideo', videoId: queued.video.id, status: 'watching', resumeSeconds: info.currentTime, durationSeconds: queued.video.durationSeconds ? undefined : info.durationSeconds });
    els.savePosition.disabled = false;
    if (!r || !r.ok) { setMsg('Could not save position: ' + (r?.error || 'unknown'), 'err'); return; }
    await checkQueued(); await loadSeriesDetail();
    setMsg(`Position saved at ${fmtDur(info.currentTime)}.`, 'ok');
  });

  els.watched.addEventListener('click', async () => {
    if (!queued) return;
    const toDone = queued.video.status !== 'done';
    els.watched.disabled = true;
    const r = await send({ type: 'patchVideo', videoId: queued.video.id, status: toDone ? 'done' : 'todo', resumeSeconds: 0, durationSeconds: queued.video.durationSeconds ? undefined : videoInfo()?.durationSeconds });
    els.watched.disabled = false;
    if (r && r.ok) {
      showToast(toDone ? 'Marked watched' : 'Marked unwatched');
      await checkQueued(); await loadSeries(els.series.value); await loadSeriesDetail();
    } else setMsg('Could not update: ' + (r && r.error ? r.error : 'unknown'), 'err');
  });

  els.importPlaylist.addEventListener('click', async () => {
    const pl = playlistInfo();
    if (!pl) return;
    els.importPlaylist.disabled = true; setMsg('Importing the full playlist…', 'muted');
    const r = await send({ type: 'importPlaylist', url: pl.url, autoSync: true });
    els.importPlaylist.disabled = false;
    if (!r || !r.ok) { setMsg('Could not import playlist: ' + (r?.error || 'unknown'), 'err'); return; }
    cfg.lastSeriesId = r.id;
    await loadSeries(r.id); await loadSeriesDetail(); await checkQueued();
    setMsg(`Imported ${r.added || 0} videos${r.unavailable ? ` · ${r.unavailable} unavailable` : ''}${r.duplicates ? ` · ${r.duplicates} duplicates skipped` : ''}.`, 'ok');
    showToast('✓ Linked playlist imported');
  });

  els.playlist.addEventListener('click', async () => {
    const pl = playlistInfo();
    if (!pl || !pl.count) return;
    const seriesId = els.series.value;
    if (!seriesId) { setMsg('Pick or create a series first.', 'warn'); return; }
    els.playlist.disabled = true; setMsg(`Saving ${pl.count} visible videos…`, 'muted');
    const r = await send({ type: 'saveMany', seriesId, urls: pl.urls });
    els.playlist.disabled = false;
    if (r && r.ok) {
      await loadSeries(seriesId); await loadSeriesDetail(); await checkQueued();
      setMsg(`Added ${r.added}${r.duplicates ? ` · ${r.duplicates} duplicates skipped` : ''}${r.skipped ? ` · ${r.skipped} unavailable` : ''}.`, 'ok');
      showToast(`✓ Added ${r.added} visible videos`);
    } else {
      if (r?.added) { await loadSeries(seriesId); await loadSeriesDetail(); }
      setMsg('Could not save visible videos: ' + (r?.error || 'unknown'), 'err');
    }
  });

  async function refreshLinked(restoreRemoved) {
    if (!selectedPlaylist || !els.series.value) return;
    if (restoreRemoved && !confirm('Re-add removed videos still in this playlist as unwatched?')) return;
    const id = els.series.value;
    els.refreshPlaylist.disabled = true; els.restorePlaylist.disabled = true;
    setMsg(restoreRemoved ? 'Restoring…' : 'Refreshing playlist…', 'muted');
    const r = await send({ type: 'refreshPlaylist', seriesId: id, restoreRemoved });
    els.refreshPlaylist.disabled = false; els.restorePlaylist.disabled = false;
    if (els.series.value === id) { await loadSeries(id); await loadSeriesDetail(); }
    if (!r || !r.ok) { setMsg('Could not refresh: ' + (r?.error || 'unknown'), 'err'); return; }
    await checkQueued();
    setMsg(`${r.added || 0} videos added${r.unavailable ? ` · ${r.unavailable} unavailable` : ''}.`, 'ok');
  }
  els.refreshPlaylist.addEventListener('click', () => refreshLinked(false));
  els.restorePlaylist.addEventListener('click', () => refreshLinked(true));
  els.autoSync.addEventListener('change', async () => {
    const id = els.series.value, enabled = els.autoSync.checked;
    if (!selectedPlaylist || !id) return;
    els.autoSync.disabled = true;
    const r = await send({ type: 'setAutoSync', seriesId: id, enabled });
    els.autoSync.disabled = false;
    if (!r || !r.ok) { if (els.series.value === id) els.autoSync.checked = !enabled; setMsg(r?.error || 'Could not update auto-sync.', 'err'); return; }
    if (els.series.value === id) await loadSeriesDetail();
    setMsg(enabled ? 'Automatic checks enabled.' : 'Automatic checks paused.', 'ok');
  });

  // ------------------------------------------------------------ lifecycle

  document.documentElement.appendChild(host);

  (async () => {
    const stored = await chrome.storage.local.get([POS_KEY, PANEL_POS_KEY, HIDDEN_KEY]);
    if (stored[POS_KEY]) pos = stored[POS_KEY];
    if (stored[PANEL_POS_KEY]) panelPos = stored[PANEL_POS_KEY];
    hidden = !!stored[HIDDEN_KEY];
    await refreshState();
    applyVisibility();
    checkQueued().catch(() => { /* the panel reports its own errors */ });
  })();

  let lastHref = location.href;
  function onNav() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    panel.dataset.open = '0';
    queued = null;
    queuedMatches = [];
    lookupError = '';
    lookupRequest++;
    detailRequest++;
    renderQueued();
    setTimeout(() => {
      checkQueued().catch(() => {});
      if (panel.dataset.open === '1') openPanel().catch(() => {});
    }, 500);
  }
  window.addEventListener('yt-navigate-finish', onNav);
  window.addEventListener('yt-page-data-updated', onNav);
  const mo = new MutationObserver(() => { clearTimeout(mo._t); mo._t = setTimeout(onNav, 500); });
  mo.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', () => { applyVisibility(); if (panel.dataset.open === '1') positionPanel(); });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) { cfg.settings = { ...cfg.settings, ...(changes.settings.newValue || {}) }; applyVisibility(); }
    if (changes.token || changes.apiBaseUrl) {
      if (changes.token) cfg.hasToken = !!changes.token.newValue;
      if (changes.apiBaseUrl) cfg.apiBaseUrl = changes.apiBaseUrl.newValue || '';
      els.who.textContent = (cfg.apiBaseUrl && cfg.hasToken) ? 'Connected' : 'Not connected';
      if (panel.dataset.open === '1') openPanel().catch(() => {});
    }
    if (changes[POS_KEY]) { pos = changes[POS_KEY].newValue || null; applyVisibility(); }
    if (changes[PANEL_POS_KEY]) { panelPos = changes[PANEL_POS_KEY].newValue || null; if (panel.dataset.open === '1') positionPanel(); }
    if (changes[HIDDEN_KEY]) { hidden = !!changes[HIDDEN_KEY].newValue; applyVisibility(); }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'getVideoInfo') { sendResponse(videoInfo()); return true; }
    if (msg && msg.type === 'openPanel') { openPanel().catch(() => {}); sendResponse({ ok: true }); return true; }
    return false;
  });
})();
