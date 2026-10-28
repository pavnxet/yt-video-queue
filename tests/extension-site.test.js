// Tests the queue-site content script without network or a browser profile.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const code = fs.readFileSync(path.join(__dirname, '../extension/content-site.js'), 'utf8');
const settled = () => new Promise((resolve) => setImmediate(resolve));

test('site handoff retries failed messages, caches config, and reports logout', async () => {
  let token = 'session', tick, fetches = 0;
  const sent = [];
  const sandbox = {
    URL, Date,
    location: { origin: 'https://pavnxet.github.io' },
    localStorage: { getItem: () => token },
    async fetch(url) {
      fetches++;
      assert.equal(url, 'https://pavnxet.github.io/yt-video-queue/config.js');
      return { ok: true, async text() { return 'const API_BASE_URL = "https://my-api.workers.dev/";'; } };
    },
    chrome: { runtime: { async sendMessage(message) {
      sent.push({ ...message });
      if (sent.length === 1) throw new Error('worker not ready');
      return { ok: true };
    } } },
    setInterval(fn) { tick = fn; },
    window: { addEventListener() {} },
  };
  vm.runInNewContext(code, sandbox, { filename: 'content-site.js' });
  await settled();
  assert.equal(sent.length, 1);
  await tick();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], { type: 'site', token: 'session', apiBaseUrl: 'https://my-api.workers.dev' });
  await tick();
  assert.equal(sent.length, 2); // successful messages are not resent on every poll
  token = '';
  await tick();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].token, '');
  assert.equal(fetches, 1);
});

test('a missing site API URL never hands off a session', async () => {
  let tick, sent = 0;
  const sandbox = {
    URL, Date,
    location: { origin: 'https://pavnxet.github.io' },
    localStorage: { getItem: () => 'session' },
    async fetch() { return { ok: true, async text() { return 'const API_BASE_URL = "REPLACE_WITH_API_URL";'; } }; },
    chrome: { runtime: { async sendMessage() { sent++; return { ok: true }; } } },
    setInterval(fn) { tick = fn; }, window: { addEventListener() {} },
  };
  vm.runInNewContext(code, sandbox, { filename: 'content-site.js' });
  await settled(); await tick();
  assert.equal(sent, 0);
});
