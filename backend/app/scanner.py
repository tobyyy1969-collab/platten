"""Liest FLAC- und MP3-Dateien ein und baut daraus die Alben.

Alben werden über ihre Tags zusammengefasst, nicht über Ordner. Dadurch
landen CD1/CD2-Unterordner im selben Album, und dasselbe Album als FLAC und
als MP3 erscheint nur einmal (mit beiden Quellen).
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import threading
import time
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

from mutagen.flac import FLAC
from mutagen.mp3 import MP3

from . import config, db

log = logging.getLogger("bulldogbeats.scan")

VARIOUS = "Verschiedene Interpreten"
_VARIOUS_NAMES = {"various artists", "various", "va", "diverse", "diverse interpreten",
                  "verschiedene interpreten", "verschiedene", "sampler", "compilation"}
_DISC_DIR = re.compile(r"^\s*(cd|disc|disk|scheibe|seite|side)[\s._-]*\d+\b.*$|^\s*\d{1,2}\s*$", re.I)
_EDITION = re.compile(r"\s*[\(\[][^\)\]]*(remaster|deluxe|edition|bonus|expanded|anniversary)[^\)\]]*[\)\]]\s*", re.I)
_LEADING_NUM = re.compile(r"^\s*\d{1,3}\s*[-._)]\s*")
_VA_PREFIX = re.compile(r"^\s*(va|v\.\s*a\.?|various( artists)?|verschiedene( interpreten)?|diverse|sampler)\s*[-–:]\s*", re.I)
# Bei Änderungen an der Album-Bildung erhöhen: dann wird beim nächsten Start neu zusammengestellt.
GROUPING_VERSION = "3"
# "Kuschel Jazz 2003 CD 1", "Modern Rock Disc 2", "Album (CD2)"
_DISC_SUFFIX = re.compile(r"[\s,:;_\-–]*[\(\[]?\s*(?:cd|disc|disk)\s*(\d{1,2})(?:\s*(?:of|von|/)\s*\d+)?\s*[\)\]]?\s*$", re.I)
_LOOSE_PARENT = re.compile(r"single|einzel", re.I)
_SAMPLER_PATH = re.compile(r"sampler|soundtrack|compilation|various|ost\b", re.I)
# Ordner mit mehr losen Titeln gelten als Sammelordner (z. B. "Singles"), nicht als ein Album.
FOLDER_ALBUM_MAX = 60

state = {"running": False, "phase": "bereit", "done": 0, "total": 0, "errors": 0,
         "changed": 0, "started": None, "finished": None, "missing_dirs": []}
_lock = threading.Lock()


# ---------------------------------------------------------------- Hilfen

def norm(s: str | None) -> str:
    s = unicodedata.normalize("NFKC", s or "").casefold()
    s = _EDITION.sub(" ", s)
    s = re.sub(r"^(the|die|der|das)\s+", "", s.strip())
    s = re.sub(r"[^\w]+", " ", s)
    return " ".join(s.split())


def is_various(name: str | None) -> bool:
    return norm(name) in {norm(v) for v in _VARIOUS_NAMES}


def _int(v) -> int | None:
    if v is None:
        return None
    m = re.match(r"\s*(\d+)", str(v))
    return int(m.group(1)) if m else None


def _year(v) -> int | None:
    m = re.search(r"(1[89]\d\d|20\d\d)", str(v or ""))
    return int(m.group(1)) if m else None


def _flag(v) -> int:
    return 1 if str(v or "").strip().lower() in {"1", "true", "yes", "ja"} else 0


def strip_disc(title: str | None) -> tuple[str, int | None]:
    """"Kuschel Jazz 2003 CD 1" → ("Kuschel Jazz 2003", 1)."""
    if not title:
        return title or "", None
    m = _DISC_SUFFIX.search(title)
    if not m or not title[:m.start()].strip():
        return title, None
    return title[:m.start()].strip(), int(m.group(1))


def album_dir(d: str) -> str:
    """Ordner des Albums: CD1/Disc 2-Unterordner zählen zum Elternordner,
    "Kuschel Jazz CD1" und "Kuschel Jazz CD2" zum gemeinsamen Namen."""
    p = Path(d)
    if _DISC_DIR.match(p.name):
        return str(p.parent)
    base, disc = strip_disc(p.name)
    return str(p.parent / base) if disc else d


# ---------------------------------------------------------------- Tags lesen

def _join(values) -> str | None:
    vals = [str(v).strip() for v in (values or []) if str(v).strip()]
    return ", ".join(dict.fromkeys(vals)) if vals else None


def read_file(path: str, fmt: str) -> dict:
    if fmt == "FLAC":
        f = FLAC(path)
        t = f.tags
        g = (lambda *keys: next((_join(t.get(k)) for k in keys if t and t.get(k)), None))
        info = f.info
        return dict(
            title=g("title"), artist=g("artist"),
            albumartist=g("albumartist", "album artist", "album_artist", "ensemble"),
            album=g("album"), disc=_int(g("discnumber", "disc")), track=_int(g("tracknumber", "track")),
            year=_year(g("originaldate", "originalyear", "date", "year")), genre=g("genre"),
            compilation=_flag(g("compilation")), duration=info.length,
            bitrate=int(info.bitrate / 1000) if info.bitrate else None,
            samplerate=info.sample_rate, bitdepth=info.bits_per_sample,
            picture=1 if f.pictures else 0, lyrics=1 if g("lyrics", "unsyncedlyrics") else 0,
        )
    f = MP3(path)
    t = f.tags

    def g(*ids):
        for i in ids:
            fr = t.get(i) if t else None
            if fr is not None and getattr(fr, "text", None):
                return _join(fr.text)
        return None

    keys = list(t.keys()) if t else []
    return dict(
        title=g("TIT2"), artist=g("TPE1"), albumartist=g("TPE2"), album=g("TALB"),
        disc=_int(g("TPOS")), track=_int(g("TRCK")),
        year=_year(g("TDOR", "TORY", "TDRC", "TYER")), genre=g("TCON"),
        compilation=_flag(g("TCMP")), duration=f.info.length,
        bitrate=int(f.info.bitrate / 1000) if f.info.bitrate else None,
        samplerate=f.info.sample_rate, bitdepth=None,
        picture=1 if any(k.startswith("APIC") for k in keys) else 0,
        lyrics=1 if any(k.startswith("USLT") for k in keys) else 0,
    )


def _fallbacks(tags: dict, path: str) -> dict:
    """Fehlende Angaben aus Datei- und Ordnernamen ergänzen."""
    p = Path(path)
    stem = _LEADING_NUM.sub("", p.stem)
    if not tags.get("title"):
        if " - " in stem and not tags.get("artist"):
            a, _, s = stem.partition(" - ")
            tags["artist"], tags["title"] = a.strip(), s.strip()
        else:
            tags["title"] = stem
    if not tags.get("track"):
        tags["track"] = _int(re.match(r"\s*(\d{1,3})", p.stem).group(1)) if re.match(r"\s*\d{1,3}", p.stem) else None
    if not tags.get("artist"):
        tags["artist"] = tags.get("albumartist") or p.parent.name or "Unbekannter Interpret"
    return tags


# ---------------------------------------------------------------- Einlesen

def _walk(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith((".", "@", "#"))]
        for fn in filenames:
            if fn.startswith("._"):  # macOS-Begleitdateien
                continue
            fmt = config.AUDIO_EXT.get(os.path.splitext(fn)[1].lower())
            if fmt:
                yield os.path.join(dirpath, fn), dirpath, fmt


COLS = ["path", "dir", "mtime", "size", "format", "title", "artist", "albumartist", "album",
        "disc", "track", "year", "genre", "duration", "bitrate", "samplerate", "bitdepth",
        "compilation", "picture", "lyrics", "added"]
UPSERT = (f"INSERT INTO tracks({','.join(COLS)}) VALUES({','.join('?' * len(COLS))}) "
          "ON CONFLICT(path) DO UPDATE SET " +
          ",".join(f"{c}=excluded.{c}" for c in COLS if c not in ("path", "added")))


def scan(full: bool = False) -> None:
    with _lock:
        if state["running"]:
            return
        state.update(running=True, phase="Dateien suchen", done=0, total=0, errors=0,
                     changed=0, started=time.time(), missing_dirs=[])
    try:
        _scan(full)
    except Exception:  # pragma: no cover - nur Protokoll
        log.exception("Einlesen fehlgeschlagen")
        state["phase"] = "Fehler beim Einlesen (siehe Protokoll)"
    finally:
        state["running"] = False
        state["finished"] = time.time()


def _scan(full: bool) -> None:
    con = db.connect()
    files, live_roots = [], []
    for root in config.MUSIC_DIRS:
        if not root.is_dir() or not any(root.iterdir()):
            # Festplatte nicht eingebunden: vorhandene Einträge NICHT löschen.
            state["missing_dirs"].append(str(root))
            log.warning("Musikordner fehlt oder ist leer: %s", root)
            continue
        live_roots.append(str(root).rstrip("/") + "/")
        files.extend(_walk(root))
    state["total"] = len(files)
    state["phase"] = "Tags lesen"

    known = {r["path"]: (r["mtime"], r["size"]) for r in con.execute("SELECT path, mtime, size FROM tracks")}
    seen, batch = set(), []
    for i, (path, d, fmt) in enumerate(files, 1):
        seen.add(path)
        state["done"] = i
        try:
            st = os.stat(path)
        except OSError:
            continue
        if not full and known.get(path) == (st.st_mtime, st.st_size):
            continue
        try:
            tags = read_file(path, fmt)
        except Exception as e:  # defekte Datei: trotzdem aufnehmen
            log.warning("Tags nicht lesbar: %s (%s)", path, e)
            state["errors"] += 1
            tags = {}
        tags = _fallbacks(tags, path)
        row = dict(tags, path=path, dir=d, mtime=st.st_mtime, size=st.st_size, format=fmt, added=st.st_mtime)
        batch.append([row.get(c) for c in COLS])
        state["changed"] += 1
        if len(batch) >= 500:
            with db.writing() as w:
                w.executemany(UPSERT, batch)
            batch.clear()
    if batch:
        with db.writing() as w:
            w.executemany(UPSERT, batch)

    gone = [p for p in known if p not in seen and any(p.startswith(r) for r in live_roots)]
    if gone:
        with db.writing() as w:
            w.executemany("DELETE FROM tracks WHERE path=?", [(p,) for p in gone])
    gv = con.execute("SELECT value FROM meta WHERE key='grouping_version'").fetchone()
    if (state["changed"] or gone or full or not con.execute("SELECT 1 FROM albums LIMIT 1").fetchone()
            or not gv or gv[0] != GROUPING_VERSION):
        state["phase"] = "Alben zusammenstellen"
        rebuild()
    state["phase"] = "fertig"


# ---------------------------------------------------------------- Alben bilden

def _most(values, default=None):
    c = Counter(v for v in values if v)
    return c.most_common(1)[0][0] if c else default


def folder_title(name: str) -> tuple[str, int | None]:
    """Albumtitel und Jahr aus einem Ordnernamen wie "VA - Hit History '61 - Volume 07 (1990)"."""
    year = None
    m = re.search(r"[\(\[]\s*((?:19|20)\d\d)\s*[\)\]]", name)
    if m:
        year = int(m.group(1))
        name = name[:m.start()] + name[m.end():]
    m = re.match(r"^\s*((?:19|20)\d\d)\s*[-–]\s*", name)
    if m:
        year = year or int(m.group(1))
        name = name[m.end():]
    name = _VA_PREFIX.sub("", name)
    name = re.sub(r"\s+[A-Z]$", "", name.strip())  # Reste wie "… (1990) F"
    name = re.sub(r"\s*\b(flac|mp3)\b\s*$", "", name, flags=re.I)
    return " ".join(name.split()).strip(" -–") or name, year


def _akey(album: str) -> str:
    return norm(strip_disc(album)[0])


def _plan(rows) -> dict:
    """Entscheidet je Titel, zu welchem Album er gehört.

    - Titel mit Album-Tag: nach Album-Interpret und Album. Liegen im selben Ordner
      Titel desselben Albums mit drei oder mehr verschiedenen Album-Interpreten,
      ist es ein Sampler und bleibt zusammen.
    - Titel ohne Album-Tag: der Ordner ist das Album (Sampler ohne Tags), außer der
      Ordner ist ein Sammelordner oder heißt wie der Interpret.
    """
    by_dir_album = defaultdict(set)
    loose_by_dir = defaultdict(list)
    for r in rows:
        if r["album"]:
            by_dir_album[(album_dir(r["dir"]), _akey(r["album"]))].add(norm(r["albumartist"] or r["artist"]))
        else:
            loose_by_dir[album_dir(r["dir"])].append(r)
    roots = {str(p).rstrip("/") for p in config.MUSIC_DIRS}
    keys = {}
    for r in rows:
        ad = album_dir(r["dir"])
        if r["album"]:
            ak = _akey(r["album"])
            if len(by_dir_album[(ad, ak)]) >= 3:
                keys[r["id"]] = ("sampler", ad, ak)
            elif r["albumartist"]:
                keys[r["id"]] = ("aa", norm(r["albumartist"]), ak)
            else:
                keys[r["id"]] = ("dir", ad, ak)
            continue
        siblings = loose_by_dir[ad]
        top = Counter(norm(t["artist"]) for t in siblings).most_common(1)[0][0]
        name = Path(ad).name
        # Ordner, der nur wie der Interpret heißt (z. B. MP3 nach Interpret sortiert): lose Titel bleiben lose.
        artist_folder = _LOOSE_PARENT.search(name) or (
            norm(name) == top and " - " not in name and not _SAMPLER_PATH.search(ad))
        if ad.rstrip("/") not in roots and len(siblings) <= FOLDER_ALBUM_MAX and not artist_folder:
            keys[r["id"]] = ("folder", ad)
        else:
            keys[r["id"]] = ("loose", norm(r["artist"]))
    return keys


def _cover_file(dirs: set[str]) -> str | None:
    best = None
    for d in sorted(dirs):
        try:
            names = os.listdir(d)
        except OSError:
            continue
        imgs = [n for n in names if n.lower().endswith(config.IMAGE_EXT) and not n.startswith(".")]
        for pref in config.IMAGE_NAMES:
            for n in imgs:
                if os.path.splitext(n)[0].lower() == pref:
                    return os.path.join(d, n)
        if imgs and not best:
            best = max((os.path.join(d, n) for n in imgs), key=lambda p: os.path.getsize(p))
    return best


def _quality(trs) -> str:
    fl = [t for t in trs if t["format"] == "FLAC"]
    if fl:
        bd = max((t["bitdepth"] or 16) for t in fl)
        sr = max((t["samplerate"] or 44100) for t in fl) / 1000
        return f"{bd}/{sr:g}".replace(".", ",")
    br = max((t["bitrate"] or 0) for t in trs)
    if not br:
        return ""
    std = min((96, 128, 160, 192, 224, 256, 320), key=lambda x: abs(x - br))
    return f"{std if abs(std - br) <= 8 else br} kbit/s"


def _disc_hint(t) -> int | None:
    disc = strip_disc(t["album"])[1]
    if disc:
        return disc
    name = Path(t["dir"]).name
    m = re.search(r"(\d{1,2})\s*$", name) if _DISC_DIR.match(name) else None
    return int(m.group(1)) if m else strip_disc(name)[1]


def album_id(artist: str, title: str) -> str:
    return hashlib.sha1(f"{norm(artist)}|{norm(title)}".encode()).hexdigest()[:16]


def rebuild() -> None:
    con = db.connect()
    rows = con.execute("SELECT * FROM tracks").fetchall()
    groups = defaultdict(list)
    keys = _plan(rows)
    for r in rows:
        groups[keys[r["id"]]].append(r)

    merged: dict[str, dict] = {}
    for key, trs in groups.items():
        folder_name, year_hint = folder_title(Path(album_dir(trs[0]["dir"])).name)
        if key[0] == "folder":
            title = folder_name
        else:
            title = strip_disc(_most([t["album"] for t in trs]))[0] or "Einzeltitel"
        aa = _most([t["albumartist"] for t in trs])
        comp = any(t["compilation"] for t in trs) or is_various(aa) or key[0] == "sampler"
        artists = Counter(t["artist"] for t in trs)
        if key[0] == "sampler":
            aa = VARIOUS
        elif not aa:
            top, n = artists.most_common(1)[0]
            if key[0] in ("dir", "folder") and len(artists) > 2 and n <= len(trs) / 2:
                aa, comp = VARIOUS, True
            else:
                aa = top
            if key[0] == "folder" and norm(aa) == norm(Path(album_dir(trs[0]["dir"])).name):
                # Interpret stammt aus dem Ordnernamen (keine Tags): "Barry Manilow - The Magic Of …"
                head, sep, rest = title.partition(" - ")
                if sep and rest.strip():
                    aa, title = head.strip(), rest.strip()
                elif _SAMPLER_PATH.search(str(Path(trs[0]["dir"]).parent)):
                    aa, comp = VARIOUS, True
        if is_various(aa):
            aa, comp = VARIOUS, True
        if comp and (is_various(aa) or not aa):
            aa = VARIOUS
        if key[0] == "folder" and aa != VARIOUS:
            # "Udo Lindenberg - Alles klar" → "Alles klar"
            head, sep, rest = title.partition(" - ")
            if sep and norm(head) == norm(aa) and rest.strip():
                title = rest.strip()
        if key[0] == "folder":
            ym = re.match(r"^\s*((?:19|20)\d\d)\s*[-–]\s*(.+)$", title)
            if ym:
                year_hint, title = year_hint or int(ym.group(1)), ym.group(2).strip()
        aid = album_id(aa, title if key[0] != "loose" else f"einzeltitel {aa}")
        m = merged.setdefault(aid, {"id": aid, "title": title, "artist": aa, "compilation": int(bool(comp)),
                                    "year_hint": year_hint, "tracks": []})
        m["tracks"].extend(trs)

    album_rows, track_updates, fts = [], [], []
    for a in merged.values():
        trs = a["tracks"]
        formats = sorted({t["format"] for t in trs}, key=lambda f: ("FLAC", "MP3").index(f))
        cover = _cover_file({t["dir"] for t in trs})
        pic = next((t["id"] for t in trs if t["picture"]), None)
        main = [t for t in trs if t["format"] == formats[0]]
        album_rows.append((
            a["id"], a["title"], a["artist"],
            (_most([t["year"] for t in trs]) and min(t["year"] for t in trs if t["year"])) or a["year_hint"],
            _most([t["genre"] for t in trs]), a["compilation"], ",".join(formats), _quality(trs),
            len(main), sum(t["duration"] or 0 for t in main), cover, pic, min(t["added"] or 0 for t in trs),
        ))
        track_updates.extend((a["id"], t["disc"] or _disc_hint(t), t["id"]) for t in trs)
        fts.append(("album", a["id"], a["title"], a["artist"], ""))
    for r in rows:
        fts.append(("track", str(r["id"]), r["title"], r["artist"], r["album"] or ""))

    with db.writing() as w:
        w.execute("DELETE FROM albums")
        w.executemany("INSERT INTO albums VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", album_rows)
        w.executemany("UPDATE tracks SET album_id=?, disc=? WHERE id=?", track_updates)
        w.execute("DELETE FROM search")
        w.executemany("INSERT INTO search(kind, ref, title, artist, album) VALUES(?,?,?,?,?)", fts)
        w.execute("INSERT OR REPLACE INTO meta VALUES('library_version', ?)", (str(time.time()),))
        w.execute("INSERT OR REPLACE INTO meta VALUES('grouping_version', ?)", (GROUPING_VERSION,))
    log.info("%d Alben aus %d Titeln", len(album_rows), len(rows))
