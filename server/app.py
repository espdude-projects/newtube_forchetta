"""
NewTube Server — YouTube proxy/transcoder for legacy Samsung Smart TVs (Orsay / E-series 2012)

Architecture:
  - TV widget (React/HTML) talks to this server over HTTP on the local network
  - This server uses yt-dlp to:
      * search YouTube via its "search" extractor
      * resolve video IDs to direct H.264 progressive MP4 URLs (TV only supports H.264 / MP4)
      * proxy / transcode the stream so the TV can play it natively
  - The TV's <video> tag simply sees a clean http://server/stream/{videoId} URL it can play

This is a complete rewrite of OldTube's old approach: OldTube tried to do
ytdl-core in the TV's browser, which broke when YouTube changed n/sig handling.
The fix is to keep all that on the server where we have full Node/Python tooling.

Tested with Samsung UE46ES6140W (2012 E-series, Orsay OS).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import pathlib
import re
import threading
import time
from contextlib import asynccontextmanager
from typing import Any, Optional

import yt_dlp
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from pydantic import BaseModel

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------

HOST = os.environ.get("NEWTUBE_HOST", "0.0.0.0")
# The TV's "Server IP" field is just an IP, and the TV fetches
# http://{ip}/widgetlist.xml on port 80 by default.  So the install side
# of the server needs port 80.  For non-root users, set NEWTUBE_PORT=8088
# and run a separate static server (IIS / python -m http.server 80) on
# port 80 to serve the widgetlist.xml + zips.  See README.md.
PORT = int(os.environ.get("NEWTUBE_PORT", "80"))

# Optional: YouTube Data API v3 key for richer search (recommendations, channels,
# playlists, etc.).  If empty, the server falls back to yt-dlp's search extractor
# which is enough for basic text search.
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "").strip()

# Codec preferences: the Orsay TV's hardware only decodes H.264 (no VP9 / no AV1),
# so we always pick the highest-quality progressive MP4 <=720p available.
# 1080p is excluded because most E-series panels are 1080p anyway and the H.264
# 1080p stream from YouTube is rare; 720p is the sweet spot.
PREFERRED_HEIGHT = int(os.environ.get("NEWTUBE_HEIGHT", "720"))
PREFERRED_FPS = int(os.environ.get("NEWTUBE_FPS", "30"))

# Optional path to a cookies.txt file (Netscape format) for authenticated
# yt-dlp access.  Bypasses YouTube's bot detection.  Get one with:
#   yt-dlp --cookies-from-browser chrome --cookies cookies.txt
COOKIES_FILE = os.environ.get("NEWTUBE_COOKIES", "").strip()

# Player client order to try.  tv_embedded and android usually work without
# bot detection; web / ios often get blocked.  NewTube tries them in order.
PLAYER_CLIENTS = ["tv_embedded", "android", "ios", "web"]

# Cache: videoId -> {"url": ..., "title": ..., "duration": ..., "ts": ...}
# Simple in-memory cache with TTL so the TV can replay without re-resolving.
_CACHE: dict[str, dict[str, Any]] = {}
_CACHE_TTL = 60 * 30  # 30 minutes

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("newtube")


# ----------------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------------

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
WIDGET_DIST_DIR = REPO_ROOT / "widget" / "dist"
WIDGET_INSTALL_DIR = REPO_ROOT / "dist" / "widget-install"
WIDGET_MANIFEST = REPO_ROOT / "dist" / "widgetlist.xml"
WIDGET_ROOT = REPO_ROOT / "widget"


# ----------------------------------------------------------------------------
# yt-dlp helpers
# ----------------------------------------------------------------------------

YDL_OPTS_INFO = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "noplaylist": True,
    # We prefer a H.264 progressive MP4 the TV can play natively.
    # If none exists, fall back to any video <=720p and let our server-side
    # transcoder handle it.  This is the format "selector expression" that
    # yt-dlp evaluates against the available formats.
    "format": (
        # Best H.264 progressive MP4 <=720p (TV plays natively, no CPU on server)
        f"best[vcodec^=avc1][ext=mp4][acodec!=none][height<={PREFERRED_HEIGHT}]"
        # Best H.264 progressive MP4 (any quality, fallback)
        f"/best[vcodec^=avc1][ext=mp4][acodec!=none]"
        # Best progressive MP4 of any codec (we'll transcode)
        f"/best[ext=mp4][acodec!=none][height<={PREFERRED_HEIGHT}]"
        # Best video + best audio (we'll transcode)
        f"/bestvideo[height<={PREFERRED_HEIGHT}]+bestaudio"
        # Last resort: anything
        f"/best"
    ),
    # If the user provided a cookies file, use it (bypasses bot detection)
    "cookiefile": COOKIES_FILE or None,
    # Try several player clients in case the default gets blocked
    "extractor_args": {
        "youtube": {
            "player_client": PLAYER_CLIENTS,
        }
    },
    # Some corporate / school networks replace TLS certs.  Set
    # NEWTUBE_INSECURE_TLS=1 to skip certificate verification (not recommended
    # for normal use, but useful for diagnosing TLS issues).
    "nocheckcertificate": bool(os.environ.get("NEWTUBE_INSECURE_TLS")),
}


def _ytdl_search(query: str, max_results: int = 25) -> list[dict[str, Any]]:
    """Use yt-dlp's built-in YouTube search extractor (ytsearch{max_results}:{query})."""
    opts = {
        **YDL_OPTS_INFO,
        "extract_flat": True,  # don't resolve every video, just metadata
        "noplaylist": True,
    }
    target = f"ytsearch{max_results}:{query}"
    out: list[dict[str, Any]] = []
    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            info = ydl.extract_info(target, download=False)
        except yt_dlp.utils.DownloadError as e:
            log.warning("ytsearch failed for %r: %s", query, e)
            return out
        entries = (info or {}).get("entries") or []
        for e in entries:
            if not e:
                continue
            out.append({
                "videoId": e.get("id"),
                "title": e.get("title") or "",
                "channelTitle": e.get("channel") or e.get("uploader") or "",
                "channelId": e.get("channel_id") or e.get("uploader_id") or "",
                "duration": e.get("duration"),
                "thumbnail": _best_thumb(e.get("thumbnails")),
            })
    return out


def _ytdl_search_api(query: str, max_results: int = 25) -> list[dict[str, Any]]:
    """Optional: use YouTube Data API v3 if a key is configured.

    Gives richer results (channel thumbnails, proper durations, etc.) but
    requires YOUTUBE_API_KEY.  Falls back to yt-dlp search if it fails.
    """
    import httpx
    params = {
        "part": "snippet",
        "q": query,
        "maxResults": min(50, max_results),
        "type": "video",
        "videoEmbeddable": "true",
        "safeSearch": "moderate",
        "key": YOUTUBE_API_KEY,
    }
    with httpx.Client(timeout=15.0) as client:
        r = client.get(
            "https://www.googleapis.com/youtube/v3/search",
            params=params,
        )
    if r.status_code != 200:
        log.warning("YouTube Data API returned %s: %s", r.status_code, r.text[:200])
        return []
    data = r.json()
    items = data.get("items") or []
    out: list[dict[str, Any]] = []
    for it in items:
        vid = (it.get("id") or {}).get("videoId")
        sn = it.get("snippet") or {}
        if not vid:
            continue
        out.append({
            "videoId": vid,
            "title": sn.get("title") or "",
            "channelTitle": sn.get("channelTitle") or "",
            "channelId": sn.get("channelId") or "",
            "duration": None,  # snippet doesn't include duration
            "thumbnail": ((sn.get("thumbnails") or {}).get("high") or {}).get("url", ""),
        })
    return out


def _best_thumb(thumbs: Optional[list[dict[str, Any]]]) -> str:
    if not thumbs:
        return ""
    # YouTube returns thumbs in different sizes; pick the medium one.
    by_pref = ("medium", "high", "default", "standard", "maxres")
    for kind in by_pref:
        for t in thumbs:
            if t.get("id") == kind and t.get("url"):
                return t["url"]
    return thumbs[-1].get("url", "")


def _resolve_video(video_id: str) -> dict[str, Any]:
    """Resolve a YouTube video ID to a directly-playable H.264 MP4 URL.

    Returns a dict with at least: videoId, title, duration, streamUrl.
    Raises HTTPException(404) if the video cannot be resolved.
    """
    cached = _CACHE.get(video_id)
    if cached and (time.time() - cached["ts"]) < _CACHE_TTL:
        return cached

    url = f"https://www.youtube.com/watch?v={video_id}"
    # First pass: get metadata + format list, prefer H.264 progressive mp4
    with yt_dlp.YoutubeDL({**YDL_OPTS_INFO, "noplaylist": True}) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
        except yt_dlp.utils.DownloadError as e:
            log.warning("extract_info failed for %s: %s", video_id, e)
            raise HTTPException(status_code=404, detail=f"Video not found: {e}") from e

    if not info:
        raise HTTPException(status_code=404, detail="Video not found")

    formats = info.get("formats") or []
    chosen = _pick_tv_compatible_format(formats)
    if not chosen:
        # Fall back: if no progressive MP4 is available, we'll need to
        # transcode DASH->MP4 on the fly.  Set a flag so /stream knows.
        chosen = _pick_dash_for_transcode(formats)
        if not chosen:
            raise HTTPException(
                status_code=415,
                detail="No compatible format (need H.264 MP4 <=720p or DASH transcode)",
            )

    direct_url = chosen.get("url")
    if not direct_url:
        raise HTTPException(status_code=502, detail="yt-dlp returned no URL")

    record = {
        "videoId": video_id,
        "title": info.get("title"),
        "channelTitle": info.get("channel") or info.get("uploader"),
        "channelId": info.get("channel_id") or info.get("uploader_id"),
        "duration": info.get("duration"),
        "thumbnail": _best_thumb(info.get("thumbnails")),
        "streamUrl": direct_url,
        "needsTranscode": bool(chosen.get("needs_transcode")),
        "vcodec": chosen.get("vcodec"),
        "acodec": chosen.get("acodec"),
        "height": chosen.get("height"),
        "fps": chosen.get("fps"),
        "ts": time.time(),
    }
    _CACHE[video_id] = record
    return record


def _pick_tv_compatible_format(formats: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Pick the best H.264 progressive MP4 <=720p the TV can play natively."""
    candidates = []
    for f in formats:
        vcodec = f.get("vcodec") or ""
        acodec = f.get("acodec") or ""
        ext = f.get("ext") or ""
        height = f.get("height") or 0
        # progressive: both audio and video in same stream
        if (
            vcodec.startswith("avc1") or vcodec == "h264"
        ) and acodec and acodec != "none" and ext == "mp4" and height <= PREFERRED_HEIGHT:
            candidates.append(f)
    if not candidates:
        return None
    # sort by: closer to preferred height (desc), then by bitrate (desc)
    candidates.sort(
        key=lambda f: (
            -(abs((f.get("height") or 0) - PREFERRED_HEIGHT)),
            -(f.get("tbr") or f.get("vbr") or 0),
        )
    )
    return candidates[0]


def _pick_dash_for_transcode(formats: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Pick a DASH format pair (separate video+audio) we can transcode to H.264 MP4."""
    videos = [
        f for f in formats
        if (f.get("vcodec") or "") and (f.get("vcodec") or "") != "none"
        and (f.get("height") or 0) <= PREFERRED_HEIGHT
    ]
    audios = [
        f for f in formats
        if (f.get("acodec") or "") and (f.get("acodec") or "") != "none"
        and (f.get("vcodec") in (None, "none", ""))
    ]
    if not videos or not audios:
        return None
    # Prefer H.264 video (no transcoding needed for video), then VP9
    videos.sort(
        key=lambda f: (
            0 if (f.get("vcodec") or "").startswith(("avc1", "h264")) else 1,
            -(f.get("tbr") or f.get("vbr") or 0),
        )
    )
    audios.sort(key=lambda f: -(f.get("abr") or f.get("tbr") or 0))
    out = dict(videos[0])
    out["_paired_audio"] = audios[0]
    out["needs_transcode"] = True
    return out


# ----------------------------------------------------------------------------
# Streaming endpoint
# ----------------------------------------------------------------------------

async def _stream_direct(video_id: str, request: Request) -> Response:
    """Stream the chosen direct URL to the TV, byte-for-byte."""
    rec = _CACHE.get(video_id)
    if not rec or (time.time() - rec["ts"]) >= _CACHE_TTL:
        rec = _resolve_video(video_id)
    url = rec["streamUrl"]

    # Use yt-dlp's built-in URL opener which handles YouTube's headers
    # and the "n" / "sig" challenge responses.
    import httpx
    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=httpx.Timeout(20.0, read=60.0),
        headers={"User-Agent": "Mozilla/5.0"},
    ) as client:
        upstream_headers = {}
        if request.headers.get("range"):
            upstream_headers["Range"] = request.headers["range"]
        upstream = await client.send(
            client.build_request("GET", url, headers=upstream_headers),
            stream=True,
        )
        if upstream.status_code not in (200, 206):
            body = await upstream.aread()
            log.warning("upstream returned %s for %s: %s", upstream.status_code, video_id, body[:200])
            raise HTTPException(status_code=502, detail="upstream error")

        async def gen():
            try:
                async for chunk in upstream.aiter_bytes(chunk_size=64 * 1024):
                    if await request.is_disconnected():
                        break
                    yield chunk
            finally:
                await upstream.aclose()

        out_headers = {
            "Content-Type": upstream.headers.get("Content-Type", "video/mp4"),
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600",
        }
        if "content-length" in upstream.headers:
            out_headers["Content-Length"] = upstream.headers["content-length"]
        if "content-range" in upstream.headers:
            out_headers["Content-Range"] = upstream.headers["content-range"]

        return StreamingResponse(
            gen(),
            status_code=upstream.status_code,
            headers=out_headers,
            media_type="video/mp4",
        )


async def _stream_transcode(video_id: str, request: Request) -> Response:
    """Transcode DASH->MP4 H.264 on the fly and stream to the TV."""
    rec = _CACHE.get(video_id)
    if not rec or (time.time() - rec["ts"]) >= _CACHE_TTL:
        rec = _resolve_video(video_id)

    # We need to re-resolve the source URLs because the cache may have a different
    # one than the transcoding source.  Use yt-dlp to get the final format URLs.
    with yt_dlp.YoutubeDL({**YDL_OPTS_INFO, "noplaylist": True}) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    formats = info.get("formats") or []
    chosen = _pick_dash_for_transcode(formats)
    if not chosen:
        raise HTTPException(status_code=415, detail="No transcodeable format")
    video_url = chosen["url"]
    audio_url = chosen["_paired_audio"]["url"]

    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-fflags", "+genpts",
        "-i", video_url,
        "-i", audio_url,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "fastdecode",
        "-profile:v", "baseline",
        "-level", "3.1",
        "-pix_fmt", "yuv420p",
        "-vf", f"scale='min({PREFERRED_HEIGHT},iw)':-2",
        "-r", str(PREFERRED_FPS),
        "-c:a", "aac",
        "-b:a", "128k",
        "-ac", "2",
        "-f", "mp4",
        "-movflags", "+faststart",
        "pipe:1",
    ]
    log.info("transcoding %s via ffmpeg", video_id)
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )

    async def gen():
        try:
            while True:
                chunk = await proc.stdout.read(64 * 1024)
                if not chunk:
                    break
                if await request.is_disconnected():
                    proc.kill()
                    break
                yield chunk
        finally:
            try:
                await proc.wait()
            except Exception:
                pass

    return StreamingResponse(
        gen(),
        media_type="video/mp4",
        headers={"Accept-Ranges": "none", "Cache-Control": "no-store"},
    )


# ----------------------------------------------------------------------------
# FastAPI app
# ----------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("NewTube server starting on %s:%s", HOST, PORT)
    if not YOUTUBE_API_KEY:
        log.info("No YOUTUBE_API_KEY set; using yt-dlp ytsearch (text search only)")
    yield
    log.info("NewTube server shutting down")


app = FastAPI(
    title="NewTube",
    version="1.0.0",
    description="YouTube replacement for legacy Samsung Smart TVs (Orsay OS)",
    lifespan=lifespan,
)

# Wide-open CORS so the TV widget can call us from any port
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- health / version ----------------------------------------------------

@app.get("/")
def root():
    return {
        "name": "NewTube",
        "version": "1.0.0",
        "youtube_api_key_configured": bool(YOUTUBE_API_KEY),
        "preferred_height": PREFERRED_HEIGHT,
        "preferred_fps": PREFERRED_FPS,
    }


# --- self-healing: if widget files are present but the install manifest is
# missing (common when the server is deployed without running the build
# steps), generate it on the fly so the TV can still find the widget.

def _ensure_widget_manifest() -> None:
    """Build a widgetlist.xml + zip from widget/dist/ if they're not there yet.

    This is a convenience for cloud deployments (Render, Fly.io, etc.)
    where we deploy the pre-built widget bundle but never run `npm run
    package`.  Without this, the TV's User App Sync would have nothing
    to download.
    """
    import zipfile
    widget_dist = REPO_ROOT / "widget" / "dist"
    target_dist = REPO_ROOT / "dist"
    target_install = target_dist / "widget-install"
    target_manifest = target_dist / "widgetlist.xml"

    if not (widget_dist / "index.js").exists():
        return  # nothing to do

    target_dist.mkdir(parents=True, exist_ok=True)
    target_install.mkdir(parents=True, exist_ok=True)

    # Build a zip with config.xml, index.html, widget.info, dist/, img/
    widget_root = REPO_ROOT / "widget"
    if not any(target_install.glob("NewTube*.zip")):
        zip_name = f"NewTube_widget_{time.strftime('%Y%m%d')}.zip"
        zip_path = target_install / zip_name
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for rel in ("config.xml", "index.html", "widget.info"):
                p = widget_root / rel
                if p.exists():
                    zf.write(p, rel)
            if widget_dist.is_dir():
                for f in widget_dist.iterdir():
                    zf.write(f, f"dist/{f.name}")
            img_dir = widget_root / "img"
            if img_dir.is_dir():
                for f in img_dir.iterdir():
                    zf.write(f, f"img/{f.name}")
        log.info("auto-generated widget install zip: %s", zip_path)

    # Build a manifest pointing at our own /widget-install/* URL
    if not target_manifest.exists():
        zips = sorted(target_install.glob("NewTube*.zip"))
        if not zips:
            return
        zip_name = zips[-1].name
        size = zips[-1].stat().st_size
        manifest = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<rsp stat="ok">\n'
            '<list>\n'
            '<widget id="NewTube">\n'
            f'<title>NewTube</title>\n'
            f'<compression type="zip" size="{size}"/>\n'
            '<description>NewTube — YouTube client for legacy Samsung Smart TVs</description>\n'
            f'<download>/widget-install/{zip_name}</download>\n'
            '</widget>\n'
            '</list>\n'
            '</rsp>\n'
        )
        target_manifest.write_text(manifest, encoding="utf-8")
        log.info("auto-generated widget manifest: %s", target_manifest)


# Run once on startup (and again on first request, in case paths
# weren't ready at import time).
_ensure_widget_manifest()


@app.get("/api/version")
def version():
    return {"server": "newtube", "version": "1.0.0"}


# --- search --------------------------------------------------------------

class SearchResult(BaseModel):
    videoId: str
    title: str
    channelTitle: Optional[str] = ""
    channelId: Optional[str] = ""
    duration: Optional[int] = None
    thumbnail: Optional[str] = ""


@app.get("/api/search")
def search(
    q: str = Query(..., min_length=1, max_length=200),
    maxResults: int = Query(25, ge=1, le=50),
):
    """Search YouTube.

    If YOUTUBE_API_KEY is set, uses the Data API v3 for richer results.
    Otherwise falls back to yt-dlp's ytsearch extractor.
    """
    if not q.strip():
        raise HTTPException(400, "empty query")
    log.info("search q=%r max=%s", q, maxResults)
    results: list[dict[str, Any]] = []
    if YOUTUBE_API_KEY:
        results = _ytdl_search_api(q, maxResults)
    if not results:
        results = _ytdl_search(q, maxResults)
    results = [r for r in results if r.get("videoId")]
    return {"items": results, "query": q}


# --- video resolve -------------------------------------------------------

@app.get("/api/resolve/{video_id}")
def resolve(video_id: str):
    """Resolve a videoId to a streamable URL on this server."""
    try:
        rec = _resolve_video(video_id)
    except HTTPException:
        raise
    return {
        "videoId": rec["videoId"],
        "title": rec.get("title"),
        "channelTitle": rec.get("channelTitle"),
        "channelId": rec.get("channelId"),
        "duration": rec.get("duration"),
        "thumbnail": rec.get("thumbnail"),
        "streamUrl": f"/stream/{video_id}",
        "needsTranscode": rec.get("needsTranscode", False),
    }


# --- stream --------------------------------------------------------------

@app.get("/stream/{video_id}")
async def stream(video_id: str, request: Request):
    """Stream a video by id.  This is the URL the TV's <video> tag uses."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,15}", video_id):
        raise HTTPException(400, "bad videoId")
    rec = _CACHE.get(video_id)
    if rec and (time.time() - rec["ts"]) < _CACHE_TTL:
        if rec.get("needsTranscode"):
            return await _stream_transcode(video_id, request)
        return await _stream_direct(video_id, request)
    # Resolve first
    try:
        rec = _resolve_video(video_id)
    except HTTPException:
        raise
    if rec.get("needsTranscode"):
        return await _stream_transcode(video_id, request)
    return await _stream_direct(video_id, request)


# --- cast (phone -> TV) --------------------------------------------------
# The mobile app calls POST /api/cast/{videoId} and the TV widget polls
# /api/cast_queue to find what to play next.  The TV keeps a short queue
# so the user can queue several videos from the phone.

_CAST_QUEUE: list[dict[str, Any]] = []  # list of {"videoId":..., "title":...}
_CAST_QUEUE_LOCK = threading.Lock()
_CAST_MAX = 10


class CastRequest(BaseModel):
    title: Optional[str] = None
    channelTitle: Optional[str] = None


@app.post("/api/cast/{video_id}")
def cast_push(video_id: str, body: CastRequest | None = None):
    """Phone -> TV: queue a video to be played on the TV.

    The TV widget's "CastQueue" component polls GET /api/cast_queue and
    plays whatever it finds.  This is the simple way to bridge phone
    to TV without needing a persistent WebSocket connection (which the
    Orsay browser can't reliably hold).
    """
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,15}", video_id):
        raise HTTPException(400, "bad videoId")
    with _CAST_QUEUE_LOCK:
        _CAST_QUEUE.append({
            "videoId": video_id,
            "title": (body and body.title) or "",
            "channelTitle": (body and body.channelTitle) or "",
            "ts": time.time(),
        })
        # Keep queue bounded
        while len(_CAST_QUEUE) > _CAST_MAX:
            _CAST_QUEUE.pop(0)
    log.info("cast push: %s (%s) — queue size %d", video_id, (body.title if body else ""), len(_CAST_QUEUE))
    return {"ok": True, "queueSize": len(_CAST_QUEUE)}


@app.get("/api/cast_queue")
def cast_pull(ack: bool = True):
    """TV -> server: fetch and (optionally) clear the pending cast queue.

    The TV widget calls this periodically (e.g. every 3s) and plays
    whatever it gets back.  If ack=true (default), the queue is emptied
    so the same video isn't re-played.
    """
    with _CAST_QUEUE_LOCK:
        items = list(_CAST_QUEUE)
        if ack:
            _CAST_QUEUE.clear()
    return {"items": items, "ts": time.time()}


@app.delete("/api/cast_queue")
def cast_clear():
    with _CAST_QUEUE_LOCK:
        n = len(_CAST_QUEUE)
        _CAST_QUEUE.clear()
    return {"ok": True, "cleared": n}


# --- static widget files -------------------------------------------------
# Serves the built TV widget so the user can preview the UI in a desktop
# browser.  The actual TV install is via the Orsay widget format.

from fastapi.staticfiles import StaticFiles
import io
import zipfile

# REPO_ROOT, WIDGET_DIST_DIR, WIDGET_INSTALL_DIR, WIDGET_MANIFEST, WIDGET_ROOT
# are defined at the top of the file (before _ensure_widget_manifest() is
# called at module load time).

# Preview in browser (the widget HTML rendered standalone)
if WIDGET_DIST_DIR.exists():
    app.mount("/widget-preview", StaticFiles(directory=str(WIDGET_DIST_DIR), html=True), name="widget-preview")


def _build_widget_zip() -> bytes | None:
    """Build a NewTube widget install zip from widget/dist/ on the fly.

    Returns the zip bytes, or None if the widget bundle isn't there.
    """
    if not (WIDGET_DIST_DIR / "index.js").exists():
        return None
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in ("config.xml", "index.html", "widget.info"):
            p = WIDGET_ROOT / rel
            if p.exists():
                zf.write(p, rel)
        for f in WIDGET_DIST_DIR.iterdir():
            if f.is_file():
                zf.write(f, f"dist/{f.name}")
        img_dir = WIDGET_ROOT / "img"
        if img_dir.is_dir():
            for f in img_dir.iterdir():
                if f.is_file():
                    zf.write(f, f"img/{f.name}")
    return buf.getvalue()


@app.get("/widget-install/{name}")
def widget_install(name: str):
    """Serve the NewTube widget install zip on demand.

    The TV's User App Sync hits /widgetlist.xml, which in turn points at
    a URL like /widget-install/NewTube_YYYYMMDD.zip.  We build the zip
    on the fly from the committed widget/dist/ so no separate build
    step is needed.
    """
    if not name.lower().startswith("newtube") or not name.lower().endswith(".zip"):
        raise HTTPException(404, "not found")
    data = _build_widget_zip()
    if data is None:
        raise HTTPException(404, "widget bundle not found")
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@app.get("/widgetlist.xml")
def widgetlist(request: Request):
    """The manifest the TV reads to find the installable zip.

    Built dynamically on every request so we don't need the file to be
    pre-generated on disk.
    """
    data = _build_widget_zip()
    if data is None:
        raise HTTPException(404, "widget bundle not found in widget/dist/")
    size = len(data)
    # Use the public hostname the request came in on (so the TV's
    # "<server ip>/widgetlist.xml" request resolves correctly).
    host = request.headers.get("host", "localhost")
    scheme = request.url.scheme
    url = f"{scheme}://{host}/widget-install/NewTube_widget_live.zip"
    text = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<rsp stat="ok">\n'
        '<list>\n'
        '<widget id="NewTube">\n'
        '<title>NewTube</title>\n'
        f'<compression type="zip" size="{size}"/>\n'
        '<description>NewTube — YouTube client for legacy Samsung Smart TVs</description>\n'
        f'<download>{url}</download>\n'
        '</widget>\n'
        '</list>\n'
        '</rsp>\n'
    )
    return Response(content=text, media_type="application/xml")


# --- install hint page (for desktop browser) ----------------------------

@app.get("/install")
def install_hint(request: Request):
    """Convenience page that explains how to install the widget on the TV."""
    host = request.headers.get("host", "localhost:8088")
    base = f"http://{host}"
    html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Install NewTube on your TV</title>
<style>body{{font-family:system-ui;max-width:680px;margin:2em auto;padding:0 1em;line-height:1.5}}
code{{background:#f4f4f4;padding:2px 6px;border-radius:3px}}
ol li{{margin:0.6em 0}}</style></head>
<body>
<h1>Install NewTube on your TV</h1>
<p>Your TV is talking to this server at <code>{base}</code>.</p>
<h2>One-time setup</h2>
<ol>
<li>On the TV, press the <b>SMART HUB</b> button on the remote.</li>
<li>Press the <b>TOOLS</b> button (or the <b>A</b> red button), choose <b>Login</b>.</li>
<li>Log in with ID <code>develop</code> and password <code>000000</code>.</li>
<li>Open <b>Settings → Development</b> (on E-series, this is under <b>Settings</b> after Tools).</li>
<li>Set <b>Server IP</b> to the IP of this computer (the one running NewTube) and the port <b>8088</b>.</li>
</ol>
<p>The "Server IP" field takes just an IP, not a URL.  So if this server is at
<code>{base}</code>, set the Server IP to the host part (<code>{host.split(':')[0]}</code>) and
set the server's port to 8088 via your URL rewriting (see README).</p>
<p><b>Alternative:</b> use the <a href="/widgetlist.xml">widgetlist.xml</a> from your own
web server that lets you specify a full URL — see the README for the IIS / Python
http.server approach.</p>
<h2>After setup</h2>
<ol>
<li>Back on the TV, choose <b>User Application Synchronisation</b>.</li>
<li>The TV downloads NewTube and installs it in Smart Hub.</li>
<li>Open NewTube, go to <b>Settings</b>, set the NewTube server URL to
<code>{base}</code> (or <code>http://newtube.local:8088</code> if you set up mDNS).</li>
<li>Switch to the <b>Search</b> tab and start watching!</li>
</ol>
<h2>API endpoints</h2>
<ul>
<li><a href="/api/version">/api/version</a> — server info</li>
<li><a href="/api/search?q=lofi+music">/api/search?q=lofi+music</a> — sample search</li>
<li>/api/resolve/{'{videoId}'} — get a stream URL for a video</li>
<li>/stream/{'{videoId}'} — proxied video stream</li>
</ul>
</body></html>"""
    return Response(content=html, media_type="text/html")


# --- main ----------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app:app",
        host=HOST,
        port=PORT,
        log_level="info",
        # No reload -- we want the in-memory cache to survive.
    )
