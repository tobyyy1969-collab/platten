"""Einstellungen aus Umgebungsvariablen (siehe .env.example)."""
import os
from pathlib import Path


def _dirs(value: str) -> list[Path]:
    return [Path(p.strip()) for p in value.replace(";", ",").split(",") if p.strip()]


# Ein oder mehrere Musikordner, durch Komma getrennt. Im Docker-Container
# werden die Festplatten nach /music/... eingebunden.
MUSIC_DIRS: list[Path] = _dirs(os.environ.get("MUSIC_DIRS", "/music"))

# Hier liegen Datenbank und Cover-Zwischenspeicher.
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))

# Oberfläche (PWA). Im Container unter /app/web.
WEB_DIR = Path(os.environ.get("WEB_DIR", Path(__file__).resolve().parents[2] / "web"))

# Automatisch neu einlesen alle N Stunden (0 = aus). Geänderte Dateien
# werden dabei erkannt, unveränderte übersprungen.
RESCAN_HOURS = float(os.environ.get("RESCAN_HOURS", "6"))

# Spotify (Stufe 2): öffentliche Client-ID der Spotify-Developer-App.
SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")

AUDIO_EXT = {".flac": "FLAC", ".mp3": "MP3"}
IMAGE_NAMES = ("cover", "folder", "front", "album", "albumart", "albumartlarge")
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp")
