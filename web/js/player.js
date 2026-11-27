// Wiedergabe: eigene Dateien im Browser (<audio>), Spotify-Titel über Spotify
// (Browser-Player am Mac, Spotify Connect am iPhone). Eine gemeinsame Warteschlange.
import { api, store } from './lib.js';
import * as spotify from './spotify.js';

export class Player extends EventTarget {
  constructor(audio) {
    super();
    this.audio = audio;
    this.queue = [];      // Titel-Objekte
    this.order = [];      // Abspielreihenfolge (Indizes in queue)
    this.pos = -1;        // Position in order
    this.shuffle = false;
    this.repeat = 'off';  // off | all | one
    this.engine = 'local';
    this.sp = { pos: 0, dur: 0, paused: true };
    this.spTimer = null;
    this.audio.volume = store.get('volume', 1);

    const emit = (type) => this.dispatchEvent(new Event(type));
    this.audio.addEventListener('timeupdate', () => emit('time'));
    this.audio.addEventListener('durationchange', () => emit('time'));
    this.audio.addEventListener('play', () => emit('state'));
    this.audio.addEventListener('pause', () => emit('state'));
    this.audio.addEventListener('ended', () => this.onEnded());
    this.audio.addEventListener('error', () => { if (this.engine === 'local' && this.audio.getAttribute('src')) this.fail('Diese Datei lässt sich nicht abspielen.'); });

    spotify.on((ev) => {
      if (this.engine !== 'spotify') return;
      if (ev === 'ended') this.onEnded();
      else if (ev === 'state') this.pollSpotify(true);
      else if (ev?.type === 'remote-track') this.followRemote(ev.uri);
      else if (ev?.type === 'error') this.fail(ev.message);
    });

    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      ms.setActionHandler('play', () => this.play());
      ms.setActionHandler('pause', () => this.pause());
      ms.setActionHandler('previoustrack', () => this.prev());
      ms.setActionHandler('nexttrack', () => this.next());
      try { ms.setActionHandler('seekto', (e) => this.seekTo(e.seekTime)); } catch { /* ältere Browser */ }
    }
  }

  get current() { return this.pos >= 0 ? this.queue[this.order[this.pos]] : null; }
  get playing() { return this.engine === 'spotify' ? !this.sp.paused : !this.audio.paused; }

  time() {
    if (this.engine === 'spotify') return { pos: this.sp.pos, dur: this.sp.dur || this.current?.duration || 0 };
    return { pos: this.audio.currentTime || 0, dur: this.audio.duration || this.current?.duration || 0 };
  }

  fail(message) {
    const e = new Event('error');
    e.message = message;
    this.dispatchEvent(e);
  }

  /** Neue Warteschlange setzen und ab Titel `start` spielen. Direkt aus einem Klick aufrufen. */
  playList(tracks, start = 0) {
    spotify.activate();
    this.queue = tracks.slice();
    this.order = this.queue.map((_, i) => i);
    if (this.shuffle) this.reshuffle(start);
    this.pos = this.shuffle ? 0 : start;
    this.load(true);
  }

  enqueue(tracks, next = false) {
    const base = this.queue.length;
    this.queue.push(...tracks);
    const idx = tracks.map((_, i) => base + i);
    if (next && this.pos >= 0) this.order.splice(this.pos + 1, 0, ...idx);
    else this.order.push(...idx);
    if (this.pos < 0) { this.pos = 0; this.load(true); }
    this.dispatchEvent(new Event('queue'));
  }

  jump(orderPos) { spotify.activate(); this.pos = orderPos; this.load(true); }

  reshuffle(keepIndex) {
    const rest = this.order.filter((i) => i !== keepIndex);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    this.order = keepIndex === undefined || keepIndex < 0 ? rest : [keepIndex, ...rest];
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    const cur = this.pos >= 0 ? this.order[this.pos] : -1;
    if (this.shuffle) { this.reshuffle(cur); this.pos = cur >= 0 ? 0 : -1; }
    else { this.order = this.queue.map((_, i) => i); this.pos = cur; }
    this.dispatchEvent(new Event('queue'));
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.dispatchEvent(new Event('queue'));
  }

  load(autoplay) {
    const t = this.current;
    if (!t) return;
    if (t.source === 'spotify') {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.engine = 'spotify';
      this.sp = { pos: 0, dur: t.duration || 0, paused: false };
      // Bei Spotify Connect die folgenden Spotify-Titel gleich mitgeben (iPhone spielt dann auch gesperrt weiter).
      const uris = [t.uri];
      if (spotify.playbackMode() === 'connect' && this.repeat !== 'one') {
        for (let k = this.pos + 1; k < this.order.length; k++) {
          const n = this.queue[this.order[k]];
          if (n.source !== 'spotify') break;
          uris.push(n.uri);
        }
      }
      spotify.play(uris, this.audio.volume).catch((e) => { this.sp.paused = true; this.fail(e.message); this.dispatchEvent(new Event('state')); });
      this.startPolling();
    } else {
      if (this.engine === 'spotify') spotify.stop();
      this.stopPolling();
      this.engine = 'local';
      this.audio.src = api.streamUrl(t.id);
      if (autoplay) this.audio.play().catch(() => {});
    }
    this.updateMediaSession();
    this.dispatchEvent(new Event('track'));
    this.dispatchEvent(new Event('state'));
  }

  startPolling() {
    this.stopPolling();
    this.spTimer = setInterval(() => this.pollSpotify(), spotify.playbackMode() === 'connect' ? 2000 : 1000);
  }
  stopPolling() { clearInterval(this.spTimer); this.spTimer = null; }

  async pollSpotify(fromEvent) {
    if (this.engine !== 'spotify') return;
    const s = await spotify.position().catch(() => null);
    if (!s) return;
    const wasPaused = this.sp.paused;
    this.sp = { pos: s.pos, dur: s.dur, paused: s.paused };
    this.dispatchEvent(new Event('time'));
    if (wasPaused !== s.paused || fromEvent) this.dispatchEvent(new Event('state'));
  }

  /** Spotify Connect hat selbst zum nächsten Titel unserer Liste gewechselt. */
  followRemote(uri) {
    for (let k = this.pos + 1; k < this.order.length; k++) {
      if (this.queue[this.order[k]].uri === uri) {
        this.pos = k;
        this.updateMediaSession();
        this.dispatchEvent(new Event('track'));
        return;
      }
    }
  }

  play() {
    if (!this.current) return;
    if (this.engine === 'spotify') { this.sp.paused = false; spotify.resume(); this.dispatchEvent(new Event('state')); }
    else this.audio.play().catch(() => {});
  }
  pause() {
    if (this.engine === 'spotify') { this.sp.paused = true; spotify.pause(); this.dispatchEvent(new Event('state')); }
    else this.audio.pause();
  }
  toggle() { this.playing ? this.pause() : this.play(); }

  next() {
    if (this.pos < this.order.length - 1) { this.pos++; this.load(true); }
    else if (this.repeat === 'all' && this.order.length) { this.pos = 0; this.load(true); }
    else { this.pause(); }
  }

  prev() {
    if (this.time().pos > 3 || this.pos <= 0) { this.seekTo(0); return; }
    this.pos--; this.load(true);
  }

  onEnded() {
    if (this.repeat === 'one') { this.seekTo(0); if (this.engine === 'spotify') this.load(true); else this.play(); return; }
    this.next();
  }

  seekTo(sec) {
    if (this.engine === 'spotify') { this.sp.pos = sec; spotify.seek(sec); this.dispatchEvent(new Event('time')); }
    else this.audio.currentTime = sec;
  }
  seekBy(delta) { this.seekTo(Math.max(0, this.time().pos + delta)); }
  seekFraction(f) { const d = this.time().dur; if (d) this.seekTo(f * d); }
  setVolume(v) { this.audio.volume = v; spotify.setVolume(v); store.set('volume', v); }

  upcoming() { return this.order.slice(this.pos).map((qi, k) => ({ track: this.queue[qi], orderPos: this.pos + k })); }

  updateMediaSession() {
    const t = this.current;
    if (!t || !('mediaSession' in navigator)) return;
    const artwork = t.image
      ? [{ src: t.imageLarge || t.image, sizes: '640x640', type: 'image/jpeg' }]
      : t.album_id ? [300, 600].map((s) => ({ src: `/api/cover/${t.album_id}?s=${s}`, sizes: `${s}x${s}`, type: 'image/jpeg' })) : [];
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album || '', artwork });
  }
}
