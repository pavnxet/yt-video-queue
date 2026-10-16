// Focused test: pull the three routing helpers straight out of app.js and
// exercise them, so the URL format is verified rather than assumed.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');

function grab(startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i === -1) throw new Error('marker not found: ' + startMarker);
  const j = src.indexOf(endMarker, i);
  if (j === -1) throw new Error('end not found after: ' + startMarker);
  return src.slice(i, j + endMarker.length);
}

const code = [
  grab('function seriesHash(', '}\n'),
  grab('function videoHash(', '}\n'),
  grab('function parseHash()', '\n}\n'),
].join('\n');

const sandbox = { location: { hash: '' }, encodeURIComponent, decodeURIComponent };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}

function parse(hash) {
  sandbox.location.hash = hash;
  return vm.runInContext('parseHash()', sandbox);
}

check('empty hash -> home', parse(''), { seriesId: null, videoId: null });
check('#/ -> home', parse('#/'), { seriesId: null, videoId: null });
check('unknown route -> home', parse('#/nonsense'), { seriesId: null, videoId: null });
check('series route', parse('#/s/abc123'), { seriesId: 'abc123', videoId: null });
check('video route', parse('#/s/abc123/v/vid9'), { seriesId: 'abc123', videoId: 'vid9' });
check('trailing slash tolerated', parse('#/s/abc123/'), { seriesId: 'abc123', videoId: null });
check('missing video id -> series only', parse('#/s/abc123/v'), { seriesId: 'abc123', videoId: null });

check('seriesHash encodes', vm.runInContext("seriesHash('a b/c')", sandbox), '#/s/a%20b%2Fc');
check('videoHash encodes', vm.runInContext("videoHash('s 1','v 2')", sandbox), '#/s/s%201/v/v%202');
check('round trip series', parse(vm.runInContext("seriesHash('id-123')", sandbox)).seriesId, 'id-123');
check('round trip video', parse(vm.runInContext("videoHash('id-123','vid-9')", sandbox)).videoId, 'vid-9');
check('round trip with spaces', parse(vm.runInContext("seriesHash('My Series')", sandbox)).seriesId, 'My Series');

// The integration points must be wired, not just defined.
const wired = [
  ["applyRoute on hashchange", "window.addEventListener('hashchange', () => { applyRoute()"],
  ["enterApp calls applyRoute", 'applyRoute().catch((e) => toast'],
  ["Open button routes", 'open.onclick = () => goToSeries(s.id);'],
  ["back-to-dash routes home", "goHome();"],
  ["back-to-series routes", 'if (state.currentSeries) goToSeries(state.currentSeries.id);'],
  ["player routes", "const target = videoHash(state.currentSeries.id, videoId);"],
  ["delete clears dead link", 'goHome();'],
  ["copy link uses seriesHash", 'location.pathname + seriesHash(state.currentSeries.id)'],
];
for (const [name, needle] of wired) check('wired: ' + name, src.includes(needle), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
