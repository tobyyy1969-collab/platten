# BulldogBeats

Deine Musik in einer hellen, ruhigen App für MacBook und iPhone: FLAC-Alben und MP3s vom eigenen Server, später zusammen mit Spotify. Im Mittelpunkt stehen die Alben.

## Was BulldogBeats kann

| Bereich | Funktionen |
|---|---|
| **Einlesen** | Liest alle FLAC- und MP3-Dateien, auch in Unterordnern (CD1/CD2, Disc 2 …). Alben werden über die Tags gebildet, nicht über Ordner. Dasselbe Album als FLAC und MP3 erscheint nur einmal, mit beiden Quellen. Sampler werden erkannt. Fehlende Tags werden aus Datei- und Ordnernamen ergänzt. Nur geänderte Dateien werden neu gelesen. Ist eine Festplatte nicht eingebunden, bleibt die Bibliothek erhalten. |
| **Übersicht** | Alben (endlos scrollen), Interpreten, Jahre. Sortieren nach Interpret, Titel, Jahr, neu hinzugefügt. Filter nach Quelle. |
| **Album** | Cover, Titelliste mit CDs, Quellenauswahl (FLAC oder MP3), Abspielen, Zufällig, Als Nächstes, Warteschlange. |
| **Interpret** | Alle eigenen Alben und Auftritte auf Samplern. |
| **Suche** | Interpreten, Alben und Titel; Umlaute egal („gronemeyer“ findet „Grönemeyer“). Treffer nach Quelle getrennt. |
| **Wiedergabe** | Auf dem Gerät (auch Bluetooth), Warteschlange, Zufall, Wiederholen, Sperrbildschirm-Steuerung auf dem iPhone. Mac: Leertaste = Pause, ← → = Titel, Shift + ← → = 10 Sekunden, ⌘F = Suche. |

| **Spotify** | Anmelden im Browser (links unten „Mit Spotify verbinden“, nur über die https-Adresse). Gespeicherte Spotify-Alben erscheinen in der Übersicht; dasselbe Album lokal und bei Spotify nur einmal, mit Quellenauswahl. Eigene Alben werden bei Spotify gesucht und lassen sich dort speichern. Suche zeigt erst Spotify, dann FLAC, dann MP3. Spotify-Playlists ansehen, abspielen, neu anlegen, Alben hinzufügen. Wiedergabe am Mac direkt im Browser, am iPhone über die Spotify-App (Spotify Connect, Gerät wählbar). Spotify Premium nötig. |

Kommt als Nächstes: Cover und Infos aus dem Netz, Liedtexte, Biografien, Lückenanzeige (Stufe 3), Tag-Bearbeitung und Offline-Download (Stufe 4).

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

### Mit NordVPN auf dem Mac (sichere Adresse im Heimnetz)

NordVPN und Tailscale vertragen sich auf dem Mac nicht. Damit die https-Adresse zu Hause trotzdem geht, liefert ein kleiner Caddy-Dienst sie auch direkt im Heimnetz aus (Zertifikat kommt von Tailscale):

1. In `.env` auf dem Server ergänzen: `COMPOSE_PROFILES=heimnetz`, `LAN_IP=<Server-IP>`, `TS_HOST=<servername>.<tailnet>.ts.net`, dann `docker compose up -d`.
2. Auf dem Mac einmalig: `echo "<Server-IP> <servername>.<tailnet>.ts.net" | sudo tee -a /etc/hosts`
3. Firefox braucht unter Systemeinstellungen → Datenschutz & Sicherheit → Lokales Netzwerk die Erlaubnis.

Unterwegs gilt dann: NordVPN aus, Tailscale an.

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
