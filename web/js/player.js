// Wiedergabe auf diesem Gerät: Warteschlange, Zufall, Wiederholen, Sperrbildschirm-Steuerung.
import { api, store } from './lib.js';

export class Player extends EventTarget {
  constructor(audio) {
    super();
    this.audio = audio;
    this.queue = [];      // Titel-Objekte: {id, title, artist, album, album_id, format, duration, ...}
    this.order = [];      // Abspielreihenfolge (Indizes in queue), bei Zufall gemischt
    this.pos = -1;        // Position in order
    this.shuffle = false;
    this.repeat = 'off';  // off | all | one
    this.audio.volume = store.get('volume', 1);

    const emit = (type) => this.dispatchEvent(new Event(type));
    this.audio.addEventListener('timeupdate', () => emit('time'));
    this.audio.addEventListener('durationchange', () => emit('time'));
    this.audio.addEventListener('play', () => emit('state'));
    this.audio.addEventListener('pause', () => emit('state'));
    this.audio.addEventListener('ended', () => this.onEnded());
    this.audio.addEventListener('error', () => { if (this.current) this.next(); });

    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      ms.setActionHandler('play', () => this.play());
      ms.setActionHandler('pause', () => this.pause());
      ms.setActionHandler('previoustrack', () => this.prev());
      ms.setActionHandler('nexttrack', () => this.next());
      try { ms.setActionHandler('seekto', (e) => { this.audio.currentTime = e.seekTime; }); } catch { /* ältere Browser */ }
    }
  }

  get current() { return this.pos >= 0 ? this.queue[this.order[this.pos]] : null; }
  get playing() { return !this.audio.paused; }

  /** Neue Warteschlange setzen und ab Titel `start` spielen. */
  playList(tracks, start = 0) {
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

  jump(orderPos) { this.pos = orderPos; this.load(true); }

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
    this.audio.src = api.streamUrl(t.id);
    if (autoplay) this.audio.play().catch(() => {});
    this.updateMediaSession();
    this.dispatchEvent(new Event('track'));
  }

  play() { if (this.current) this.audio.play().catch(() => {}); }
  pause() { this.audio.pause(); }
  toggle() { this.playing ? this.pause() : this.play(); }

  next() {
    if (this.pos < this.order.length - 1) { this.pos++; this.load(true); }
    else if (this.repeat === 'all' && this.order.length) { this.pos = 0; this.load(true); }
    else { this.pause(); }
  }

  prev() {
    if (this.audio.currentTime > 3 || this.pos <= 0) { this.audio.currentTime = 0; return; }
    this.pos--; this.load(true);
  }

  onEnded() {
    if (this.repeat === 'one') { this.audio.currentTime = 0; this.play(); return; }
    this.next();
  }

  seekFraction(f) { if (isFinite(this.audio.duration)) this.audio.currentTime = f * this.audio.duration; }
  setVolume(v) { this.audio.volume = v; store.set('volume', v); }

  upcoming() { return this.order.slice(this.pos).map((qi, k) => ({ track: this.queue[qi], orderPos: this.pos + k })); }

  updateMediaSession() {
    const t = this.current;
    if (!t || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album || '',
      artwork: t.album_id ? [300, 600].map((s) => ({ src: `/api/cover/${t.album_id}?s=${s}`, sizes: `${s}x${s}`, type: 'image/jpeg' })) : [],
    });
  }
}
