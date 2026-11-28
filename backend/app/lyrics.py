"""Liedtexte: zuerst aus der Datei selbst, sonst von LRCLIB (frei, ohne Schlüssel).

Der Text kommt immer in der Originalsprache. Auf Wunsch wird er ins Deutsche
übersetzt; Text und Übersetzung werden in der Datenbank aufbewahrt, damit
jedes Lied nur einmal geholt wird.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
import urllib.parse
import urllib.request

from . import db
from .scanner import norm

log = logging.getLogger("bulldogbeats.lyrics")

LRCLIB = os.environ.get("LRCLIB_URL", "https://lrclib.net").rstrip("/")
TRANSLATE = os.environ.get("TRANSLATE_URL", "https://translate.googleapis.com/translate_a/single")
UA = "BulldogBeats/1.0"
RETRY_MISSING = 7 * 86400  # nicht gefundene Texte nach einer Woche noch einmal suchen

_TIMESTAMP = re.compile(r"^\s*\[(\d+):(\d+(?:[.:]\d+)?)\]")
_TITLE_NOISE = re.compile(
    r"\s*[-–]\s*((\d{4} )?(digital )?remaster(ed)?.*|mono|stereo|single version|radio edit|live)$"
    r"|\s*[\(\[][^)\]]*(remaster|version|mono|stereo|edit|feat\.|ft\.)[^)\]]*[\)\]]", re.I)


def clean_title(title: str) -> str:
    return _TITLE_NOISE.sub("", title or "").strip() or (title or "")


def main_artist(artist: str) -> str:
    return re.split(r",\s|\s(?:feat\.?|ft\.?|&|und|and|x)\s", artist or "", maxsplit=1, flags=re.I)[0].strip()


def _key(artist: str, title: str) -> str:
    return f"{norm(main_artist(artist))}|{norm(clean_title(title))}"


def _get(url: str, params: dict | None = None, data: dict | None = None, timeout: float = 12):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    body = urllib.parse.urlencode(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# ---------------------------------------------------------------- Text aus der Datei

def _from_file(path: str | None) -> str | None:
    if not path:
        return None
    try:
        if path.lower().endswith(".flac"):
            from mutagen.flac import FLAC
            f = FLAC(path)
            for k in ("lyrics", "unsyncedlyrics", "unsynced lyrics"):
                if f.get(k):
                    return "\n".join(f[k]).strip() or None
        else:
            from mutagen.id3 import ID3
            frames = ID3(path).getall("USLT")
            if frames:
                return str(frames[0].text).strip() or None
    except Exception as e:  # Datei nur lesen; Fehler sind kein Drama
        log.debug("Liedtext aus %s: %s", path, e)
    return None


# ---------------------------------------------------------------- LRCLIB

def _lrclib(artist: str, title: str, album: str, duration: float) -> dict | None:
    a, t = main_artist(artist), clean_title(title)
    try:
        hits = _get(f"{LRCLIB}/api/search", {"track_name": t, "artist_name": a})
        if not hits:
            hits = _get(f"{LRCLIB}/api/search", {"q": f"{a} {t}"})
    except Exception as e:
        log.warning("LRCLIB nicht erreichbar: %s", e)
        raise
    na, nt = norm(a), norm(t)
    good = [h for h in hits or [] if norm(h.get("artistName")) == na
            and (norm(h.get("trackName")) == nt or norm(clean_title(h.get("trackName", ""))) == nt)]
    if not good:
        good = [h for h in hits or [] if na and na in norm(h.get("artistName")) and nt in norm(h.get("trackName"))]
    if not good:
        return None

    def score(h):
        d = abs((h.get("duration") or 0) - duration) if duration else 0
        return (h.get("instrumental") is not True and not (h.get("plainLyrics") or h.get("syncedLyrics")),
                d > 4, not h.get("syncedLyrics"), d)
    return sorted(good, key=score)[0]


def _plain_from_synced(synced: str) -> str:
    return "\n".join(re.sub(r"^\s*(\[\d+:[\d.:]+\]\s*)+", "", l).strip()
                     for l in synced.splitlines() if not re.match(r"^\s*\[[a-z]+:", l, re.I))


def _row(r) -> dict:
    return {"found": bool(r["plain"] or r["synced"] or r["instrumental"]), "plain": r["plain"],
            "synced": r["synced"], "instrumental": bool(r["instrumental"]), "source": r["source"],
            "lang": r["lang"]}


def find(artist: str, title: str, album: str = "", duration: float = 0, path: str | None = None) -> dict:
    key = _key(artist, title)
    con = db.connect()
    r = con.execute("SELECT * FROM lyrics WHERE key=?", (key,)).fetchone()
    if r and (r["plain"] or r["synced"] or r["instrumental"] or time.time() - (r["fetched"] or 0) < RETRY_MISSING):
        return _row(r)

    plain = _from_file(path)
    synced, source, instrumental = None, "Datei", 0
    if plain and _TIMESTAMP.match(plain.splitlines()[0] if plain.splitlines() else ""):
        synced, plain = plain, _plain_from_synced(plain)
    if not plain:
        try:
            h = _lrclib(artist, title, album, duration)
        except Exception:
            return {"found": False, "error": "Die Liedtext-Datenbank ist gerade nicht erreichbar."}
        source = "LRCLIB"
        if h:
            synced = h.get("syncedLyrics") or None
            # Zeilen des mitlaufenden Textes nehmen, damit Übersetzung und Zeitmarken zusammenpassen
            plain = _plain_from_synced(synced) if synced else h.get("plainLyrics") or None
            instrumental = 1 if h.get("instrumental") else 0
    with db.writing() as w:
        w.execute("INSERT OR REPLACE INTO lyrics(key, plain, synced, lang, source, de, instrumental, fetched) "
                  "VALUES(?,?,?,?,?,?,?,?)", (key, plain, synced, None, source if plain or instrumental else None,
                                              None, instrumental, time.time()))
    return {"found": bool(plain or instrumental), "plain": plain, "synced": synced,
            "instrumental": bool(instrumental), "source": source, "lang": None}


# ---------------------------------------------------------------- Übersetzung

def _translate_text(text: str) -> tuple[str, str]:
    """Text ins Deutsche übersetzen. Gibt (Übersetzung, erkannte Sprache) zurück."""
    chunks, cur = [], ""
    for line in text.split("\n"):
        if len(cur) + len(line) > 3500 and cur:
            chunks.append(cur)
            cur = ""
        cur += line + "\n"
    if cur:
        chunks.append(cur)
    out, lang = [], None
    for c in chunks:
        d = _get(TRANSLATE, {"client": "gtx", "sl": "auto", "tl": "de", "dt": "t"}, data={"q": c})
        out.append("".join(seg[0] for seg in d[0] if seg and seg[0]))
        lang = lang or d[2]
    return "".join(out), lang or ""


def translate(artist: str, title: str) -> dict:
    key = _key(artist, title)
    r = db.connect().execute("SELECT * FROM lyrics WHERE key=?", (key,)).fetchone()
    if not r or not r["plain"]:
        return {"lang": None, "lines": None}
    if r["lang"] and (r["de"] or r["lang"] == "de"):
        return {"lang": r["lang"], "lines": json.loads(r["de"]) if r["de"] else None}
    orig = r["plain"].split("\n")
    try:
        de, lang = _translate_text(r["plain"])
    except Exception as e:
        log.warning("Übersetzung nicht möglich: %s", e)
        return {"lang": None, "lines": None, "error": "Die Übersetzung ist gerade nicht erreichbar."}
    lines = None
    if not lang.startswith("de"):
        tr = [l.strip() for l in de.split("\n")]
        o_full = [i for i, l in enumerate(orig) if l.strip()]
        t_full = [l for l in tr if l]
        if len(o_full) == len(t_full):
            lines = [""] * len(orig)
            for i, l in zip(o_full, t_full):
                lines[i] = l
        else:  # Zeilen passen nicht zusammen: Übersetzung als Block
            lines = {"block": de.strip()}
    with db.writing() as w:
        w.execute("UPDATE lyrics SET lang=?, de=? WHERE key=?",
                  (lang or "?", json.dumps(lines, ensure_ascii=False) if lines else None, key))
    return {"lang": lang, "lines": lines}
