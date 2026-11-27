// Service Worker: App-Gerüst und Cover zwischenspeichern.
// Musik wird nicht zwischengespeichert (das kommt mit dem Offline-Download).
const SHELL = 'bb-shell-v4';
const COVERS = 'bb-covers-v1';
const SHELL_FILES = ['/', '/css/app.css', '/js/app.js', '/js/lib.js', '/js/player.js', '/js/spotify.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, COVERS].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/cover/')) {
    // Cover: erst Zwischenspeicher, sonst Netz
    e.respondWith(caches.open(COVERS).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  // App-Gerüst: erst Netz (damit Updates sofort ankommen), sonst Zwischenspeicher
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});
