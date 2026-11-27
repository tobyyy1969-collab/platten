// Spotify-Anbindung: Anmeldung (PKCE, ohne Geheimnis auf dem Server), Web API,
// Wiedergabe im Browser (Web Playback SDK, Mac) oder über Spotify Connect (iPhone).
// Regeln im Spotify-Entwicklermodus (Stand 2026): nur HTTPS, Suche höchstens 10 Treffer,
// keine Sammelabfragen (/albums?ids=), Speichern über /me/library, Playlist-Inhalte über /items.

const API = 'https://api.spotify.com/v1';
const AUTH = 'https://accounts.spotify.com';
const SCOPES = [
  'streaming', 'user-read-private', 'user-read-email',
  'user-library-read', 'user-library-modify',
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
  'playlist-read-private', 'playlist-read-collaborative', 'playlist-modify-private', 'playlist-modify-public',
].join(' ');
const K = { token: 'bb.spotify.token', verifier: 'bb.spotify.verifier', albums: 'bb.spotify.albums', device: 'bb.spotify.device', back: 'bb.spotify.back' };

let clientId = '';
let token = null; // { access, refresh, expires }
let profile = null;

const listeners = new Set();
const emit = (what) => listeners.forEach((fn) => fn(what));
export const on = (fn) => listeners.add(fn);

const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* voll oder privat */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* egal */ } },
};

// ---------------------------------------------------------------- Konfiguration
export const redirectUri = () => `${location.origin}/callback`;
export const secureOk = () => window.isSecureContext && (location.protocol === 'https:' || location.hostname === '127.0.0.1');
export const configured = () => !!clientId;
export const isConnected = () => !!token?.refresh;
export const user = () => profile;

/** Beim Start aufrufen. Erledigt auch die Rückkehr von der Spotify-Anmeldung (/callback?code=…). */
export async function init(id) {
  clientId = id || '';
  token = ls.get(K.token);
  if (location.pathname === '/callback') {
    const params = new URLSearchParams(location.search);
    const back = ls.get(K.back) || '#/alben';
    history.replaceState(null, '', '/' + back);
    if (params.get('code')) await exchangeCode(params.get('code'));
    else if (params.get('error')) throw new Error(params.get('error') === 'access_denied' ? 'Spotify-Anmeldung abgebrochen' : 'Spotify-Anmeldung fehlgeschlagen: ' + params.get('error'));
  }
  if (isConnected()) {
    profile = ls.get('bb.spotify.me');
    me().then((p) => { profile = p; ls.set('bb.spotify.me', p); emit('auth'); }).catch(() => {});
  }
}

// ---------------------------------------------------------------- Anmeldung
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function login() {
  if (!clientId) throw new Error('Auf dem Server ist noch keine Spotify-Client-ID eingetragen.');
  if (!secureOk()) throw new Error('Spotify braucht die sichere Adresse (https://…ts.net).');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  ls.set(K.verifier, verifier);
  ls.set(K.back, location.hash || '#/alben');
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
  token = { access: d.access_token, refresh: d.refresh_token || token?.refresh, expires: Date.now() + (d.expires_in - 60) * 1000 };
  ls.set(K.token, token);
  emit('auth');
}

async function exchangeCode(code) {
  const verifier = ls.get(K.verifier);
  ls.del(K.verifier);
  await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier });
}

let refreshing = null;
export async function accessToken() {
  if (!token) throw new Error('Nicht mit Spotify verbunden');
  if (Date.now() < token.expires) return token.access;
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh })
    .catch((e) => { if (e.code === 'invalid_grant') logout(); throw e; })
    .finally(() => { refreshing = null; });
  await refreshing;
  return token.access;
}

export function logout() {
  token = null; profile = null;
  for (const k of Object.values(K)) ls.del(k);
  ls.del('bb.spotify.me');
  sdkPlayer?.disconnect();
  sdkPlayer = null; deviceId = null;
  emit('auth');
}

// ---------------------------------------------------------------- Web API
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function call(path, { method = 'GET', body, query } = {}) {
  const url = new URL(path.startsWith('http') ? path : API + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, {
      method,
      headers: { Authorization: 'Bearer ' + await accessToken(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) {
      await sleep(Math.min(30, parseInt(r.headers.get('Retry-After') || '2', 10)) * 1000);
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
  throw new Error('Spotify ist gerade überlastet. Bitte gleich noch einmal versuchen.');
}

/** Erst den neuen Pfad versuchen, bei 403/404 den alten (Spotify stellt gerade um). */
async function callEither(paths, opts) {
  let last;
  for (const p of paths) {
    try { return await call(p, opts); } catch (e) { last = e; if (![403, 404, 405].includes(e.status)) throw e; }
  }
  throw last;
}

export const me = () => call('/me');

// ---------------------------------------------------------------- Umwandeln
export function image(images, size = 300) {
  if (!images?.length) return '';
  const sorted = images.slice().sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find((i) => (i.width || 0) >= size) || sorted[sorted.length - 1]).url;
}
const joinArtists = (arr) => (arr ?? []).map((a) => a.name).join(', ');

export function toAlbum(sa, addedAt) {
  return {
    id: 'sp:' + sa.id,
    title: sa.name,
    artist: joinArtists(sa.artists),
    year: parseInt(sa.release_date, 10) || null,
    formats: ['Spotify'],
    tracks: sa.total_tracks,
    added: addedAt ? Date.parse(addedAt) / 1000 : 0,
    compilation: sa.album_type === 'compilation',
    image: image(sa.images, 300),
    imageLarge: image(sa.images, 640),
    spotify: { id: sa.id, uri: sa.uri },
  };
}

export function toTrack(t, album) {
  return {
    id: 'sp:' + t.id,
    source: 'spotify',
    format: 'Spotify',
    uri: t.uri,
    title: t.name,
    artist: joinArtists(t.artists),
    album: album?.title ?? t.album?.name,
    album_id: album?.id ?? (t.album ? 'sp:' + t.album.id : null),
    image: album?.image ?? image(t.album?.images, 300),
    imageLarge: album?.imageLarge ?? image(t.album?.images, 640),
    duration: (t.duration_ms || 0) / 1000,
    track: t.track_number,
    disc: t.disc_number,
    year: parseInt(t.album?.release_date, 10) || album?.year || null,
  };
}

// ---------------------------------------------------------------- Bibliothek
export const cachedAlbums = () => ls.get(K.albums)?.albums ?? [];
export const cachedAt = () => ls.get(K.albums)?.at ?? 0;

export async function savedAlbums(onProgress) {
  const out = [];
  let next = '/me/albums';
  let query = { limit: 50, offset: 0, market: 'from_token' };
  while (next) {
    const d = await call(next, { query });
    for (const it of d.items ?? []) if (it?.album) out.push(toAlbum(it.album, it.added_at));
    onProgress?.(out.length, d.total);
    next = d.next;
    query = undefined;
  }
  ls.set(K.albums, { at: Date.now(), albums: out });
  return out;
}

export async function album(spotifyId) {
  const a = await call(`/albums/${spotifyId}`, { query: { market: 'from_token' } });
  const alb = toAlbum(a);
  alb.genre = (a.genres || [])[0] || '';
  alb.label = a.label;
  const items = [...(a.tracks?.items ?? [])];
  let next = a.tracks?.next;
  while (next) { const d = await call(next); items.push(...(d.items ?? [])); next = d.next; }
  alb.trackList = items.map((t) => toTrack(t, alb));
  return alb;
}

export const search = (q, type = 'album,track,artist', limit = 10) => call('/search', { query: { q, type, limit, market: 'from_token' } });

/** Album in der Spotify-Bibliothek speichern (oder entfernen). Neuer Weg: /me/library?uris=…, alter: /me/albums?ids=… */
export async function saveAlbum(uri, saved = true) {
  const method = saved ? 'PUT' : 'DELETE';
  try {
    await call('/me/library', { method, query: { uris: uri } });
  } catch (e) {
    if (![403, 404, 405].includes(e.status)) throw e;
    await call('/me/albums', { method, query: { ids: uri.split(':').pop() } });
  }
}

// ---------------------------------------------------------------- Playlists
export async function playlists() {
  const out = [];
  let next = '/me/playlists';
  let query = { limit: 50 };
  while (next) {
    const d = await call(next, { query });
    out.push(...(d.items ?? []).filter(Boolean));
    next = d.next;
    query = undefined;
  }
  return out.map((p) => ({
    id: p.id, name: p.name, owner: p.owner?.display_name, ownerId: p.owner?.id,
    count: p.items?.total ?? p.tracks?.total ?? 0, image: image(p.images, 300), uri: p.uri,
    mine: p.owner?.id === profile?.id || p.collaborative,
  }));
}

export async function playlist(id) {
  const p = await call(`/playlists/${id}`, { query: { market: 'from_token' } });
  let page = p.items?.items ? p.items : p.tracks;
  if (!page?.items) page = await callEither([`/playlists/${id}/items`, `/playlists/${id}/tracks`], { query: { limit: 100, market: 'from_token' } });
  const items = [...(page.items ?? [])];
  let next = page.next;
  while (next) { const d = await call(next); items.push(...(d.items ?? [])); next = d.next; }
  const tracks = items.map((it) => it.item || it.track).filter((t) => t && t.type === 'track' && t.uri && !t.is_local).map((t) => toTrack(t));
  return { id: p.id, name: p.name, description: p.description, image: image(p.images, 640), owner: p.owner?.display_name, uri: p.uri, tracks };
}

export async function createPlaylist(name) {
  const body = { name, public: false, description: 'Angelegt in BulldogBeats' };
  try {
    return await call('/me/playlists', { method: 'POST', body });
  } catch (e) {
    if (![403, 404, 405].includes(e.status)) throw e;
    const meId = (profile || await me()).id;
    return call(`/users/${encodeURIComponent(meId)}/playlists`, { method: 'POST', body });
  }
}

export async function addToPlaylist(id, uris) {
  for (let i = 0; i < uris.length; i += 100) {
    await callEither([`/playlists/${id}/items`, `/playlists/${id}/tracks`], { method: 'POST', body: { uris: uris.slice(i, i + 100) } });
  }
}

// ---------------------------------------------------------------- Abgleich lokal ↔ Spotify
export function norm(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\s*[([][^)\]]*(remaster|deluxe|edition|version|expanded|anniversary|bonus|mono|stereo|reissue|special|collector|explicit)[^)\]]*[)\]]/g, '')
    .replace(/\s+-\s+.*(remaster|deluxe|edition|version|anniversary).*$/g, '')
    .replace(/&/g, ' and ').replace(/^(the|die|der|das)\s+/g, '')
    .replace(/[^a-z0-9ß]+/g, ' ').trim();
}
export const albumKey = (artist, title) => norm(String(artist).split(',')[0]) + '|' + norm(title);

// ---------------------------------------------------------------- Wiedergabe
const isTouchDevice = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let mode = isTouchDevice() ? 'connect' : 'browser';
export const playbackMode = () => mode;

let sdkPlayer = null, deviceId = null, sdkReady = null;
let currentUri = null, runUris = [], lastState = null, started = false, endedFired = false;

function loadSdk() {
  sdkReady ??= new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = resolve;
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.onerror = () => reject(new Error('Der Spotify-Player konnte nicht geladen werden.'));
    document.head.appendChild(s);
  });
  return sdkReady;
}

export async function ensurePlayer(volume = 1) {
  if (mode === 'connect') return null;
  if (deviceId) return deviceId;
  await loadSdk();
  if (!sdkPlayer) {
    sdkPlayer = new window.Spotify.Player({ name: 'BulldogBeats', getOAuthToken: (cb) => accessToken().then(cb).catch(() => {}), volume });
    sdkPlayer.addListener('player_state_changed', onSdkState);
    sdkPlayer.addListener('initialization_error', ({ message }) => {
      mode = 'connect';
      emit({ type: 'error', message: `Dieser Browser kann Spotify nicht selbst abspielen, BulldogBeats steuert stattdessen deine Spotify-App. (${message})` });
    });
    sdkPlayer.addListener('authentication_error', ({ message }) => emit({ type: 'error', message: 'Spotify-Anmeldung: ' + message }));
    sdkPlayer.addListener('account_error', () => emit({ type: 'error', message: 'Für die Wiedergabe ist Spotify Premium nötig.' }));
    sdkPlayer.addListener('playback_error', ({ message }) => emit({ type: 'error', message: 'Spotify: ' + message }));
    sdkPlayer.addListener('not_ready', () => { deviceId = null; });
  }
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Der Spotify-Player antwortet nicht.')), 15000);
    sdkPlayer.addListener('ready', ({ device_id }) => { clearTimeout(t); deviceId = device_id; resolve(device_id); });
  });
  if (!(await sdkPlayer.connect())) throw new Error('Der Spotify-Player konnte sich nicht verbinden.');
  return ready;
}

/** Direkt aus einem Klick heraus aufrufen (Autoplay-Regeln der Browser). */
export function activate() { try { sdkPlayer?.activateElement?.(); } catch { /* egal */ } }

function onSdkState(state) {
  if (!state || !currentUri) return;
  lastState = { pos: state.position / 1000, dur: state.duration / 1000, paused: state.paused, uri: state.track_window?.current_track?.uri };
  emit('state');
  const prev = state.track_window?.previous_tracks ?? [];
  const cur = state.track_window?.current_track;
  const finished = state.paused && state.position === 0 &&
    (prev.some((t) => t.uri === currentUri || t.linked_from?.uri === currentUri) || (cur && cur.uri !== currentUri && !cur.linked_from));
  if (finished && !endedFired) { endedFired = true; emit('ended'); }
}

// Spotify Connect: die Spotify-App auf einem Gerät fernsteuern (iPhone)
export async function devices() {
  const d = await call('/me/player/devices');
  return (d?.devices ?? []).filter((x) => !x.is_restricted);
}
export const chosenDevice = () => ls.get(K.device);
export function chooseDevice(dev) { ls.set(K.device, { id: dev.id, name: dev.name, type: dev.type }); emit('device'); }

async function connectDevice() {
  const list = await devices();
  const saved = chosenDevice();
  const dev = list.find((x) => x.id === saved?.id) || list.find((x) => x.name === saved?.name)
    || list.find((x) => x.is_active) || list.find((x) => /smartphone|tablet/i.test(x.type)) || list[0];
  if (!dev) {
    const e = new Error('Keine Spotify-App gefunden. Öffne kurz die Spotify-App auf diesem Gerät und tippe dann noch einmal auf Abspielen.');
    e.noDevice = true;
    throw e;
  }
  if (dev.id !== saved?.id) chooseDevice(dev);
  return dev.id;
}

/** uris: aktueller Titel und (bei Spotify Connect) die folgenden Spotify-Titel, damit die App auch bei gesperrtem iPhone weiterspielt. */
export async function play(uris, volume) {
  uris = [].concat(uris);
  currentUri = uris[0];
  endedFired = false;
  started = false;
  if (mode === 'connect') {
    const id = await connectDevice();
    runUris = uris.slice(0, 50);
    lastState = { pos: 0, dur: 0, paused: false, uri: currentUri };
    await call('/me/player/play', { method: 'PUT', query: { device_id: id }, body: { uris: runUris } });
    return;
  }
  const id = await ensurePlayer(volume);
  runUris = [currentUri];
  await call('/me/player/play', { method: 'PUT', query: { device_id: id }, body: { uris: [currentUri] } });
}

const remote = (path, query, method = 'PUT') => call(path, { method, query: { ...query, device_id: chosenDevice()?.id } }).catch((e) => emit({ type: 'error', message: 'Spotify: ' + e.message }));

export function pause() { return mode === 'connect' ? remote('/me/player/pause') : sdkPlayer?.pause(); }
export function resume() { return mode === 'connect' ? remote('/me/player/play') : sdkPlayer?.resume(); }
export function seek(sec) { return mode === 'connect' ? remote('/me/player/seek', { position_ms: Math.round(sec * 1000) }) : sdkPlayer?.seek(Math.round(sec * 1000)); }
export function setVolume(v) { if (mode !== 'connect') sdkPlayer?.setVolume(v); }
export function stop() {
  const wasPlaying = lastState && !lastState.paused;
  currentUri = null; runUris = [];
  if (wasPlaying) pause();
}
export const paused = () => (lastState ? lastState.paused : true);

/** Aktueller Stand; bei Spotify Connect wird hier auch das Titelende erkannt. */
export async function position() {
  if (mode === 'browser') {
    const s = await sdkPlayer?.getCurrentState();
    if (s) lastState = { pos: s.position / 1000, dur: s.duration / 1000, paused: s.paused, uri: s.track_window?.current_track?.uri };
    return lastState;
  }
  if (!currentUri) return null;
  const d = await call('/me/player').catch(() => null);
  const uri = d?.item?.uri;
  const st = { pos: (d?.progress_ms || 0) / 1000, dur: (d?.item?.duration_ms || 0) / 1000, paused: !d?.is_playing, uri };
  if (uri === currentUri && d?.is_playing) started = true;
  if (started && uri && uri !== currentUri && runUris.includes(uri)) {
    currentUri = uri;
    emit({ type: 'remote-track', uri });
  } else if (started && !endedFired && (!d || (uri !== currentUri && !runUris.includes(uri)) || (!d.is_playing && st.pos === 0))) {
    endedFired = true;
    emit('ended');
  }
  lastState = st;
  return st;
}

// ---------------------------------------------------------------- Interpreten
/** Interpreten bei Spotify über den Namen finden (genauer Treffer, sonst null). */
export async function artistByName(name) {
  const d = await search(`artist:${name}`, 'artist', 10);
  const items = (d?.artists?.items ?? []).filter(Boolean);
  const hit = items.find((a) => norm(a.name) === norm(name));
  return hit ? { id: hit.id, name: hit.name, image: image(hit.images, 640), genres: hit.genres ?? [] } : null;
}

export async function artistAlbums(id, max = 100) {
  const out = [];
  let next = `/artists/${id}/albums`;
  let query = { include_groups: 'album,compilation', limit: 10, market: 'from_token' };
  while (next && out.length < max) {
    const d = await call(next, { query });
    out.push(...(d?.items ?? []).filter(Boolean).map((a) => toAlbum(a)));
    next = d?.next;
    query = undefined;
  }
  return out;
}
