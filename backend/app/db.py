"""SQLite-Datenbank der Bibliothek."""
import sqlite3
import threading
from contextlib import contextmanager

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS tracks(
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  dir TEXT NOT NULL,
  mtime REAL, size INTEGER,
  format TEXT, title TEXT, artist TEXT, albumartist TEXT, album TEXT,
  album_id TEXT, disc INTEGER, track INTEGER, year INTEGER, genre TEXT,
  duration REAL, bitrate INTEGER, samplerate INTEGER, bitdepth INTEGER,
  compilation INTEGER DEFAULT 0, picture INTEGER DEFAULT 0, lyrics INTEGER DEFAULT 0,
  added REAL
);
CREATE INDEX IF NOT EXISTS tracks_album ON tracks(album_id);
CREATE INDEX IF NOT EXISTS tracks_artist ON tracks(artist);

CREATE TABLE IF NOT EXISTS albums(
  id TEXT PRIMARY KEY,
  title TEXT, artist TEXT, year INTEGER, genre TEXT,
  compilation INTEGER, formats TEXT, quality TEXT,
  track_count INTEGER, duration REAL,
  cover_path TEXT, cover_track INTEGER,
  added REAL
);
CREATE INDEX IF NOT EXISTS albums_artist ON albums(artist);

CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  kind UNINDEXED, ref UNINDEXED, title, artist, album,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
"""

_local = threading.local()
write_lock = threading.Lock()


def connect() -> sqlite3.Connection:
    con = getattr(_local, "con", None)
    if con is None:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(config.DATA_DIR / "bulldogbeats.db", timeout=30)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=NORMAL")
        con.execute("PRAGMA foreign_keys=ON")
        _local.con = con
    return con


def init() -> None:
    con = connect()
    con.executescript(SCHEMA)
    con.commit()


@contextmanager
def writing():
    """Nur ein Schreibvorgang gleichzeitig (Einlesen läuft im Hintergrund)."""
    with write_lock:
        con = connect()
        try:
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise
