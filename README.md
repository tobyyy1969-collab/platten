# Plattenregal

Eine eigene Oberfläche für deine FLAC-Sammlung auf dem Linux-Homeserver: Cover-Raster, Sampler-Ansicht, Interpreten, Playlists, Lyrics und Wiedergabe direkt im Browser in voller FLAC-Qualität.

## So ist es aufgebaut

```
Laptop (Browser)  ──►  http://SERVER:8080  ──►  nginx (Plattenregal-Oberfläche)
                                                   │  /rest/…
                                                   ▼
                                                Navidrome (Musikserver, liest /music nur lesend)
                                                   │
                                                   ▼
                                                deine FLAC-Ordner
```

* **Navidrome** (Open Source) übernimmt das Einlesen der Tags und Cover, die Datenbank, Bewertungen, Favoriten, Playlists und Lyrics. Es scannt neue Alben stündlich und bemerkt Änderungen im Ordner sofort.
* **Plattenregal** ist die eigene Oberfläche davor. Sie spricht mit Navidrome über die offene Subsonic-Schnittstelle. Später kommt hier Spotify dazu (Schritt 2).
* Deine Musikdateien werden **nur gelesen**, nie verändert.

## Installation auf dem Linux-Server

Voraussetzung: Docker mit dem Compose-Plugin (`docker compose version` sollte eine Version zeigen).

1. Das Repo auf den Server holen:
   ```bash
   git clone https://github.com/tobyyy1969-collab/platten.git ~/plattenregal
   ```
   (Da das Repo privat ist, fragt git nach deinem GitHub-Namen und einem Zugriffstoken als Passwort.)
2. Einstellungen anlegen:
   ```bash
   cd ~/plattenregal
   cp .env.example .env
   nano .env        # MUSIC_DIR auf deinen Musikordner setzen, PUID/PGID mit "id -u" und "id -g" prüfen
   ```
3. Starten:
   ```bash
   docker compose up -d
   ```
4. Im Browser am Laptop **http://SERVER-IP:4533** öffnen (Navidrome) und den ersten Benutzer anlegen. Dieser wird Administrator. Der erste Scan läuft automatisch; bei ca. 1.000 Alben dauert er einige Minuten.
5. Dann **http://SERVER-IP:8080** öffnen und mit demselben Benutzer anmelden. Fertig.

Aktualisieren: `git pull && docker compose pull && docker compose up -d`. Stoppen: `docker compose down`.

## Was die Oberfläche kann

| Bereich | Funktionen |
|---|---|
| **Meine Alben** | Cover-Raster, Sortierung nach Interpret, Titel, Jahr, zuletzt hinzugefügt, Bewertung, zuletzt gespielt. Filter nach Text, Genre, Favoriten und „mit / ohne / nur Sampler“. „Jetzt wiedergeben“ spielt einen Zufallsmix aus der aktuellen Ansicht. |
| **Album** | Großes Cover (anklickbar), Titelliste mit CD-Trennung, Format (z. B. FLAC 16/44,1), Bewertung, Favorit, Abspielen, Zufällig, Als Nächstes, Warteschlange, zu Playlist. |
| **Sampler** | Eigene Ansicht. Auf Samplern steht bei jedem Titel der Interpret, verlinkt auf seine Seite. |
| **Interpreten** | Alphabetisch mit Sprungleiste. Optional auch Interpreten, die nur auf Samplern vorkommen. Die Interpretenseite zeigt eigene Alben **und „Auf Samplern“** mit genau den Titeln dieses Interpreten. |
| **Playlists** | Anlegen, Titel oder ganze Alben hinzufügen, entfernen, umbenennen, löschen. Sie liegen in Navidrome und gelten damit auch in anderen Subsonic-Apps. |
| **Lyrics** | Rechtes Seitenfenster. Synchronisierte Lyrics laufen mit und lassen sich anklicken, um zu springen. |
| **Player** | Zufall, Wiederholen (alle / einen), Warteschlange, Lautstärke, Medientasten der Tastatur. Leertaste = Pause, Shift+Pfeil = Titel vor/zurück, `/` = Suche. |

Hell- und Dunkelmodus folgen der Einstellung deines Laptops.

## Wie deine Tags genutzt werden

* **Sampler** werden erkannt, wenn `COMPILATION=1` gesetzt ist oder der Album-Interpret „Various Artists“ heißt (MusicBrainz Picard macht beides automatisch).
* **Cover**: eingebettet oder als `cover.jpg` / `folder.jpg` im Albumordner.
* **Lyrics**: aus dem Tag `LYRICS` (gern im LRC-Format mit Zeitmarken) oder aus einer `.lrc`-Datei mit gleichem Namen neben der FLAC-Datei.
* **Mehrere CDs**: über `DISCNUMBER`.
* **Künstlerfotos** holt Navidrome automatisch aus dem Netz (Deezer). Mit einem Last.fm-Schlüssel in `.env` kommen Biografien dazu.

Wenn ein Album falsch einsortiert ist, Tags korrigieren. Navidrome bemerkt die Änderung von selbst.

## Schritt 2: Spotify (geplant)

* Anmeldung mit deinem Spotify-Premium-Konto über die offizielle Spotify-Schnittstelle (Web API) und Wiedergabe im Browser über das Spotify Web Playback SDK.
* Gemeinsame Bibliothek: deine gespeicherten Spotify-Alben und deine FLACs in einem Raster, je Album mit Quelle „Lokal“ oder „Spotify“.
* Abgleich: Für jedes eigene Album wird bei Spotify gesucht. Daraus entstehen die Ansichten „Fehlt bei Spotify“ (deine Lücken-Füller) und „Doppelt“. Bei Dopplungen wird die eigene FLAC bevorzugt.
* Voraussetzung: Spotify verlangt für die Anmeldung und das Abspielen eine **HTTPS-Adresse**. Dafür kommt ein kleiner Caddy-Server mit eigenem Zertifikat dazu; ein Spotify-Entwicklerzugang (kostenlos) ist nötig.

## Dateien

```
docker-compose.yml   Navidrome + Webserver
nginx.conf           liefert die Oberfläche aus und reicht /rest an Navidrome weiter
.env.example         Vorlage für deine Einstellungen
web/                 die Oberfläche (HTML, CSS, JavaScript, ohne Build-Schritt)
```

## Screenshots

![Meine Alben](docs/screenshots/1-alben.png)
![Sampler](docs/screenshots/2-sampler.png)
![Interpret mit „Auf Samplern“](docs/screenshots/3-interpret.png)
![Lyrics](docs/screenshots/4-lyrics.png)
