// Pure helpers for series progress and duration editing. Unknown durations are
// deliberately excluded from time estimates instead of being counted as zero.
export const MAX_DURATION_SECONDS = 31_536_000;

export function calculateSeriesAnalytics(videos) {
  const result = {
    total: videos.length,
    watched: 0,
    inProgress: 0,
    remaining: 0,
    completionPercent: 0,
    knownDurations: 0,
    unknownDurations: 0,
    missingYouTubeDurations: 0,
    totalSeconds: 0,
    watchedSeconds: 0,
    remainingSeconds: 0,
    averageSeconds: 0,
    longest: null,
    sources: { youtube: 0, telegram: 0, other: 0 },
  };
  for (const video of videos) {
    if (video.status === 'done') result.watched++;
    else {
      result.remaining++;
      if (video.status === 'watching') result.inProgress++;
    }
    if (video.source === 'youtube' || (!video.source && video.youtubeId)) result.sources.youtube++;
    else if (video.source === 'telegram') result.sources.telegram++;
    else result.sources.other++;

    const duration = Number(video.durationSeconds);
    if (video.durationSeconds == null || !Number.isFinite(duration) || duration <= 0) {
      result.unknownDurations++;
      if (video.youtubeId) result.missingYouTubeDurations++;
      continue;
    }
    result.knownDurations++;
    result.totalSeconds += duration;
    const resume = Number(video.resumeSeconds);
    const progress = video.status === 'done' ? duration
      : Math.min(duration, Math.max(0, Number.isFinite(resume) ? resume : 0));
    result.watchedSeconds += progress;
    result.remainingSeconds += duration - progress;
    if (!result.longest || duration > result.longest.durationSeconds) {
      result.longest = { title: video.title || video.youtubeId || video.url || 'Untitled', durationSeconds: duration };
    }
  }
  result.completionPercent = result.total ? Math.round(result.watched / result.total * 100) : 0;
  result.averageSeconds = result.knownDurations ? Math.round(result.totalSeconds / result.knownDurations) : 0;
  return result;
}

export function formatDuration(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (rest || !parts.length) parts.push(`${rest}s`);
  return parts.join(' ');
}

// Empty means clear the value; NaN means invalid. Accept seconds, M:SS or H:MM:SS.
export function parseDuration(input) {
  const value = String(input || '').trim();
  if (!value) return null;
  if (!/^\d+(?::\d{1,2}){0,2}$/.test(value)) return NaN;
  const parts = value.split(':').map(Number);
  if (parts.slice(1).some((part) => part >= 60)) return NaN;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= MAX_DURATION_SECONDS ? seconds : NaN;
}

export function durationInputValue(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
