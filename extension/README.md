# YT Video Queue — Save (browser extension)

A small, **personal** Chrome extension that puts a “Save to queue” button on
YouTube and files the video straight into your own [YT Video Queue](../README.md).

It is built for one person — you — and it keeps everything on your machine:

- Your API URL and session token live in `chrome.storage.local`, never on a server.
- The only thing it talks to is **your own Worker**, which writes to **your own
  Turso database**.
- The token is picked up from your queue site (where you already signed in with a
  passkey); the extension never asks for your passkey and never sees your password
  (there isn’t one).

---

## What it does

**From YouTube, without leaving the page**

- A floating **“Save to queue”** pill in the bottom-right corner.
- **`Alt+Q`** saves the video you are watching.
- The pill opens a small panel with the thumbnail, title and channel, a **series
  picker**, a **create-series** box, and a **“Save all N videos in this
  playlist”** button when you are on a playlist page.

**From the toolbar**

- Click the icon for the popup: the current video, a series dropdown, your series
  with `done/total` counts, and one click to save.
- Right-click any link → **“Save link to YT Video Queue”**.
- Right-click a YouTube page → **“Save this video to YT Video Queue”**.

**Saving wisely**

- **Duplicate detection.** If the video is already in the chosen series it is
  reported, not added twice.
- **Remembers your series.** The last series you used becomes the default for
  one-click saves and `Alt+Q`.
- **Records duration and position.** When enabled, the row is updated with the
  video’s length and where you had got to, so the queue can resume.
- **Batch playlists.** A whole playlist is saved in batches of 20, the way the
  web app does it.

---

## Install (unpacked, personal use)

1. Open `chrome://extensions/` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this `extension/` folder.
3. Open your queue site (`https://pavnxet.github.io/yt-video-queue/`) and sign in
   once. The extension quietly picks up your session token and API URL.
   - If you would rather paste them by hand, open the extension’s **Settings**
     (right-click the toolbar icon → Options) and fill in the API base URL and
     token, then press **Test connection**.
4. Open any YouTube video. Use the pill, the popup, or `Alt+Q`.

> If your Worker runs on a custom domain rather than `*.workers.dev`, the first
> **Save** in Settings asks for permission for that one origin. That is the
> narrowest grant the extension needs.

---

## Files

```
extension/
├─ manifest.json          MV3 manifest
├─ background.js          service worker — the only thing that calls your API
├─ content-youtube.js     floating pill + panel on YouTube (shadow DOM)
├─ content-site.js        reads your token + API URL from your queue site
├─ popup.html / popup.js  toolbar popup
├─ options.html / options.js   settings
├─ ui.css                 shared Claude-theme styling
└─ icons/                 16 / 32 / 48 / 128
```

### How the pieces talk

```
YouTube page ──content-youtube.js──▶ service worker ──▶ your Worker ──▶ Turso
queue site  ──content-site.js──────▶ (token + API URL)
popup / options ────────────────────▶ service worker
```

Only the **service worker** makes network calls, so the extension origin never
has to be added to the Worker’s CORS allow-list, and the token is used in exactly
one place.

---

## Permissions, and why

| Permission | Why it is needed |
| --- | --- |
| `storage` | Keep your API URL, token and preferences locally |
| `contextMenus` | The two right-click “Save …” items |
| `activeTab` | Read the current tab when you press `Alt+Q` |
| `*://*.youtube.com/*` | The floating button and the video metadata |
| `https://pavnxet.github.io/*` | Read your session token from your queue site |
| `https://*.workers.dev/*` | Talk to the default Worker deployment |
| `optional_host_permissions` | Only if you move the Worker to a custom domain |

No analytics, no third-party hosts, no remote code.

---

## Notes and limits

- **The repo is public, your queue is not.** GitHub Pages on a free account needs
  a public repo, so this code is public — but your *data* is protected by your
  passkey, and this extension only ever holds a session token for it.
- Sessions last 30 days. When one expires the extension says so and clears the
  token; sign in on the queue site again to reconnect.
- The extension records a resume position only when **Remember where you stopped**
  is on.
- Telegram and generic web links are not added from the extension yet — the web
  app handles those; the extension focuses on YouTube, which is where the button
  makes sense.

---

Made for one person. Made with 💖 by [pavnxet](https://github.com/pavnxet).
