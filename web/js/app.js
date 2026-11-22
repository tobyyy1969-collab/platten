// Plattenregal – Oberfläche für die eigene Musikbibliothek.
import * as api from './api.js';
import * as player from './player.js';

// ---------------------------------------------------------------- Hilfen
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const fmtTotal = s => { const m = Math.round((s || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)} Std. ${m % 60} Min.` : `${m} Min.`; };
const plural = (n, one, many) => `${n.toLocaleString('de-DE')} ${n === 1 ? one : many}`;
const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });
const sortKey = s => String(s ?? '').replace(/^(the|die|der|das|les|la|le)\s+/i, '');
const pref = (k, d) => { try { return JSON.parse(localStorage.getItem('plattenregal.' + k)) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem('plattenregal.' + k, JSON.stringify(v)); } catch {} };

const VA = /^(various artists|various|verschiedene interpreten|va)$/i;
// Interpret mit eigenen Alben (nicht nur auf Samplern vertreten)
const hasOwnAlbums = ar => ar.roles ? ar.roles.includes('albumartist') : ar.albumCount > 0;
const isSampler = a => !!a.isCompilation || VA.test(a.artist || '');

const ICON = {
  play: '<svg viewBox="0 0 24 24" class="ico"><path d="M8 5v14l11-7z"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" class="ico"><path d="M17 3l4 4-4 4V8h-2.6l-2.3 3.1-1.3-1.7L13 6h4V3ZM3 6h4.5l9 12H17v-3l4 4-4 4v-3h-1.5l-9-12H3V6Zm0 10h4l1.7-2.3 1.3 1.7L7.5 18H3v-2Z"/></svg>',
  heart: '<svg viewBox="0 0 24 24" class="ico"><path d="M12 21s-7.5-4.6-9.6-9.3C.9 8.3 3 4.5 6.7 4.5c2.1 0 3.6 1.1 4.3 2.4.7-1.3 2.2-2.4 4.3-2.4 3.7 0 5.8 3.8 4.3 7.2C19.5 16.4 12 21 12 21Z"/></svg>',
  heartO: '<svg viewBox="0 0 24 24" class="ico"><path d="M12 21s-7.5-4.6-9.6-9.3C.9 8.3 3 4.5 6.7 4.5c2.1 0 3.6 1.1 4.3 2.4.7-1.3 2.2-2.4 4.3-2.4 3.7 0 5.8 3.8 4.3 7.2C19.5 16.4 12 21 12 21Zm0-2.4c2.3-1.5 6.3-4.5 7.6-7.7 1-2.3-.3-4.4-2.6-4.4-1.7 0-2.9 1.1-3.4 2.4h-3.2C9.9 7.6 8.7 6.5 7 6.5c-2.3 0-3.6 2.1-2.6 4.4 1.3 3.2 5.3 6.2 7.6 7.7Z"/></svg>',
  people: '<svg viewBox="0 0 24 24" class="ico"><path d="M9 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm7.5 0a3 3 0 1 1 0-6 3 3 0 0 1 0 6ZM2 20c0-3.3 3.1-6 7-6s7 2.7 7 6H2Zm15.5 0c0-1.9-.7-3.6-1.9-4.9 3.6.2 6.4 2.3 6.4 4.9h-4.5Z"/></svg>',
  more: '<svg viewBox="0 0 24 24" class="ico"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 2.5l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.4l-6.1 3.5 1.5-6.8L2.2 9.5l6.9-.7z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" class="ico"><path d="M7 10l5 5 5-5z"/></svg>',
  pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
  playPath: 'M8 5v14l11-7z',
};

// ---------------------------------------------------------------- Zustand
const lib = {
  albums: null,          // alle Alben (Reihenfolge = "Nach Interpret" vom Server)
  byId: new Map(),
  artists: null,
  playlists: [],
};
const contexts = new Map(); // Titellisten der aktuellen Seite, damit Klicks die richtige Liste abspielen
let ctxCounter = 0;
const putCtx = songs => { const k = 'c' + (++ctxCounter); contexts.set(k, songs); return k; };
let renderToken = 0;

const main = $('#main');

// ---------------------------------------------------------------- Meldungen
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------------------------------------------------------------- Bausteine
function coverImg(id, size = 300, alt = '') {
  if (!id) return '';
  return `<img loading="lazy" decoding="async" src="${esc(api.coverUrl(id, size))}" alt="${esc(alt)}" onload="this.classList.add('loaded')" onerror="this.remove()">`;
}

function starsHtml(id, rating, big = false) {
  let s = `<span class="stars${big ? ' big' : ''}" data-rate-id="${esc(id)}" title="Bewertung">`;
  for (let i = 1; i <= 5; i++) s += `<button data-r="${i}" class="${i <= (rating || 0) ? 'on' : ''}" aria-label="${i} Sterne">${ICON.star}</button>`;
  return s + '</span>';
}

function albumCard(a) {
  const sampler = isSampler(a);
  return `<div class="card" data-album="${esc(a.id)}">
    <div class="cover" data-open="#/album/${esc(a.id)}">
      <div class="ph">${esc((a.name || '?').trim()[0] || '?')}</div>
      ${coverImg(a.coverArt, 300, a.name)}
      <div class="overlay"></div>
      <div class="badges">
        ${a.starred ? `<span class="b fav" title="Favorit">${ICON.heart}</span>` : ''}
        ${sampler ? `<span class="b" title="Sampler">${ICON.people}</span>` : ''}
      </div>
      <button class="play-fab" data-act="play-album" data-id="${esc(a.id)}" title="Abspielen">${ICON.play}</button>
    </div>
    <a class="t" href="#/album/${esc(a.id)}">${esc(a.name)}</a>
    ${a.artistId && !sampler ? `<a class="a" href="#/interpret/${esc(a.artistId)}">${esc(a.artist)}</a>` : `<span class="a">${esc(sampler ? 'Sampler' + (a.year ? ' · ' + a.year : '') : a.artist)}</span>`}
    ${starsHtml(a.id, a.userRating)}
  </div>`;
}

// Künstlerfoto: Navidrome holt es automatisch (Deezer, optional Last.fm). Ohne Treffer zeigt es einen Platzhalter.
const artistCoverId = ar => ar.coverArt || 'ar-' + ar.id;

function artistCard(ar) {
  return `<div class="card round">
    <div class="cover" data-open="#/interpret/${esc(ar.id)}">
      <div class="ph">${esc((ar.name || '?').trim()[0] || '?')}</div>
      ${coverImg(artistCoverId(ar), 300, ar.name)}
    </div>
    <a class="t" href="#/interpret/${esc(ar.id)}">${esc(ar.name)}</a>
    <span class="a">${hasOwnAlbums(ar) ? plural(ar.albumCount || 0, 'Album', 'Alben') : 'nur auf Samplern'}</span>
  </div>`;
}

// Titelliste. opts: showAlbum, showArtist ('auto'|true), albumArtist, playlistId
function trackTable(songs, opts = {}) {
  const ctx = putCtx(songs);
  const multiDisc = !opts.showAlbum && new Set(songs.map(s => s.discNumber || 1)).size > 1;
  const cur = player.current();
  let lastDisc = null;
  let rows = '';
  songs.forEach((s, i) => {
    const disc = s.discNumber || 1;
    if (multiDisc && disc !== lastDisc) {
      lastDisc = disc;
      rows += `<tr class="disc-row"><td colspan="5">CD ${disc}</td></tr>`;
    }
    const showArtist = opts.showArtist === true || (opts.showArtist !== false && s.artist && s.artist !== opts.albumArtist);
    const artistHtml = s.artistId ? `<a href="#/interpret/${esc(s.artistId)}">${esc(s.artist)}</a>` : esc(s.artist);
    rows += `<tr class="row${cur && cur.id === s.id ? ' playing' : ''}" data-ctx="${ctx}" data-i="${i}" data-song="${esc(s.id)}">
      <td class="n">${opts.showAlbum || opts.playlistId ? i + 1 : (s.track || i + 1)}</td>
      <td><div class="ti">${esc(s.title)}</div>${showArtist ? `<div class="ar">${artistHtml}</div>` : ''}</td>
      ${opts.showAlbum ? `<td class="al"><a href="#/album/${esc(s.albumId)}">${esc(s.album)}</a></td>` : ''}
      <td class="d">${fmtTime(s.duration)}</td>
      <td class="x"><button class="icon-btn${s.starred ? ' on' : ''}" data-act="track-menu" data-ctx="${ctx}" data-i="${i}" ${opts.playlistId ? `data-pl="${esc(opts.playlistId)}"` : ''} title="Mehr">${ICON.more}</button></td>
    </tr>`;
  });
  return `<table class="tracks"><tbody>${rows}</tbody></table>`;
}

function markPlaying() {
  const cur = player.current();
  $$('.tracks tr.row').forEach(tr => tr.classList.toggle('playing', !!cur && tr.dataset.song === cur.id));
}

// ---------------------------------------------------------------- Bibliothek laden
async function ensureAlbums(force = false) {
  if (lib.albums && !force) return lib.albums;
  const list = await api.allAlbums(n => {
    const el = $('#load-progress');
    if (el) el.textContent = `${n.toLocaleString('de-DE')} Alben geladen …`;
  });
  list.forEach((a, i) => (a._order = i));
  lib.albums = list;
  lib.byId = new Map(list.map(a => [a.id, a]));
  return list;
}

async function ensureArtists() {
  if (!lib.artists) lib.artists = (await api.allArtists()).sort((a, b) => collator.compare(sortKey(a.name), sortKey(b.name)));
  return lib.artists;
}

async function refreshPlaylists() {
  lib.playlists = await api.playlists();
  $('#playlist-nav').innerHTML = lib.playlists.map(p => `<a href="#/playlist/${esc(p.id)}" data-nav="playlist/${esc(p.id)}">${esc(p.name)}</a>`).join('') || '<span class="muted" style="padding:4px 10px;font-size:13px">Noch keine Playlists</span>';
  highlightNav();
}

// ---------------------------------------------------------------- Ansicht: Alben
const albumView = {
  sort: pref('sort', 'artist'),
  filter: '',
  fav: false,
  sampler: pref('samplerMode', 'all'), // all | none | only
  genre: '',
};

const SORTS = {
  artist: { label: 'Nach Interpret', fn: (a, b) => a._order - b._order },
  title: { label: 'Nach Titel', fn: (a, b) => collator.compare(sortKey(a.name), sortKey(b.name)) },
  year: { label: 'Nach Jahr', fn: (a, b) => (a.year || 9999) - (b.year || 9999) || a._order - b._order },
  added: { label: 'Zuletzt hinzugefügt', fn: (a, b) => String(b.created).localeCompare(String(a.created)) },
  rating: { label: 'Nach Bewertung', fn: (a, b) => (b.userRating || 0) - (a.userRating || 0) || a._order - b._order },
  played: { label: 'Zuletzt gespielt', fn: (a, b) => String(b.played || '').localeCompare(String(a.played || '')) },
};

function filteredAlbums(mode) {
  const v = albumView;
  const q = v.filter.trim().toLowerCase();
  let list = lib.albums;
  if (mode === 'sampler') list = list.filter(isSampler);
  else if (mode === 'favoriten') list = list.filter(a => a.starred);
  else {
    if (v.sampler === 'none') list = list.filter(a => !isSampler(a));
    if (v.sampler === 'only') list = list.filter(isSampler);
    if (v.fav) list = list.filter(a => a.starred);
  }
  if (v.genre) list = list.filter(a => (a.genres?.map(g => g.name) ?? [a.genre]).includes(v.genre));
  if (q) list = list.filter(a => `${a.name} ${a.artist} ${a.year || ''} ${a.genre || ''}`.toLowerCase().includes(q));
  return list.slice().sort(SORTS[v.sort]?.fn ?? SORTS.artist.fn);
}

async function renderAlbums(mode = 'alben') {
  const token = renderToken;
  if (!lib.albums) main.innerHTML = `<h1 class="page-title">Meine Alben</h1><p class="loading" id="load-progress">Bibliothek wird geladen …</p>`;
  await ensureAlbums();
  if (token !== renderToken) return;

  const titles = { alben: 'Meine Alben', sampler: 'Sampler', favoriten: 'Favoriten' };
  const genres = [...new Set(lib.albums.flatMap(a => a.genres?.map(g => g.name) ?? (a.genre ? [a.genre] : [])))].sort(collator.compare);
  const v = albumView;

  main.innerHTML = `
    <h1 class="page-title">${titles[mode]}</h1>
    <p class="page-sub" id="album-count"></p>
    <div class="btn-group">
      <button class="btn primary" data-act="play-visible">${ICON.play} Jetzt wiedergeben</button>
      <button class="btn primary" data-act="play-menu" title="Weitere Optionen">${ICON.chevron}</button>
    </div>
    <div class="toolbar">
      ${mode === 'alben' ? `
        <button class="chip${v.fav ? ' on' : ''}" data-act="toggle-fav" title="Nur Favoriten">${v.fav ? ICON.heart : ICON.heartO} Favoriten</button>
        <select class="select" id="sampler-mode" title="Sampler">
          <option value="all"${v.sampler === 'all' ? ' selected' : ''}>Alben und Sampler</option>
          <option value="none"${v.sampler === 'none' ? ' selected' : ''}>Ohne Sampler</option>
          <option value="only"${v.sampler === 'only' ? ' selected' : ''}>Nur Sampler</option>
        </select>` : ''}
      <select class="select" id="genre" title="Genre">
        <option value="">Alle Genres</option>
        ${genres.map(g => `<option${g === v.genre ? ' selected' : ''}>${esc(g)}</option>`).join('')}
      </select>
      <span class="spacer"></span>
      <select class="select" id="sort">${Object.entries(SORTS).map(([k, s]) => `<option value="${k}"${k === v.sort ? ' selected' : ''}>${s.label}</option>`).join('')}</select>
      <input class="filter-input" id="filter" type="search" placeholder="Filtern" value="${esc(v.filter)}">
    </div>
    <div class="grid" id="album-grid"></div>`;

  const draw = () => {
    const list = filteredAlbums(mode);
    $('#album-count').textContent = plural(list.length, 'Album', 'Alben') + (list.length !== lib.albums.length ? ` von ${lib.albums.length.toLocaleString('de-DE')}` : '');
    $('#album-grid').innerHTML = list.length ? list.map(albumCard).join('') : `<p class="empty">Keine Alben gefunden.</p>`;
  };
  draw();

  $('#sort').onchange = e => { v.sort = e.target.value; setPref('sort', v.sort); draw(); };
  $('#genre').onchange = e => { v.genre = e.target.value; draw(); };
  $('#filter').oninput = e => { v.filter = e.target.value; draw(); };
  const sm = $('#sampler-mode');
  if (sm) sm.onchange = e => { v.sampler = e.target.value; setPref('samplerMode', v.sampler); draw(); };
  main._redrawAlbums = draw;
}

// ---------------------------------------------------------------- Ansicht: Album
async function renderAlbum(id) {
  const token = renderToken;
  main.innerHTML = `<p class="loading">Album wird geladen …</p>`;
  const a = await api.album(id);
  if (token !== renderToken) return;
  const songs = a.song ?? [];
  const sampler = isSampler(a);
  const first = songs[0];
  const fmt = first ? `${(first.suffix || '').toUpperCase()}${first.bitDepth ? ` ${first.bitDepth}/${(first.samplingRate / 1000).toLocaleString('de-DE')}` : ''}` : '';
  const discs = new Set(songs.map(s => s.discNumber || 1)).size;
  const ctx = putCtx(songs);

  main.innerHTML = `
    <div class="detail-head">
      <div class="cover"><div class="ph">${esc((a.name || '?')[0])}</div>${a.coverArt ? `<img src="${esc(api.coverUrl(a.coverArt, 600))}" alt="" onload="this.classList.add('loaded')" data-act="zoom-cover" data-cover="${esc(a.coverArt)}">` : ''}</div>
      <div>
        <div class="kind">${sampler ? 'Sampler' : 'Album'}</div>
        <h1>${esc(a.name)}</h1>
        <div class="by">${sampler ? esc(a.artist) : `<a href="#/interpret/${esc(a.artistId)}">${esc(a.artist)}</a>`}</div>
        <div class="meta">${[a.year, a.genre, plural(songs.length, 'Titel', 'Titel'), discs > 1 ? `${discs} CDs` : '', fmtTotal(a.duration)].filter(Boolean).map(esc).join(' · ')} ${fmt ? `<span class="format">${esc(fmt)}</span>` : ''}</div>
        <div class="actions">
          <button class="btn primary" data-act="play-ctx" data-ctx="${ctx}">${ICON.play} Abspielen</button>
          <button class="btn" data-act="shuffle-ctx" data-ctx="${ctx}">${ICON.shuffle} Zufällig</button>
          <button class="icon-btn${a.starred ? ' on' : ''}" data-act="star-album" data-id="${esc(a.id)}" title="Favorit">${a.starred ? ICON.heart : ICON.heartO}</button>
          <button class="icon-btn" data-act="album-menu" data-ctx="${ctx}" title="Mehr">${ICON.more}</button>
          ${starsHtml(a.id, a.userRating, true)}
        </div>
      </div>
    </div>
    ${trackTable(songs, { albumArtist: sampler ? null : a.artist, showArtist: sampler ? true : 'auto' })}`;
}

// ---------------------------------------------------------------- Ansicht: Interpreten
async function renderArtists() {
  const token = renderToken;
  main.innerHTML = `<h1 class="page-title">Interpreten</h1><p class="loading">Wird geladen …</p>`;
  const artists = await ensureArtists();
  if (token !== renderToken) return;
  const showAll = pref('artistsAll', false);
  const list = artists.filter(a => !VA.test(a.name) && (showAll || hasOwnAlbums(a)));
  const letterOf = n => { const c = sortKey(n).trim()[0]?.toUpperCase() || '#'; return /[A-ZÄÖÜ]/.test(c) ? c.replace('Ä', 'A').replace('Ö', 'O').replace('Ü', 'U') : '#'; };
  const groups = new Map();
  list.forEach(a => { const l = letterOf(a.name); if (!groups.has(l)) groups.set(l, []); groups.get(l).push(a); });

  main.innerHTML = `
    <h1 class="page-title">Interpreten</h1>
    <p class="page-sub">${plural(list.length, 'Interpret', 'Interpreten')}</p>
    <div class="toolbar">
      <button class="chip${showAll ? ' on' : ''}" data-act="toggle-artists-all">${ICON.people} Auch Interpreten, die nur auf Samplern sind</button>
      <span class="spacer"></span>
      <input class="filter-input" id="filter" type="search" placeholder="Filtern">
    </div>
    <div class="alpha-index">${[...groups.keys()].map(l => `<a href="#" data-act="jump" data-l="${l}">${l}</a>`).join('')}</div>
    <div id="artist-groups">${[...groups].map(([l, arr]) => `<h2 class="section-title" id="letter-${l}" style="margin-top:28px">${l}</h2><div class="grid">${arr.map(artistCard).join('')}</div>`).join('')}</div>`;

  $('#filter').oninput = e => {
    const q = e.target.value.trim().toLowerCase();
    $('#artist-groups').innerHTML = q
      ? `<div class="grid">${list.filter(a => a.name.toLowerCase().includes(q)).map(artistCard).join('')}</div>`
      : [...groups].map(([l, arr]) => `<h2 class="section-title" id="letter-${l}" style="margin-top:28px">${l}</h2><div class="grid">${arr.map(artistCard).join('')}</div>`).join('');
  };
}

// ---------------------------------------------------------------- Ansicht: Interpret
async function renderArtist(id) {
  const token = renderToken;
  main.innerHTML = `<p class="loading">Wird geladen …</p>`;
  const ar = await api.artist(id);
  if (token !== renderToken) return;
  const all = ar.album ?? [];
  // Eigene Alben: Albuminterpret ist dieser Interpret und es ist kein Sampler.
  const own = all.filter(a => a.artistId === id && !isSampler(a)).sort((a, b) => (a.year || 0) - (b.year || 0));
  const samplers = all.filter(a => !own.includes(a));

  main.innerHTML = `
    <div class="detail-head artist">
      <div class="cover"><div class="ph">${esc(ar.name[0])}</div>${coverImg(artistCoverId(ar), 400, ar.name)}</div>
      <div>
        <div class="kind">Interpret</div>
        <h1>${esc(ar.name)}</h1>
        <div class="meta">${[own.length ? plural(own.length, 'Album', 'Alben') : '', samplers.length ? `auf ${plural(samplers.length, 'Sampler', 'Samplern')}` : ''].filter(Boolean).join(' · ')}</div>
        <div class="actions">
          <button class="btn primary" data-act="play-artist" data-id="${esc(id)}">${ICON.play} Alles abspielen</button>
          <button class="btn" data-act="play-artist" data-id="${esc(id)}" data-shuffle="1">${ICON.shuffle} Zufällig</button>
          <button class="icon-btn${ar.starred ? ' on' : ''}" data-act="star-artist" data-id="${esc(id)}" title="Favorit">${ar.starred ? ICON.heart : ICON.heartO}</button>
        </div>
      </div>
    </div>
    ${own.length ? `<h2 class="section-title">Alben</h2><div class="grid">${own.map(albumCard).join('')}</div>` : ''}
    ${samplers.length ? `<h2 class="section-title">Auf Samplern</h2><div id="sampler-tracks"><p class="loading" style="padding:10px 0">Titel werden gesucht …</p></div>
      <h2 class="section-title" style="font-size:20px">Diese Sampler</h2><div class="grid">${samplers.map(albumCard).join('')}</div>` : ''}`;

  if (samplers.length) {
    const songs = await artistSamplerSongs(id, samplers);
    if (token !== renderToken) return;
    $('#sampler-tracks').innerHTML = songs.length ? trackTable(songs, { showAlbum: true, showArtist: false }) : '<p class="muted">Keine Titel gefunden.</p>';
  }
}

async function artistSamplerSongs(artistId, samplers) {
  const out = [];
  const lists = await Promise.all(samplers.slice(0, 60).map(a => api.album(a.id).catch(() => null)));
  for (const a of lists) {
    for (const s of a?.song ?? []) {
      const ids = s.artists?.map(x => x.id) ?? [s.artistId];
      if (ids.includes(artistId)) out.push(s);
    }
  }
  return out;
}

async function songsOfArtist(id) {
  const ar = await api.artist(id);
  const albums = (ar.album ?? []);
  const own = albums.filter(a => a.artistId === id && !isSampler(a)).sort((a, b) => (a.year || 0) - (b.year || 0));
  const ownSongs = (await Promise.all(own.map(a => api.album(a.id)))).flatMap(a => a.song ?? []);
  const samplerSongs = await artistSamplerSongs(id, albums.filter(a => !own.includes(a)));
  return [...ownSongs, ...samplerSongs];
}

// ---------------------------------------------------------------- Ansicht: Playlists
async function renderPlaylist(id) {
  const token = renderToken;
  main.innerHTML = `<p class="loading">Wird geladen …</p>`;
  const pl = await api.playlist(id);
  if (token !== renderToken) return;
  const songs = pl.entry ?? [];
  const ctx = putCtx(songs);
  main.innerHTML = `
    <div class="detail-head">
      <div class="cover"><div class="ph">♫</div>${coverImg(pl.coverArt || 'pl-' + id, 600)}</div>
      <div>
        <div class="kind">Playlist</div>
        <h1>${esc(pl.name)}</h1>
        <div class="meta">${plural(songs.length, 'Titel', 'Titel')} · ${fmtTotal(pl.duration)}</div>
        <div class="actions">
          <button class="btn primary" data-act="play-ctx" data-ctx="${ctx}">${ICON.play} Abspielen</button>
          <button class="btn" data-act="shuffle-ctx" data-ctx="${ctx}">${ICON.shuffle} Zufällig</button>
          <button class="icon-btn" data-act="playlist-menu" data-id="${esc(id)}" data-name="${esc(pl.name)}" title="Mehr">${ICON.more}</button>
        </div>
      </div>
    </div>
    ${songs.length ? trackTable(songs, { showAlbum: true, showArtist: true, playlistId: id }) : '<p class="empty">Diese Playlist ist leer. Füge Titel über das ⋯-Menü bei einem Album hinzu.</p>'}`;
}

// ---------------------------------------------------------------- Ansicht: Suche
async function renderSearch(q) {
  const token = renderToken;
  $('#search-input').value = q;
  main.innerHTML = `<h1 class="page-title">Suche</h1><p class="loading">Suche nach „${esc(q)}“ …</p>`;
  const r = await api.search(q);
  if (token !== renderToken) return;
  const artists = (r.artist ?? []).filter(a => !VA.test(a.name));
  const albums = r.album ?? [];
  const songs = r.song ?? [];
  main.innerHTML = `
    <h1 class="page-title">„${esc(q)}“</h1>
    <p class="page-sub">${[plural(artists.length, 'Interpret', 'Interpreten'), plural(albums.length, 'Album', 'Alben'), plural(songs.length, 'Titel', 'Titel')].join(' · ')}</p>
    ${artists.length ? `<h2 class="section-title">Interpreten</h2><div class="grid">${artists.map(artistCard).join('')}</div>` : ''}
    ${albums.length ? `<h2 class="section-title">Alben</h2><div class="grid">${albums.map(albumCard).join('')}</div>` : ''}
    ${songs.length ? `<h2 class="section-title">Titel</h2>${trackTable(songs, { showAlbum: true, showArtist: true })}` : ''}
    ${!artists.length && !albums.length && !songs.length ? '<p class="empty">Nichts gefunden.</p>' : ''}`;
}

// ---------------------------------------------------------------- Router
function highlightNav() {
  const h = location.hash.replace(/^#\//, '');
  $$('[data-nav]').forEach(a => a.classList.toggle('active', h === a.dataset.nav || (h === '' && a.dataset.nav === 'alben')));
}

async function route() {
  renderToken++;
  closeMenu();
  highlightNav();
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [view, ...rest] = h.split('/');
  const arg = rest.join('/');
  main.scrollTop = 0;
  try {
    switch (view) {
      case '': case 'alben': await renderAlbums('alben'); break;
      case 'sampler': await renderAlbums('sampler'); break;
      case 'favoriten': await renderAlbums('favoriten'); break;
      case 'album': await renderAlbum(arg); break;
      case 'interpreten': await renderArtists(); break;
      case 'interpret': await renderArtist(arg); break;
      case 'playlist': await renderPlaylist(arg); break;
      case 'suche': await renderSearch(arg); break;
      default: location.hash = '#/alben';
    }
  } catch (e) {
    console.error(e);
    main.innerHTML = `<h1 class="page-title">Hoppla</h1><p class="error">${esc(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------- Menüs und Dialoge
const menuEl = $('#menu');
let menuActions = [];
function openMenu(anchor, items) {
  menuActions = items.filter(Boolean);
  menuEl.innerHTML = menuActions.map((it, i) => it === '-' ? '<hr>' : `<button data-mi="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`).join('');
  menuEl.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  menuEl.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + 'px';
  menuEl.style.top = (r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
}
function closeMenu() { menuEl.hidden = true; }
menuEl.addEventListener('click', e => {
  const b = e.target.closest('[data-mi]');
  if (!b) return;
  closeMenu();
  menuActions[+b.dataset.mi].run();
});

const dialog = $('#dialog');

function chooseNamePrompt(title, initial = '') {
  return new Promise(resolve => {
    dialog.className = 'dialog';
    dialog.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3><input type="text" name="n" value="${esc(initial)}" required placeholder="Name">
      <div class="row"><button class="btn" value="cancel" formnovalidate>Abbrechen</button><button class="btn primary" value="ok">Speichern</button></div></form>`;
    dialog.onclose = () => resolve(dialog.returnValue === 'ok' ? dialog.querySelector('input').value.trim() : null);
    dialog.showModal();
    dialog.querySelector('input').select();
  });
}

async function addToPlaylistDialog(songs) {
  if (!lib.playlists.length) await refreshPlaylists().catch(() => {});
  dialog.className = 'dialog';
  dialog.innerHTML = `<h3>Zu Playlist hinzufügen</h3>
    <div class="list">${lib.playlists.map(p => `<button data-pl="${esc(p.id)}">${esc(p.name)} <span class="muted">· ${p.songCount}</span></button>`).join('') || '<p class="muted" style="padding:0 10px">Noch keine Playlists.</p>'}</div>
    <form class="newpl"><input type="text" placeholder="Neue Playlist …" required><div class="row"><button type="button" class="btn" data-close>Abbrechen</button><button class="btn primary">Anlegen und hinzufügen</button></div></form>`;
  dialog.onclose = null;
  dialog.showModal();
  const ids = songs.map(s => s.id);
  dialog.querySelectorAll('[data-pl]').forEach(b => b.onclick = async () => {
    dialog.close();
    await api.addToPlaylist(b.dataset.pl, ids);
    toast(`${plural(ids.length, 'Titel', 'Titel')} hinzugefügt`);
    refreshPlaylists();
  });
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.querySelector('.newpl').onsubmit = async e => {
    e.preventDefault();
    const name = e.target.querySelector('input').value.trim();
    dialog.close();
    await api.createPlaylist(name, ids);
    toast(`Playlist „${name}“ angelegt`);
    refreshPlaylists();
  };
}

function songMenuItems(songs, label = 'Titel') {
  return [
    { label: 'Abspielen', run: () => player.playList(songs) },
    { label: 'Als Nächstes spielen', run: () => { player.playNext(songs); toast(`${label} kommt als Nächstes`); } },
    { label: 'Zur Warteschlange hinzufügen', run: () => { player.enqueue(songs); toast(`${plural(songs.length, 'Titel', 'Titel')} zur Warteschlange hinzugefügt`); } },
    '-',
    { label: 'Zu Playlist hinzufügen …', run: () => addToPlaylistDialog(songs) },
  ];
}

// ---------------------------------------------------------------- Aktionen
async function playAlbum(id, shuffle = false) {
  const a = await api.album(id);
  let songs = a.song ?? [];
  if (shuffle) songs = songs.slice().sort(() => Math.random() - .5);
  player.playList(songs);
}

async function playRandomFrom(albums, n = 12) {
  if (!albums.length) return;
  const pick = albums.slice().sort(() => Math.random() - .5).slice(0, n);
  const songs = (await Promise.all(pick.map(a => api.album(a.id)))).flatMap(a => a.song ?? []);
  player.playList(songs.sort(() => Math.random() - .5));
  toast(`Zufallsmix aus ${plural(pick.length, 'Album', 'Alben')}`);
}

function currentGridAlbums() {
  const h = location.hash.replace(/^#\/?/, '');
  const mode = h.startsWith('sampler') ? 'sampler' : h.startsWith('favoriten') ? 'favoriten' : 'alben';
  return filteredAlbums(mode);
}

function updateAlbumLocal(id, patch) {
  const a = lib.byId.get(id);
  if (a) Object.assign(a, patch);
}

document.addEventListener('click', async e => {
  if (!menuEl.hidden && !e.target.closest('#menu')) closeMenu();

  // Sterne-Bewertung
  const starBtn = e.target.closest('.stars button');
  if (starBtn) {
    e.preventDefault();
    const box = starBtn.parentElement;
    const id = box.dataset.rateId;
    const cur = box.querySelectorAll('button.on').length;
    const r = +starBtn.dataset.r === cur ? 0 : +starBtn.dataset.r;
    box.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i < r));
    updateAlbumLocal(id, { userRating: r });
    api.setRating(id, r).catch(err => toast('Bewertung nicht gespeichert: ' + err.message));
    return;
  }

  const act = e.target.closest('[data-act]');
  if (act) {
    e.preventDefault();
    e.stopPropagation();
    const d = act.dataset;
    try {
      switch (d.act) {
        case 'play-album': await playAlbum(d.id); break;
        case 'play-ctx': player.playList(contexts.get(d.ctx)); break;
        case 'shuffle-ctx': player.playList(contexts.get(d.ctx).slice().sort(() => Math.random() - .5)); break;
        case 'play-visible': await playRandomFrom(currentGridAlbums()); break;
        case 'play-menu': openMenu(act, [
          { label: 'Zufallsmix aus der Ansicht', run: () => playRandomFrom(currentGridAlbums()) },
          { label: 'Zufälliges Album', run: () => { const l = currentGridAlbums(); if (l.length) playAlbum(l[Math.floor(Math.random() * l.length)].id); } },
          { label: 'Zufallsmix nur aus Samplern', run: () => playRandomFrom(lib.albums.filter(isSampler)) },
          { label: 'Zufallsmix aus 4–5-Sterne-Alben', run: () => playRandomFrom(lib.albums.filter(a => a.userRating >= 4)) },
        ]); break;
        case 'toggle-fav': albumView.fav = !albumView.fav; route(); break;
        case 'toggle-artists-all': setPref('artistsAll', !pref('artistsAll', false)); route(); break;
        case 'jump': $('#letter-' + d.l)?.scrollIntoView({ behavior: 'smooth' }); break;
        case 'star-album': {
          const on = !act.classList.contains('on');
          await api.star({ albumId: d.id }, on);
          act.classList.toggle('on', on);
          act.innerHTML = on ? ICON.heart : ICON.heartO;
          updateAlbumLocal(d.id, { starred: on ? new Date().toISOString() : undefined });
          toast(on ? 'Zu Favoriten hinzugefügt' : 'Aus Favoriten entfernt');
          break;
        }
        case 'star-artist': {
          const on = !act.classList.contains('on');
          await api.star({ artistId: d.id }, on);
          act.classList.toggle('on', on);
          act.innerHTML = on ? ICON.heart : ICON.heartO;
          break;
        }
        case 'play-artist': {
          toast('Titel werden zusammengestellt …');
          let songs = await songsOfArtist(d.id);
          if (d.shuffle) songs = songs.sort(() => Math.random() - .5);
          player.playList(songs);
          break;
        }
        case 'album-menu': openMenu(act, songMenuItems(contexts.get(d.ctx), 'Album')); break;
        case 'track-menu': {
          const songs = contexts.get(d.ctx);
          const s = songs[+d.i];
          openMenu(act, [
            ...songMenuItems([s]),
            { label: s.starred ? 'Aus Favoriten entfernen' : 'Als Favorit markieren', run: async () => {
              await api.star({ id: s.id }, !s.starred);
              s.starred = s.starred ? undefined : new Date().toISOString();
              act.classList.toggle('on', !!s.starred);
            } },
            s.albumId && { label: 'Zum Album', run: () => (location.hash = '#/album/' + s.albumId) },
            s.artistId && { label: 'Zum Interpreten', run: () => (location.hash = '#/interpret/' + s.artistId) },
            d.pl && '-',
            d.pl && { label: 'Aus Playlist entfernen', danger: true, run: async () => { await api.removeFromPlaylist(d.pl, +d.i); refreshPlaylists(); route(); } },
          ]);
          break;
        }
        case 'playlist-menu': openMenu(act, [
          { label: 'Umbenennen …', run: async () => { const n = await chooseNamePrompt('Playlist umbenennen', d.name); if (n) { await api.renamePlaylist(d.id, n); await refreshPlaylists(); route(); } } },
          { label: 'Playlist löschen', danger: true, run: async () => { if (confirm(`Playlist „${d.name}“ wirklich löschen?`)) { await api.deletePlaylist(d.id); await refreshPlaylists(); location.hash = '#/alben'; } } },
        ]); break;
        case 'zoom-cover':
          dialog.className = 'dialog image';
          dialog.innerHTML = `<img class="big" src="${esc(api.coverUrl(d.cover, 1200))}" alt="">`;
          dialog.onclose = null;
          dialog.showModal();
          dialog.onclick = () => dialog.close();
          break;
        case 'q-jump': player.jump(+d.i); break;
        case 'q-remove': player.removeAt(+d.i); break;
        case 'q-clear': player.clearQueue(); break;
        case 'lyric-seek': player.seek(+d.t); break;
      }
    } catch (err) {
      console.error(err);
      toast('Fehler: ' + err.message);
    }
    return;
  }

  // Klick auf Cover öffnet Album/Interpret
  const open = e.target.closest('[data-open]');
  if (open && !e.target.closest('a,button')) { location.hash = open.dataset.open; return; }

  // Klick auf Titelzeile spielt die Liste ab diesem Titel
  const row = e.target.closest('tr.row');
  if (row && !e.target.closest('a,button')) player.playList(contexts.get(row.dataset.ctx), +row.dataset.i);
});

// Sterne beim Überfahren hervorheben
document.addEventListener('mouseover', e => {
  const b = e.target.closest('.stars button');
  if (!b) return;
  const n = +b.dataset.r;
  b.parentElement.querySelectorAll('button').forEach((x, i) => x.classList.toggle('hov', i < n));
});

// ---------------------------------------------------------------- Player-Leiste
const seekEl = $('#seek'), volEl = $('#volume');
const setRangeFill = el => el.style.setProperty('--p', (100 * (el.value - el.min) / (el.max - el.min)) + '%');
let seeking = false;

function renderNowPlaying() {
  const s = player.current();
  const img = $('#np-cover');
  if (!s) { img.hidden = true; $('#np-title').textContent = ''; $('#np-artist').textContent = ''; $('#np-format').textContent = ''; return; }
  img.hidden = !s.coverArt;
  if (s.coverArt) img.src = api.coverUrl(s.coverArt, 120);
  $('#np-title').textContent = s.title;
  $('#np-title').href = '#/album/' + s.albumId;
  $('#np-artist').textContent = s.artist + (s.album ? ' — ' + s.album : '');
  $('#np-artist').href = s.artistId ? '#/interpret/' + s.artistId : '#/album/' + s.albumId;
  $('#np-format').textContent = [(s.suffix || '').toUpperCase(), s.bitDepth && s.samplingRate ? `${s.bitDepth}/${(s.samplingRate / 1000).toLocaleString('de-DE')}` : ''].filter(Boolean).join(' ');
  img.onclick = () => (location.hash = '#/album/' + s.albumId);
  document.title = `${s.title} · ${s.artist} – Plattenregal`;
}

function renderState() {
  $('#play-path').setAttribute('d', player.isPlaying() ? ICON.pause : ICON.playPath);
  const st = player.settings();
  $('#btn-shuffle').classList.toggle('on', st.shuffle);
  $('#btn-repeat').classList.toggle('on', st.repeat !== 'off');
  $('#repeat-one').hidden = st.repeat !== 'one';
}

function renderTime() {
  const a = player.audioEl;
  const dur = a.duration || player.current()?.duration || 0;
  $('#t-cur').textContent = fmtTime(a.currentTime);
  $('#t-dur').textContent = fmtTime(dur);
  if (!seeking) { seekEl.value = dur ? Math.round(1000 * a.currentTime / dur) : 0; setRangeFill(seekEl); }
  if (panel === 'lyrics') syncLyrics();
}

seekEl.addEventListener('input', () => { seeking = true; setRangeFill(seekEl); const dur = player.audioEl.duration || 0; $('#t-cur').textContent = fmtTime(dur * seekEl.value / 1000); });
seekEl.addEventListener('change', () => { player.seek((player.audioEl.duration || 0) * seekEl.value / 1000); seeking = false; });
volEl.value = player.audioEl.volume; setRangeFill(volEl);
volEl.addEventListener('input', () => { player.setVolume(+volEl.value); setRangeFill(volEl); });
$('#btn-play').onclick = () => player.toggle();
$('#btn-next').onclick = () => player.next();
$('#btn-prev').onclick = () => player.prev();
$('#btn-shuffle').onclick = () => player.toggleShuffle();
$('#btn-repeat').onclick = () => player.cycleRepeat();

player.on(what => {
  if (what === 'track') { renderNowPlaying(); markPlaying(); renderState(); if (panel) renderPanel(); }
  if (what === 'queue' && panel === 'queue') renderPanel();
  if (what === 'state') renderState();
  if (what === 'time') renderTime();
  if (what === 'error') toast('Titel konnte nicht abgespielt werden');
});

document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select, dialog')) return;
  if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
  if (e.code === 'ArrowRight' && e.shiftKey) player.next();
  if (e.code === 'ArrowLeft' && e.shiftKey) player.prev();
  if (e.key === '/') { e.preventDefault(); $('#search-input').focus(); }
});

// ---------------------------------------------------------------- Seitenleiste rechts: Warteschlange & Lyrics
let panel = null;
let lyricsFor = null, lyricsData = null;

function openPanel(name) {
  panel = panel === name ? null : name;
  $('#side-panel').hidden = !panel;
  $$('.panel-tabs [data-panel]').forEach(b => b.classList.toggle('active', b.dataset.panel === panel));
  $('#btn-queue').classList.toggle('on', panel === 'queue');
  $('#btn-lyrics').classList.toggle('on', panel === 'lyrics');
  if (panel) renderPanel();
}
$('#btn-queue').onclick = () => openPanel('queue');
$('#btn-lyrics').onclick = () => openPanel('lyrics');
$('#panel-close').onclick = () => openPanel(panel);
$$('.panel-tabs [data-panel]').forEach(b => (b.onclick = () => { if (panel !== b.dataset.panel) openPanel(b.dataset.panel); }));

function renderPanel() {
  const body = $('#panel-body');
  if (panel === 'queue') {
    const q = player.queue(), cur = player.index();
    if (!q.length) { body.innerHTML = '<p class="empty">Die Warteschlange ist leer.</p>'; return; }
    const item = (s, i) => `<div class="q-item${i === cur ? ' current' : ''}${i < cur ? ' past' : ''}" data-act="q-jump" data-i="${i}">
      ${s.coverArt ? `<img src="${esc(api.coverUrl(s.coverArt, 80))}" alt="" loading="lazy">` : '<span class="noimg"></span>'}
      <div class="txt"><div class="tt">${esc(s.title)}</div><div class="muted">${esc(s.artist)}</div></div>
      ${i !== cur ? `<button class="icon-btn small" data-act="q-remove" data-i="${i}" title="Entfernen">×</button>` : ''}
    </div>`;
    body.innerHTML = `<div class="q-label">Läuft gerade</div>${item(q[cur], cur)}
      <div class="q-label"><span>Als Nächstes · ${q.length - cur - 1}</span><button class="link-btn" data-act="q-clear">Leeren</button></div>
      ${q.map((s, i) => (i > cur ? item(s, i) : '')).join('')}
      ${cur > 0 ? `<div class="q-label">Bereits gespielt</div>${q.map((s, i) => (i < cur ? item(s, i) : '')).join('')}` : ''}`;
  } else if (panel === 'lyrics') {
    renderLyrics();
  }
}

async function renderLyrics() {
  const body = $('#panel-body');
  const s = player.current();
  if (!s) { body.innerHTML = '<p class="empty">Gerade läuft nichts.</p>'; return; }
  if (lyricsFor !== s.id) {
    lyricsFor = s.id;
    lyricsData = null;
    body.innerHTML = '<p class="empty">Lyrics werden geladen …</p>';
    try { lyricsData = await api.lyrics(s); } catch { lyricsData = null; }
    if (lyricsFor !== s.id || panel !== 'lyrics') return;
  }
  const L = lyricsData;
  if (!L || !L.line?.length) {
    body.innerHTML = `<p class="empty">Keine Lyrics für „${esc(s.title)}“ gefunden.<br><br><span style="font-size:12px">Tipp: Lyrics werden aus den FLAC-Tags (LYRICS) oder aus einer .lrc-Datei mit gleichem Namen neben der FLAC-Datei gelesen.</span></p>`;
    return;
  }
  body.innerHTML = `<div class="lyrics ${L.synced ? 'synced' : 'plain'}">${L.line.map(l => L.synced
    ? `<p data-act="lyric-seek" data-t="${(l.start || 0) / 1000}" data-start="${l.start || 0}">${esc(l.value) || '&nbsp;'}</p>`
    : `<p>${esc(l.value) || '&nbsp;'}</p>`).join('')}</div>`;
  syncLyrics(true);
}

let lastLyricIdx = -1;
function syncLyrics(force = false) {
  if (!lyricsData?.synced) return;
  const ms = player.audioEl.currentTime * 1000;
  const ps = $$('#panel-body .lyrics p');
  let idx = -1;
  ps.forEach((p, i) => { if (+p.dataset.start <= ms + 150) idx = i; });
  if (idx === lastLyricIdx && !force) return;
  lastLyricIdx = idx;
  ps.forEach((p, i) => p.classList.toggle('on', i === idx));
  if (idx >= 0) ps[idx].scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
}

// ---------------------------------------------------------------- Suche, Playlists, Abmelden
$('#search-form').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  if (q) location.hash = '#/suche/' + encodeURIComponent(q);
});
let searchTimer;
$('#search-input').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length >= 2) searchTimer = setTimeout(() => (location.hash = '#/suche/' + encodeURIComponent(q)), 350);
});

$('#new-playlist').onclick = async () => {
  const name = await chooseNamePrompt('Neue Playlist');
  if (!name) return;
  await api.createPlaylist(name);
  await refreshPlaylists();
  const pl = lib.playlists.find(p => p.name === name);
  if (pl) location.hash = '#/playlist/' + pl.id;
};

$('#logout').onclick = () => { api.logout(); player.audioEl.pause(); location.reload(); };

// ---------------------------------------------------------------- Start
function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#user-name').textContent = api.userName();
  refreshPlaylists().catch(() => {});
  window.addEventListener('hashchange', route);
  route();
  renderState();
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const err = $('#login-error');
  err.hidden = true;
  try {
    await api.login(f.user.value.trim(), f.password.value);
    showApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

if (api.isLoggedIn()) showApp();
else $('#login').hidden = false;
