// Mocked MV3 service-worker tests. Run with: node --test extension/test_background_mocked.js
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const code = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
const shared = fs.readFileSync(path.join(__dirname, 'shared.js'), 'utf8');
const PAGE = { url: 'chrome-extension://test/popup.html' };
const SITE = { url: 'https://pavnxet.github.io/yt-video-queue/' };
const YOUTUBE = { url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA' };
const A = 'AAAAAAAAAAA', B = 'BBBBBBBBBBB', PLAYLIST = 'PL1234567890';
const base = 'https://api.example.workers.dev';
const plain = (value) => JSON.parse(JSON.stringify(value));
const response = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

function harness(overrides = {}) {
  const store = {};
  const calls = [];
  let listener;
  const chrome = {
    storage: { local: {
      async get(keys) {
        if (keys == null) return { ...store };
        const out = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) if (key in store) out[key] = store[key];
        return out;
      },
      async set(obj) { Object.assign(store, obj); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; },
    } },
    runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      getURL: (p) => 'chrome-extension://test/' + p, openOptionsPage() {}, lastError: null,
    },
    action: { setBadgeBackgroundColor() {}, setBadgeText() {}, async openPopup() {} },
    contextMenus: { removeAll(cb) { if (cb) cb(); }, create() {}, onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    tabs: { async query() { return []; }, async sendMessage() { return {}; }, create() {} },
  };
  const fetch = async (input, opts = {}) => {
    const url = new URL(String(input));
    const call = { url: url.href, path: url.pathname, search: url.searchParams, method: opts.method || 'GET',
      body: opts.body ? JSON.parse(opts.body) : null, authorization: opts.headers?.Authorization };
    calls.push(call);
    if (overrides.fetch) {
      const custom = await overrides.fetch(call);
      if (custom !== undefined) return custom;
    }
    if (call.authorization !== 'Bearer tok') return response({ error: 'Unauthorized' }, 401);
    if (call.path === '/series' && call.method === 'GET') return response({ series: [{ id: 's1', title: 'Study', done: 0, total: 1 }] });
    if (call.path === '/series' && call.method === 'POST') return response({ id: 'new-series' }, 201);
    if (call.path === '/series/s1' && call.method === 'GET') return response({ series: { id: 's1', title: 'Study' }, videos: [{ id: 'v1', youtubeId: A, title: 'Old video', status: 'todo' }] });
    if (call.path === '/series/s1' && call.method === 'PATCH') return response({ ok: true });
    if (call.path === '/series/s1/videos' && call.method === 'POST') {
      const urls = call.body.urls ? call.body.urls.split('\n') : [call.body.url];
      return response({ added: urls.length, ids: urls.map((_, i) => 'new-' + i), skipped: 0 }, 201);
    }
    if (call.path === '/series/import-playlist' && call.method === 'POST') return response({ id: 'linked', added: 2, unavailable: 1, duplicates: 1 }, 201);
    if (call.path === '/series/s1/refresh-playlist' && call.method === 'POST') return response({ ok: true, added: 1 });
    if (call.path === '/videos/lookup' && call.method === 'GET') {
      const matches = call.search.get('youtubeId') === A ? [{ seriesId: 's1', seriesTitle: 'Study', video: { id: 'v1', youtubeId: A } }] : [];
      return response({ matches });
    }
    if (call.path.startsWith('/videos/') && call.method === 'PATCH') return response({ ok: true, updated: true });
    return response({ error: 'Not found' }, 404);
  };
  // Badge timers should not keep the Node process alive.
  const schedule = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; };
  const sandbox = { chrome, fetch, console, setTimeout: schedule, clearTimeout, AbortController, URL, Date };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.importScripts = (file) => {
    assert.equal(file, 'shared.js');
    vm.runInContext(shared, sandbox, { filename: 'shared.js' });
  };
  vm.runInContext(code, sandbox, { filename: 'background.js' });
  const ask = (msg, sender = PAGE) => new Promise((resolve) => listener(msg, sender, resolve));
  const setup = () => ask({ type: 'setConfig', patch: { apiBaseUrl: base, token: 'tok', lastSeriesId: 's1' } });
  return { chrome, store, calls, ask, setup };
}

test('single saves deduplicate and record watching progress without overwriting a known duration', async () => {
  const h = harness(); await h.setup();
  const dup = await h.ask({ type: 'save', url: `https://www.youtube.com/watch?v=${A}` }, YOUTUBE);
  assert.deepEqual(plain([dup.ok, dup.duplicate, dup.seriesTitle]), [false, true, 'Study']);
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
  h.calls.length = 0;
  const result = await h.ask({ type: 'save', url: `https://youtu.be/${B}`, durationSeconds: 615.4, resumeSeconds: 42.2 }, YOUTUBE);
  assert.equal(result.ok, true);
  assert.deepEqual(plain(h.calls.find((c) => c.method === 'PATCH').body), { durationSeconds: 615, durationIfMissing: true, resumeSeconds: 42, status: 'watching' });
  assert.equal(h.calls.find((c) => c.method === 'POST').body.url, `https://www.youtube.com/watch?v=${B}`);
  const bad = await h.ask({ type: 'save', url: `https://youtube.com.evil.test/watch?v=${B}` });
  assert.equal(bad.ok, false);
});

test('duration capture is independent of resume preference and partial saves warn honestly', async () => {
  const h = harness({ fetch(call) { if (call.path.startsWith('/videos/') && call.method === 'PATCH') return response({ error: 'patch failed' }, 500); } });
  await h.setup();
  await h.ask({ type: 'setConfig', patch: { settings: { recordResume: false } } });
  h.calls.length = 0;
  const result = await h.ask({ type: 'save', url: `https://youtu.be/${B}`, durationSeconds: 90, resumeSeconds: 12 });
  assert.equal(result.ok, true);
  assert.match(result.warning, /saved.*could not be recorded/i);
  assert.deepEqual(plain(h.calls.find((c) => c.method === 'PATCH').body), { durationSeconds: 90, durationIfMissing: true });
});

test('visible playlist batches deduplicate against the series and within the batch', async () => {
  const h = harness(); await h.setup(); h.calls.length = 0;
  const urls = Array.from({ length: 35 }, (_, i) => `https://www.youtube.com/watch?v=${String(i).padStart(11, '0')}`);
  const result = await h.ask({ type: 'saveMany', urls: [...urls, urls[0], `https://youtu.be/${A}`, 'https://example.com/'] });
  assert.deepEqual(plain([result.ok, result.added, result.duplicates, result.skipped]), [true, 35, 2, 1]);
  assert.deepEqual(h.calls.filter((c) => c.path.endsWith('/videos') && c.method === 'POST').map((c) => c.body.urls.split('\n').length), [20, 15]);
});

test('batch failure reports videos already saved instead of claiming atomicity', async () => {
  let posts = 0;
  const h = harness({ fetch(call) { if (call.path.endsWith('/videos') && call.method === 'POST' && ++posts === 2) return response({ error: 'quota exceeded' }, 503); } });
  await h.setup();
  const urls = Array.from({ length: 21 }, (_, i) => `https://www.youtube.com/watch?v=${String(i).padStart(11, '0')}`);
  const result = await h.ask({ type: 'saveMany', urls });
  assert.equal(result.ok, false); assert.equal(result.added, 20);
  assert.match(result.error, /20 confirmed in earlier batches/);
  assert.match(result.error, /may also have partially saved/);
});

test('linked playlist import, refresh, restore and auto-sync use the website endpoints', async () => {
  const h = harness(); await h.setup(); h.calls.length = 0;
  const result = await h.ask({ type: 'importPlaylist', url: `https://www.youtube.com/watch?v=${B}&list=${PLAYLIST}`, title: ' Course ', autoSync: false }, YOUTUBE);
  assert.equal(result.ok, true); assert.equal(result.id, 'linked'); assert.equal(h.store.lastSeriesId, 'linked');
  assert.deepEqual(plain(h.calls[0].body), { url: `https://www.youtube.com/playlist?list=${PLAYLIST}`, title: 'Course', autoSync: false });
  assert.equal((await h.ask({ type: 'importPlaylist', url: `https://youtube.com.evil.test/?list=${PLAYLIST}` })).ok, false);
  assert.equal((await h.ask({ type: 'refreshPlaylist', seriesId: 's1', restoreRemoved: true })).added, 1);
  assert.deepEqual(plain(h.calls.find((c) => c.path.endsWith('/refresh-playlist')).body), { restoreRemoved: true });
  assert.equal((await h.ask({ type: 'setAutoSync', seriesId: 's1', enabled: false })).ok, true);
  assert.deepEqual(plain(h.calls.find((c) => c.path === '/series/s1' && c.method === 'PATCH').body), { autoSync: false });
});

test('indexed lookup falls back on 404 only, and does not treat API failures as misses', async () => {
  let h = harness(); await h.setup(); h.calls.length = 0;
  let result = await h.ask({ type: 'findVideo', youtubeId: A });
  assert.equal(result.found, true); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].path, '/videos/lookup');
  h = harness({ fetch(call) { if (call.path === '/videos/lookup') return response({ error: 'Not found' }, 404); } });
  await h.setup(); h.calls.length = 0;
  result = await h.ask({ type: 'findVideo', youtubeId: A });
  assert.equal(result.found, true); assert.equal(result.matches[0].video.id, 'v1');
  assert.deepEqual(h.calls.map((c) => c.path), ['/videos/lookup', '/series', '/series/s1']);
  h = harness({ fetch(call) { if (call.path === '/videos/lookup') return response({ error: 'unavailable' }, 503); } });
  await h.setup(); h.calls.length = 0;
  result = await h.ask({ type: 'findVideo', youtubeId: A });
  assert.equal(result.ok, false); assert.equal(result.status, 503); assert.equal(h.calls.length, 1);
});

test('progress updates validate inputs and report a completed-video race', async () => {
  const h = harness({ fetch(call) { if (call.path === '/videos/v1' && call.method === 'PATCH') return response({ ok: true, updated: false }); } });
  await h.setup();
  const result = await h.ask({ type: 'patchVideo', videoId: 'v1', status: 'watching', resumeSeconds: 12.6, durationSeconds: 120 });
  assert.equal(result.ok, false); assert.match(result.error, /already watched/i);
  assert.deepEqual(plain(h.calls.find((c) => c.path === '/videos/v1').body), { status: 'watching', resumeSeconds: 13, durationSeconds: 120, durationIfMissing: true });
  assert.equal((await h.ask({ type: 'patchVideo', videoId: 'v1', status: 'bogus' })).ok, false);
});

test('site handoff is sender-checked; logout clears site tokens but not manual sessions', async () => {
  const h = harness();
  let result = await h.ask({ type: 'site', apiBaseUrl: base, token: 'tok' }, YOUTUBE);
  assert.equal(result.ok, false); assert.equal(h.store.token, undefined);
  result = await h.ask({ type: 'setConfig', patch: { apiBaseUrl: 'https://evil.test', token: 'stolen' } }, YOUTUBE);
  assert.equal(result.ok, false);
  result = await h.ask({ type: 'site', apiBaseUrl: base + '/', token: 'tok' }, SITE);
  assert.equal(result.ok, true); assert.equal(h.store.tokenSource, 'site');
  assert.equal((await h.ask({ type: 'state' })).token, undefined);
  // Saving the same settings just to grant a custom-host permission preserves source.
  await h.ask({ type: 'setConfig', patch: { apiBaseUrl: base, token: 'tok' } });
  assert.equal(h.store.tokenSource, 'site');
  await h.ask({ type: 'site', apiBaseUrl: 'https://other.workers.dev', token: '' }, SITE);
  assert.equal(h.store.token, 'tok'); // an unrelated deployment cannot log this session out
  await h.ask({ type: 'site', apiBaseUrl: base, token: '' }, SITE);
  assert.equal(h.store.token, '');
  await h.ask({ type: 'setConfig', patch: { apiBaseUrl: base, token: 'manual' } });
  await h.ask({ type: 'site', apiBaseUrl: base, token: '' }, SITE);
  assert.equal(h.store.token, 'manual');
  result = await h.ask({ type: 'setConfig', patch: { apiBaseUrl: 'http://evil.test' } });
  assert.equal(result.ok, false); assert.equal(h.store.apiBaseUrl, base);
  await h.ask({ type: 'setConfig', patch: { lastSeriesId: 'old-series' } });
  await h.ask({ type: 'setConfig', patch: { apiBaseUrl: 'https://new.example.test' } });
  assert.equal(h.store.token, ''); // do not send the old session to a new host
  assert.equal(h.store.lastSeriesId, ''); // the old deployment's series is not a valid default
});

test('an old 401 cannot clear a session delivered while the request is in flight', async () => {
  let started, release;
  const entered = new Promise((resolve) => { started = resolve; });
  const h = harness({ async fetch(call) {
    if (call.path === '/series') {
      started();
      return await new Promise((resolve) => { release = resolve; });
    }
  } });
  await h.ask({ type: 'setConfig', patch: { apiBaseUrl: base, token: 'old' } });
  const request = h.ask({ type: 'series' });
  await entered;
  await h.ask({ type: 'site', apiBaseUrl: base, token: 'new' }, SITE);
  release(response({ error: 'expired' }, 401));
  assert.equal((await request).status, 401);
  assert.equal(h.store.token, 'new');
});

test('an unchanged expired session is cleared, but a same-token handoff to another API is not', async () => {
  let h = harness();
  await h.ask({ type: 'setConfig', patch: { apiBaseUrl: base, token: 'expired' } });
  assert.equal((await h.ask({ type: 'series' })).status, 401);
  assert.equal(h.store.token, '');

  let started, release;
  const entered = new Promise((resolve) => { started = resolve; });
  h = harness({ async fetch(call) {
    if (call.path === '/series') { started(); return await new Promise((resolve) => { release = resolve; }); }
  } });
  await h.ask({ type: 'setConfig', patch: { apiBaseUrl: base, token: 'same' } });
  const request = h.ask({ type: 'series' });
  await entered;
  await h.ask({ type: 'site', apiBaseUrl: 'https://new.workers.dev', token: 'same' }, SITE);
  release(response({ error: 'expired' }, 401));
  await request;
  assert.equal(h.store.token, 'same');
  assert.equal(h.store.apiBaseUrl, 'https://new.workers.dev');
});
