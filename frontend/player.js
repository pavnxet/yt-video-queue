// player.js — thin wrapper around the YouTube IFrame Player API.
// Detects completion (state ENDED) and reports playback progress.
// The YouTube script itself is loaded lazily, only when a video is played.

let apiPromise = null;

/** Inject the YouTube IFrame API script the first time a video is played. */
function injectYouTubeApi() {
  if (document.querySelector('script[data-yt-api]')) return;
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  s.async = true;
  s.dataset.ytApi = '1';
  document.head.appendChild(s);
}

/** Resolve once window.YT is available. */
export function loadYouTubeApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === 'function') prev();
      resolve(window.YT);
    };
    injectYouTubeApi();
    // never hang forever if the player script fails to load
    setTimeout(() => {
      if (!(window.YT && window.YT.Player)) reject(new Error('YouTube player failed to load'));
    }, 12000);
  }).catch((e) => {
    apiPromise = null; // allow a retry on the next attempt
    throw e;
  });
  return apiPromise;
}

export class QueuePlayer {
  /**
   * @param {object} opts
   * @param {string} opts.elementId   id of the <div> to replace with the iframe
   * @param {object} opts.handlers    { onEnded(videoId, duration), onProgress(seconds, ended, duration, videoId), onError }
   */
  constructor({ elementId, handlers = {} }) {
    this.elementId = elementId;
    this.handlers = handlers;
    this.player = null;
    this.YT = null;
    this.current = null;
    this._timer = null;
  }

  async ready() {
    this.YT = await loadYouTubeApi();
    if (this.player) return;
    await new Promise((resolve) => {
      this.player = new this.YT.Player(this.elementId, {
        width: '100%',
        height: '100%',
        playerVars: {
          enablejsapi: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: () => resolve(),
          onStateChange: (e) => this._onState(e),
          onError: (e) => this.handlers.onError && this.handlers.onError(e),
        },
      });
    });
  }

  /** Load a video object { youtubeId, resumeSeconds } and start playing. */
  async load(video) {
    await this.ready();
    this.current = video;
    const start = Math.max(0, Math.floor(video.resumeSeconds || 0));
    this.player.loadVideoById({ videoId: video.youtubeId, startSeconds: start });
  }

  _onState(e) {
    const YT = this.YT;
    if (e.data === YT.PlayerState.PLAYING) {
      this._startTimer();
    } else {
      this._stopTimer();
      if (e.data === YT.PlayerState.PAUSED) this._save(false);
      if (e.data === YT.PlayerState.ENDED) {
        this._save(true);
        this.handlers.onEnded && this.handlers.onEnded(this.current?.id || null, this.getDuration());
      }
    }
  }

  _startTimer() {
    this._stopTimer();
    this._timer = setInterval(() => this._save(false), 5000);
  }

  _stopTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _save(ended) {
    if (!this.player || typeof this.player.getCurrentTime !== 'function') return;
    let t = 0;
    try {
      t = Math.floor(this.player.getCurrentTime() || 0);
    } catch {
      return;
    }
    this.handlers.onProgress && this.handlers.onProgress(t, !!ended, this.getDuration(), this.current?.id || null);
  }

  getDuration() {
    try {
      return Math.floor(this.player.getDuration() || 0);
    } catch {
      return 0;
    }
  }

  play() {
    try {
      this.player.playVideo();
    } catch {}
  }

  pause() {
    try {
      this.player.pauseVideo();
    } catch {}
  }
}
