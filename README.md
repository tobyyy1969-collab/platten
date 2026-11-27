# BulldogBeats

Deine Musik in einer hellen, ruhigen App für MacBook und iPhone: FLAC-Alben und MP3s vom eigenen Server, später zusammen mit Spotify. Im Mittelpunkt stehen die Alben.

## Was Stufe 1 kann

| Bereich | Funktionen |
|---|---|
| **Einlesen** | Liest alle FLAC- und MP3-Dateien, auch in Unterordnern (CD1/CD2, Disc 2 …). Alben werden über die Tags gebildet, nicht über Ordner. Dasselbe Album als FLAC und MP3 erscheint nur einmal, mit beiden Quellen. Sampler werden erkannt. Fehlende Tags werden aus Datei- und Ordnernamen ergänzt. Nur geänderte Dateien werden neu gelesen. Ist eine Festplatte nicht eingebunden, bleibt die Bibliothek erhalten. |
| **Übersicht** | Alben (endlos scrollen), Interpreten, Jahre. Sortieren nach Interpret, Titel, Jahr, neu hinzugefügt. Filter nach Quelle. |
| **Album** | Cover, Titelliste mit CDs, Quellenauswahl (FLAC oder MP3), Abspielen, Zufällig, Als Nächstes, Warteschlange. |
| **Interpret** | Alle eigenen Alben und Auftritte auf Samplern. |
| **Suche** | Interpreten, Alben und Titel; Umlaute egal („gronemeyer“ findet „Grönemeyer“). Treffer nach Quelle getrennt. |
| **Wiedergabe** | Auf dem Gerät (auch Bluetooth), Warteschlange, Zufall, Wiederholen, Sperrbildschirm-Steuerung auf dem iPhone. Mac: Leertaste = Pause, ← → = Titel, Shift + ← → = 10 Sekunden, ⌘F = Suche. |

Kommt als Nächstes: Spotify (Stufe 2), Cover und Infos aus dem Netz, Liedtexte, Biografien, Lückenanzeige (Stufe 3), Tag-Bearbeitung und Offline-Download (Stufe 4).

## Installation auf dem Server

Voraussetzung: Docker mit Compose (`docker compose version` zeigt eine Version) und Tailscale.

```bash
git clone https://github.com/tobyyy1969-collab/platten.git bulldogbeats
cd bulldogbeats
cp .env.example .env
nano .env                 # FLAC_DIR und MP3_DIR eintragen, PUID/PGID mit "id -u" und "id -g" prüfen
docker compose up -d --build
```

Im Heimnetz läuft BulldogBeats dann unter `http://SERVER-IP:8484`. Das erste Einlesen läuft von selbst; bei 100.000 MP3s kann es eine Weile dauern. Den Fortschritt siehst du links unten.

### Sichere Adresse über Tailscale (für iPhone und Spotify nötig)

Einmalig auf dem Server:

```bash
sudo tailscale serve --bg 8484
```

Danach ist BulldogBeats überall, wo Tailscale an ist, unter `https://<servername>.<tailnet>.ts.net` erreichbar, mit gültigem Zertifikat. Voraussetzung: Im Tailscale-Admin unter DNS sind MagicDNS und „HTTPS Certificates“ eingeschaltet.

### Auf dem iPhone als App

Die https-Adresse in Safari öffnen, Teilen-Knopf, „Zum Home-Bildschirm“.

### Aktualisieren

```bash
git pull && docker compose up -d --build
```

## Aufbau

```
backend/app/      Python (FastAPI): Einlesen, Datenbank (SQLite), Cover, Streaming
web/              die App (HTML, CSS, JavaScript, ohne Build-Schritt)
data/             Datenbank und Cover-Zwischenspeicher (entsteht beim Start)
```

Die Musikdateien werden in Stufe 1 nur gelesen, nie verändert.
