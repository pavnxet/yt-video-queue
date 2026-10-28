# YT Video Queue — browser extension

A self-contained Chrome Manifest V3 extension for your own [YT Video Queue](../README.md). It uses the same Worker and database as the website; there is no build or packaging step.

## Install unpacked

1. Deploy the current website and Worker from this branch. Full playlist import and synchronization additionally require the optional **`YOUTUBE_API_KEY` Worker secret** and YouTube Data API v3; see the [main setup guide](../README.md). The key is never put in the extension.
2. Open `chrome://extensions` (or `edge://extensions` in Edge), enable **Developer mode**, and choose **Load unpacked**.
3. Select the repository's **`extension/` folder** — the folder containing `manifest.json`, not the repository root. Pin the extension if you want the toolbar button visible.
4. Open `https://pavnxet.github.io/yt-video-queue/` and sign in. The extension picks up that site's session and its configured API URL. **Reload any YouTube tabs that were already open** before installing or updating the extension.
5. Open a YouTube video or playlist and use the toolbar popup or the floating pill. `Alt+Q` saves the current video to your default series; if no default exists, the panel opens so you can pick one.

To connect manually, open the extension's **Settings**, enter the Worker URL and your existing session token, choose **Save**, and then **Test connection**. A token can be found in the queue site's browser storage as `ytq_token` after signing in; keep it private. The API URL must use HTTPS, except for localhost development. For a custom Worker host, Settings requests access to that one origin when you save.

The automatic handoff and **Open queue** links are intentionally scoped to the project URL above. For a fork at a different site, either use manual settings or update the queue-site match/host in `manifest.json`, the trusted origin/path check in `background.js`, the config path in `content-site.js`, and the `SITE_URL` constants in the popup, options and YouTube scripts. Keep the trusted match specific to your own site.

## Features

- **Save without leaving YouTube:** choose or create a series in the floating panel or toolbar popup. Drag or hide the pill; use **Reset position** in the popup to restore the pill and panel.
- **See progress:** the selected series shows watched and remaining counts, completion, known total/remaining time and duration coverage. Estimated watch time includes saved positions and excludes unknown durations, just like the website.
- **Import a full playlist:** on a YouTube playlist or playlist video, choose **Import full playlist** in the panel or **Import playlist as a series** in the popup. This creates a new linked series and fetches the complete playlist through your Worker, not just the items YouTube has rendered. The popup also lets you set a title and opt out of auto-sync.
- **Refresh and restore:** linked series expose **Refresh playlist**, **Restore removed**, and the auto-sync toggle. Refresh appends newly available videos and preserves your edits and watch state; it does not delete videos removed from the source playlist. Restore explicitly re-adds previously removed items that are still in the playlist, as unwatched. Automatic checks target roughly six-hour intervals, subject to the scheduler and backlog.
- **Save visible videos:** the separate **Save N visible** panel action adds only rendered playlist items to the selected existing series, in batches of 20. Existing and repeated video IDs are skipped. If a later batch fails, the message reports what was already saved; unlike full playlist import, this action is not atomic or linked.
- **Track playback:** already-queued videos offer **Resume**, **Save position**, and **Mark watched / unwatched**. Saving a video captures its available duration without overwriting a known or manually edited length; the **Remember where you stopped** preference controls recording position when adding. The explicit **Save position** action is available regardless of that preference.
- **Find videos quickly:** the current Worker provides an authenticated, indexed lookup. The extension falls back to scanning your series on older Workers; playlist features require the updated Worker.
- **Other shortcuts:** right-click a YouTube page or video link to save it. The panel also previews the next unwatched videos in the selected series.

Full imports support public and unlisted playlists of up to **500 entries**, including unavailable and duplicate entries. Private or inaccessible playlists cannot be imported. The Worker reports unavailable videos and missing API-key or quota errors. Video durations can remain unknown if YouTube does not supply them.

## Privacy and permissions

The session token is stored in `chrome.storage.local` and sent in an Authorization header to your configured Worker. The Worker stores only a hash of the session token. The queue-site content script reads the token and its own `config.js`; the YouTube page itself does not receive the token. A site-sourced token is cleared when logout is observed or the session expires; a manually configured token is not cleared merely because the site is signed out. The extension never asks for your passkey or password.

| Permission / host | Purpose |
| --- | --- |
| `storage` | Save the session, selected series and preferences locally |
| `contextMenus` | Right-click save actions |
| `activeTab` | Read the current tab for the popup and `Alt+Q` |
| `*://*.youtube.com/*` | Show the floating panel and read video metadata |
| `https://pavnxet.github.io/*` | Read the session and config from the configured queue site |
| `https://*.workers.dev/*` | Send authenticated requests to a default Worker deployment |
| Optional host access | Request a specific custom API origin only when configured in Settings |

The popup can load YouTube thumbnails, and the site content script fetches the queue site's config. There is no extension analytics or remotely loaded extension code.

## Development and tests

`shared.js` contains dependency-free URL and progress helpers shared by the service worker, popup and YouTube content script. The service worker performs authenticated API requests; `content-site.js` handles the scoped site handoff, and `content-youtube.js` renders the shadow-DOM panel.

```bash
cd api
npm ci
npm run typecheck
npm test
```

This runs the manifest/resource checks, mocked service-worker and site-handoff tests, analytics parity tests, and Worker tests. For an optional Chromium UI smoke test with mocked Chrome APIs and API data:

```bash
npm --prefix api install --no-save --package-lock=false playwright-core
CHROME_PATH=/path/to/chromium node tests/extension-ui.smoke.cjs
```

The smoke test exercises the popup and YouTube panel but does not replace loading the extension unpacked in Chrome and checking it against your deployed Worker.
