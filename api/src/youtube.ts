// YouTube Data API helpers. The API key stays in the Worker; the only host we
// fetch here is Google's fixed API endpoint, never a URL supplied by a user.

// Ten playlist pages plus ten video-detail requests leave room for database
// and authentication subrequests on Cloudflare's free Worker plan.
export const MAX_PLAYLIST_ENTRIES = 500;
export const MAX_DURATION_SECONDS = 31_536_000; // one year
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,100}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be',
]);

export class YouTubeError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
    this.name = 'YouTubeError';
  }
}

export interface YouTubeVideo {
  id: string;
  title: string | null;
  durationSeconds: number | null;
}

export interface YouTubePlaylist {
  id: string;
  title: string;
  description: string | null;
  videos: YouTubeVideo[]; // unique, available videos in playlist order
  unavailable: number;
  duplicates: number;
}

/** Accept a playlist ID or a genuine YouTube URL containing a list parameter. */
export function parsePlaylistId(input: string): string | null {
  const value = String(input || '').trim();
  if (PLAYLIST_ID.test(value)) return value;
  try {
    // Copy/pasted links normally include a scheme, but a typed youtube.com/…
    // is also convenient. The hostname is still checked exactly below.
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value.replace(/^\/\//, '')}`;
    const url = new URL(candidate);
    if (!['https:', 'http:'].includes(url.protocol) || !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
    const id = url.searchParams.get('list') || '';
    return PLAYLIST_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Convert a YouTube ISO 8601 duration (including days) to seconds. */
export function parseYouTubeDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!m || !m.slice(1).some((part) => part !== undefined)) return null;
  const seconds = Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 +
    Number(m[3] || 0) * 60 + Number(m[4] || 0);
  // Live streams often report PT0S: that is unknown, not a zero-length video.
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= MAX_DURATION_SECONDS ? seconds : null;
}

export function requireYouTubeKey(key: string | undefined): string {
  if (!key || !key.trim()) {
    throw new YouTubeError('YouTube Data API key is not configured. Add YOUTUBE_API_KEY to the Worker secrets.', 503);
  }
  return key.trim();
}

async function youtubeGet(
  resource: string,
  params: Record<string, string>,
  key: string,
  fetcher: typeof fetch,
): Promise<any> {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + resource);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set('key', key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetcher(url.toString(), { signal: controller.signal });
    if (res.status === 403) {
      throw new YouTubeError('YouTube rejected the request. Check the API key, Data API access and quota.', 502);
    }
    if (res.status === 429) throw new YouTubeError('YouTube rate limit reached. Please try again later.', 502);
    if (!res.ok) throw new YouTubeError('Could not retrieve data from YouTube. Please try again later.', 502);
    const data: any = await res.json();
    if (!data || !Array.isArray(data.items)) throw new YouTubeError('YouTube returned an invalid response.', 502);
    return data;
  } catch (e) {
    if (e instanceof YouTubeError) throw e;
    // Do not include the URL or upstream error in logs/responses: it contains the key.
    throw new YouTubeError('Could not reach YouTube. Please try again later.', 502);
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch up to 50 video details per request; omitted/private IDs stay missing. */
export async function fetchYouTubeVideos(
  inputIds: string[],
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<Map<string, YouTubeVideo>> {
  const key = requireYouTubeKey(apiKey);
  const ids = [...new Set(inputIds.filter((id) => VIDEO_ID.test(id)))];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  const out = new Map<string, YouTubeVideo>();
  let next = 0;
  // Stay below the Worker's simultaneous-connection limit.
  await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      const allowed = new Set(chunk);
      const data = await youtubeGet('videos', {
        part: 'snippet,contentDetails', id: chunk.join(','), maxResults: '50',
      }, key, fetcher);
      for (const item of data.items) {
        if (typeof item?.id !== 'string' || !allowed.has(item.id)) continue;
        const title = typeof item.snippet?.title === 'string' ? item.snippet.title.trim().slice(0, 300) : '';
        out.set(item.id, {
          id: item.id,
          title: title || null,
          durationSeconds: parseYouTubeDuration(item.contentDetails?.duration),
        });
      }
    }
  }));
  return out;
}

/** Fetch the entire playlist before changing the database; never save partial pages. */
export async function fetchYouTubePlaylist(
  playlistId: string,
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<YouTubePlaylist> {
  const key = requireYouTubeKey(apiKey);
  if (!PLAYLIST_ID.test(playlistId)) throw new YouTubeError('Enter a valid YouTube playlist URL or ID.', 400);

  const info = await youtubeGet('playlists', { part: 'snippet', id: playlistId }, key, fetcher);
  const snippet = info.items[0]?.snippet;
  if (!snippet) {
    throw new YouTubeError('Playlist not found or inaccessible. Use a public or unlisted playlist.', 404);
  }
  const title = typeof snippet.title === 'string' ? snippet.title.trim().slice(0, 300) : '';
  const description = typeof snippet.description === 'string' ? snippet.description.trim().slice(0, 2000) : '';

  const ids: string[] = [];
  const seen = new Set<string>();
  let unavailable = 0;
  let duplicates = 0;
  let entries = 0;
  let pageToken = '';
  let pages = 0;
  do {
    if (++pages > Math.ceil(MAX_PLAYLIST_ENTRIES / 50)) {
      throw new YouTubeError(`Playlists with more than ${MAX_PLAYLIST_ENTRIES} entries are not supported.`, 400);
    }
    const params: Record<string, string> = {
      part: 'contentDetails', playlistId, maxResults: '50',
    };
    if (pageToken) params.pageToken = pageToken;
    const page = await youtubeGet('playlistItems', params, key, fetcher);
    for (const item of page.items) {
      if (++entries > MAX_PLAYLIST_ENTRIES) {
        throw new YouTubeError(`Playlists with more than ${MAX_PLAYLIST_ENTRIES} entries are not supported.`, 400);
      }
      const id = item?.contentDetails?.videoId;
      if (typeof id !== 'string' || !VIDEO_ID.test(id)) {
        unavailable++;
      } else if (seen.has(id)) {
        duplicates++;
      } else {
        seen.add(id);
        ids.push(id);
      }
    }
    pageToken = typeof page.nextPageToken === 'string' ? page.nextPageToken : '';
  } while (pageToken);

  const details = await fetchYouTubeVideos(ids, key, fetcher);
  const videos: YouTubeVideo[] = [];
  for (const id of ids) {
    const video = details.get(id);
    if (video) videos.push(video);
    else unavailable++;
  }
  return { id: playlistId, title: title || 'YouTube playlist', description: description || null, videos, unavailable, duplicates };
}
