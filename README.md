# NewTube

A YouTube client for legacy Samsung Smart TVs (2011–2015 Orsay OS, E/F/H series).

A modern rewrite of the abandoned [OldTube](https://github.com/arielscarpinelli/oldtube)
project.  The original tried to extract YouTube stream URLs in the TV's
browser, which broke the moment YouTube changed its `n`/`sig` challenge.
NewTube pushes all that work to a small Python server that uses `yt-dlp`
to handle YouTube's anti-bot machinery and (when needed) transcode VP9/AV1
to H.264 MP4 the TV can play natively.

```
   ┌──────────────────────┐        HTTP       ┌────────────────────────────┐
   │  TV (Orsay / 2012)   │ ────────────────► │  NewTube server            │
   │  - NewTube widget    │ ◄──────────────── │  - FastAPI + yt-dlp        │
   │  - <video> tag       │  H.264 MP4 stream │  - ffmpeg (only if needed) │
   └──────────────────────┘                   └────────────────────────────┘
```

## What's in the box

```
newtube/
├── server/        # Python FastAPI + yt-dlp proxy / transcoder
├── widget/        # React TV widget (Orsay app)
├── mobile/        # Phone web app (PWA, no install)
├── desktop/       # Windows GUI launcher (one-click)
├── deploy/        # render.yaml for free cloud deploy
├── scripts/       # build helpers
└── README.md      # you are here
```

## Quick start — three ways

### 🚀 Option A — Free cloud (recommended, zero cost)

Deploy the server to **Render.com free tier** — no PC, no electricity, 24/7.
PC and phone stay off.

1. Fork or upload this repo to your GitHub account.
2. Go to <https://render.com> → **New +** → **Blueprint** → pick the repo.
3. Render reads `deploy/render.yaml` and creates the service.
4. Wait ~3 min for the build, then copy the URL Render gives you
   (looks like `https://newtube-xxxx.onrender.com`).
5. On your TV: install the widget, open NewTube, go to **Settings** →
   **Set NewTube server URL**, paste the URL.  Done.

Free-tier caveat: the service sleeps after 15 min of inactivity and takes
~30 s to wake on the next request.  Fine for occasional viewing.  For
always-on, upgrade to the $7/mo plan.

### 🖥 Option B — Run on your PC (Windows 8 / 10 / 11)

1. Install **Python 3.9+** from <https://python.org/downloads> — tick
   *"Add Python to PATH"* during install.
2. Open the `desktop/` folder and double-click **`Run.bat`**.
3. A friendly window opens.  Click **▶ Sunucuyu Başlat**.  Wait for
   "Kurulum tamamlandı.  Sunucu çalışıyor."  The window shows your
   local IP and the install URL.
4. Follow the on-screen TV-install steps.

To turn the whole thing into a **single .exe**, run `desktop\build_exe.bat`
once on a Windows PC with Python installed.  The result is a ~30 MB
`dist\NewTube.exe` that works on any Windows machine without Python.

### 📱 Option C — Just use the phone

Open `mobile/index.html` in your phone's browser, then **Add to Home
Screen**.  You now have a YouTube client on your phone.  No server
needed for watching on the phone itself.

If you've also set up Option A or B, the same phone app can push videos
to the TV with the **"TV'de oynat"** button.

## Installing the widget on the TV

The widget is a regular Orsay user app.  It needs to be downloaded by the
TV's *User Application Synchronisation* feature, which fetches a
`widgetlist.xml` manifest from a server.  Easiest ways:

- **If using Option A (Render):** put `widgetlist.xml` and the
  `NewTube_*.zip` file on the same Render service (or a separate free
  static host like GitHub Pages or Netlify).  Then on the TV, log in as
  `develop` and point *Server IP* at the host.
- **If using Option B (PC):** Run the desktop launcher; the window
  shows the exact TV-install steps including the right IP to enter.

Detailed steps for the TV side are in the [desktop GUI's on-screen
instructions](desktop/NewTube.py) and at
<http://oldtube.is-local.org> (OldTube's docs, same procedure).

## Repo layout

| Path | What it is |
|------|------------|
| `server/app.py` | The FastAPI server, ~500 LOC.  Endpoints: `/`, `/api/version`, `/api/search`, `/api/resolve/{id}`, `/stream/{id}`, `/api/cast/{id}`, `/api/cast_queue`, `/install`, `/widgetlist.xml`, `/widget-install/*`. |
| `server/requirements.txt` | Python deps: `fastapi`, `uvicorn[standard]`, `yt-dlp`, `httpx`, `pydantic`. |
| `widget/src/` | React source for the TV widget.  Built with webpack 4.  Talks to the server over plain `XMLHttpRequest` for max compatibility with the Orsay browser. |
| `widget/dist/` | Pre-built `index.js` and `main.css` — committed so users can install without `npm install`. |
| `mobile/index.html` | The phone PWA.  Single file, no build.  Uses Invidious for search (no API key) and YouTube embed for playback. |
| `desktop/NewTube.py` | The tkinter GUI.  Auto-installs Python deps into a local venv and starts the server in a background thread. |
| `desktop/Run.bat` | Windows launcher.  Detects Python, opens download page if missing, then runs the GUI. |
| `deploy/render.yaml` | Render Blueprint for the free cloud deploy. |

## Development

```bash
# server
cd server
python3 -m pip install -r requirements.txt
NEWTUBE_PORT=8088 python3 app.py

# widget
cd widget
npm install
npm run build
npm run package  # creates dist/widgetlist.xml + dist/widget-install/*.zip

# mobile
cd mobile
python3 -m http.server 8080
# open http://localhost:8080 on your phone (same wifi)
```

## License

MIT.  See [LICENSE](LICENSE).

Based on the original [OldTube](https://github.com/arielscarpinelli/oldtube)
by Ariel Scarpinelli (also MIT).
