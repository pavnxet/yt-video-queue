/* YT Video Queue — Save · options page */

const SITE_URL = 'https://pavnxet.github.io/yt-video-queue/';

const $ = (s) => document.querySelector(s);
const el = {
  status: $('#status'), apiUrl: $('#apiUrl'), token: $('#token'), showToken: $('#showToken'),
  test: $('#test'), saveConn: $('#saveConn'), testResult: $('#testResult'),
  defaultSeries: $('#defaultSeries'), showPill: $('#showPill'), recordResume: $('#recordResume'),
  openSite: $('#openSite'), openQueue: $('#openQueue'), savedFlag: $('#savedFlag')
};

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(r || { ok: false, error: 'No response' });
    });
  });
}

function originOf(url) {
  try {
    const parsed = new URL(url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) ||
        parsed.username || parsed.password || parsed.search || parsed.hash) return '';
    // Extension match patterns omit ports and cover all ports on this host.
    return parsed.protocol + '//' + parsed.hostname + '/*';
  } catch { return ''; }
}

function setStatus(ok) {
  el.status.textContent = ok ? 'Connected' : 'Not connected';
  el.status.className = 'sub ' + (ok ? 'ok' : 'warn');
}

// ------------------------------------------------------------------ load

async function load() {
  const st = await send({ type: 'state' });
  const s = (st && st.ok) ? st : {};
  el.apiUrl.value = s.apiBaseUrl || '';
  const { token } = await chrome.storage.local.get('token');
  el.token.value = token || '';
  el.showPill.checked = !s.settings || s.settings.showPill !== false;
  el.recordResume.checked = !s.settings || s.settings.recordResume !== false;
  setStatus(!!(s.apiBaseUrl && s.hasToken));
  await loadSeries(s.lastSeriesId);
}

async function loadSeries(selected) {
  if (!el.apiUrl.value) { el.defaultSeries.innerHTML = '<option value="">— connect first —</option>'; return; }
  const r = await send({ type: 'series' });
  if (!r || !r.ok) {
    el.defaultSeries.innerHTML = `<option value="">${r && r.error ? escapeHtml(r.error) : '— none —'}</option>`;
    return;
  }
  const list = r.series || [];
  el.defaultSeries.innerHTML = '<option value="">— none —</option>' +
    list.map((s) => `<option value="${s.id}">${escapeHtml(s.title)} · ${s.done}/${s.total}</option>`).join('');
  if (selected && list.some((x) => x.id === selected)) el.defaultSeries.value = selected;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ------------------------------------------------------------------ actions

el.showToken.addEventListener('click', () => {
  el.token.type = el.token.type === 'password' ? 'text' : 'password';
});

el.saveConn.addEventListener('click', async () => {
  const url = (el.apiUrl.value || '').trim().replace(/\/+$/, '');
  const token = (el.token.value || '').trim();

  // A custom API host needs an explicit grant, since the manifest only ships
  // the default worker domain.
  if (url) {
    const origin = originOf(url);
    if (!origin) {
      el.testResult.className = 'hint err';
      el.testResult.textContent = 'Use an HTTPS API URL, or localhost for development.';
      return;
    }
    // Request directly within the click gesture. Already-granted origins do
    // not show a prompt, and no preceding async call can lose the gesture.
    try {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        el.testResult.className = 'hint err';
        el.testResult.textContent = 'Access to ' + origin + ' was declined, so requests will fail. Try again and allow it.';
        return;
      }
    } catch {
      el.testResult.className = 'hint err';
      el.testResult.textContent = 'Could not request access to ' + origin + '. Check the URL and try again.';
      return;
    }
  }

  const r = await send({ type: 'setConfig', patch: { apiBaseUrl: url, token } });
  if (!r || !r.ok) {
    el.testResult.className = 'hint err';
    el.testResult.textContent = r?.error || 'Could not save connection settings.';
    return;
  }
  setStatus(!!(url && token));
  el.testResult.className = 'hint ok';
  el.testResult.textContent = 'Saved.';
  await loadSeries(r && r.lastSeriesId);
});

el.test.addEventListener('click', async () => {
  el.testResult.className = 'hint';
  el.testResult.textContent = 'Testing…';
  const r = await send({ type: 'test' });
  if (r && r.ok) {
    el.testResult.className = 'hint ok';
    el.testResult.textContent = `Connected — ${r.seriesCount} series found.`;
    setStatus(true);
  } else {
    el.testResult.className = 'hint err';
    el.testResult.textContent = r && r.error ? r.error : 'Could not connect.';
    setStatus(false);
  }
});

el.defaultSeries.addEventListener('change', async () => {
  await send({ type: 'setConfig', patch: { lastSeriesId: el.defaultSeries.value } });
  el.savedFlag.textContent = 'Default series saved';
});

el.showPill.addEventListener('change', async () => {
  await send({ type: 'setConfig', patch: { settings: { showPill: el.showPill.checked } } });
  el.savedFlag.textContent = 'Saved';
});

el.recordResume.addEventListener('change', async () => {
  await send({ type: 'setConfig', patch: { settings: { recordResume: el.recordResume.checked } } });
  el.savedFlag.textContent = 'Saved';
});

el.openSite.addEventListener('click', () => chrome.tabs.create({ url: SITE_URL }));
el.openQueue.addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: SITE_URL }); });

// If the site content script hands over a token while this page is open, show it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.token) el.token.value = changes.token.newValue || '';
  if (changes.apiBaseUrl) el.apiUrl.value = changes.apiBaseUrl.newValue || '';
  if (changes.token || changes.apiBaseUrl) {
    setStatus(!!(el.apiUrl.value && el.token.value));
    el.testResult.className = 'hint ok';
    el.testResult.textContent = 'Connection changed. Test it or sign in again if needed.';
  }
});

load();
