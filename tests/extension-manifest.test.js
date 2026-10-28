const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const dir = path.join(__dirname, '../extension');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

function exists(relative) {
  assert.ok(relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'), `unsafe extension path: ${relative}`);
  assert.ok(fs.statSync(path.join(dir, relative)).isFile(), `missing extension file: ${relative}`);
}

test('unpacked MV3 manifest references existing local resources in the correct order', () => {
  assert.equal(manifest.manifest_version, 3);
  exists(manifest.background.service_worker);
  exists(manifest.action.default_popup);
  exists(manifest.options_page);
  for (const item of manifest.content_scripts) for (const file of item.js) exists(file);
  const youtube = manifest.content_scripts.find((item) => item.js.includes('content-youtube.js'));
  assert.deepEqual(youtube.js, ['shared.js', 'content-youtube.js']);
  assert.match(fs.readFileSync(path.join(dir, manifest.background.service_worker), 'utf8'), /importScripts\(['"]shared\.js['"]\)/);
  for (const html of [manifest.action.default_popup, manifest.options_page]) {
    const source = fs.readFileSync(path.join(dir, html), 'utf8');
    for (const match of source.matchAll(/(?:src|href)="([^"]+\.(?:js|css|png))"/g)) exists(match[1]);
  }
  for (const size of [16, 32, 48, 128]) {
    const file = manifest.icons[size];
    exists(file);
    const png = fs.readFileSync(path.join(dir, file));
    assert.equal(png.readUInt32BE(0), 0x89504e47); // PNG signature and matching dimensions
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});
