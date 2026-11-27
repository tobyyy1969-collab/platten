// Hilfsfunktionen und Server-Schnittstelle

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDuration(sec) {
  const min = Math.round((sec || 0) / 60);
  return min >= 60 ? `${Math.floor(min / 60)} Std. ${min % 60} Min.` : `${min} Min.`;
}

const PALETTE = [
  ['#2C3E50', '#F2D16B'], ['#C8102E', '#111111'], ['#8FB8DE', '#1B2A41'], ['#EDE4D3', '#3B2F2F'],
  ['#1F4E8C', '#F5F1E6'], ['#151515', '#E9E9E9'], ['#D9D4C7', '#2B2B2B'], ['#B8312F', '#FBE9D8'],
  ['#D94F2B', '#10131A'], ['#F3C6CF', '#4B1E2A'], ['#4E7D5B', '#F4F1E8'], ['#2B2B2B', '#C9A227'],
  ['#A44A3F', '#F5E6C8'], ['#5B3A73', '#F1E3F7'], ['#F2B705', '#1A1A1A'], ['#2E5D8A', '#E8EEF4'],
];

export function colorsFor(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

let libVersion = '0';
export const setVersion = (v) => { libVersion = v; };

/** Cover als Farbfläche mit Titel; das echte Bild legt sich darüber, wenn es existiert. */
export function coverHtml(album, size = 300, opts = {}) {
  const [bg, fg] = colorsFor(album.id || album.title);
  const img = album.id && !opts.noImage && album.cover !== false
    ? `<img src="/api/cover/${esc(album.id)}?s=${size}&v=${esc(libVersion)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
    : '';
  return `<div class="cover" style="background:${bg};color:${fg}">
    <span class="ph-artist">${esc(album.artist)}</span><span class="ph-title">${esc(album.title)}</span>${img}</div>`;
}

export function initials(name) {
  const parts = String(name || '?').replace(/^(The|Die|Der|Das) /i, '').split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

export const badges = (formats) => `<div class="badges">${(formats || []).map((f) => `<span class="badge ${esc(f)}">${esc(f)}</span>`).join('')}</div>`;

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

export const api = {
  status: () => get('/api/status'),
  albums: () => get('/api/albums'),
  album: (id) => get(`/api/album/${encodeURIComponent(id)}`),
  artist: (name) => get(`/api/artist?name=${encodeURIComponent(name)}`),
  search: (q) => get(`/api/search?q=${encodeURIComponent(q)}`),
  scan: (full = false) => fetch(`/api/scan?full=${full}`, { method: 'POST' }).then((r) => r.json()),
  streamUrl: (id) => `/api/stream/${id}`,
};

export const store = {
  get(key, def) { try { const v = localStorage.getItem('bb.' + key); return v === null ? def : JSON.parse(v); } catch { return def; } },
  set(key, val) { try { localStorage.setItem('bb.' + key, JSON.stringify(val)); } catch { /* privat */ } },
};

export const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });

/** Sortiername: "The Beatles" unter B, "Die Ärzte" unter Ä. */
export const sortName = (s) => String(s || '').replace(/^(The|Die|Der|Das) /i, '');
