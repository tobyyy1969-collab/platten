// Wiedergabe und Warteschlange. Spielt die FLAC-Dateien direkt im Browser ab.
// Für Schritt 2 (Spotify) bekommt jeder Titel ein Feld "source"; hier gibt es vorerst nur "local".
import * as api from './api.js';

const audio = new Audio();
audio.preload = 'auto';

const state = {
  queue: [],
  index: -1,
  shuffle: false,
  repeat: 'off', // off | all | one
};

const listeners = new Set();
const emit = (what) => listeners.forEach(fn => fn(what));
export const on = fn => listeners.add(fn);

export const audioEl = audio;
export const current = () => state.queue[state.index] ?? null;
export const queue = () => state.queue;
export const index = () => state.index;
export const isPlaying = () => !audio.paused;
export const settings = () => ({ shuffle: state.shuffle, repeat: state.repeat });

let scrobbled = false;

function load(i, autoplay = true) {
  if (i < 0 || i >= state.queue.length) return;
  state.index = i;
  const song = state.queue[i];
  scrobbled = false;
  audio.src = api.streamUrl(song.id);
  if (autoplay) audio.play().catch(() => {});
  api.scrobble(song.id, false).catch(() => {}); // "läuft gerade"
  updateMediaSession(song);
  emit('track');
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function playList(songs, start = 0) {
  if (!songs.length) return;
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
  const wasEmpty = state.queue.length === 0;
  state.queue.push(...songs);
  emit('queue');
  if (wasEmpty) load(0);
}

export function playNext(songs) {
  if (state.queue.length === 0) return playList(songs);
  state.queue.splice(state.index + 1, 0, ...songs);
  emit('queue');
}

export function jump(i) { load(i); }

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
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

export function next(auto = false) {
  if (auto && state.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (state.index + 1 < state.queue.length) load(state.index + 1);
  else if (state.repeat === 'all' && state.queue.length) load(0);
  else if (auto) { audio.pause(); emit('state'); }
}

export function prev() {
  if (audio.currentTime > 3 || state.index <= 0) { audio.currentTime = 0; return; }
  load(state.index - 1);
}

export function seek(sec) { if (isFinite(sec)) audio.currentTime = sec; }
export function setVolume(v) { audio.volume = v; localStorage.setItem('plattenregal.volume', v); }

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

audio.addEventListener('ended', () => next(true));
audio.addEventListener('play', () => emit('state'));
audio.addEventListener('pause', () => emit('state'));
audio.addEventListener('timeupdate', () => {
  emit('time');
  const song = current();
  // Als "gehört" zählen, wenn die Hälfte oder 4 Minuten erreicht sind.
  if (song && !scrobbled && audio.duration && (audio.currentTime > audio.duration / 2 || audio.currentTime > 240)) {
    scrobbled = true;
    api.scrobble(song.id, true).catch(() => {});
  }
});
audio.addEventListener('error', () => emit('error'));

const savedVol = parseFloat(localStorage.getItem('plattenregal.volume'));
audio.volume = isFinite(savedVol) ? savedVol : 0.8;

function updateMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: song.artist,
    album: song.album,
    artwork: song.coverArt ? [{ src: new URL(api.coverUrl(song.coverArt, 512), location.href).href, sizes: '512x512' }] : [],
  });
}

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('nexttrack', () => next());
  navigator.mediaSession.setActionHandler('previoustrack', () => prev());
}
