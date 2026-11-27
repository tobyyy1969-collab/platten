// BulldogBeats – Oberfläche
import { api, badges, collator, coverHtml, esc, fmtDuration, fmtTime, initials, colorsFor, setVersion, sortName, store } from './lib.js';
import { Player } from './player.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const content = $('#content');
const player = new Player($('#audio'));
const VA = 'Verschiedene Interpreten';
const CHUNK = 270;
const mobile = () => matchMedia('(max-width: 820px)').matches;

const lib = { albums: [], byId: new Map(), version: null };
const prefs = { sort: store.get('sort', 'artist'), filter: store.get('filter', 'Alle'), source: store.get('source', {}) };
const memory = new Map(); // Scrollposition und geladene Menge je Ansicht
let current = { key: '', view: '' };

// ---------------------------------------------------------------- Bibliothek

async function loadLibrary() {
  const d = await api.albums();
  if (d.version === lib.version) return false;
  lib.version = d.version;
  setVersion(d.version);
  lib.albums = d.albums;
  lib.byId = new Map(d.albums.map((a) => [a.id, a]));
  return true;
}

function filtered() {
  const f = prefs.filter;
  return f === 'Alle' ? lib.albums : lib.albums.filter((a) => a.formats.includes(f));
}

const SORTS = {
  artist: { label: 'Interpret', fn: (a, b) => collator.compare(sortName(a.artist), sortName(b.artist)) || (a.year || 0) - (b.year || 0) || collator.compare(a.title, b.title) },
  title: { label: 'Titel', fn: (a, b) => collator.compare(a.title, b.title) },
  year: { label: 'Jahr', fn: (a, b) => (a.year || 9999) - (b.year || 9999) || collator.compare(sortName(a.artist), sortName(b.artist)) },
  added: { label: 'Neu hinzugefügt', fn: (a, b) => (b.added || 0) - (a.added || 0) },
};

// ---------------------------------------------------------------- Router

function parseHash() {
  const h = location.hash.slice(1) || '/alben';
  const [path, qs] = h.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { view: parts[0] || 'alben', arg: parts.slice(1).join('/'), params: new URLSearchParams(qs || ''), key: h };
}

async function route() {
  if (current.key) memory.set(current.key, { top: content.scrollTop, count: content.dataset.count | 0 });
  const r = parseHash();
  current = { key: r.key, view: r.view };
  document.body.classList.toggle('view-player', r.view === 'wiedergabe');
  const top = ['alben', 'interpreten', 'jahre', 'suche', 'playlists', 'offline'];
  $('#back').hidden = top.includes(r.view) || r.view === 'wiedergabe';
  const navKey = ['album', 'interpret'].includes(r.view) ? null : r.view;
  $$('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.nav === navKey));
  const tab = { alben: 'alben', interpreten: 'alben', jahre: 'alben', album: 'alben', interpret: 'alben', suche: 'suche', playlists: 'playlists', offline: 'offline' }[r.view];
  $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  if (r.view !== 'suche' && document.activeElement !== $('#search')) $('#search').value = '';

  const views = { alben: viewLibrary, interpreten: viewLibrary, jahre: viewLibrary, album: viewAlbum, interpret: viewArtist, suche: viewSearch, wiedergabe: viewPlayer, playlists: viewPlaylists, offline: viewOffline };
  const mem = memory.get(r.key);
  try {
    await (views[r.view] || viewLibrary)(r, mem);
  } catch (e) {
    console.error(e);
    content.innerHTML = `<div class="empty"><strong>Das hat nicht geklappt.</strong><br>${esc(e.message)}</div>`;
  }
  content.scrollTop = mem ? mem.top : 0;
}

// ---------------------------------------------------------------- Übersicht (Alben, Interpreten, Jahre)

function libraryHeader(view) {
  const tabs = [['alben', 'Alben'], ['interpreten', 'Interpreten'], ['jahre', 'Jahre']];
  const sortChips = view === 'alben' ? `<div class="chips"><span class="label">Sortieren:</span>${Object.entries(SORTS).map(([k, s]) => `<button class="chip" data-sort="${k}" aria-pressed="${prefs.sort === k}">${s.label}</button>`).join('')}</div>` : '';
  const filters = ['Alle', 'FLAC', 'MP3'].map((f) => `<button class="chip" data-filter="${f}" aria-pressed="${prefs.filter === f}">${f}</button>`).join('');
  return `<div class="stack" style="gap:16px;margin-bottom:24px">
    <div class="row" style="gap:24px;align-items:flex-end">
      <h1 class="page">${mobile() ? 'Bibliothek' : tabs.find((t) => t[0] === view)[1]}</h1>
      <div class="seg" role="group" aria-label="Ansicht">${tabs.map(([k, l]) => `<button data-go="#/${k}" aria-pressed="${view === k}">${l}</button>`).join('')}</div>
    </div>
    <div class="row" style="gap:18px">${sortChips}<div class="chips"><span class="label">Quelle:</span>${filters}</div></div>
  </div>`;
}

function bindHeader() {
  $$('[data-go]', content).forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.go; }));
  $$('[data-sort]', content).forEach((b) => b.addEventListener('click', () => { prefs.sort = b.dataset.sort; store.set('sort', prefs.sort); memory.delete(current.key); route(); }));
  $$('[data-filter]', content).forEach((b) => b.addEventListener('click', () => { prefs.filter = b.dataset.filter; store.set('filter', prefs.filter); memory.clear(); route(); }));
}

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
  const list = filtered();
  content.innerHTML = libraryHeader(view) + (lib.albums.length ? '<div class="grid" id="grid"></div>' : emptyLibrary());
  bindHeader();
  if (!lib.albums.length) return;
  const grid = $('#grid');

  if (view === 'alben') {
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
  const img = album && album.cover !== false ? `<img src="/api/cover/${esc(album.id)}?s=300&v=${esc(lib.version)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<div class="cover" style="background:${bg};color:${fg}">${esc(initials(name))}${img}</div>`;
}

// ---------------------------------------------------------------- Album

function sourceLabel(fmt, tracks) {
  if (fmt === 'FLAC') {
    const bd = Math.max(...tracks.map((t) => t.bitdepth || 16));
    const sr = Math.max(...tracks.map((t) => t.samplerate || 44100)) / 1000;
    return `${bd} Bit / ${String(sr).replace('.', ',')} kHz`;
  }
  const br = Math.max(...tracks.map((t) => t.bitrate || 0));
  return br ? `${br} kbit/s` : 'MP3';
}

function playerTracks(album, tracks) {
  return tracks.map((t) => ({ ...t, album: album.title, album_id: album.id, albumArtist: album.artist }));
}

async function viewAlbum(r) {
  const a = await api.album(r.arg);
  const formats = Object.keys(a.sources);
  let src = prefs.source[a.id] && a.sources[prefs.source[a.id]] ? prefs.source[a.id] : formats[0];
  const render = () => {
    const tracks = a.sources[src] || [];
    const multiDisc = new Set(tracks.map((t) => t.disc || 1)).size > 1;
    let lastDisc = null;
    const rows = tracks.map((t, i) => {
      const disc = t.disc || 1;
      const head = multiDisc && disc !== lastDisc ? `<div class="disc">CD ${disc}</div>` : '';
      lastDisc = disc;
      const sub = t.artist && t.artist !== a.artist ? `<span class="ta">${esc(t.artist)}</span>` : '';
      return `${head}<button class="track" data-i="${i}" data-id="${t.id}"><span class="n">${t.track || i + 1}</span>
        <span class="tt">${esc(t.title)}${sub}</span><span></span><span class="d">${fmtTime(t.duration)}</span></button>`;
    }).join('');
    const wiki = `https://de.wikipedia.org/w/index.php?search=${encodeURIComponent(`${a.title} ${a.artist === VA ? '' : a.artist} Album`)}`;
    content.innerHTML = `<div class="album-layout">
      <div class="stack" style="gap:28px;min-width:0">
        <div class="album-head">${coverHtml(a, 600)}
          <div class="stack" style="gap:10px;min-width:0">
            <span class="kicker">${a.compilation ? 'Sampler' : 'Album'}</span>
            <h1 class="album-title">${esc(a.title)}</h1>
            ${a.artist === VA ? `<span class="album-artist">${VA}</span>` : `<a class="album-artist" href="#/interpret/${encodeURIComponent(a.artist)}">${esc(a.artist)}</a>`}
            <span class="muted">${[a.year, a.genre, `${tracks.length} Titel`, fmtDuration(tracks.reduce((s, t) => s + (t.duration || 0), 0))].filter(Boolean).map(esc).join(' · ')}</span>
            <div class="stack" style="gap:6px;margin-top:6px">
              <span class="muted" style="font-size:12px;font-weight:600">Abspielen aus:</span>
              <div class="seg" role="group" aria-label="Quelle">${formats.map((f) => `<button data-src="${f}" aria-pressed="${f === src}">${f}<span class="sub">${esc(sourceLabel(f, a.sources[f]))}</span></button>`).join('')}</div>
            </div>
          </div>
        </div>
        <div class="row album-actions">
          <button class="btn primary" data-act="play"><svg viewBox="0 0 24 24" class="fill" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>Abspielen</button>
          <button class="btn" data-act="shuffle">Zufällig</button>
          <button class="btn" data-act="next">Als Nächstes</button>
          <button class="btn" data-act="queue">Zur Warteschlange</button>
        </div>
        <div class="tracks">${rows}</div>
      </div>
      <aside class="stack" style="gap:16px">
        <div class="box"><h3>Dieses Album gibt es</h3>
          ${['FLAC', 'MP3'].map((f) => a.sources[f] ? `<span>als ${f} auf dem Server (${esc(sourceLabel(f, a.sources[f]))})</span>` : `<span class="muted">nicht als ${f}</span>`).join('')}
        </div>
        <div class="box about"><h3>Über das Album</h3><a href="${wiki}" target="_blank" rel="noopener">Bei Wikipedia nachschlagen ↗</a></div>
      </aside>
    </div>`;
    $$('[data-src]', content).forEach((b) => b.addEventListener('click', () => {
      src = b.dataset.src; prefs.source[a.id] = src; store.set('source', prefs.source); render();
    }));
    const pt = playerTracks(a, tracks);
    $$('.track', content).forEach((b) => b.addEventListener('click', () => player.playList(pt, +b.dataset.i)));
    content.querySelector('[data-act=play]').onclick = () => { if (player.shuffle) player.toggleShuffle(); player.playList(pt, 0); };
    content.querySelector('[data-act=shuffle]').onclick = () => { if (!player.shuffle) player.toggleShuffle(); player.playList(pt, Math.floor(Math.random() * pt.length)); };
    content.querySelector('[data-act=next]').onclick = () => player.enqueue(pt, true);
    content.querySelector('[data-act=queue]').onclick = () => player.enqueue(pt, false);
    markPlaying();
  };
  render();
}

function markPlaying() {
  const id = player.current?.id;
  $$('.track', content).forEach((b) => b.classList.toggle('playing', +b.dataset.id === id));
}

// ---------------------------------------------------------------- Interpret

async function viewArtist(r) {
  const d = await api.artist(r.arg);
  if (!lib.version) await loadLibrary();
  const latest = d.albums[d.albums.length - 1];
  content.innerHTML = `<div class="stack" style="gap:30px">
    <div class="artist-head">${artistCircle(d.name, latest).replace('class="cover"', 'class="cover artist-photo"')}
      <div class="stack" style="gap:12px;min-width:0">
        <span class="kicker">Interpret</span>
        <h1 class="artist-name">${esc(d.name)}</h1>
        <span class="muted">${d.albums.length} ${d.albums.length === 1 ? 'Album' : 'Alben'} in deiner Sammlung${d.appearances.length ? ` · auf ${d.appearances.length} weiteren Alben vertreten` : ''}</span>
        <div class="row" style="margin-top:4px">
          <button class="btn primary" data-act="all"><svg viewBox="0 0 24 24" class="fill" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>Alles abspielen</button>
          <button class="btn" data-act="shuffle">Zufällig</button>
          <a class="btn" href="https://de.wikipedia.org/w/index.php?search=${encodeURIComponent(d.name)}" target="_blank" rel="noopener">Wikipedia ↗</a>
        </div>
      </div>
    </div>
    <section class="stack" style="gap:14px"><h2 class="section">Alben</h2>
      ${d.albums.length ? `<div class="grid">${d.albums.map((a) => albumTile(a, a.year || '')).join('')}</div>` : '<p class="muted">Keine eigenen Alben.</p>'}</section>
    ${d.appearances.length ? `<section class="stack" style="gap:14px"><h2 class="section">Auf Samplern und anderen Alben</h2>
      <div class="grid">${d.appearances.map((a) => albumTile(a)).join('')}</div></section>` : ''}
  </div>`;
  const collect = async () => {
    const out = [];
    for (const a of d.albums) {
      const full = await api.album(a.id);
      const f = Object.keys(full.sources)[0];
      out.push(...playerTracks(full, full.sources[f]));
    }
    return out;
  };
  content.querySelector('[data-act=all]').onclick = async () => { if (player.shuffle) player.toggleShuffle(); player.playList(await collect(), 0); };
  content.querySelector('[data-act=shuffle]').onclick = async () => { const t = await collect(); if (!player.shuffle) player.toggleShuffle(); player.playList(t, Math.floor(Math.random() * t.length)); };
}

// ---------------------------------------------------------------- Suche

let searchTimer;
function onSearchInput(value) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const target = `#/suche?q=${encodeURIComponent(value)}`;
    if (current.view === 'suche') { history.replaceState(null, '', target); current.key = target.slice(1); viewSearch(parseHash()); }
    else location.hash = target;
  }, 220);
}

async function viewSearch(r) {
  const q = r.params.get('q') || '';
  if (!mobile() && document.activeElement !== $('#search')) $('#search').value = q;
  const box = `<div class="mobile-search" style="margin-bottom:18px"><label class="searchbox"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
    <input id="msearch" type="search" placeholder="Alben, Interpreten, Titel" value="${esc(q)}" autocomplete="off" aria-label="Suchen"></label></div>`;
  if (!q.trim()) {
    content.innerHTML = `${box}<h1 class="page">Suche</h1><p class="muted">Tippe einen Interpreten, ein Album oder einen Titel ein. ${mobile() ? '' : 'Mit ⌘F kommst du jederzeit ins Suchfeld.'}</p>`;
    bindMobileSearch();
    return;
  }
  const [res] = await Promise.all([api.search(q), lib.version ? null : loadLibrary()]);
  const nq = q.toLocaleLowerCase('de').normalize('NFD').replace(/\p{M}/gu, '');
  const norm = (s) => String(s).toLocaleLowerCase('de').normalize('NFD').replace(/\p{M}/gu, '');
  const artists = [...new Set(lib.albums.map((a) => a.artist))].filter((n) => n !== VA && nq.split(/\s+/).every((w) => norm(n).includes(w))).slice(0, 12);

  const group = (fmt) => {
    const al = res.albums.filter((a) => a.formats.includes(fmt));
    const tr = res.tracks.filter((t) => t.format === fmt).slice(0, 12);
    if (!al.length && !tr.length) return '';
    return `<section class="result-group">
      <div class="row"><span class="group-badge badge ${fmt}">${fmt}</span><span class="muted" style="font-size:13px">${al.length} ${al.length === 1 ? 'Album' : 'Alben'} · ${tr.length}${tr.length === 12 ? '+' : ''} Titel</span></div>
      <div class="result-cols">
        <div class="grid">${al.slice(0, 12).map((a) => albumTile(a)).join('')}</div>
        <div class="tracks">${tr.map((t) => `<button class="track" data-id="${t.id}"><span class="n"></span><span class="tt">${esc(t.title)}<span class="ta">${esc(t.artist)} · ${esc(t.album || '')}</span></span><span></span><span class="d">${fmtTime(t.duration)}</span></button>`).join('')}</div>
      </div></section>`;
  };
  const body = [group('FLAC'), group('MP3')].join('');
  content.innerHTML = `${box}<div class="stack" style="gap:30px">
    <div class="stack" style="gap:6px"><h1 class="page" style="font-size:30px">Ergebnisse für „${esc(q)}“</h1>
      <span class="muted">Reihenfolge: Spotify (folgt mit der Spotify-Anbindung), dann FLAC, dann MP3. Alle Treffer werden gezeigt.</span></div>
    ${artists.length ? `<section class="result-group"><h2 class="section" style="font-size:18px">Interpreten</h2><div class="chips">${artists.map((n) => `<a class="chip" href="#/interpret/${encodeURIComponent(n)}">${esc(n)}</a>`).join('')}</div></section>` : ''}
    ${body || (artists.length ? '' : '<p class="muted">Nichts gefunden.</p>')}
  </div>`;
  const all = res.tracks;
  $$('.track', content).forEach((b) => b.addEventListener('click', () => {
    const t = all.find((x) => x.id === +b.dataset.id);
    player.playList([{ ...t, album_id: t.album_id }], 0);
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

function viewPlayer(r) {
  const tab = r.params.get('tab') || 'lyrics';
  const t = player.current;
  if (!t) {
    content.innerHTML = `<div class="empty"><strong>Gerade läuft nichts.</strong><br>Wähle ein Album und tippe auf „Abspielen“.</div>`;
    return;
  }
  const album = lib.byId.get(t.album_id) || { id: t.album_id, title: t.album || '', artist: t.albumArtist || t.artist };
  const tabs = [['lyrics', 'Liedtext'], ['queue', 'Warteschlange'], ['info', 'Über das Lied']];
  const pane = {
    lyrics: () => `<div class="lyrics"><p class="muted" style="font-size:15px;line-height:1.6">Liedtexte (erst Deutsch, sonst Englisch, mitlaufend) werden im nächsten Ausbauschritt eingebaut.</p></div>`,
    queue: () => `<div>${player.upcoming().map(({ track: q, orderPos }, k) => `<button class="queue-item${k === 0 ? ' current' : ''}" data-pos="${orderPos}">
        ${coverHtml({ id: q.album_id, title: q.album, artist: q.artist }, 120)}
        <span class="qt"><b>${esc(q.title)}</b><span>${esc(q.artist)} · ${esc(q.album || '')}</span></span>
        <span class="badge ${esc(q.format)}">${esc(q.format)}</span><span class="muted">${fmtTime(q.duration)}</span></button>`).join('')}</div>`,
    info: () => `<div class="stack" style="gap:12px;max-width:620px"><p style="margin:0;line-height:1.6">${esc(t.title)} von ${esc(t.artist)}${t.album ? `, aus „${esc(t.album)}“` : ''}${t.year ? ` (${t.year})` : ''}.</p>
      <a href="https://de.wikipedia.org/w/index.php?search=${encodeURIComponent(`${t.title} ${t.artist}`)}" target="_blank" rel="noopener">Bei Wikipedia nachschlagen ↗</a></div>`,
  };
  content.innerHTML = `<div class="np">
    <div class="np-left">
      ${mobile() ? `<button class="icon-btn" data-close aria-label="Wiedergabe schließen" style="width:44px;height:44px"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9l7 7 7-7"/></svg></button>` : ''}
      ${coverHtml(album, 1200)}
      <div class="stack" style="gap:4px">
        <span class="np-title">${esc(t.title)}</span>
        <a href="#/interpret/${encodeURIComponent(t.artist)}" style="font-size:16px;font-weight:600">${esc(t.artist)}</a>
        ${t.album_id ? `<a href="#/album/${encodeURIComponent(t.album_id)}" class="muted">${esc(t.album || '')}${t.year ? ' · ' + t.year : ''}</a>` : ''}
      </div>
      <div class="row"><span class="badge ${esc(t.format)}">${esc(t.format)}</span><span class="muted" style="font-size:12.5px">${esc(sourceLabel(t.format, [t]))} · auf diesem Gerät</span></div>
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
  content.querySelector('[data-prev]').onclick = () => player.prev();
  content.querySelector('[data-next]').onclick = () => player.next();
  content.querySelector('[data-play]').onclick = () => player.toggle();
  bindSeek(content.querySelector('[data-seek]'));
  updatePlayState();
  updateTime();
}

// ---------------------------------------------------------------- Playlists und Offline

function viewPlaylists() {
  content.innerHTML = `<h1 class="page">Playlists</h1><div class="empty">Playlists kommen zusammen mit der Spotify-Anbindung:
    deine Spotify-Playlists erscheinen hier, und hier angelegte Playlists landen auch bei Spotify.</div>`;
}

function viewOffline() {
  content.innerHTML = `<h1 class="page">Offline</h1><div class="empty">Hier kannst du später FLAC- und MP3-Alben aufs iPhone laden.
    FLAC wird dafür kleiner umgewandelt, damit es unterwegs weniger Platz braucht.</div>`;
}

// ---------------------------------------------------------------- Player-Leiste

const PLAY = '<svg viewBox="0 0 24 24" class="fill" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" class="fill" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';

function updateTrack() {
  const t = player.current;
  document.body.classList.toggle('no-track', !t);
  if (!t) return;
  const album = lib.byId.get(t.album_id) || { id: t.album_id, title: t.album || '', artist: t.artist };
  $('#pb-cover').innerHTML = coverHtml(album, 120);
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
  const a = player.audio;
  const frac = a.duration ? a.currentTime / a.duration : 0;
  if (!seeking) {
    for (const s of [$('#seek'), content.querySelector('[data-seek]')]) if (s) setRange(s, frac);
  }
  for (const el of [$('#t-cur'), content.querySelector('[data-cur]')]) if (el) el.textContent = fmtTime(a.currentTime);
  for (const el of [$('#t-dur'), content.querySelector('[data-dur]')]) if (el) el.textContent = fmtTime(a.duration || player.current?.duration);
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

// ---------------------------------------------------------------- Suche, Tastatur, Zurück

$('#search').addEventListener('input', (e) => onSearchInput(e.target.value));
$('#search').addEventListener('focus', () => { if (current.view !== 'suche' && $('#search').value) onSearchInput($('#search').value); });
$('#back').onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/alben'));

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, [contenteditable]') && e.target.type !== 'range';
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (mobile()) location.hash = '#/suche';
    else { $('#search').focus(); $('#search').select(); }
    return;
  }
  if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); player.toggle(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? (player.audio.currentTime += 10) : player.next(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? (player.audio.currentTime -= 10) : player.prev(); }
});

// ---------------------------------------------------------------- Status und Einlesen

const nf = new Intl.NumberFormat('de-DE');
let statusTimer;
async function pollStatus() {
  clearTimeout(statusTimer);
  let st;
  try { st = await api.status(); } catch { statusTimer = setTimeout(pollStatus, 15000); return; }
  const s = st.scan;
  const scanLine = s.running
    ? `<span class="scan">${esc(s.phase)}${s.total ? `: ${nf.format(s.done)} von ${nf.format(s.total)}` : ''}</span>`
    : `<button id="rescan">Neu einlesen</button>`;
  const missing = s.missing_dirs?.length ? `<span class="scan">Nicht gefunden: ${s.missing_dirs.map(esc).join(', ')}</span>` : '';
  $('#sources').innerHTML = `<div class="nav-title" style="padding:0 0 4px">Quellen</div>
    <span>FLAC · ${nf.format(st.albums.FLAC || 0)} Alben</span>
    <span>MP3 · ${nf.format(st.tracks.MP3 || 0)} Titel</span>
    <span class="scan">Spotify · noch nicht verbunden</span>${missing}${scanLine}`;
  $('#rescan')?.addEventListener('click', async () => { await api.scan(false); pollStatus(); });
  if (st.version !== lib.version && lib.version !== null) {
    const changed = await loadLibrary();
    if (changed && ['alben', 'interpreten', 'jahre'].includes(current.view)) { memory.delete(current.key); route(); }
  }
  statusTimer = setTimeout(pollStatus, s.running ? 3000 : 60000);
}

// ---------------------------------------------------------------- Start

window.addEventListener('hashchange', route);
(async () => {
  try { await loadLibrary(); } catch (e) { console.error(e); }
  route();
  pollStatus();
  updatePlayState();
  document.body.classList.add('no-track');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
