// Wiedergabe und Warteschlange. Lokale FLACs laufen über ein <audio>-Element,
// Spotify-Titel über den Spotify-Player im Browser (Web Playback SDK).
// Jeder Titel trägt "source": "local" (Standard) oder "spotify".
import * as api from './api.js';
import * as spotify from './spotify.js';

const audio = new Audio();
audio.preload = 'auto';

const state = {
  queue: [],
  index: -1,
  shuffle: false,
  repeat: 'off', // off | all | one
  engine: null,  // 'local' | 'spotify'
  sp: { pos: 0, dur: 0, paused: true, at: 0 }, // letzter bekannter Spotify-Stand
};

const listeners = new Set();
const emit = (what, detail) => listeners.forEach(fn => fn(what, detail));
export const on = fn => listeners.add(fn);

export const audioEl = audio;
export const current = () => state.queue[state.index] ?? null;
export const queue = () => state.queue;
export const index = () => state.index;
export const settings = () => ({ shuffle: state.shuffle, repeat: state.repeat });
export const engine = () => state.engine;

export function isPlaying() {
  return state.engine === 'spotify' ? !state.sp.paused : !audio.paused;
}
export function position() {
  if (state.engine !== 'spotify') return audio.currentTime || 0;
  const s = state.sp;
  return s.paused ? s.pos : Math.min(s.dur, s.pos + (Date.now() - s.at) / 1000);
}
export function duration() {
  if (state.engine !== 'spotify') return audio.duration || current()?.duration || 0;
  return state.sp.dur || current()?.duration || 0;
}

let scrobbled = false;
let loadSeq = 0;

async function load(i, autoplay = true) {
  if (i < 0 || i >= state.queue.length) return;
  const seq = ++loadSeq;
  state.index = i;
  const song = state.queue[i];
  scrobbled = false;
  emit('track');
  updateMediaSession(song);

  if (song.source === 'spotify') {
    audio.pause();
    audio.removeAttribute('src');
    state.engine = 'spotify';
    state.sp = { pos: 0, dur: song.duration, paused: false, at: Date.now() };
    emit('state');
    try {
      // Folgende Spotify-Titel gleich mitgeben (iPhone: die Spotify-App spielt dann auch bei gesperrtem Bildschirm weiter)
      const run = [];
      for (let j = i; j < state.queue.length && state.queue[j].source === 'spotify'; j++) run.push(state.queue[j].uri);
      await spotify.play(run, audio.volume);
      if (seq !== loadSeq) return;
    } catch (e) {
      if (seq !== loadSeq) return;
      state.sp.paused = true;
      emit('error', e.message);
      emit('state');
    }
    return;
  }

  if (state.engine === 'spotify') spotify.stop();
  state.engine = 'local';
  audio.src = api.streamUrl(song.id);
  if (autoplay) audio.play().catch(() => {});
  api.scrobble(song.id, false).catch(() => {}); // "läuft gerade"
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Vor dem Abspielen aus einem Klick heraus aufrufen, damit der Browser Spotify-Ton erlaubt.
function unlock(songs) { if (songs.some(s => s.source === 'spotify')) spotify.activate(); }

export function playList(songs, start = 0) {
  if (!songs?.length) return;
  unlock(songs);
  if (state.shuffle) {
    const first = songs[start];
    state.queue = [first, ...shuffled(songs.filter((_, i) => i !== start))];
    start = 0;
  } else {
    state.queue = songs.slice();
  }
  load(start);
  emit('queue');
}

export function enqueue(songs) {
  unlock(songs);
  const wasEmpty = state.queue.length === 0;
  state.queue.push(...songs);
  emit('queue');
  if (wasEmpty) load(0);
}

export function playNext(songs) {
  if (state.queue.length === 0) return playList(songs);
  unlock(songs);
  state.queue.splice(state.index + 1, 0, ...songs);
  emit('queue');
}

export function jump(i) { unlock([state.queue[i]]); load(i); }

export function removeAt(i) {
  if (i === state.index) return;
  state.queue.splice(i, 1);
  if (i < state.index) state.index--;
  emit('queue');
}

export function clearQueue() {
  const cur = current();
  state.queue = cur ? [cur] : [];
  state.index = cur ? 0 : -1;
  emit('queue');
}

export function toggle() {
  if (!current()) return;
  if (state.engine === 'spotify') {
    spotify.activate();
    if (state.sp.paused) { spotify.resume(); state.sp.paused = false; state.sp.at = Date.now(); }
    else { state.sp.pos = position(); spotify.pause(); state.sp.paused = true; }
    emit('state');
    return;
  }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

export function next(auto = false) {
  if (auto && state.repeat === 'one') { seek(0); if (state.engine === 'spotify') spotify.resume(); else audio.play(); return; }
  if (state.index + 1 < state.queue.length) load(state.index + 1);
  else if (state.repeat === 'all' && state.queue.length) load(0);
  else if (auto) {
    if (state.engine === 'spotify') state.sp.paused = true; else audio.pause();
    emit('state');
  }
}

export function prev() {
  if (position() > 3 || state.index <= 0) { seek(0); return; }
  load(state.index - 1);
}

export function seek(sec) {
  if (!isFinite(sec)) return;
  if (state.engine === 'spotify') {
    spotify.seek(sec);
    state.sp.pos = sec;
    state.sp.at = Date.now();
    emit('time');
  } else audio.currentTime = sec;
}

export function setVolume(v) {
  audio.volume = v;
  spotify.setVolume(v);
  localStorage.setItem('plattenregal.volume', v);
}

export function toggleShuffle() {
  state.shuffle = !state.shuffle;
  if (state.shuffle && state.queue.length > 1) {
    const cur = current();
    const rest = state.queue.filter((_, i) => i !== state.index);
    state.queue = [cur, ...shuffled(rest)];
    state.index = 0;
    emit('queue');
  }
  emit('state');
}

export function cycleRepeat() {
  state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat];
  emit('state');
}

// ---------------------------------------------------------------- lokale Wiedergabe
audio.addEventListener('ended', () => next(true));
audio.addEventListener('play', () => emit('state'));
audio.addEventListener('pause', () => emit('state'));
audio.addEventListener('timeupdate', () => {
  if (state.engine !== 'local') return;
  emit('time');
  const song = current();
  // Als "gehört" zählen, wenn die Hälfte oder 4 Minuten erreicht sind.
  if (song && !scrobbled && audio.duration && (audio.currentTime > audio.duration / 2 || audio.currentTime > 240)) {
    scrobbled = true;
    api.scrobble(song.id, true).catch(() => {});
  }
});
audio.addEventListener('error', () => { if (state.engine === 'local' && audio.getAttribute('src')) emit('error', 'Titel konnte nicht abgespielt werden'); });

// ---------------------------------------------------------------- Spotify-Wiedergabe
spotify.on(async what => {
  if (what === 'ended' && state.engine === 'spotify') { next(true); return; }
  if (what?.type === 'remote-track' && state.engine === 'spotify') {
    // Die Spotify-App ist selbst zum nächsten Titel gesprungen: Anzeige nachziehen, ohne neu zu starten
    const j = state.queue.findIndex((s, k) => k > state.index && s.uri === what.uri);
    if (j >= 0) { state.index = j; updateMediaSession(state.queue[j]); emit('track'); }
    return;
  }
  if (what === 'state' && state.engine === 'spotify') {
    const p = await spotify.position();
    if (p) { state.sp = { ...p, at: Date.now() }; emit('state'); }
  }
  if (what?.type === 'error') emit('error', what.message);
});

// Fortschrittsanzeige für Spotify: lokal weiterzählen, alle paar Sekunden mit dem Player abgleichen.
let tick = 0;
setInterval(async () => {
  if (state.engine !== 'spotify' || !current()) return;
  if (++tick % 10 === 0) {
    const p = await spotify.position();
    if (p) state.sp = { ...p, at: Date.now() };
  }
  emit('time');
}, 300);

const savedVol = parseFloat(localStorage.getItem('plattenregal.volume'));
audio.volume = isFinite(savedVol) ? savedVol : 0.8;

function updateMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  const art = song.source === 'spotify'
    ? spotify.imageUrl(song, 512)
    : song.coverArt ? new URL(api.coverUrl(song.coverArt, 512), location.href).href : '';
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: song.artist,
    album: song.album,
    artwork: art ? [{ src: art, sizes: '512x512' }] : [],
  });
}

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => toggle());
  navigator.mediaSession.setActionHandler('pause', () => toggle());
  navigator.mediaSession.setActionHandler('nexttrack', () => next());
  navigator.mediaSession.setActionHandler('previoustrack', () => prev());
}
