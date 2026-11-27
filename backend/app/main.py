"""BulldogBeats Server: Bibliothek, Cover, Streaming und die Oberfläche."""
from __future__ import annotations

import hashlib
import io
import logging
import os
import re
import threading
import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import config, db, scanner

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("bulldogbeats")

app = FastAPI(title="BulldogBeats", docs_url="/api/docs", openapi_url="/api/openapi.json")
app.add_middleware(GZipMiddleware, minimum_size=1000)

MIME = {"FLAC": "audio/flac", "MP3": "audio/mpeg"}
COVER_SIZES = (120, 300, 600, 1200)


# ---------------------------------------------------------------- Start

def _scan_loop() -> None:
    scanner.scan()
    while config.RESCAN_HOURS > 0:
        time.sleep(config.RESCAN_HOURS * 3600)
        scanner.scan()


@app.on_event("startup")
def startup() -> None:
    db.init()
    (config.DATA_DIR / "covers").mkdir(parents=True, exist_ok=True)
    if os.environ.get("BB_NO_AUTOSCAN") != "1":
        threading.Thread(target=_scan_loop, daemon=True, name="scan").start()


def _version() -> str:
    r = db.connect().execute("SELECT value FROM meta WHERE key='library_version'").fetchone()
    return r[0] if r else "0"


# ---------------------------------------------------------------- Bibliothek

def _album_out(r) -> dict:
    return {"id": r["id"], "title": r["title"], "artist": r["artist"], "year": r["year"],
            "formats": (r["formats"] or "").split(",") if r["formats"] else [],
            "quality": r["quality"], "tracks": r["track_count"], "added": r["added"],
            "compilation": bool(r["compilation"]),
            "cover": bool(r["cover_path"] or r["cover_track"])}


@app.get("/api/status")
def status():
    con = db.connect()
    counts = {f: n for f, n in con.execute("SELECT format, COUNT(*) FROM tracks GROUP BY format")}
    albums_by_format = {
        "FLAC": con.execute("SELECT COUNT(*) FROM albums WHERE formats LIKE '%FLAC%'").fetchone()[0],
        "MP3": con.execute("SELECT COUNT(*) FROM albums WHERE formats LIKE '%MP3%'").fetchone()[0],
    }
    return {"scan": scanner.state, "tracks": counts, "albums": albums_by_format,
            "version": _version(), "music_dirs": [str(d) for d in config.MUSIC_DIRS],
            "spotify_client_id": config.SPOTIFY_CLIENT_ID}


@app.post("/api/scan")
def start_scan(full: bool = False):
    if scanner.state["running"]:
        return {"started": False, "reason": "läuft bereits"}
    threading.Thread(target=scanner.scan, kwargs={"full": full}, daemon=True).start()
    return {"started": True}


@app.get("/api/albums")
def albums(request: Request):
    v = _version()
    if request.headers.get("if-none-match") == f'"{v}"':
        return Response(status_code=304)
    rows = db.connect().execute("SELECT * FROM albums").fetchall()
    return JSONResponse({"version": v, "albums": [_album_out(r) for r in rows]},
                        headers={"ETag": f'"{v}"', "Cache-Control": "no-cache"})


def _track_out(r) -> dict:
    return {"id": r["id"], "title": r["title"], "artist": r["artist"], "album": r["album"],
            "album_id": r["album_id"], "disc": r["disc"], "track": r["track"], "format": r["format"],
            "duration": r["duration"], "bitrate": r["bitrate"], "samplerate": r["samplerate"],
            "bitdepth": r["bitdepth"], "year": r["year"]}


@app.get("/api/album/{aid}")
def album(aid: str):
    con = db.connect()
    a = con.execute("SELECT * FROM albums WHERE id=?", (aid,)).fetchone()
    if not a:
        raise HTTPException(404, "Album nicht gefunden")
    rows = con.execute(
        "SELECT * FROM tracks WHERE album_id=? ORDER BY format, COALESCE(disc,1), COALESCE(track,999), path",
        (aid,)).fetchall()
    sources: dict[str, list] = {}
    for r in rows:
        sources.setdefault(r["format"], []).append(_track_out(r))
    out = _album_out(a)
    out.update(genre=a["genre"], duration=a["duration"], sources=sources,
               discs=len({(t["disc"] or 1) for t in rows if t["format"] == (out["formats"] or ["FLAC"])[0]}))
    return out


@app.get("/api/artist")
def artist(name: str):
    con = db.connect()
    own = con.execute("SELECT * FROM albums WHERE artist=? ORDER BY year", (name,)).fetchall()
    own_ids = {r["id"] for r in own}
    appear = con.execute(
        "SELECT DISTINCT a.* FROM tracks t JOIN albums a ON a.id=t.album_id "
        "WHERE t.artist=? OR t.artist LIKE ? ORDER BY a.year", (name, f"%{name}%")).fetchall()
    return {"name": name, "albums": [_album_out(r) for r in own],
            "appearances": [_album_out(r) for r in appear if r["id"] not in own_ids]}


@app.get("/api/search")
def search(q: str, limit: int = 60):
    tokens = re.findall(r"\w+", q, flags=re.U)
    if not tokens:
        return {"albums": [], "tracks": []}
    match = " ".join(f'"{t}"*' for t in tokens)
    con = db.connect()
    album_ids = [r[0] for r in con.execute(
        "SELECT ref FROM search WHERE search MATCH ? AND kind='album' ORDER BY rank LIMIT ?", (match, limit))]
    track_ids = [int(r[0]) for r in con.execute(
        "SELECT ref FROM search WHERE search MATCH ? AND kind='track' ORDER BY rank LIMIT ?", (match, limit * 3))]
    albums_out = []
    if album_ids:
        rows = {r["id"]: r for r in con.execute(
            f"SELECT * FROM albums WHERE id IN ({','.join('?' * len(album_ids))})", album_ids)}
        albums_out = [_album_out(rows[i]) for i in album_ids if i in rows]
    tracks_out = []
    if track_ids:
        rows = {r["id"]: r for r in con.execute(
            f"SELECT * FROM tracks WHERE id IN ({','.join('?' * len(track_ids))})", track_ids)}
        tracks_out = [_track_out(rows[i]) for i in track_ids if i in rows]
    return {"albums": albums_out, "tracks": tracks_out}


# ---------------------------------------------------------------- Cover

def _embedded_picture(path: str) -> bytes | None:
    try:
        if path.lower().endswith(".flac"):
            from mutagen.flac import FLAC
            pics = FLAC(path).pictures
        else:
            from mutagen.id3 import ID3
            pics = ID3(path).getall("APIC")
    except Exception:
        return None
    if not pics:
        return None
    front = [p for p in pics if getattr(p, "type", 0) == 3]
    return (front or pics)[0].data


@app.get("/api/cover/{aid}")
def cover(aid: str, s: int = 300):
    size = min(COVER_SIZES, key=lambda x: abs(x - s))
    con = db.connect()
    a = con.execute("SELECT cover_path, cover_track FROM albums WHERE id=?", (aid,)).fetchone()
    if not a:
        raise HTTPException(404)
    src = a["cover_path"]
    if not src and a["cover_track"]:
        t = con.execute("SELECT path FROM tracks WHERE id=?", (a["cover_track"],)).fetchone()
        src = t["path"] if t else None
    if not src or not os.path.exists(src):
        raise HTTPException(404, "kein Cover")
    key = hashlib.sha1(f"{src}|{os.path.getmtime(src)}|{size}".encode()).hexdigest()[:20]
    cached = config.DATA_DIR / "covers" / f"{aid}_{key}.jpg"
    headers = {"Cache-Control": "public, max-age=604800"}
    if cached.exists():
        return FileResponse(cached, media_type="image/jpeg", headers=headers)
    data = open(src, "rb").read() if a["cover_path"] else _embedded_picture(src)
    if not data:
        raise HTTPException(404, "kein Cover")
    from PIL import Image
    try:
        img = Image.open(io.BytesIO(data))
        img = img.convert("RGB")
        img.thumbnail((size, size), Image.LANCZOS)
        img.save(cached, "JPEG", quality=86, optimize=True)
    except Exception:
        raise HTTPException(404, "Cover nicht lesbar")
    return FileResponse(cached, media_type="image/jpeg", headers=headers)


# ---------------------------------------------------------------- Streaming

def _file_range(path: str, start: int, end: int, chunk: int = 256 * 1024):
    with open(path, "rb") as f:
        f.seek(start)
        left = end - start + 1
        while left > 0:
            data = f.read(min(chunk, left))
            if not data:
                break
            left -= len(data)
            yield data


@app.api_route("/api/stream/{tid}", methods=["GET", "HEAD"])
def stream(tid: int, request: Request):
    r = db.connect().execute("SELECT path, format FROM tracks WHERE id=?", (tid,)).fetchone()
    if not r or not os.path.exists(r["path"]):
        raise HTTPException(404, "Titel nicht gefunden")
    path, size = r["path"], os.path.getsize(r["path"])
    mime = MIME.get(r["format"], "application/octet-stream")
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=86400"}
    rng = request.headers.get("range")
    start, end, code = 0, size - 1, 200
    if rng:
        m = re.match(r"bytes=(\d*)-(\d*)", rng)
        if m:
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            elif m.group(2):  # letzte N Bytes
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            if start > end:
                return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
            code = 206
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    headers["Content-Length"] = str(end - start + 1)
    if request.method == "HEAD":
        return Response(status_code=code, headers=headers, media_type=mime)
    return StreamingResponse(_file_range(path, start, end), status_code=code, headers=headers, media_type=mime)


# ---------------------------------------------------------------- Oberfläche

@app.get("/sw.js")
def service_worker():
    return FileResponse(config.WEB_DIR / "sw.js", media_type="text/javascript",
                        headers={"Cache-Control": "no-cache"})


@app.get("/callback")
def spotify_callback():
    return FileResponse(config.WEB_DIR / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=config.WEB_DIR, html=True), name="web")
