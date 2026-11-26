// Service Worker: hält die App-Hülle (HTML, CSS, JS, Symbole) bereit, damit Plattenregal
// als App sofort startet. Musik, Cover und Spotify laufen immer live über das Netz.
const CACHE = 'plattenregal-v3';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/api.js', 'js/player.js', 'js/spotify.js', 'js/md5.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // nur die eigene App-Hülle; Musikserver (/rest), Einstellungen und fremde Adressen nie zwischenspeichern
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/rest/') || url.pathname.endsWith('config.json') || url.pathname.endsWith('.crt')) return;
  // Netz zuerst (damit Updates sofort ankommen), bei fehlendem Netz die gespeicherte Version
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
