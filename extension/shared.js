// Small, dependency-free helpers shared by the unpacked extension's pages,
// YouTube content script and service worker. Keep estimates in step with the
// website: unknown lengths are excluded and resume positions are clamped.
(function (root) {
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,100}$/;
  const HOSTS = new Set([
    'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
    'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be',
  ]);

  function youtubeUrl(input) {
    try {
      const url = new URL(String(input || '').trim());
      return ['https:', 'http:'].includes(url.protocol) && HOSTS.has(url.hostname.toLowerCase()) ? url : null;
    } catch { return null; }
  }

  function videoIdFrom(input) {
    const raw = String(input || '').trim();
    if (VIDEO_ID.test(raw)) return raw;
    const url = youtubeUrl(raw);
    if (!url) return '';
    let id = '';
    if (url.hostname.toLowerCase() === 'youtu.be') id = url.pathname.split('/')[1] || '';
    else {
      id = url.searchParams.get('v') || '';
      if (!id) id = (url.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/) || [])[1] || '';
    }
    return VIDEO_ID.test(id) ? id : '';
  }

  function playlistIdFrom(input) {
    const raw = String(input || '').trim();
    if (PLAYLIST_ID.test(raw)) return raw;
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/\//, '')}`;
    const url = youtubeUrl(candidate);
    const id = url ? url.searchParams.get('list') || '' : '';
    return PLAYLIST_ID.test(id) ? id : '';
  }

  function playlistUrl(input) {
    const id = playlistIdFrom(input);
    return id ? 'https://www.youtube.com/playlist?list=' + encodeURIComponent(id) : '';
  }

  function seriesStats(videos) {
    const stats = {
      total: videos.length, watched: 0, remaining: 0, inProgress: 0, percent: 0,
      known: 0, unknown: 0, totalSeconds: 0, watchedSeconds: 0, remainingSeconds: 0,
    };
    for (const video of videos) {
      if (video.status === 'done') stats.watched++;
      else {
        stats.remaining++;
        if (video.status === 'watching') stats.inProgress++;
      }
      const duration = Number(video.durationSeconds);
      if (video.durationSeconds == null || !Number.isFinite(duration) || duration <= 0) {
        stats.unknown++;
        continue;
      }
      stats.known++;
      stats.totalSeconds += duration;
      const resume = Number(video.resumeSeconds);
      const watched = video.status === 'done' ? duration
        : Math.min(duration, Math.max(0, Number.isFinite(resume) ? resume : 0));
      stats.watchedSeconds += watched;
      stats.remainingSeconds += duration - watched;
    }
    stats.percent = stats.total ? Math.round(stats.watched / stats.total * 100) : 0;
    return stats;
  }

  function formatDuration(value) {
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

  const helpers = { videoIdFrom, playlistIdFrom, playlistUrl, seriesStats, formatDuration };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  else root.YTQShared = helpers;
})(globalThis);
