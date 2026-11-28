// BulldogBeats – Oberfläche
import { api, badges, collator, coverHtml, coverSrc, esc, fmtDuration, fmtTime, initials, colorsFor, setVersion, sortName, store } from './lib.js';
import { Player } from './player.js';
import * as spotify from './spotify.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const content = $('#content');
const player = new Player($('#audio'));
const VA = 'Verschiedene Interpreten';
const CHUNK = 270;
const mobile = () => matchMedia('(max-width: 820px)').matches;
const nf = new Intl.NumberFormat('de-DE');

const lib = { local: [], albums: [], byId: new Map(), byKey: new Map(), version: null };
const prefs = { sort: store.get('sort', 'artist'), filter: store.get('filter', 'Alle'), source: store.get('source', {}) };
const memory = new Map(); // Scrollposition und geladene Menge je Ansicht
let current = { key: '', view: '' };

// ---------------------------------------------------------------- Meldungen und Auswahlfenster

let toastTimer;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 6000);
}

function closeSheet() { $('.sheet-back')?.remove(); }
function sheet(title, html, bind) {
  closeSheet();
  const back = document.createElement('div');
  back.className = 'sheet-back';
  back.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="row" style="justify-content:space-between"><h3>${esc(title)}</h3>
    <button class="icon-btn" data-close-sheet aria-label="Schließen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="sheet-body">${html}</div></div>`;
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close-sheet]')) closeSheet(); });
  document.body.append(back);
  bind?.(back);
  return back;
}

// ---------------------------------------------------------------- Bibliothek (Server + Spotify)

/** Album-Arten: eigene Ansichten für Solo-Alben, Sampler und Soundtracks. */
const KIND_VIEWS = { solo: 'solo', sampler: 'sampler', soundtracks: 'soundtrack' };
const KIND_TITLE = { solo: 'Solo-Alben', sampler: 'Sampler', soundtracks: 'Soundtracks' };
const KIND_LABEL = { solo: 'Album', sampler: 'Sampler', soundtrack: 'Soundtrack', single: 'Einzeltitel' };
const LIB_VIEWS = ['alben', 'interpreten', 'jahre', ...Object.keys(KIND_VIEWS)];
const ALBUM_VIEWS = ['alben', ...Object.keys(KIND_VIEWS)];
const SOUNDTRACK = /soundtrack|filmmusik|\bo\.?s\.?t\b|original (motion picture|score|film|cast|tv|television)|music from (and inspired by )?(the )?(motion picture|film|movie|series|tv)|\bscore\b|musical/i;
let kindOver = {}, kindsLoaded = false;
const spKind = (a) => (SOUNDTRACK.test(a.title) ? 'soundtrack' : a.compilation || isVA(a.artist) ? 'sampler' : 'solo');

const isVA = (n) => n === VA || /^(various( artists)?|verschiedene( interpreten)?|va|diverse)$/i.test(String(n).trim());
const keyOf = (a) => (isVA(a.artist) ? 'va|' + spotify.norm(a.title) : spotify.albumKey(a.artist, a.title));

/** Eigene Alben und die in Spotify gespeicherten zusammenführen: dasselbe Album erscheint nur einmal. */
function merge() {
  const out = lib.local.map((a) => ({ ...a }));
  const byKey = new Map(out.map((a) => [keyOf(a), a]));
  for (const s of spotify.isConnected() ? spotify.cachedAlbums() : []) {
    const k = keyOf(s);
    const hit = byKey.get(k);
    if (hit) {
      if (hit.spotify) continue;
      hit.spotify = s.spotify;
      hit.formats = [...hit.formats, 'Spotify'];
      if (!hit.cover) { hit.image = s.image; hit.imageLarge = s.imageLarge; }
    } else {
      const c = { ...s, artists: s.artist, artist: isVA(s.artist) ? VA : s.artist.split(', ')[0] };
      out.push(c);
      byKey.set(k, c);
    }
  }
  for (const a of out) a.kind = kindOver[a.id] || (a.id.startsWith('sp:') ? spKind(a) : a.kind || 'solo');
  lib.albums = out;
  lib.byId = new Map(out.map((a) => [a.id, a]));
  lib.byKey = byKey;
}

async function loadLibrary() {
  if (!kindsLoaded) { kindOver = await api.kinds().catch(() => ({})); kindsLoaded = true; }
  const d = await api.albums();
  if (d.version === lib.version) return false;
  lib.version = d.version;
  setVersion(d.version);
  lib.local = d.albums;
  merge();
  return true;
}

const formatsInLibrary = () => ['FLAC', 'MP3', 'Spotify'].filter((f) => lib.albums.some((a) => a.formats.includes(f)));

function filtered(kind) {
  const f = formatsInLibrary().includes(prefs.filter) ? prefs.filter : 'Alle';
  const list = f === 'Alle' ? lib.albums : lib.albums.filter((a) => a.formats.includes(f));
  return kind ? list.filter((a) => a.kind === kind) : list;
}

const SORTS = {
  artist: { label: 'Interpret', fn: (a, b) => collator.compare(sortName(a.artist), sortName(b.artist)) || (a.year || 0) - (b.year || 0) || collator.compare(a.title, b.title) },
  title: { label: 'Titel', fn: (a, b) => collator.compare(a.title, b.title) },
  year: { label: 'Jahr', fn: (a, b) => (a.year || 9999) - (b.year || 9999) || collator.compare(sortName(a.artist), sortName(b.artist)) },
  added: { label: 'Neu hinzugefügt', fn: (a, b) => (b.added || 0) - (a.added || 0) },
};

/** Gespeicherte Spotify-Alben im Hintergrund neu holen (höchstens alle 30 Minuten, außer `force`). */
let syncing = null, syncNote = '';
function syncSpotify(force = false) {
  if (!spotify.isConnected() || syncing) return syncing;
  if (!force && Date.now() - spotify.cachedAt() < 30 * 60e3) return null;
  syncing = spotify.savedAlbums((n, total) => { syncNote = `${nf.format(n)} von ${nf.format(total || n)}`; renderSources(); })
    .then(() => { merge(); if (LIB_VIEWS.includes(current.view)) route(); })
    .catch((e) => toast('Spotify-Bibliothek: ' + e.message))
    .finally(() => { syncing = null; syncNote = ''; renderSources(); });
  return syncing;
}

const spAlbums = new Map();
function spAlbum(id) {
  if (!spAlbums.has(id)) spAlbums.set(id, spotify.album(id).catch((e) => { spAlbums.delete(id); throw e; }));
  return spAlbums.get(id);
}

/** Ein eigenes Album, das nicht in der Spotify-Bibliothek gespeichert ist, bei Spotify suchen. */
async function findOnSpotify(a) {
  const q = isVA(a.artist) ? `album:${a.title}` : `album:${a.title} artist:${a.artist}`;
  const res = await spotify.search(q, 'album', 10).catch(() => null);
  const k = keyOf(a);
  const hit = (res?.albums?.items ?? []).filter(Boolean).find((s) => keyOf(spotify.toAlbum(s)) === k);
  return hit ? spotify.toAlbum(hit) : null;
}

// ---------------------------------------------------------------- Router

function parseHash() {
  const h = location.hash.slice(1) || '/alben';
  const [path, qs] = h.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { view: parts[0] || 'alben', arg: parts.slice(1).join('/'), params: new URLSearchParams(qs || ''), key: h };
}

async function route() {
  if (current.key) memory.set(current.key, { top: content.scrollTop, count: content.dataset.count | 0 });
  closeSheet();
  const r = parseHash();
  current = { key: r.key, view: r.view };
  document.body.classList.toggle('view-player', r.view === 'wiedergabe');
  const top = [...LIB_VIEWS, 'suche', 'playlists', 'offline'];
  $('#back').hidden = top.includes(r.view) || r.view === 'wiedergabe';
  const navKey = ['album', 'interpret'].includes(r.view) ? null : r.view === 'playlist' ? 'playlists' : r.view;
  $$('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.nav === navKey));
  const tab = { alben: 'alben', solo: 'alben', sampler: 'alben', soundtracks: 'alben', interpreten: 'alben', jahre: 'alben', album: 'alben', interpret: 'alben', suche: 'suche', playlists: 'playlists', playlist: 'playlists', offline: 'offline' }[r.view];
  $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  if (r.view !== 'suche' && document.activeElement !== $('#search')) $('#search').value = '';

  const views = { alben: viewLibrary, solo: viewLibrary, sampler: viewLibrary, soundtracks: viewLibrary, interpreten: viewLibrary, jahre: viewLibrary, album: viewAlbum, interpret: viewArtist, suche: viewSearch, wiedergabe: viewPlayer, playlists: viewPlaylists, playlist: viewPlaylist, offline: viewOffline };
  const mem = memory.get(r.key);
  try {
    await (views[r.view] || viewLibrary)(r, mem);
  } catch (e) {
    console.error(e);
    if (current.key !== r.key) return;
    content.innerHTML = `<div class="empty"><strong>Das hat nicht geklappt.</strong><br>${esc(e.message)}</div>`;
  }
  if (current.key === r.key) content.scrollTop = mem ? mem.top : 0;
}

// ---------------------------------------------------------------- Übersicht (Alben, Interpreten, Jahre)

function libraryHeader(view) {
  const tabs = [['alben', 'Alben'], ['interpreten', 'Interpreten'], ['jahre', 'Jahre']];
  const albumView = ALBUM_VIEWS.includes(view);
  const kindChips = albumView ? `<div class="chips"><span class="label">Art:</span>${[['alben', 'Alle'], ...Object.entries(KIND_TITLE)].map(([k, l]) => `<button class="chip" data-go="#/${k}" aria-pressed="${view === k}">${l}</button>`).join('')}</div>` : '';
  const sortChips = albumView ? `<div class="chips"><span class="label">Sortieren:</span>${Object.entries(SORTS).map(([k, s]) => `<button class="chip" data-sort="${k}" aria-pressed="${prefs.sort === k}">${s.label}</button>`).join('')}</div>` : '';
  const fs = formatsInLibrary();
  const active = fs.includes(prefs.filter) ? prefs.filter : 'Alle';
  const filters = fs.length > 1 ? `<div class="chips"><span class="label">Quelle:</span>${['Alle', ...fs].map((f) => `<button class="chip" data-filter="${f}" aria-pressed="${active === f}">${f}</button>`).join('')}</div>` : '';
  return `<div class="stack" style="gap:16px;margin-bottom:24px">
    <div class="row" style="gap:24px;align-items:flex-end">
      <h1 class="page">${mobile() ? 'Bibliothek' : KIND_TITLE[view] || tabs.find((t) => t[0] === view)?.[1] || 'Alben'}</h1>
      <div class="seg" role="group" aria-label="Ansicht">${tabs.map(([k, l]) => `<button data-go="#/${k}" aria-pressed="${view === k || (k === 'alben' && albumView)}">${l}</button>`).join('')}</div>
    </div>
    ${kindChips}
    <div class="row" style="gap:18px">${sortChips}${filters}</div>
  </div>`;
}

function bindHeader() {
  $$('[data-go]', content).forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.go; }));
  $$('[data-sort]', content).forEach((b) => b.addEventListener('click', () => { prefs.sort = b.dataset.sort; store.set('sort', prefs.sort); memory.delete(current.key); route(); }));
  $$('[data-filter]', content).forEach((b) => b.addEventListener('click', () => { prefs.filter = b.dataset.filter; store.set('filter', prefs.filter); memory.clear(); route(); }));
}

/** Titel, die gerade in einer Liste stehen (für das Titel-Menü „+“). */
const rowTracks = new Map();
const remember = (t) => rowTracks.set(String(t.id), t);
const menuBtn = (id) => `<span class="tmenu" role="button" tabindex="0" data-tmenu="${esc(id)}" aria-label="Zur Playlist oder Warteschlange" title="Zur Playlist oder Warteschlange">+</span>`;

/** Spotify-Adresse eines Titels; eigene Dateien werden bei Spotify gesucht. */
async function spotifyUriFor(t) {
  if (t.uri) return t.uri;
  const artist = String(t.artist || '').split(', ')[0];
  const res = await spotify.search(`track:${t.title} artist:${artist}`, 'track', 10).catch(() => null);
  const items = (res?.tracks?.items ?? []).filter(Boolean);
  const nt = spotify.norm(t.title), na = spotify.norm(artist);
  const byArtist = items.filter((x) => (x.artists ?? []).some((a) => spotify.norm(a.name) === na));
  const hit = byArtist.find((x) => spotify.norm(x.name) === nt) || byArtist.find((x) => spotify.norm(x.name).startsWith(nt));
  return hit?.uri || null;
}

function trackMenu(t) {
  const canPl = spotify.isConnected();
  sheet(t.title, `
    <button class="sheet-item" data-m="playlist"${canPl ? '' : ' disabled'}><b>Zur Playlist …</b>${canPl ? '' : '<span class="muted">Dafür mit Spotify verbinden</span>'}</button>
    <button class="sheet-item" data-m="next"><b>Als Nächstes spielen</b></button>
    <button class="sheet-item" data-m="queue"><b>Zur Warteschlange</b></button>`, (el) => {
    el.querySelector('[data-m=next]').onclick = () => { closeSheet(); player.enqueue([t], true); toast(`„${t.title}“ kommt als Nächstes.`); };
    el.querySelector('[data-m=queue]').onclick = () => { closeSheet(); player.enqueue([t], false); toast(`„${t.title}“ steht in der Warteschlange.`); };
    el.querySelector('[data-m=playlist]').onclick = async (e) => {
      e.currentTarget.querySelector('b').textContent = 'Suche bei Spotify …';
      const uri = await spotifyUriFor(t);
      if (!uri) { closeSheet(); toast(`„${t.title}“ gibt es bei Spotify nicht, deshalb kann es nicht in eine Spotify-Playlist.`); return; }
      addToPlaylistDialog([uri], t.title);
    };
  });
}

function kindDialog(a, done) {
  const cur = kindOver[a.id] || '';
  const opts = [['solo', 'Solo-Album', 'Ein Album eines Interpreten'], ['sampler', 'Sampler', 'Zusammenstellung verschiedener Interpreten'],
    ['soundtrack', 'Soundtrack', 'Musik aus Film, Serie oder Musical'], ['', 'Automatisch erkennen', 'BulldogBeats entscheidet selbst']];
  sheet('Art des Albums', opts.map(([k, l, d]) => `<button class="sheet-item" data-k="${k}"><b>${l}${k === cur ? ' ✓' : ''}</b><span class="muted">${d}</span></button>`).join(''), (el) => {
    $$('[data-k]', el).forEach((b) => b.addEventListener('click', async () => {
      closeSheet();
      try { await api.setKind(a.id, b.dataset.k); } catch (e) { toast('Das hat nicht geklappt: ' + e.message); return; }
      if (b.dataset.k) kindOver[a.id] = b.dataset.k; else delete kindOver[a.id];
      memory.clear();
      merge();
      if (!b.dataset.k) { const d = await api.album(a.id).catch(() => null); if (d) { const x = lib.byId.get(a.id); if (x && !a.id.startsWith('sp:')) x.kind = d.kind; } }
      done();
      toast(`„${a.title}“ steht jetzt unter ${{ solo: 'Solo-Alben', sampler: 'Sampler', soundtrack: 'Soundtracks' }[lib.byId.get(a.id)?.kind] || 'Alben'}.`);
    }));
  });
}

const wikiUrl = (lang, q) => `https://${lang}.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`;
const wikiLinks = (qDe, qEn = qDe) => `<span class="wiki-links">Bei Wikipedia nachschlagen:
  <a href="${wikiUrl('de', qDe)}" target="_blank" rel="noopener">Deutsch ↗</a>
  <a href="${wikiUrl('en', qEn)}" target="_blank" rel="noopener">Englisch ↗</a></span>`;

/** Interpreten als Verweise auf ihre Seite (mehrere, mit Komma getrennt, einzeln). */
const artistLinks = (names) => String(names || '').split(', ').filter(Boolean)
  .map((n) => `<span class="alink" role="link" tabindex="0" data-artist="${esc(n)}">${esc(n)}</span>`).join(', ');

const albumTile = (a, sub) => `<a class="tile" href="#/album/${encodeURIComponent(a.id)}">${coverHtml(a, 300)}
  <span class="t1">${esc(a.title)}</span><span class="t2">${esc(sub ?? `${a.artist}${a.year ? ' · ' + a.year : ''}`)}</span>${badges(a.formats)}</a>`;

function emptyLibrary() {
  return `<div class="empty"><strong>Noch keine Musik gefunden.</strong><br>
    BulldogBeats liest die Musikordner gerade ein oder findet sie nicht. Links unten siehst du den Fortschritt.
    Prüfe sonst in der Datei <code>.env</code> auf dem Server die Einträge zu den Musikordnern.</div>`;
}

/** Endloses Raster: rendert in Portionen, sobald man ans Ende scrollt. */
function infiniteGrid(container, items, renderItem, initialCount) {
  let shown = 0;
  const sentinel = document.createElement('div');
  sentinel.className = 'sentinel';
  container.after(sentinel);
  const more = (n = CHUNK) => {
    const next = items.slice(shown, shown + n);
    container.insertAdjacentHTML('beforeend', next.map(renderItem).join(''));
    shown += next.length;
    content.dataset.count = shown;
    if (shown >= items.length) io.disconnect();
  };
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) more(); }, { root: content, rootMargin: '1200px' });
  more(Math.max(CHUNK, initialCount || 0));
  io.observe(sentinel);
}

async function viewLibrary(r, mem) {
  if (!lib.version) await loadLibrary();
  const view = r.view;
  const list = filtered(KIND_VIEWS[view]);
  const noneOfKind = lib.albums.length && KIND_VIEWS[view] && !list.length
    ? `<div class="empty"><strong>Hier ist noch nichts.</strong><br>Auf jeder Albumseite kannst du oben einstellen, ob es ein Solo-Album, ein Sampler oder ein Soundtrack ist.</div>` : '';
  content.innerHTML = libraryHeader(view) + (noneOfKind || (lib.albums.length ? '<div class="grid" id="grid"></div>' : emptyLibrary()));
  bindHeader();
  if (!lib.albums.length || noneOfKind) return;
  const grid = $('#grid');

  if (ALBUM_VIEWS.includes(view)) {
    const sorted = list.slice().sort(SORTS[prefs.sort].fn);
    infiniteGrid(grid, sorted, (a) => albumTile(a), mem?.count);
  } else if (view === 'interpreten') {
    const map = new Map();
    for (const a of list) {
      if (a.artist === VA) continue;
      const e = map.get(a.artist) || { name: a.artist, n: 0, cover: a };
      e.n++;
      if ((a.year || 0) > (e.cover.year || 0)) e.cover = a;
      map.set(a.artist, e);
    }
    const artists = [...map.values()].sort((x, y) => collator.compare(sortName(x.name), sortName(y.name)));
    let letter = '';
    const items = [];
    for (const ar of artists) {
      const l = sortName(ar.name)[0]?.toLocaleUpperCase('de').replace(/[^A-ZÄÖÜ]/, '#') || '#';
      const L = l.normalize('NFD')[0];
      if (L !== letter) { letter = L; items.push({ letter: L }); }
      items.push(ar);
    }
    infiniteGrid(grid, items, (it) => it.letter
      ? `<div class="letter">${esc(it.letter)}</div>`
      : `<a class="tile artist-tile" href="#/interpret/${encodeURIComponent(it.name)}">${artistCircle(it.name, it.cover)}
          <span class="t1">${esc(it.name)}</span><span class="t2">${it.n} ${it.n === 1 ? 'Album' : 'Alben'}</span></a>`, mem?.count);
  } else {
    grid.remove();
    const groups = new Map();
    for (const a of list.slice().sort(SORTS.year.fn)) {
      const k = a.year ? `${Math.floor(a.year / 10) * 10}er` : 'Ohne Jahr';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(a);
    }
    content.insertAdjacentHTML('beforeend', [...groups].map(([k, as]) => `<section class="stack" style="gap:14px;margin-bottom:30px">
      <h2 class="section">${esc(k)} <span class="muted" style="font-size:14px;font-weight:500">${as.length} ${as.length === 1 ? 'Album' : 'Alben'}</span></h2>
      <div class="grid small">${as.map((a) => albumTile(a, `${a.year || ''} · ${a.artist}`)).join('')}</div></section>`).join(''));
  }
}

function artistCircle(name, album) {
  const [bg, fg] = colorsFor(name);
  const src = album ? coverSrc(album, 300) : '';
  const img = src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<div class="cover" style="background:${bg};color:${fg}">${esc(initials(name))}${img}</div>`;
}

// ---------------------------------------------------------------- Album

function sourceLabel(fmt, tracks) {
  if (fmt === 'Spotify') return 'Stream';
  if (fmt === 'FLAC') {
    const bd = Math.max(...tracks.map((t) => t.bitdepth || 16));
    const sr = Math.max(...tracks.map((t) => t.samplerate || 44100)) / 1000;
    return `${bd} Bit / ${String(sr).replace('.', ',')} kHz`;
  }
  const br = Math.max(...tracks.map((t) => t.bitrate || 0));
  return br ? `${br} kbit/s` : 'MP3';
}

function playerTracks(album, tracks) {
  return tracks.map((t) => ({ ...t, album: album.title, album_id: album.id, albumArtist: album.artist, year: t.year || album.year }));
}

const FORMAT_ORDER = ['FLAC', 'MP3', 'Spotify'];

async function viewAlbum(r) {
  if (!lib.version) await loadLibrary();
  const id = r.arg;
  const meta = lib.byId.get(id);
  let a;
  if (id.startsWith('sp:')) {
    const s = await spAlbum(id.slice(3));
    a = { ...s, artist: isVA(s.artist) ? VA : s.artist.split(', ')[0], artists: s.artist, ...(meta || {}), genre: s.genre, label: s.label, sources: { Spotify: s.trackList }, inSpotifyLibrary: !!meta };
  } else {
    a = await api.album(id);
    if (meta?.spotify) { a.spotify = meta.spotify; a.inSpotifyLibrary = true; }
    if (meta?.image) { a.image = meta.image; a.imageLarge = meta.imageLarge; }
  }
  const formats = () => FORMAT_ORDER.filter((f) => a.sources[f]);
  let src = prefs.source[a.id] && a.sources[prefs.source[a.id]] ? prefs.source[a.id] : formats()[0];
  let spState = a.sources.Spotify ? 'ok' : spotify.isConnected() ? 'search' : 'off';

  const spotifyLine = () => {
    if (spState === 'off') return '<span class="muted">Spotify ist nicht verbunden</span>';
    if (spState === 'search') return '<span class="muted">bei Spotify: wird gesucht …</span>';
    if (spState === 'missing') return '<span class="muted">nicht bei Spotify gefunden</span>';
    if (a.inSpotifyLibrary) return '<span>bei Spotify, in deiner Spotify-Bibliothek</span>';
    return '<span>bei Spotify, noch nicht in deiner Bibliothek</span><button class="link" data-act="save">In Spotify-Bibliothek speichern</button>';
  };

  const render = () => {
    const tracks = a.sources[src] || [];
    const multiDisc = new Set(tracks.map((t) => t.disc || 1)).size > 1;
    let lastDisc = null;
    const rows = tracks.map((t, i) => {
      const disc = t.disc || 1;
      const head = multiDisc && disc !== lastDisc ? `<div class="disc">CD ${disc}</div>` : '';
      lastDisc = disc;
      const sub = t.artist && t.artist !== a.artist && t.artist !== a.artists ? `<span class="ta">${artistLinks(t.artist)}</span>` : '';
      return `${head}<button class="track" data-i="${i}" data-id="${esc(t.id)}"><span class="n">${t.track || i + 1}</span>
        <span class="tt">${esc(t.title)}${sub}</span>${menuBtn(t.id)}<span class="d">${fmtTime(t.duration)}</span></button>`;
    }).join('');
    const wikiQ = `${a.title} ${a.artist === VA ? '' : a.artist}`;
    const canPlaylist = a.sources.Spotify && spotify.isConnected();
    content.innerHTML = `<div class="album-layout">
      <div class="stack" style="gap:28px;min-width:0">
        <div class="album-head">${coverHtml(a, 600)}
          <div class="stack" style="gap:10px;min-width:0">
            <button class="kicker kind-btn" data-act="kind" title="Art ändern">${KIND_LABEL[lib.byId.get(a.id)?.kind || a.kind] || (a.compilation ? 'Sampler' : 'Album')} <span aria-hidden="true">▾</span></button>
            <h1 class="album-title">${esc(a.title)}</h1>
            ${a.artist === VA ? `<span class="album-artist">${VA}</span>` : `<a class="album-artist" href="#/interpret/${encodeURIComponent(a.artist)}">${esc(a.artists || a.artist)}</a>`}
            <span class="muted">${[a.year, a.genre, `${tracks.length} Titel`, fmtDuration(tracks.reduce((s, t) => s + (t.duration || 0), 0))].filter(Boolean).map(esc).join(' · ')}</span>
            <div class="stack" style="gap:6px;margin-top:6px">
              <span class="muted" style="font-size:12px;font-weight:600">Abspielen aus:</span>
              <div class="seg" role="group" aria-label="Quelle">${formats().map((f) => `<button data-src="${f}" aria-pressed="${f === src}">${f}<span class="sub">${esc(sourceLabel(f, a.sources[f]))}</span></button>`).join('')}</div>
            </div>
          </div>
        </div>
        <div class="row album-actions">
          <button class="btn primary" data-act="play"><svg viewBox="0 0 24 24" class="fill" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>Abspielen</button>
          <button class="btn" data-act="shuffle">Zufällig</button>
          <button class="btn" data-act="next">Als Nächstes</button>
          <button class="btn" data-act="queue">Zur Warteschlange</button>
          ${canPlaylist ? '<button class="btn" data-act="playlist">Zur Playlist</button>' : ''}
        </div>
        <div class="tracks">${rows}</div>
      </div>
      <aside class="stack" style="gap:16px">
        <div class="box"><h3>Dieses Album gibt es</h3>
          ${['FLAC', 'MP3'].filter((f) => a.sources[f] || lib.local.some((x) => x.formats.includes(f))).map((f) => a.sources[f] ? `<span>als ${f} auf dem Server (${esc(sourceLabel(f, a.sources[f]))})</span>` : `<span class="muted">nicht als ${f}</span>`).join('')}
          ${spotifyLine()}
        </div>
        <div class="box about"><h3>Über das Album</h3>${a.label ? `<p>Label: ${esc(a.label)}</p>` : ''}${wikiLinks(wikiQ + ' Album', wikiQ + ' album')}</div>
      </aside>
    </div>`;
    $$('[data-src]', content).forEach((b) => b.addEventListener('click', () => {
      src = b.dataset.src; prefs.source[a.id] = src; store.set('source', prefs.source); render();
    }));
    const pt = playerTracks(a, tracks);
    pt.forEach(remember);
    $$('.track', content).forEach((b) => b.addEventListener('click', () => player.playList(pt, +b.dataset.i)));
    const act = (k, fn) => { const b = content.querySelector(`[data-act=${k}]`); if (b) b.onclick = fn; };
    act('play', () => { if (player.shuffle) player.toggleShuffle(); player.playList(pt, 0); });
    act('kind', () => kindDialog(a, render));
    act('shuffle', () => { if (!player.shuffle) player.toggleShuffle(); player.playList(pt, Math.floor(Math.random() * pt.length)); });
    act('next', () => { player.enqueue(pt, true); toast(`„${a.title}“ kommt als Nächstes.`); });
    act('queue', () => { player.enqueue(pt, false); toast(`„${a.title}“ steht in der Warteschlange.`); });
    act('playlist', () => addToPlaylistDialog(a.sources.Spotify.map((t) => t.uri), a.title));
    act('save', async () => {
      try {
        await spotify.saveAlbum(a.spotify.uri);
        a.inSpotifyLibrary = true; render();
        toast(`„${a.title}“ ist jetzt in deiner Spotify-Bibliothek.`);
        syncSpotify(true);
      } catch (e) { toast('Speichern bei Spotify: ' + e.message); }
    });
    markPlaying();
  };
  render();

  // Spotify-Fassung nachladen: aus der eigenen Spotify-Bibliothek oder per Suche.
  if (spState === 'search') {
    try {
      let sid = a.spotify?.id;
      if (!sid) { const found = await findOnSpotify(a); if (found) { sid = found.spotify.id; a.spotify = found.spotify; } }
      if (sid) { a.sources.Spotify = (await spAlbum(sid)).trackList; spState = 'ok'; } else spState = 'missing';
    } catch { spState = 'missing'; }
    if (current.key === r.key) { const top = content.scrollTop; render(); content.scrollTop = top; }
  }
}

function markPlaying() {
  const id = String(player.current?.id ?? '');
  $$('.track', content).forEach((b) => b.classList.toggle('playing', b.dataset.id === id));
}

// ---------------------------------------------------------------- Interpret

async function viewArtist(r) {
  const [d] = await Promise.all([api.artist(r.arg), lib.version ? null : loadLibrary()]);
  const n = spotify.norm(d.name);
  const own = d.albums.map((a) => lib.byId.get(a.id) || a);
  const spOnly = lib.albums.filter((a) => a.id.startsWith('sp:') && spotify.norm(a.artist) === n).sort((x, y) => (x.year || 0) - (y.year || 0));
  const all = [...own, ...spOnly].sort((x, y) => (x.year || 0) - (y.year || 0));
  const latest = all[all.length - 1];
  content.innerHTML = `<div class="stack" style="gap:30px">
    <div class="artist-head">${artistHero(d.name, latest ? coverSrc(latest, 600) : '')}
      <div class="stack" style="gap:12px;min-width:0">
        <span class="kicker">Interpret</span>
        <h1 class="artist-name">${esc(d.name)}</h1>
        <span class="muted">${all.length} ${all.length === 1 ? 'Album' : 'Alben'} in deiner Sammlung${d.appearances.length ? ` · auf ${d.appearances.length} weiteren Alben vertreten` : ''}</span>
        <div class="row" style="margin-top:4px">
          <button class="btn primary" data-act="all"><svg viewBox="0 0 24 24" class="fill" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>Alles abspielen</button>
          <button class="btn" data-act="shuffle">Zufällig</button>
          <a class="btn" href="${wikiUrl('de', d.name)}" target="_blank" rel="noopener">Wikipedia DE ↗</a>
          <a class="btn" href="${wikiUrl('en', d.name)}" target="_blank" rel="noopener">Wikipedia EN ↗</a>
        </div>
      </div>
    </div>
    <section class="stack" style="gap:14px"><h2 class="section">Alben</h2>
      ${all.length ? `<div class="grid">${all.map((a) => albumTile(a, a.year || '')).join('')}</div>` : '<p class="muted">Keine Alben in deiner Sammlung.</p>'}</section>
    ${d.appearances.length ? `<section class="stack" style="gap:14px"><h2 class="section">Auf Samplern und anderen Alben</h2>
      <div class="grid">${d.appearances.map((a) => albumTile(lib.byId.get(a.id) || a)).join('')}</div></section>` : ''}
    <div id="artist-spotify"></div>
  </div>`;
  if (spotify.isConnected()) artistFromSpotify(d.name, all, r.key);
  const collect = async () => {
    const out = [];
    for (const a of all) {
      if (a.id.startsWith('sp:')) { const s = await spAlbum(a.id.slice(3)); out.push(...playerTracks(a, s.trackList)); continue; }
      const full = await api.album(a.id);
      const f = prefs.source[a.id] && full.sources[prefs.source[a.id]] ? prefs.source[a.id] : Object.keys(full.sources)[0];
      out.push(...playerTracks(full, full.sources[f]));
    }
    return out;
  };
  content.querySelector('[data-act=all]').onclick = async () => { if (player.shuffle) player.toggleShuffle(); player.playList(await collect(), 0); };
  content.querySelector('[data-act=shuffle]').onclick = async () => { const t = await collect(); if (!player.shuffle) player.toggleShuffle(); player.playList(t, Math.floor(Math.random() * t.length)); };
}

/** Breites Interpretenbild: das Foto in voller Höhe, daneben unscharf aufgefüllt. */
const heroImgs = (src) => `<img class="bg" src="${esc(src)}" alt="" aria-hidden="true" onerror="this.remove()"><img class="fg" src="${esc(src)}" alt="" onerror="this.remove()">`;
function artistHero(name, src) {
  const [bg, fg] = colorsFor(name);
  return `<div class="cover artist-photo" style="background:${bg};color:${fg}">${esc(initials(name))}${src ? heroImgs(src) : ''}</div>`;
}

/** Interpretenseite ergänzen: Foto und die Alben bei Spotify, die nicht in der Sammlung sind. */
async function artistFromSpotify(name, shown, key) {
  try {
    const ar = await spotify.artistByName(name);
    if (!ar || current.key !== key) return;
    const photo = content.querySelector('.artist-photo');
    if (photo && ar.image) {
      photo.querySelectorAll('img').forEach((i) => i.remove());
      photo.insertAdjacentHTML('beforeend', heroImgs(ar.image));
    }
    const albums = await spotify.artistAlbums(ar.id);
    if (current.key !== key) return;
    const seen = new Set(shown.map(keyOf));
    const missing = [];
    for (const a of albums) {
      const k = keyOf(a);
      if (seen.has(k)) continue;
      seen.add(k);
      missing.push({ ...a, artists: a.artist, artist: a.artist.split(', ')[0] });
    }
    if (!missing.length) return;
    missing.sort((x, y) => (x.year || 0) - (y.year || 0));
    $('#artist-spotify').outerHTML = `<section class="stack" style="gap:14px"><h2 class="section">Bei Spotify, nicht in deiner Sammlung</h2>
      <div class="grid">${missing.map((a) => albumTile(a, a.year || '')).join('')}</div></section>`;
  } catch (e) { console.warn('Spotify-Interpret', e); }
}

// ---------------------------------------------------------------- Suche

let searchTimer;
function onSearchInput(value) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const target = `#/suche?q=${encodeURIComponent(value)}`;
    if (current.view === 'suche') { history.replaceState(null, '', target); current.key = target.slice(1); viewSearch(parseHash()); }
    else location.hash = target;
  }, 260);
}

const trackRow = (t) => `<button class="track" data-id="${esc(t.id)}"><span class="n"></span><span class="tt">${esc(t.title)}<span class="ta">${artistLinks(t.artist)} · ${esc(t.album || '')}</span></span>${menuBtn(t.id)}<span class="d">${fmtTime(t.duration)}</span></button>`;

async function viewSearch(r) {
  const q = r.params.get('q') || '';
  const key = r.key;
  if (!mobile() && document.activeElement !== $('#search')) $('#search').value = q;
  const box = `<div class="mobile-search" style="margin-bottom:18px"><label class="searchbox"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
    <input id="msearch" type="search" placeholder="Alben, Interpreten, Titel" value="${esc(q)}" autocomplete="off" aria-label="Suchen"></label></div>`;
  if (!q.trim()) {
    content.innerHTML = `${box}<h1 class="page">Suche</h1><p class="muted">Tippe einen Interpreten, ein Album oder einen Titel ein. ${mobile() ? '' : 'Mit ⌘F kommst du jederzeit ins Suchfeld.'}</p>`;
    bindMobileSearch();
    return;
  }
  const spQuery = spotify.isConnected() ? spotify.search(q).catch((e) => ({ error: e.message })) : Promise.resolve(null);
  const [res, sp] = await Promise.all([api.search(q), spQuery, lib.version ? null : loadLibrary()]);
  if (current.key !== key) return;
  const norm = (s) => String(s).toLocaleLowerCase('de').normalize('NFD').replace(/\p{M}/gu, '');
  const nq = norm(q);
  const names = new Set(lib.albums.map((a) => a.artist).filter((n) => n !== VA && nq.split(/\s+/).every((w) => norm(n).includes(w))));
  for (const ar of sp?.artists?.items ?? []) if (ar) names.add(ar.name);
  const artists = [...names].slice(0, 14);

  const tracksById = new Map();
  const group = (fmt, al, tr, note = '') => {
    tr.forEach((t) => { tracksById.set(String(t.id), t); remember(t); });
    if (!al.length && !tr.length && !note) return '';
    return `<section class="result-group">
      <div class="row"><span class="group-badge badge ${fmt}">${fmt}</span><span class="muted" style="font-size:13px">${note || `${al.length} ${al.length === 1 ? 'Album' : 'Alben'} · ${tr.length} Titel`}</span></div>
      ${al.length || tr.length ? `<div class="result-cols">
        <div class="grid">${al.slice(0, 12).map((a) => albumTile(a)).join('')}</div>
        <div class="tracks">${tr.map(trackRow).join('')}</div>
      </div>` : ''}</section>`;
  };
  let spGroup = '';
  if (sp?.error) spGroup = group('Spotify', [], [], 'Spotify antwortet gerade nicht: ' + sp.error);
  else if (sp) {
    const al = (sp.albums?.items ?? []).filter(Boolean).map((s) => { const x = spotify.toAlbum(s); return lib.byKey.get(keyOf(x)) || x; });
    spGroup = group('Spotify', al, (sp.tracks?.items ?? []).filter(Boolean).map((t) => spotify.toTrack(t)));
  }
  const local = (fmt) => group(fmt, res.albums.filter((a) => a.formats.includes(fmt)).map((a) => lib.byId.get(a.id) || a), res.tracks.filter((t) => t.format === fmt).slice(0, 12));
  const body = [spGroup, local('FLAC'), local('MP3')].join('');
  const order = spotify.isConnected() ? 'Spotify, dann FLAC, dann MP3' : 'FLAC, dann MP3 (Spotify ist nicht verbunden)';
  content.innerHTML = `${box}<div class="stack" style="gap:30px">
    <div class="stack" style="gap:6px"><h1 class="page" style="font-size:30px">Ergebnisse für „${esc(q)}“</h1>
      <span class="muted">Reihenfolge: ${order}. Alle Treffer werden gezeigt.</span></div>
    ${artists.length ? `<section class="result-group"><h2 class="section" style="font-size:18px">Interpreten</h2><div class="chips">${artists.map((n) => `<a class="chip" href="#/interpret/${encodeURIComponent(n)}">${esc(n)}</a>`).join('')}</div></section>` : ''}
    ${body || (artists.length ? '' : '<p class="muted">Nichts gefunden.</p>')}
  </div>`;
  $$('.track', content).forEach((b) => b.addEventListener('click', () => {
    const t = tracksById.get(b.dataset.id);
    if (t) player.playList([t], 0);
  }));
  bindMobileSearch();
  markPlaying();
}

function bindMobileSearch() {
  const m = $('#msearch');
  if (!m) return;
  m.addEventListener('input', () => onSearchInput(m.value));
  if (mobile() && !m.value) m.focus();
}

// ---------------------------------------------------------------- Wiedergabe

const albumFor = (t) => lib.byId.get(t.album_id) || { id: t.album_id, title: t.album || '', artist: t.albumArtist || t.artist, image: t.image, imageLarge: t.imageLarge };
const spotifyTarget = () => (spotify.playbackMode() === 'connect' ? `Spotify-App auf ${spotify.chosenDevice()?.name || 'deinem Gerät'}` : 'auf diesem Gerät');

function viewPlayer(r) {
  const tab = r.params.get('tab') || 'lyrics';
  const t = player.current;
  if (t) remember(t);
  if (!t) {
    content.innerHTML = `<div class="empty"><strong>Gerade läuft nichts.</strong><br>Wähle ein Album und tippe auf „Abspielen“.</div>`;
    return;
  }
  const album = albumFor(t);
  const tabs = [['lyrics', 'Liedtext'], ['queue', 'Warteschlange'], ['info', 'Über das Lied']];
  const pane = {
    lyrics: () => `<div class="lyrics" id="lyrics"><p class="muted lyr-note">Liedtext wird gesucht …</p></div>`,
    queue: () => `<div>${player.upcoming().map(({ track: q, orderPos }, k) => `<button class="queue-item${k === 0 ? ' current' : ''}" data-pos="${orderPos}">
        ${coverHtml(albumFor(q), 120)}
        <span class="qt"><b>${esc(q.title)}</b><span>${artistLinks(q.artist)} · ${esc(q.album || '')}</span></span>
        <span class="badge ${esc(q.format)}">${esc(q.format)}</span><span class="muted">${fmtTime(q.duration)}</span></button>`).join('')}</div>`,
    info: () => `<div class="stack" style="gap:12px;max-width:620px"><p style="margin:0;line-height:1.6">${esc(t.title)} von ${esc(t.artist)}${t.album ? `, aus „${esc(t.album)}“` : ''}${t.year ? ` (${t.year})` : ''}.</p>
      ${wikiLinks(`${t.title} ${t.artist}`)}</div>`,
  };
  const where = t.source === 'spotify'
    ? `${spotify.playbackMode() === 'connect' ? `<button class="link" data-device>${esc(spotifyTarget())}</button>` : esc(spotifyTarget())}`
    : `${esc(sourceLabel(t.format, [t]))} · auf diesem Gerät`;
  content.innerHTML = `<div class="np">
    <div class="np-left">
      ${mobile() ? `<button class="icon-btn" data-close aria-label="Wiedergabe schließen" style="width:44px;height:44px"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9l7 7 7-7"/></svg></button>` : ''}
      ${coverHtml(album, 1200)}
      <div class="stack" style="gap:4px">
        <span class="np-title">${esc(t.title)}</span>
        <span style="font-size:16px;font-weight:600">${artistLinks(t.artist)}</span>
        ${t.album_id ? `<a href="#/album/${encodeURIComponent(t.album_id)}" class="muted">${esc(t.album || '')}${t.year ? ' · ' + t.year : ''}</a>` : ''}
      </div>
      <div class="row"><span class="badge ${esc(t.format)}">${esc(t.format)}</span><span class="muted" style="font-size:12.5px">${where}</span>
        <button class="link" data-tmenu="${esc(t.id)}" style="margin-left:auto">＋ Zur Playlist</button></div>
      <div class="np-controls">
        <div class="pb-progress" style="max-width:none"><span data-cur>0:00</span><input type="range" min="0" max="1000" value="0" data-seek aria-label="Position im Titel"><span data-dur>0:00</span></div>
        <div class="buttons">
          <button class="icon-btn" data-prev aria-label="Vorheriger Titel"><svg viewBox="0 0 24 24" class="fill" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg></button>
          <button class="play-btn" data-play aria-label="Wiedergabe"></button>
          <button class="icon-btn" data-next aria-label="Nächster Titel"><svg viewBox="0 0 24 24" class="fill" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg></button>
        </div>
      </div>
    </div>
    <div class="stack" style="gap:18px;min-width:0">
      <div class="seg" role="group" aria-label="Bereich">${tabs.map(([k, l]) => `<button data-tab="${k}" aria-pressed="${k === tab}">${l}</button>`).join('')}</div>
      ${pane[tab]()}
    </div></div>`;
  $$('[data-tab]', content).forEach((b) => b.addEventListener('click', () => history.replaceState(null, '', `#/wiedergabe?tab=${b.dataset.tab}`) || viewPlayer(parseHash())));
  $$('[data-pos]', content).forEach((b) => b.addEventListener('click', () => player.jump(+b.dataset.pos)));
  content.querySelector('[data-close]')?.addEventListener('click', () => history.length > 1 ? history.back() : (location.hash = '#/alben'));
  content.querySelector('[data-device]')?.addEventListener('click', pickDevice);
  content.querySelector('[data-prev]').onclick = () => player.prev();
  content.querySelector('[data-next]').onclick = () => player.next();
  content.querySelector('[data-play]').onclick = () => player.toggle();
  bindSeek(content.querySelector('[data-seek]'));
  updatePlayState();
  updateTime();
  if (tab === 'lyrics') loadLyrics(t);
}

// ---------------------------------------------------------------- Liedtexte

const lyricsCache = new Map();
const langName = (l) => { try { return new Intl.DisplayNames(['de'], { type: 'language' }).of(l); } catch { return l; } };
const showDe = () => store.get('lyricsDe', true);

/** Zeilen wie auf dem Server: Kopfzeilen weglassen, Zeitmarken abtrennen. */
function lyricLines(d) {
  if (!d.synced) return d.plain.split('\n').map((text) => ({ t: null, text: text.trim() }));
  return d.synced.split('\n').filter((l) => !/^\s*\[[a-z]+:/i.test(l)).map((l) => {
    const m = l.match(/^\s*\[(\d+):(\d+(?:[.:]\d+)?)\]/);
    return { t: m ? +m[1] * 60 + parseFloat(m[2].replace(':', '.')) : null, text: l.replace(/^\s*(\[\d+:[\d.:]+\]\s*)+/, '').trim() };
  });
}

async function loadLyrics(t) {
  const box = content.querySelector('#lyrics');
  if (!box) return;
  const still = () => player.current?.id === t.id && content.contains(box);
  let d = lyricsCache.get(t.id);
  if (!d) {
    d = await api.lyrics({ artist: t.artist, title: t.title, album: t.album || '', duration: Math.round(t.duration || 0), track: t.source === 'spotify' ? '' : t.id })
      .catch(() => ({ found: false, error: 'Der Liedtext ließ sich gerade nicht laden.' }));
    if (!d.error) lyricsCache.set(t.id, d);
  }
  if (!still()) return;
  if (!d.found || (!d.plain && d.instrumental)) {
    box.innerHTML = `<p class="muted lyr-note">${esc(d.error || (d.instrumental ? 'Ein Instrumentalstück, ohne Text.' : 'Für dieses Lied ist kein Liedtext bekannt.'))}</p>`;
    return;
  }
  const lines = lyricLines(d);
  const draw = (tr) => {
    const de = showDe() && Array.isArray(tr?.lines) ? tr.lines : null;
    const lang = tr?.lang ? langName(tr.lang) : '';
    const toggle = tr?.lines ? `<button class="link" data-de>${showDe() ? 'Übersetzung ausblenden' : 'Deutsche Übersetzung zeigen'}</button>` : '';
    const state = tr === undefined ? 'Übersetzung wird geholt …' : tr?.error ? esc(tr.error) : '';
    box.toggleAttribute('data-synced', !!d.synced);
    box.innerHTML = `<div class="lyr-head muted">Originaltext${lang ? ' · ' + esc(lang) : ''}${d.source === 'Datei' ? ' · aus der Datei' : ''} ${toggle}<span>${state}</span></div>
      ${lines.map((l, i) => l.text ? `<div class="line"${l.t != null ? ` data-t="${l.t}"` : ''}>${esc(l.text)}${de?.[i] ? `<span class="de">${esc(de[i])}</span>` : ''}</div>` : '<div class="gap"></div>').join('')}
      ${showDe() && tr?.lines?.block ? `<div class="lyr-block"><div class="lyr-head muted">Deutsche Übersetzung</div>${esc(tr.lines.block).replace(/\n/g, '<br>')}</div>` : ''}
      <p class="muted lyr-src">Liedtext: ${d.source === 'Datei' ? 'aus der Musikdatei' : 'LRCLIB'}${tr?.lines ? ' · Übersetzung: Google Übersetzer' : ''}</p>`;
    box.querySelector('[data-de]')?.addEventListener('click', () => { store.set('lyricsDe', !showDe()); draw(tr); });
    $$('.line[data-t]', box).forEach((el) => el.addEventListener('click', () => { const { dur } = player.time(); if (dur) player.seekFraction(+el.dataset.t / dur); }));
    lastLyric = null;
    updateLyric();
  };
  draw(d.trans);
  if (d.trans) return;
  const tr = await api.lyricsDe(t.artist, t.title).catch(() => ({ error: 'Die Übersetzung ließ sich gerade nicht laden.' }));
  if (!tr.error) d.trans = tr;
  if (still()) draw(tr);
}

let lastLyric = null;
function updateLyric() {
  const box = content.querySelector('#lyrics[data-synced]');
  if (!box) return;
  const { pos } = player.time();
  let now = null;
  for (const el of box.querySelectorAll('.line[data-t]')) { if (+el.dataset.t <= pos + 0.3) now = el; else break; }
  if (now === lastLyric) return;
  lastLyric?.classList.remove('now');
  now?.classList.add('now');
  lastLyric = now;
  if (now && !box.matches(':hover')) now.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ---------------------------------------------------------------- Playlists

function connectPrompt(what) {
  if (!spotify.configured()) return `<div class="empty">${what} kommen von Spotify. Auf dem Server ist aber noch keine Spotify-Client-ID eingetragen (Datei <code>.env</code>, Eintrag <code>SPOTIFY_CLIENT_ID</code>).</div>`;
  if (!spotify.secureOk()) return `<div class="empty">${what} kommen von Spotify. Das klappt nur über die sichere Adresse, die mit <code>https://</code> beginnt und auf <code>.ts.net</code> endet.</div>`;
  return `<div class="empty">${what} kommen von Spotify. Verbinde BulldogBeats einmal mit deinem Spotify-Konto.<br><br>
    <button class="btn primary" data-sp-login>Mit Spotify verbinden</button></div>`;
}

let playlistCache = null;
async function loadPlaylists(force = false) {
  if (!playlistCache || force) playlistCache = spotify.playlists().catch((e) => { playlistCache = null; throw e; });
  return playlistCache;
}

async function viewPlaylists(r) {
  if (!spotify.isConnected()) { content.innerHTML = `<h1 class="page">Playlists</h1>${connectPrompt('Playlists')}`; return; }
  content.innerHTML = '<h1 class="page">Playlists</h1><p class="muted">Lädt …</p>';
  const list = await loadPlaylists(r.params.has('neu'));
  if (current.key !== r.key) return;
  const tile = (p) => `<a class="tile" href="#/playlist/${encodeURIComponent(p.id)}">${coverHtml({ id: 'pl:' + p.id, title: p.name, artist: p.owner || '', image: p.image }, 300)}
    <span class="t1">${esc(p.name)}</span><span class="t2">${p.count} Titel${p.mine ? '' : ' · ' + esc(p.owner || '')}</span></a>`;
  content.innerHTML = `<div class="stack" style="gap:24px">
    <div class="row" style="gap:18px;justify-content:space-between"><h1 class="page">Playlists</h1>
      <div class="row"><button class="btn" data-act="reload">Neu laden</button><button class="btn primary" data-act="new">Neue Playlist</button></div></div>
    <span class="muted">Deine Spotify-Playlists. Was du hier anlegst, landet auch bei Spotify.</span>
    ${list.length ? `<div class="grid">${list.map(tile).join('')}</div>` : '<p class="muted">Noch keine Playlists.</p>'}
  </div>`;
  content.querySelector('[data-act=reload]').onclick = async () => { await loadPlaylists(true); route(); };
  content.querySelector('[data-act=new]').onclick = () => newPlaylistDialog();
}

function newPlaylistDialog(uris = [], label = '') {
  sheet('Neue Playlist', `<form class="stack" style="gap:12px" data-new>
      <input class="field" name="name" placeholder="Name der Playlist" required autocomplete="off" value="${esc(label)}">
      <button class="btn primary" style="align-self:flex-start">Anlegen</button></form>`, (el) => {
    const f = el.querySelector('[data-new]');
    f.name.focus();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const name = f.name.value.trim();
      if (!name) return;
      try {
        const p = await spotify.createPlaylist(name);
        if (uris.length) await spotify.addToPlaylist(p.id, uris);
        closeSheet();
        toast(uris.length ? `Playlist „${name}“ angelegt, ${uris.length} Titel hinzugefügt.` : `Playlist „${name}“ angelegt.`);
        await loadPlaylists(true);
        if (current.view === 'playlists') route();
      } catch (err) { toast('Playlist anlegen: ' + err.message); }
    };
  });
}

async function addToPlaylistDialog(uris, label) {
  uris = uris.filter(Boolean);
  if (!uris.length) { toast('Diese Titel gibt es nicht bei Spotify.'); return; }
  let list;
  try { list = (await loadPlaylists()).filter((p) => p.mine); } catch (e) { toast('Playlists: ' + e.message); return; }
  sheet('Zur Playlist hinzufügen', `<button class="sheet-item" data-new><b>Neue Playlist …</b></button>
    ${list.map((p) => `<button class="sheet-item" data-pl="${esc(p.id)}"><b>${esc(p.name)}</b><span class="muted">${p.count} Titel</span></button>`).join('')}`, (el) => {
    el.querySelector('[data-new]').onclick = () => newPlaylistDialog(uris, label);
    $$('[data-pl]', el).forEach((b) => b.addEventListener('click', async () => {
      const p = list.find((x) => x.id === b.dataset.pl);
      try {
        await spotify.addToPlaylist(p.id, uris);
        closeSheet();
        toast(`${uris.length} Titel zu „${p.name}“ hinzugefügt.`);
        playlistCache = null;
      } catch (e) { toast('Hinzufügen: ' + e.message); }
    }));
  });
}

async function viewPlaylist(r) {
  if (!spotify.isConnected()) { content.innerHTML = `<h1 class="page">Playlist</h1>${connectPrompt('Playlists')}`; return; }
  const p = await spotify.playlist(r.arg);
  if (current.key !== r.key) return;
  const tracks = p.tracks;
  content.innerHTML = `<div class="stack" style="gap:28px">
    <div class="album-head">${coverHtml({ id: 'pl:' + p.id, title: p.name, artist: p.owner || '', image: p.image }, 600)}
      <div class="stack" style="gap:10px;min-width:0">
        <span class="kicker">Playlist</span>
        <h1 class="album-title">${esc(p.name)}</h1>
        ${p.description ? `<span class="muted">${esc(p.description.replace(/<[^>]+>/g, ''))}</span>` : ''}
        <span class="muted">${[p.owner, `${tracks.length} Titel`, fmtDuration(tracks.reduce((s, t) => s + (t.duration || 0), 0))].filter(Boolean).map(esc).join(' · ')}</span>
      </div>
    </div>
    <div class="row album-actions">
      <button class="btn primary" data-act="play"><svg viewBox="0 0 24 24" class="fill" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>Abspielen</button>
      <button class="btn" data-act="shuffle">Zufällig</button>
      <button class="btn" data-act="queue">Zur Warteschlange</button>
    </div>
    <div class="tracks">${tracks.map((t, i) => `<button class="track" data-i="${i}" data-id="${esc(t.id)}"><span class="n">${i + 1}</span>
      <span class="tt">${esc(t.title)}<span class="ta">${artistLinks(t.artist)} · ${esc(t.album || '')}</span></span><span class="tbtns">${p.mine ? `<span class="tmenu tminus" role="button" tabindex="0" data-tminus="${i}" aria-label="Aus der Playlist entfernen" title="Aus der Playlist entfernen">−</span>` : ''}${menuBtn(t.id)}</span><span class="d">${fmtTime(t.duration)}</span></button>`).join('')}</div>
  </div>`;
  tracks.forEach(remember);
  const removeAt = (i) => {
    const t = tracks[i];
    if (!t) return;
    sheet('Aus der Playlist entfernen', `<p style="margin:0 0 12px;line-height:1.5">„${esc(t.title)}“ von ${esc(t.artist)} aus „${esc(p.name)}“ entfernen? Das gilt auch in Spotify.</p>
      <button class="sheet-item" data-yes><b>Entfernen</b></button><button class="sheet-item" data-close-sheet><b>Abbrechen</b></button>`, (el) => {
      el.querySelector('[data-yes]').onclick = async () => {
        closeSheet();
        try { await spotify.removeFromPlaylist(p.id, t.uri); } catch (e) { toast('Entfernen hat nicht geklappt: ' + e.message); return; }
        playlistCache = null;
        toast(`„${t.title}“ ist aus „${p.name}“ entfernt.`);
        if (current.key === r.key) viewPlaylist(r);
      };
    });
  };
  $$('[data-tminus]', content).forEach((el) => {
    const go = (e) => { if (e.type === 'keydown' && e.key !== 'Enter') return; e.preventDefault(); e.stopPropagation(); removeAt(+el.dataset.tminus); };
    el.addEventListener('click', go);
    el.addEventListener('keydown', go);
  });
  $$('.track', content).forEach((b) => b.addEventListener('click', () => player.playList(tracks, +b.dataset.i)));
  content.querySelector('[data-act=play]').onclick = () => { if (player.shuffle) player.toggleShuffle(); player.playList(tracks, 0); };
  content.querySelector('[data-act=shuffle]').onclick = () => { if (!player.shuffle) player.toggleShuffle(); player.playList(tracks, Math.floor(Math.random() * tracks.length)); };
  content.querySelector('[data-act=queue]').onclick = () => { player.enqueue(tracks, false); toast(`„${p.name}“ steht in der Warteschlange.`); };
  markPlaying();
}

function viewOffline() {
  content.innerHTML = `<h1 class="page">Offline</h1><div class="empty">Hier kannst du später FLAC- und MP3-Alben aufs iPhone laden.
    FLAC wird dafür kleiner umgewandelt, damit es unterwegs weniger Platz braucht.</div>`;
}

// ---------------------------------------------------------------- Spotify-Gerät (iPhone: Spotify Connect)

async function pickDevice() {
  if (!spotify.isConnected()) { toast('Spotify ist nicht verbunden.'); return; }
  let list;
  try { list = await spotify.devices(); } catch (e) { toast('Spotify-Geräte: ' + e.message); return; }
  const chosen = spotify.chosenDevice()?.id;
  sheet('Spotify spielen auf', list.length
    ? list.map((d) => `<button class="sheet-item" data-dev="${esc(d.id)}" aria-pressed="${d.id === chosen}"><b>${esc(d.name)}</b><span class="muted">${esc(d.type)}${d.is_active ? ' · gerade aktiv' : ''}</span></button>`).join('')
    : '<p class="muted" style="margin:0;line-height:1.6">Keine Spotify-App gefunden. Öffne kurz die Spotify-App auf dem Gerät und tippe dann noch einmal hier.</p>', (el) => {
    $$('[data-dev]', el).forEach((b) => b.addEventListener('click', () => {
      spotify.chooseDevice(list.find((d) => d.id === b.dataset.dev));
      closeSheet();
      renderDevice();
      if (current.view === 'wiedergabe') viewPlayer(parseHash());
    }));
  });
}

function renderDevice() {
  const el = $('#device-name');
  const connect = spotify.isConnected() && spotify.playbackMode() === 'connect';
  el.textContent = connect ? `diesem Gerät · Spotify: ${spotify.chosenDevice()?.name || 'wählen'}` : 'diesem Gerät';
  $('.device').classList.toggle('clickable', connect);
}

// ---------------------------------------------------------------- Player-Leiste

const PLAY = '<svg viewBox="0 0 24 24" class="fill" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" class="fill" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';

function updateTrack() {
  const t = player.current;
  document.body.classList.toggle('no-track', !t);
  if (!t) return;
  $('#pb-cover').innerHTML = coverHtml(albumFor(t), 120);
  $('#pb-title').textContent = t.title;
  $('#pb-sub').textContent = `${t.artist} · ${t.format}`;
  document.title = `${t.title} – ${t.artist}`;
  markPlaying();
  if (current.view === 'wiedergabe') viewPlayer(parseHash());
}

function updatePlayState() {
  const icon = player.playing ? PAUSE : PLAY;
  const label = player.playing ? 'Pause' : 'Wiedergabe';
  for (const b of [$('#btn-play'), $('#btn-mini-play'), content.querySelector('[data-play]')]) {
    if (b) { b.innerHTML = icon; b.setAttribute('aria-label', label); }
  }
  $('#btn-shuffle').setAttribute('aria-pressed', player.shuffle);
  $('#btn-repeat').setAttribute('aria-pressed', player.repeat !== 'off');
  $('#btn-repeat').setAttribute('aria-label', { off: 'Wiederholen: aus', all: 'Wiederholen: alle', one: 'Wiederholen: diesen Titel' }[player.repeat]);
}

let seeking = false;
function setRange(input, frac) { input.value = Math.round(frac * 1000); input.style.setProperty('--p', `${frac * 100}%`); }

function updateTime() {
  const { pos, dur } = player.time();
  const frac = dur ? Math.min(1, pos / dur) : 0;
  if (!seeking) {
    for (const s of [$('#seek'), content.querySelector('[data-seek]')]) if (s) setRange(s, frac);
  }
  for (const el of [$('#t-cur'), content.querySelector('[data-cur]')]) if (el) el.textContent = fmtTime(pos);
  for (const el of [$('#t-dur'), content.querySelector('[data-dur]')]) if (el) el.textContent = fmtTime(dur);
}

function bindSeek(input) {
  if (!input) return;
  input.addEventListener('input', () => { seeking = true; input.style.setProperty('--p', `${input.value / 10}%`); });
  input.addEventListener('change', () => { player.seekFraction(input.value / 1000); seeking = false; });
}

player.addEventListener('track', updateTrack);
player.addEventListener('state', updatePlayState);
player.addEventListener('queue', () => { updatePlayState(); if (current.view === 'wiedergabe') viewPlayer(parseHash()); });
player.addEventListener('time', updateTime);
player.addEventListener('time', updateLyric);
player.addEventListener('error', (e) => toast(e.message || 'Wiedergabe nicht möglich.'));

$('#btn-play').onclick = () => player.toggle();
$('#btn-mini-play').onclick = (e) => { e.stopPropagation(); player.toggle(); };
$('#btn-prev').onclick = () => player.prev();
$('#btn-next').onclick = () => player.next();
$('#btn-shuffle').onclick = () => player.toggleShuffle();
$('#btn-repeat').onclick = () => player.cycleRepeat();
$('#pb-now').onclick = () => { if (player.current) location.hash = '#/wiedergabe'; };
bindSeek($('#seek'));
const vol = $('#volume');
vol.max = 100; vol.value = Math.round(player.audio.volume * 100); vol.style.setProperty('--p', `${vol.value}%`);
vol.oninput = () => { player.setVolume(vol.value / 100); vol.style.setProperty('--p', `${vol.value}%`); };

// ---------------------------------------------------------------- Suche, Tastatur, Zurück, Spotify-Knöpfe

$('#search').addEventListener('input', (e) => onSearchInput(e.target.value));
$('#search').addEventListener('focus', () => { if (current.view !== 'suche' && $('#search').value) onSearchInput($('#search').value); });
$('#back').onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/alben'));
$('.device').addEventListener('click', () => { if ($('.device').classList.contains('clickable')) pickDevice(); });

const openArtist = (e) => {
  const el = e.target.closest?.('[data-artist]');
  if (!el || (e.type === 'keydown' && e.key !== 'Enter')) return;
  e.preventDefault();
  e.stopPropagation();
  closeSheet();
  location.hash = '#/interpret/' + encodeURIComponent(el.dataset.artist);
};
document.addEventListener('click', openArtist, true);
const openTrackMenu = (e) => {
  const el = e.target.closest?.('[data-tmenu]');
  if (!el || (e.type === 'keydown' && e.key !== 'Enter')) return;
  e.preventDefault();
  e.stopPropagation();
  const t = rowTracks.get(el.dataset.tmenu);
  if (t) trackMenu(t);
};
document.addEventListener('click', openTrackMenu, true);
document.addEventListener('keydown', openTrackMenu, true);
document.addEventListener('keydown', openArtist, true);

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-sp-login]')) spotify.login().catch((err) => toast(err.message));
  else if (e.target.closest('[data-sp-logout]')) { spotify.logout(); merge(); playlistCache = null; route(); toast('Spotify ist getrennt.'); }
});

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, [contenteditable]') && e.target.type !== 'range';
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    closeSheet();
    if (mobile()) location.hash = '#/suche';
    else { $('#search').focus(); $('#search').select(); }
    return;
  }
  if (e.key === 'Escape' && $('.sheet-back')) { closeSheet(); return; }
  if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey || $('.sheet-back')) return;
  if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); player.toggle(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? player.seekBy(10) : player.next(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? player.seekBy(-10) : player.prev(); }
});

// ---------------------------------------------------------------- Status und Einlesen

let statusTimer, lastStatus = null;

function spotifySourceLine() {
  if (!spotify.configured()) return '<span class="scan">Spotify · keine Client-ID eingetragen</span>';
  if (!spotify.secureOk()) return '<span class="scan">Spotify · nur über die https-Adresse</span>';
  if (!spotify.isConnected()) return '<button data-sp-login>Mit Spotify verbinden</button>';
  const n = lib.albums.filter((a) => a.formats.includes('Spotify')).length;
  const who = spotify.user()?.display_name;
  return `<span>Spotify · ${syncing ? `lädt ${syncNote}` : `${nf.format(n)} Alben`}</span>${who ? `<span class="scan">angemeldet als ${esc(who)}</span>` : ''}
    <button data-sp-logout class="quiet">Spotify trennen</button>`;
}

function renderSources() {
  const st = lastStatus;
  if (!st) return;
  const s = st.scan;
  const scanLine = s.running
    ? `<span class="scan">${esc(s.phase)}${s.total ? `: ${nf.format(s.done)} von ${nf.format(s.total)}` : ''}</span>`
    : `<button id="rescan">Neu einlesen</button>`;
  const missing = s.missing_dirs?.length ? `<span class="scan">Nicht gefunden: ${s.missing_dirs.map(esc).join(', ')}</span>` : '';
  const mp3 = st.tracks.MP3 ? `<span>MP3 · ${nf.format(st.tracks.MP3)} Titel</span>` : '';
  $('#sources').innerHTML = `<div class="nav-title" style="padding:0 0 4px">Quellen</div>
    <span>FLAC · ${nf.format(st.albums.FLAC || 0)} Alben</span>${mp3}
    ${spotifySourceLine()}${missing}${scanLine}`;
  $('#rescan')?.addEventListener('click', async () => { await api.scan(false); pollStatus(); });
}

async function pollStatus() {
  clearTimeout(statusTimer);
  let st;
  try { st = await api.status(); } catch { statusTimer = setTimeout(pollStatus, 15000); return; }
  lastStatus = st;
  renderSources();
  if (st.version !== lib.version && lib.version !== null) {
    const changed = await loadLibrary();
    if (changed && LIB_VIEWS.includes(current.view)) route();
  }
  syncSpotify();
  statusTimer = setTimeout(pollStatus, st.scan.running ? 3000 : 60000);
}

spotify.on((ev) => {
  if (ev === 'auth') { renderSources(); renderDevice(); }
  else if (ev === 'device') renderDevice();
  else if (ev?.type === 'error' && player.engine !== 'spotify') toast(ev.message);
});

// ---------------------------------------------------------------- Start

window.addEventListener('hashchange', route);
(async () => {
  document.body.classList.add('no-track');
  try { lastStatus = await api.status(); } catch (e) { console.error(e); }
  try { await spotify.init(lastStatus?.spotify_client_id); } catch (e) { toast(e.message); }
  try { await loadLibrary(); } catch (e) { console.error(e); }
  renderDevice();
  route();
  pollStatus();
  updatePlayState();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
