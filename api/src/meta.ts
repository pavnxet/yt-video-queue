// meta.ts — turn any pasted link into something we can store and show.
//
// YouTube links keep their id (the IFrame player needs it). Telegram post links
// are embeddable. Everything else is stored as a plain web link and opened in a
// new tab, because most sites refuse to be framed.
//
// When a page's title cannot be read — network error, timeout, no <title>, a
// non-HTML response, a bot wall — we never leave the row blank: we build a
// readable name from the URL itself and flag it as guessed, so the UI can show
// it was auto-named and the user can rename it.

import { parseYouTubeId } from './util';

export type SourceKind = 'youtube' | 'telegram' | 'web';

export interface LinkMeta {
  kind: SourceKind;
  url: string;
  youtubeId: string | null;
  title: string | null;
  imageUrl: string | null;
  siteName: string | null;
  embeddable: boolean;
  embedUrl: string | null;
  titleAuto: boolean;
}

const YT_HOSTS = /^(youtube\.com|m\.youtube\.com|music\.youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
const TG_HOSTS = /^(t\.me|telegram\.me|telegram\.dog)$/i;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Work out what a pasted token is. Returns null if it is not a link we accept. */
export function classify(input: string): { kind: SourceKind; url: string; youtubeId: string | null } | null {
  const s = String(input || '').trim();
  if (!s) return null;

  // a bare YouTube id
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) {
    return { kind: 'youtube', url: `https://www.youtube.com/watch?v=${s}`, youtubeId: s };
  }

  if (!/^https?:\/\//i.test(s)) return null;

  let host: string;
  try {
    host = new URL(s).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }

  if (YT_HOSTS.test(host)) {
    const id = parseYouTubeId(s);
    if (id) return { kind: 'youtube', url: `https://www.youtube.com/watch?v=${id}`, youtubeId: id };
    return null;
  }
  if (TG_HOSTS.test(host)) return { kind: 'telegram', url: s, youtubeId: null };
  return { kind: 'web', url: s, youtubeId: null };
}

export async function fetchMeta(input: string): Promise<LinkMeta | null> {
  const c = classify(input);
  if (!c) return null;

  if (c.kind === 'youtube') {
    const id = c.youtubeId as string;
    return {
      kind: 'youtube',
      url: c.url,
      youtubeId: id,
      title: await youTubeTitle(id),
      imageUrl: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      siteName: 'YouTube',
      embeddable: true,
      embedUrl: null,
      titleAuto: false,
    };
  }

  let title: string | null = null;
  let image: string | null = null;
  let site: string | null = null;

  const html = await fetchHtml(c.url);
  if (html) {
    title = metaContent(html, 'og:title') || metaContent(html, 'twitter:title') || titleTag(html);
    image = metaContent(html, 'og:image') || metaContent(html, 'twitter:image');
    site = metaContent(html, 'og:site_name');
  }

  const cleanTitle = cleanText(title);
  const derived = deriveName(c.url);
  const telegram = c.kind === 'telegram';
  // t.me/c/… are private-channel posts, which Telegram refuses to embed (it
  // answers "Channel with username @c not found"). Send those to the app.
  const canEmbed = telegram && !isPrivateTelegram(c.url);

  return {
    kind: c.kind,
    url: c.url,
    youtubeId: null,
    title: cleanTitle || derived,
    imageUrl: image,
    siteName: cleanText(site) || hostOf(c.url),
    embeddable: canEmbed,
    embedUrl: canEmbed ? withEmbed(c.url) : null,
    titleAuto: !cleanTitle,
  };
}

// --------------------------------------------------------------------- fetch

async function fetchHtml(url: string): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en,*;q=0.5' },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(ct)) return null;
    const text = await res.text();
    return text.slice(0, 300_000);
  } catch {
    return null; // network error, timeout, blocked — caller falls back to a derived name
  } finally {
    clearTimeout(timer);
  }
}

async function youTubeTitle(id: string): Promise<string | null> {
  try {
    const url =
      'https://www.youtube.com/oembed?url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + id) +
      '&format=json';
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const j: any = await res.json();
    return typeof j.title === 'string' ? j.title : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- html parse

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function metaContent(html: string, key: string): string | null {
  const re = new RegExp(`<meta[^>]*(?:property|name)\\s*=\\s*["']${escapeRe(key)}["'][^>]*>`, 'i');
  const tag = html.match(re);
  if (!tag) return null;
  const m = tag[0].match(/content\s*=\s*["']([^"']*)["']/i);
  return m ? decodeEntities(m[1]) : null;
}

function titleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].replace(/\s+/g, ' ').trim()) : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

// ---------------------------------------------------------------- fallbacks

function cleanText(s: string | null): string | null {
  if (!s) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 300) : null;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * A readable name built from the URL alone, used when the page can't be read:
 *   https://t.me/SomeChannel/123      -> "t.me · SomeChannel 123"
 *   https://example.com/my-cool-post  -> "example.com · my cool post"
 *   https://example.com/              -> "example.com"
 */
export function deriveName(url: string): string {
  const host = hostOf(url) || 'link';
  let seg = '';
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    seg = parts.length ? parts[parts.length - 1] : '';
  } catch {
    /* ignore */
  }
  let pretty = '';
  try {
    pretty = decodeURIComponent(seg);
  } catch {
    pretty = seg;
  }
  pretty = pretty.replace(/\.(html?|php|aspx?|jsp)$/i, '').replace(/[-_+]+/g, ' ').trim();
  if (pretty.length > 60) pretty = pretty.slice(0, 60) + '…';
  if (/^\d+$/.test(pretty)) pretty = 'post ' + pretty;
  return pretty ? `${host} · ${pretty}` : host;
}

// Posts from private channels (/c/…) and invite links (/+…, /joinchat/…) are not
// embeddable — Telegram answers them with an error instead of a post.
function isPrivateTelegram(url: string): boolean {
  try {
    const p = new URL(url).pathname;
    return /^\/c\//.test(p) || /^\/joinchat\//i.test(p) || /^\/\+/.test(p);
  } catch {
    return false;
  }
}

function withEmbed(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set('embed', '1');
    return u.toString();
  } catch {
    return url;
  }
}
