# KOJAN Studio

Private encrypted WebRTC podcast studio for the Kojan Podcast.

## Files

```
index.html   — markup and structure
style.css    — all visual styling
studio.js    — all WebRTC logic, recording, peer management
```

## Deploying to GitHub Pages (multi-file setup)

When your project has multiple files instead of a single `index.html`, GitHub Pages still works exactly the same way — it just needs all files to live together in the same repo (or folder you're publishing from).

### Option A: Root of the repo (simplest)

1. Create a repo (e.g. `kojan-studio`) or use your existing one.
2. Place `index.html`, `style.css`, and `studio.js` at the **root** of the repo — same folder, no subfolders.
3. Go to **Settings → Pages**.
4. Under "Build and deployment", set Source to **Deploy from a branch**, select `main`, and set folder to `/ (root)`.
5. Save. GitHub will give you a URL like `https://yourusername.github.io/kojan-studio/`.

That's it. Because `index.html` links to `style.css` and `studio.js` with relative paths (no `/` prefix, no domain), they resolve correctly on any subdomain or path GitHub Pages uses.

### Option B: `/docs` folder

If your repo has other code you don't want to publish:

1. Create a `/docs` folder and put all three files inside it.
2. In **Settings → Pages**, set folder to `/docs` instead of root.
3. Everything else is identical.

### Option C: Separate branch (`gh-pages`)

1. Create a branch called `gh-pages`.
2. On that branch, put only the three studio files at the root.
3. In Settings → Pages, set source branch to `gh-pages` and folder to root.

---

## Key changes from v1

### 1. Stream freeze fix (30–40 min)
The freeze was caused by DTLS rekeying and SRTP counter rollover — a known WebRTC bug where the media pipeline silently stalls after 20–40 minutes of continuous connection. Fixed by scheduling a lightweight ICE renegotiation every 25 minutes per connection, invisible to participants.

### 2. Connection stability
- Peer reconnects to the PeerJS signalling server automatically if it drops.
- ICE restart triggers within 4 seconds of `disconnected` state, before the full `failed` state.
- Each connection has its own independent ICE monitor and timers.

### 3. Multi-participant (up to 4)
After unlocking host controls, you can now set how many participants can join (2–4, including you). The gallery grid adjusts automatically. Connect each guest by pasting their ID one at a time.

### 4. MP4 export
- On Chrome/Edge 94+ the studio attempts to re-encode recordings as MP4 using the WebCodecs API.
- On Safari and Firefox, recordings save as `.webm`. Convert offline using:
  ```
  ffmpeg -i Kojan_Host.webm -c:v libx264 -c:a aac Kojan_Host.mp4
  ```
  Or use Handbrake (free, GUI).

### 5. Code is now split into 3 files
Easier to maintain. No functional change to how the page loads or runs.
