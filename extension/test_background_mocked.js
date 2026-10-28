// Mocked test: loads background.js in a stubbed Chrome + fetch environment and
// exercises the save / dedupe / batching logic. No network, no real extension.
const fs = require('fs');
const vm = require('vm');

const code = fs.readFileSync('/scratch/work/ytq-ext/extension/background.js', 'utf8');

// ---- chrome stub -----------------------------------------------------------
const store = {};
const chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (keys == null) return { ...store };
        const arr = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of arr) if (k in store) out[k] = store[k];
        return out;
      },
      set: async (obj) => { Object.assign(store, obj); },
      remove: async (k) => { delete store[k]; }
    }
  },
  runtime: {
    onMessage: { addListener: (fn) => { chrome.__onMessage = fn; } },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    getURL: (p) => 'chrome-extension://test/' + p,
    openOptionsPage: () => {},
    lastError: null
  },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {}, openPopup: async () => {} },
  contextMenus: { removeAll: (cb) => cb && cb(), create: () => {}, onClicked: { addListener: () => {} } },
  commands: { onCommand: { addListener: () => {} } },
  tabs: { query: async () => [], sendMessage: async () => ({}), create: () => {} }
};

// ---- fetch stub ------------------------------------------------------------
const calls = [];
const VIDEO_EXISTING = 'AAAAAAAAAAA';
const VIDEO_NEW = 'BBBBBBBBBBB';
function makeFetch(token) {
  return async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, url: u, body, auth: (opts.headers || {}).Authorization });
    const auth = (opts.headers || {}).Authorization || '';
    if (token && auth !== 'Bearer ' + token) {
      return { ok: false, status: 401, text: async () => JSON.stringify({ error: 'Unauthorized' }) };
    }
    const j = (o, s = 200) => ({ ok: s < 400, status: s, text: async () => JSON.stringify(o) });
    if (u.endsWith('/series') && method === 'GET') return j({ series: [{ id: 's1', title: 'Study', done: 1, total: 2 }] });
    if (u.endsWith('/series') && method === 'POST') return j({ id: 'sNEW' }, 201);
    if (u.endsWith('/series/s1') && method === 'GET') {
      return j({ series: { id: 's1', title: 'Study' }, videos: [{ id: 'v1', youtubeId: VIDEO_EXISTING, title: 'Old video' }] });
    }
    if (/\/series\/s1\/videos$/.test(u) && method === 'POST') {
      const has = body && (body.url || body.urls || '');
      const n = body && body.urls ? String(body.urls).split('\n').length : 1;
      return j({ added: n, ids: ['newid' + n], skipped: 0 }, 201);
    }
    if (/\/videos\/[^/]+$/.test(u) && method === 'PATCH') return j({ ok: true });
    return j({ error: 'not found' }, 404);
  };
}

function load(token) {
  calls.length = 0;
  for (const k of Object.keys(store)) delete store[k]; // fresh storage per case
  const sandbox = { chrome, fetch: makeFetch(token), console, setTimeout, clearTimeout, AbortController, URL, JSON, Math, String, Number, Array, Object, isFinite, RegExp, Promise, encodeURIComponent, Date };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'background.js' });
  return sandbox;
}

function ask(sandbox, msg) {
  return new Promise((resolve) => {
    sandbox.chrome.__onMessage(msg, {}, resolve);
  });
}

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}

(async () => {
  // --- youtube id parsing (via the public save path) ---
  let sb = load('tok');
  await ask(sb, { type: 'setConfig', patch: { apiBaseUrl: 'https://api.example.workers.dev', token: 'tok', lastSeriesId: 's1' } });

  // duplicate detection
  let r = await ask(sb, { type: 'save', url: 'https://www.youtube.com/watch?v=' + VIDEO_EXISTING });
  check('duplicate is detected', [r.ok, r.duplicate, r.seriesTitle], [false, true, 'Study']);

  // new video saves, and records duration + resume
  calls.length = 0;
  r = await ask(sb, { type: 'save', url: 'https://youtu.be/' + VIDEO_NEW, durationSeconds: 615, resumeSeconds: 42 });
  check('new video saved', [r.ok, r.added], [true, 1]);
  const patch = calls.find((c) => c.method === 'PATCH');
  check('resume recorded via PATCH', patch && patch.body, { durationSeconds: 615, resumeSeconds: 42 });
  check('POST carried the url', !!calls.find((c) => c.method === 'POST' && /\/series\/s1\/videos$/.test(c.url)), true);

  // non-youtube link rejected
  r = await ask(sb, { type: 'save', url: 'https://example.com/thing' });
  check('non-youtube link rejected', [r.ok, !!r.error], [false, true]);

  // no series chosen
  sb = load('tok');
  await ask(sb, { type: 'setConfig', patch: { apiBaseUrl: 'https://api.example.workers.dev', token: 'tok', lastSeriesId: '' } });
  r = await ask(sb, { type: 'save', url: 'https://youtu.be/' + VIDEO_NEW });
  check('needs a series first', [r.ok, r.needSeries], [false, true]);

  // playlist batch (35 urls -> 2 batches of 20 + 15)
  sb = load('tok');
  await ask(sb, { type: 'setConfig', patch: { apiBaseUrl: 'https://api.example.workers.dev', token: 'tok', lastSeriesId: 's1' } });
  calls.length = 0;
  const urls = Array.from({ length: 35 }, (_, i) => 'https://www.youtube.com/watch?v=vid' + String(i).padStart(8, '0'));
  r = await ask(sb, { type: 'saveMany', urls });
  check('batch save added 35', [r.ok, r.added], [true, 35]);
  check('split into 2 requests', calls.filter((c) => c.method === 'POST' && /videos$/.test(c.url)).length, 2);

  // 401 clears the token
  sb = load('GOOD');
  await ask(sb, { type: 'setConfig', patch: { apiBaseUrl: 'https://api.example.workers.dev', token: 'WRONG', lastSeriesId: 's1' } });
  r = await ask(sb, { type: 'series' });
  check('401 reported', [r.ok, r.status], [false, 401]);
  const st = await ask(sb, { type: 'state' });
  check('token cleared after 401', st.hasToken, false);

  // no API url
  sb = load('tok');
  r = await ask(sb, { type: 'test' });
  check('missing setup is flagged', [r.ok, r.needSetup], [false, true]);

  // site handoff
  sb = load('tok');
  r = await ask(sb, { type: 'site', token: 'fromSite', apiBaseUrl: 'https://api.example.workers.dev/' });
  const st2 = await ask(sb, { type: 'state' });
  check('site token + url captured', [st2.hasToken, st2.apiBaseUrl], [true, 'https://api.example.workers.dev']);

  // --- findVideo (already-in-queue detection) ---
  sb = load('tok');
  await ask(sb, { type: 'setConfig', patch: { apiBaseUrl: 'https://api.example.workers.dev', token: 'tok', lastSeriesId: 's1' } });
  let f = await ask(sb, { type: 'findVideo', youtubeId: VIDEO_EXISTING });
  check('findVideo finds a queued video', [f.ok, f.found, f.matches[0].seriesTitle, f.matches[0].video.id], [true, true, 'Study', 'v1']);
  f = await ask(sb, { type: 'findVideo', youtubeId: 'ZZZZZZZZZZZ' });
  check('findVideo reports a miss', [f.ok, f.found], [true, false]);

  // --- patchVideo (mark watched / resume) ---
  calls.length = 0;
  let pv = await ask(sb, { type: 'patchVideo', videoId: 'v1', status: 'done' });
  check('patchVideo marks watched', pv.ok, true);
  check('PATCH sent status', (calls.find((c) => c.method === 'PATCH' && c.body && c.body.status) || {}).body, { status: 'done' });
  pv = await ask(sb, { type: 'patchVideo', videoId: 'v1', resumeSeconds: 123.6 });
  check('patchVideo rounds resume', calls.filter((c) => c.method === 'PATCH').pop().body, { resumeSeconds: 124 });
  pv = await ask(sb, { type: 'patchVideo', videoId: 'v1' });
  check('patchVideo needs something to change', [pv.ok, !!pv.error], [false, true]);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
