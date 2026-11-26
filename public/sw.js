// App-shell cache. Prices come over WebSockets, which service workers never intercept.
// The build id placeholder below is replaced at build time, so every deploy installs a fresh worker and cache.
const CACHE = 'btc-fun-trader-__BUILD_ID__';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg', './icons/apple-touch-icon.png', './icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // The version check must always hit the network.
  if (url.pathname.endsWith('/version.json')) return;

  // Pages: network first so updates arrive, cache as offline fallback.
  // cache: 'no-cache' revalidates with the server; GitHub Pages sends max-age=600,
  // which would otherwise serve a stale index.html for up to 10 minutes.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(new Request(req, { cache: 'no-cache' }))
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  // Hashed assets and icons: cache first (file names change with every build).
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
