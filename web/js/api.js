// Zugriff auf den Musikserver (Navidrome) über die Subsonic-/OpenSubsonic-Schnittstelle.
// Die Oberfläche läuft unter derselben Adresse wie der Server (nginx leitet /rest weiter),
// deshalb gibt es keine CORS-Probleme.
import { md5 } from './md5.js';

const CLIENT = 'plattenregal';
const API_VERSION = '1.16.1';
const STORE_KEY = 'plattenregal.login';

let creds = null;

function loadCreds() {
  try { creds = JSON.parse(localStorage.getItem(STORE_KEY)); } catch { creds = null; }
  return creds;
}

function randomSalt() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

function authParams() {
  if (!creds) throw new Error('Nicht angemeldet');
  return { u: creds.user, t: creds.token, s: creds.salt, v: API_VERSION, c: CLIENT };
}

export function url(method, params = {}) {
  const sp = new URLSearchParams({ ...authParams(), f: 'json' });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach(x => sp.append(k, x));
    else sp.append(k, v);
  }
  return `rest/${method}?${sp}`;
}

export async function call(method, params = {}) {
  const res = await fetch(url(method, params));
  if (!res.ok) throw new Error(`Server antwortet mit ${res.status}`);
  const data = (await res.json())['subsonic-response'];
  if (!data || data.status !== 'ok') {
    const err = new Error(data?.error?.message || 'Unbekannter Fehler');
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

export const isLoggedIn = () => !!loadCreds();

export async function login(user, password) {
  const salt = randomSalt();
  creds = { user, salt, token: md5(password + salt) };
  try {
    await call('ping');
  } catch (e) {
    creds = null;
    throw e.code === 40 ? new Error('Benutzername oder Passwort falsch') : e;
  }
  localStorage.setItem(STORE_KEY, JSON.stringify(creds));
}

export function logout() {
  creds = null;
  localStorage.removeItem(STORE_KEY);
}

export const userName = () => creds?.user ?? '';

export const coverUrl = (id, size = 300) => id ? url('getCoverArt', { id, size }) : '';
// format=raw: die FLAC-Datei wird unverändert ausgeliefert (keine Umwandlung, volle Qualität).
export const streamUrl = id => url('stream', { id, format: 'raw' });

// ---- Bibliothek --------------------------------------------------------------

export async function allAlbums(onProgress) {
  const size = 500;
  const out = [];
  for (let offset = 0; ; offset += size) {
    const d = await call('getAlbumList2', { type: 'alphabeticalByArtist', size, offset });
    const page = d.albumList2?.album ?? [];
    out.push(...page);
    onProgress?.(out.length);
    if (page.length < size) break;
  }
  return out;
}

export const album = async id => (await call('getAlbum', { id })).album;
export const artist = async id => (await call('getArtist', { id })).artist;

export async function allArtists() {
  // search3 mit leerer Suche liefert alle Interpreten, auch die, die nur auf Samplern vorkommen.
  const d = await call('search3', { query: '', artistCount: 20000, albumCount: 0, songCount: 0 });
  return d.searchResult3?.artist ?? [];
}

export async function search(query) {
  const d = await call('search3', { query, artistCount: 20, albumCount: 40, songCount: 60 });
  return d.searchResult3 ?? {};
}

export async function lyrics(song) {
  try {
    const d = await call('getLyricsBySongId', { id: song.id });
    const list = d.lyricsList?.structuredLyrics ?? [];
    return list.find(l => l.synced) || list[0] || null;
  } catch {
    const d = await call('getLyrics', { artist: song.artist, title: song.title });
    const text = d.lyrics?.value;
    return text ? { synced: false, line: text.split('\n').map(value => ({ value })) } : null;
  }
}

export const star = (params, on) => call(on ? 'star' : 'unstar', params);
export const setRating = (id, rating) => call('setRating', { id, rating });
export const scrobble = (id, submission) => call('scrobble', { id, submission });

// ---- Playlists ---------------------------------------------------------------

export const playlists = async () => (await call('getPlaylists')).playlists?.playlist ?? [];
export const playlist = async id => (await call('getPlaylist', { id })).playlist;
export const createPlaylist = (name, songIds = []) => call('createPlaylist', { name, songId: songIds });
export const addToPlaylist = (playlistId, songIds) => call('updatePlaylist', { playlistId, songIdToAdd: songIds });
export const removeFromPlaylist = (playlistId, index) => call('updatePlaylist', { playlistId, songIndexToRemove: index });
export const renamePlaylist = (playlistId, name) => call('updatePlaylist', { playlistId, name });
export const deletePlaylist = id => call('deletePlaylist', { id });
