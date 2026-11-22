// Spotify-Anbindung: Anmeldung (OAuth mit PKCE, ohne Server-Geheimnis), Web API und Web Playback SDK.
// Hinweise zu den Spotify-Regeln (Stand 2026, Entwicklermodus):
//  * Anmeldung und Wiedergabe nur über HTTPS (oder http://127.0.0.1).
//  * Suche liefert höchstens 10 Treffer je Anfrage, Mehrfachabfragen (/albums?ids=) gibt es nicht mehr.
//  * Speichern in der Bibliothek über PUT/DELETE /me/library mit Spotify-URIs.

const API = 'https://api.spotify.com/v1';
const AUTH = 'https://accounts.spotify.com';
const SCOPES = [
  'streaming', 'user-read-private', 'user-read-email',
  'user-library-read', 'user-library-modify',
  'user-read-playback-state', 'user-modify-playback-state',
].join(' ');
const KEY_TOKEN = 'plattenregal.spotify.token';
const KEY_CLIENT = 'plattenregal.spotify.clientId';
const KEY_VERIFIER = 'plattenregal.spotify.verifier';
const KEY_ALBUMS = 'plattenregal.spotify.albums';

let clientId = '';
let token = null; // { access, refresh, expires }

const listeners = new Set();
const emit = what => listeners.forEach(fn => fn(what));
export const on = fn => listeners.add(fn);

// ---------------------------------------------------------------- Konfiguration
export const redirectUri = () => location.origin + location.pathname;
export const secureOk = () => window.isSecureContext && (location.protocol === 'https:' || location.hostname === '127.0.0.1');

export async function init() {
  try {
    const r = await fetch('config.json', { cache: 'no-store' });
    if (r.ok) clientId = (await r.json()).spotifyClientId || '';
  } catch {}
  if (!clientId) clientId = localStorage.getItem(KEY_CLIENT) || '';
  try { token = JSON.parse(localStorage.getItem(KEY_TOKEN)); } catch { token = null; }

  // Rückkehr von der Spotify-Anmeldung
  const params = new URLSearchParams(location.search);
  if (params.has('code') || params.has('error')) {
    const code = params.get('code');
    const err = params.get('error');
    history.replaceState(null, '', location.pathname + '#/spotify');
    if (code) await exchangeCode(code);
    else throw new Error(err === 'access_denied' ? 'Spotify-Anmeldung abgebrochen' : 'Spotify-Anmeldung fehlgeschlagen: ' + err);
  }
}

export const getClientId = () => clientId;
export function setClientId(id) { clientId = id.trim(); localStorage.setItem(KEY_CLIENT, clientId); }
export const isConnected = () => !!token?.refresh;

// ---------------------------------------------------------------- Anmeldung (PKCE)
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function login() {
  if (!clientId) throw new Error('Keine Spotify Client-ID eingetragen');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  localStorage.setItem(KEY_VERIFIER, verifier);
  const q = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri(),
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES,
  });
  location.href = `${AUTH}/authorize?${q}`;
}

async function tokenRequest(body) {
  const r = await fetch(`${AUTH}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, ...body }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(d.error_description || d.error || 'Spotify-Anmeldung fehlgeschlagen');
    e.code = d.error;
    throw e;
  }
  token = {
    access: d.access_token,
    refresh: d.refresh_token || token?.refresh,
    expires: Date.now() + (d.expires_in - 60) * 1000,
  };
  localStorage.setItem(KEY_TOKEN, JSON.stringify(token));
  emit('auth');
}

async function exchangeCode(code) {
  const verifier = localStorage.getItem(KEY_VERIFIER);
  localStorage.removeItem(KEY_VERIFIER);
  await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier });
}

let refreshing = null;
export async function accessToken() {
  if (!token) throw new Error('Nicht mit Spotify verbunden');
  if (Date.now() < token.expires) return token.access;
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh })
    .catch(e => {
      // Refresh-Token abgelaufen (Spotify: spätestens nach 6 Monaten) → neu anmelden
      if (e.code === 'invalid_grant') logout();
      throw e;
    })
    .finally(() => (refreshing = null));
  await refreshing;
  return token.access;
}

export function logout() {
  token = null;
  localStorage.removeItem(KEY_TOKEN);
  localStorage.removeItem(KEY_ALBUMS);
  sdkPlayer?.disconnect();
  sdkPlayer = null;
  deviceId = null;
  emit('auth');
}

// ---------------------------------------------------------------- Web API
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function call(path, { method = 'GET', body, query } = {}) {
  const url = new URL(path.startsWith('http') ? path : API + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, {
      method,
      headers: { Authorization: 'Bearer ' + await accessToken(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) {
      const wait = Math.min(60, parseInt(r.headers.get('Retry-After') || '2', 10));
      emit({ type: 'ratelimit', wait });
      await sleep(wait * 1000);
      continue;
    }
    if (r.status === 401 && attempt === 0) { token.expires = 0; continue; }
    if (r.status === 204 || r.status === 202) return null;
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      const e = new Error(d?.error?.message || `Spotify antwortet mit ${r.status}`);
      e.status = r.status;
      e.reason = d?.error?.reason;
      throw e;
    }
    return d;
  }
  throw new Error('Spotify ist gerade überlastet, bitte später erneut versuchen');
}

export const me = () => call('/me');

// ---------------------------------------------------------------- Umwandeln in das Format der Oberfläche
const bestImage = (images, size) => {
  if (!images?.length) return '';
  const sorted = images.slice().sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find(i => (i.width || 0) >= size) || sorted[sorted.length - 1]).url;
};
const joinArtists = arr => (arr ?? []).map(a => a.name).join(', ');

export function toAlbum(sa, addedAt) {
  return {
    id: 'sp:' + sa.id,
    source: 'spotify',
    spotifyId: sa.id,
    uri: sa.uri,
    name: sa.name,
    artist: joinArtists(sa.artists),
    artistNames: (sa.artists ?? []).map(a => a.name),
    spotifyArtistId: sa.artists?.[0]?.id,
    images: sa.images ?? [],
    year: parseInt(sa.release_date, 10) || undefined,
    songCount: sa.total_tracks,
    isCompilation: sa.album_type === 'compilation',
    created: addedAt,
    genre: '',
  };
}

export function toTrack(t, album) {
  return {
    id: 'sp:' + t.id,
    source: 'spotify',
    spotifyId: t.id,
    uri: t.uri,
    title: t.name,
    artist: joinArtists(t.artists),
    album: album?.name ?? t.album?.name,
    albumId: 'sp:' + (album?.spotifyId ?? t.album?.id),
    images: album?.images ?? t.album?.images ?? [],
    duration: Math.round((t.duration_ms || 0) / 1000),
    track: t.track_number,
    discNumber: t.disc_number,
    suffix: 'spotify',
  };
}

export const imageUrl = (item, size = 300) => bestImage(item.images, size);

// ---------------------------------------------------------------- Bibliothek
// Gespeicherte Alben werden zwischengespeichert, damit die Oberfläche sofort startet.
export function cachedAlbums() {
  try { return JSON.parse(localStorage.getItem(KEY_ALBUMS))?.albums ?? null; } catch { return null; }
}
export function cachedAt() {
  try { return JSON.parse(localStorage.getItem(KEY_ALBUMS))?.at ?? null; } catch { return null; }
}

export async function savedAlbums(onProgress) {
  const out = [];
  let next = '/me/albums';
  let query = { limit: 50, offset: 0, market: 'from_token' };
  while (next) {
    const d = await call(next, { query });
    for (const it of d.items ?? []) {
      const a = toAlbum(it.album, it.added_at);
      a.saved = true;
      out.push(a);
    }
    onProgress?.(out.length, d.total);
    next = d.next;
    query = undefined;
  }
  try { localStorage.setItem(KEY_ALBUMS, JSON.stringify({ at: Date.now(), albums: out })); } catch {}
  return out;
}

export async function album(spotifyId) {
  const a = await call(`/albums/${spotifyId}`, { query: { market: 'from_token' } });
  const alb = toAlbum(a);
  alb.label = a.label;
  const items = [...(a.tracks?.items ?? [])];
  let next = a.tracks?.next;
  while (next) { const d = await call(next); items.push(...(d.items ?? [])); next = d.next; }
  alb.song = items.map(t => toTrack(t, alb));
  alb.duration = alb.song.reduce((s, t) => s + t.duration, 0);
  return alb;
}

export async function search(q, type = 'album', limit = 10) {
  return call('/search', { query: { q, type, limit, market: 'from_token' } });
}

export async function artistAlbums(spotifyArtistId) {
  const out = [];
  let next = `/artists/${spotifyArtistId}/albums`;
  let query = { include_groups: 'album,single,compilation', limit: 50, market: 'from_token' };
  for (let page = 0; next && page < 4; page++) {
    const d = await call(next, { query });
    out.push(...(d.items ?? []).map(a => toAlbum(a)));
    next = d.next;
    query = undefined;
  }
  return out;
}

export async function saveAlbum(uri, on = true) {
  await call('/me/library', { method: on ? 'PUT' : 'DELETE', body: { uris: [uri] } });
  const cache = cachedAlbums();
  if (cache && !on) {
    localStorage.setItem(KEY_ALBUMS, JSON.stringify({ at: cachedAt(), albums: cache.filter(a => a.uri !== uri) }));
  }
}

// ---------------------------------------------------------------- Wiedergabe (Web Playback SDK)
let sdkPlayer = null;
let deviceId = null;
let sdkReady = null;
let currentUri = null;
let lastState = null;
let endedFired = false;

function loadSdk() {
  sdkReady ??= new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = resolve;
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.onerror = () => reject(new Error('Spotify-Player konnte nicht geladen werden'));
    document.head.appendChild(s);
  });
  return sdkReady;
}

export async function ensurePlayer(volume = 0.8) {
  if (deviceId) return deviceId;
  if (!secureOk()) throw new Error('Spotify-Wiedergabe braucht die HTTPS-Adresse (siehe Einstellungen)');
  await loadSdk();
  if (!sdkPlayer) {
    sdkPlayer = new window.Spotify.Player({
      name: 'Plattenregal',
      getOAuthToken: cb => accessToken().then(cb).catch(() => {}),
      volume,
    });
    sdkPlayer.addListener('player_state_changed', onState);
    sdkPlayer.addListener('initialization_error', ({ message }) => emit({ type: 'error', message: 'Spotify-Player: ' + message }));
    sdkPlayer.addListener('authentication_error', ({ message }) => emit({ type: 'error', message: 'Spotify-Anmeldung: ' + message }));
    sdkPlayer.addListener('account_error', () => emit({ type: 'error', message: 'Für die Wiedergabe ist Spotify Premium nötig' }));
    sdkPlayer.addListener('playback_error', ({ message }) => emit({ type: 'error', message: 'Spotify: ' + message }));
    sdkPlayer.addListener('not_ready', () => { deviceId = null; });
  }
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Spotify-Player antwortet nicht')), 15000);
    sdkPlayer.addListener('ready', ({ device_id }) => { clearTimeout(t); deviceId = device_id; resolve(device_id); });
  });
  const ok = await sdkPlayer.connect();
  if (!ok) throw new Error('Spotify-Player konnte sich nicht verbinden');
  return ready;
}

// Muss direkt aus einem Klick heraus aufgerufen werden (Autoplay-Regeln der Browser).
export function activate() { try { sdkPlayer?.activateElement?.(); } catch {} }

function onState(state) {
  lastState = state;
  if (!state || !currentUri) return;
  emit('state');
  // Titelende erkennen: Spotify pausiert am Ende bei Position 0 und schiebt den Titel in "previous_tracks".
  const prev = state.track_window?.previous_tracks ?? [];
  const cur = state.track_window?.current_track;
  const finished = state.paused && state.position === 0 &&
    (prev.some(t => t.uri === currentUri || t.linked_from?.uri === currentUri) || (cur && cur.uri !== currentUri && !cur.linked_from));
  if (finished && !endedFired) { endedFired = true; emit('ended'); }
}

export async function play(uri, volume) {
  const id = await ensurePlayer(volume);
  currentUri = uri;
  endedFired = false;
  await call('/me/player/play', { method: 'PUT', query: { device_id: id }, body: { uris: [uri] } });
}

export const pause = () => sdkPlayer?.pause();
export const resume = () => sdkPlayer?.resume();
export const seek = sec => sdkPlayer?.seek(Math.round(sec * 1000));
export const setVolume = v => sdkPlayer?.setVolume(v);
export function stop() { currentUri = null; if (lastState && !lastState.paused) sdkPlayer?.pause(); }
export async function position() {
  const s = await sdkPlayer?.getCurrentState();
  if (s) lastState = s;
  return s ? { pos: s.position / 1000, dur: s.duration / 1000, paused: s.paused } : null;
}
export const paused = () => lastState ? lastState.paused : true;

// ---------------------------------------------------------------- Abgleich lokal ↔ Spotify
// Vereinheitlicht Titel und Interpreten, damit "Arrival (Remastered 2001)" und "Arrival" zusammenpassen.
export function norm(s) {
  return String(s ?? '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\s*[([][^)\]]*(remaster|deluxe|edition|version|expanded|anniversary|bonus|mono|stereo|reissue|special|collector|live at|explicit|clean|edição)[^)\]]*[)\]]/g, '')
    .replace(/\s+-\s+.*(remaster|deluxe|edition|version|anniversary).*$/g, '')
    .replace(/&/g, ' and ')
    .replace(/^the\s+|^die\s+|^der\s+/g, '')
    .replace(/[^a-z0-9äöüß]+/g, ' ')
    .trim();
}
export const albumKey = (artist, name) => norm(artist).split(' ').slice(0, 3).join(' ') + '|' + norm(name);

const VA = /^(various artists|various|verschiedene interpreten|va)$/i;

// Sucht ein lokales Album bei Spotify. Ergebnis: { spotifyId, uri, name, artist, images } oder null.
export async function findAlbum(local) {
  const sampler = local.isCompilation || VA.test(local.artist || '');
  const title = local.name.replace(/[([].*?[)\]]/g, '').trim() || local.name;
  const queries = sampler
    ? [`album:${title}`]
    : [`album:${title} artist:${local.artist}`, `${title} ${local.artist}`];
  const wantTitle = norm(local.name);
  const wantArtist = norm(local.artist);
  for (const q of queries) {
    const d = await search(q, 'album', 10);
    const items = d.albums?.items ?? [];
    let best = null, bestScore = 0;
    for (const it of items) {
      if (!it) continue;
      const t = norm(it.name);
      const titleScore = t === wantTitle ? 3 : (t.startsWith(wantTitle) || wantTitle.startsWith(t)) && Math.min(t.length, wantTitle.length) >= 3 ? 2 : 0;
      if (!titleScore) continue;
      const names = (it.artists ?? []).map(a => norm(a.name));
      const artistScore = sampler
        ? (it.album_type === 'compilation' || names.some(n => VA.test(n)) ? 2 : 1)
        : names.some(n => n === wantArtist) ? 3 : names.some(n => n && (wantArtist.includes(n) || n.includes(wantArtist))) ? 2 : 0;
      if (!artistScore) continue;
      const yearBonus = local.year && parseInt(it.release_date, 10) === local.year ? 1 : 0;
      const score = titleScore + artistScore + yearBonus;
      if (score > bestScore) { bestScore = score; best = it; }
    }
    if (best) return { spotifyId: best.id, uri: best.uri, name: best.name, artist: joinArtists(best.artists), images: best.images ?? [] };
  }
  return null;
}

// ---------------------------------------------------------------- Lyrics (LRCLIB, frei und ohne Anmeldung)
export async function lrclib(song) {
  const q = new URLSearchParams({ artist_name: song.artist.split(',')[0], track_name: song.title });
  if (song.album) q.set('album_name', song.album);
  if (song.duration) q.set('duration', song.duration);
  let r = await fetch('https://lrclib.net/api/get?' + q);
  if (r.status === 404) {
    // ohne Album und Länge noch einmal suchen
    const s = await fetch('https://lrclib.net/api/search?' + new URLSearchParams({ artist_name: song.artist.split(',')[0], track_name: song.title }));
    const list = s.ok ? await s.json() : [];
    const hit = list.find(x => x.syncedLyrics) || list[0];
    if (!hit) return null;
    return parseLrc(hit);
  }
  if (!r.ok) return null;
  return parseLrc(await r.json());
}

function parseLrc(d) {
  if (d.syncedLyrics) {
    const line = [];
    for (const raw of d.syncedLyrics.split('\n')) {
      const m = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
      if (m) line.push({ start: Math.round((+m[1] * 60 + +m[2]) * 1000), value: m[3].trim() });
    }
    if (line.length) return { synced: true, line, source: 'LRCLIB' };
  }
  if (d.plainLyrics) return { synced: false, line: d.plainLyrics.split('\n').map(value => ({ value })), source: 'LRCLIB' };
  return null;
}
