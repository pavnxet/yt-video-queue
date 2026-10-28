import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { calculateSeriesAnalytics, formatDuration } from '../frontend/analytics.mjs';

const require = createRequire(import.meta.url);
const shared = require('../extension/shared.js');

test('extension accepts YouTube video and playlist links but rejects spoofed hosts', () => {
  const id = 'abcdefghijk', list = 'PL1234567890';
  for (const url of [id, `https://youtu.be/${id}?t=3`, `https://www.youtube.com/watch?v=${id}`, `https://m.youtube.com/shorts/${id}`, `https://www.youtube-nocookie.com/embed/${id}`]) {
    assert.equal(shared.videoIdFrom(url), id, url);
  }
  for (const url of [`https://youtube.com.evil.test/watch?v=${id}`, `https://evil.test/?v=${id}`, 'javascript:alert(1)', 'not-video']) {
    assert.equal(shared.videoIdFrom(url), '', url);
  }
  for (const url of [list, `youtube.com/playlist?list=${list}`, `https://www.youtube.com/watch?v=${id}&list=${list}`, `https://youtu.be/${id}?list=${list}`]) {
    assert.equal(shared.playlistUrl(url), `https://www.youtube.com/playlist?list=${list}`, url);
  }
  for (const url of [`https://youtube.com.evil.test/playlist?list=${list}`, `https://evil.test/?list=${list}`, 'javascript:alert(1)', 'https://www.youtube.com/watch?v=abcdefghijk']) {
    assert.equal(shared.playlistIdFrom(url), '', url);
  }
});

test('extension progress and time estimates match website analytics', () => {
  const cases = [
    [],
    [
      { status: 'done', durationSeconds: 120, resumeSeconds: 1 },
      { status: 'watching', durationSeconds: 600, resumeSeconds: 75 },
      { status: 'todo', durationSeconds: 200, resumeSeconds: 1000 },
      { status: 'watching', durationSeconds: 50, resumeSeconds: -20 },
      { status: 'done', durationSeconds: null },
      { status: 'todo', durationSeconds: 0 },
      { status: 'todo', durationSeconds: 'not-a-number' },
    ],
  ];
  for (const videos of cases) {
    const a = calculateSeriesAnalytics(videos), b = shared.seriesStats(videos);
    for (const key of ['total', 'watched', 'remaining', 'inProgress', 'totalSeconds', 'watchedSeconds', 'remainingSeconds']) assert.equal(b[key], a[key], key);
    assert.equal(b.percent, a.completionPercent);
    assert.equal(b.known, a.knownDurations);
    assert.equal(b.unknown, a.unknownDurations);
  }
  for (const seconds of [-1, 0, 1, 59, 60, 3601, 31536000]) assert.equal(shared.formatDuration(seconds), formatDuration(seconds));
});
