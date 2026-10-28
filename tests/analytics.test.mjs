import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSeriesAnalytics, formatDuration, parseDuration, durationInputValue } from '../frontend/analytics.mjs';

test('series analytics include resume progress but exclude unknown durations', () => {
  const stats = calculateSeriesAnalytics([
    { title: 'Finished', source: 'youtube', youtubeId: 'aaaaaaaaaaa', status: 'done', durationSeconds: 300, resumeSeconds: 0 },
    { title: 'In progress', source: 'youtube', youtubeId: 'bbbbbbbbbbb', status: 'watching', durationSeconds: 120, resumeSeconds: 30 },
    { title: 'Unknown', source: 'telegram', status: 'todo', durationSeconds: null, resumeSeconds: 100 },
    { title: 'Watched unknown', source: 'web', status: 'done', durationSeconds: null },
  ]);
  assert.equal(stats.total, 4);
  assert.equal(stats.watched, 2);
  assert.equal(stats.remaining, 2);
  assert.equal(stats.inProgress, 1);
  assert.equal(stats.completionPercent, 50);
  assert.equal(stats.knownDurations, 2);
  assert.equal(stats.unknownDurations, 2);
  assert.equal(stats.totalSeconds, 420);
  assert.equal(stats.watchedSeconds, 330);
  assert.equal(stats.remainingSeconds, 90);
  assert.equal(stats.averageSeconds, 210);
  assert.equal(stats.longest.title, 'Finished');
  assert.deepEqual(stats.sources, { youtube: 2, telegram: 1, other: 1 });
});

test('empty series, missing values and over-long resume positions stay well-defined', () => {
  assert.equal(calculateSeriesAnalytics([]).completionPercent, 0);
  const stats = calculateSeriesAnalytics([
    { youtubeId: 'aaaaaaaaaaa', durationSeconds: 0, status: 'todo' },
    { youtubeId: 'bbbbbbbbbbb', durationSeconds: 60, resumeSeconds: 600, status: 'watching' },
    { youtubeId: 'ccccccccccc', durationSeconds: 20, resumeSeconds: -2, status: 'todo' },
  ]);
  assert.equal(stats.missingYouTubeDurations, 1);
  assert.equal(stats.watchedSeconds, 60);
  assert.equal(stats.remainingSeconds, 20);
  assert.equal(stats.completionPercent, 0);
});

test('duration editing accepts seconds and clock notation and rejects invalid values', () => {
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('90'), 90);
  assert.equal(parseDuration('1:30'), 90);
  assert.equal(parseDuration('2:03:04'), 7384);
  assert.ok(Number.isNaN(parseDuration('1:60')));
  assert.ok(Number.isNaN(parseDuration('0')));
  assert.ok(Number.isNaN(parseDuration('-30')));
  assert.ok(Number.isNaN(parseDuration('abc')));
  assert.ok(Number.isNaN(parseDuration('9999999999')));
  assert.equal(durationInputValue(7384), '2:03:04');
  assert.equal(durationInputValue(90), '1:30');
  assert.equal(durationInputValue(null), '');
  assert.equal(formatDuration(7384), '2h 3m 4s');
  assert.equal(formatDuration(0), '0s');
});
