/* Service worker for "Elise and Luke's Games".
   Offline-first: precache the launcher + every game + fonts/icons, serve
   cache-first, and let cross-origin requests (e.g. the photo games) pass
   through to the network untouched.

   MAINTENANCE: when you add a new game, add its "<game>/" to PAGES below and
   bump CACHE (e.g. el-games-v2) so clients pick up the new precache list. */
const CACHE = 'el-games-v83';

const PAGES = [
  '/', 'battleships/', 'bunny-dig/', 'burgle-cats/', 'catch-the-treats/', 'chameleons/',
  'connect-4/', 'crossy-pets/', 'flappy-dog/', 'fly-or-die/', 'frog-feast/', 'fruit-merge/',
  'grindy-vet/', 'hog-ball/', 'hungry-pig/', 'kit-clash/', 'kitten-jump/', 'match-it/',
  'mob-soccer/', 'monkey-swing/', 'mr-grizzles/', 'naughty-shelf/', 'pet-lovers/', 'picwits/',
  'scroot-rooms/', 'snakes-and-ladders/', 'street-fighter/', 'sumo/', 'twisted-system/', 'wavelength/',
  'whack-a-mole/', 'your-store/'
];
const ASSETS = [
  'manifest.webmanifest', 'pwa.js', 'shared/game.css',
  'shared/game.js', 'fonts/fonts.css', 'fonts/nunito.woff2',
  'fonts/pacifico.woff2', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/icon-512-maskable.png', 'icons/apple-touch-icon.png', 'icons/favicon.png',
  'grindy-vet/js/main.js'
];
const PRECACHE = PAGES.concat(ASSETS);

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return Promise.all(PRECACHE.map(function (u) { return c.add(new Request(u, { cache: 'reload' })).catch(function () {}); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only handle our own origin; cross-origin (photo games, etc.) goes straight
  // to the network so it fails gracefully offline instead of breaking the SW.
  if (url.origin !== self.location.origin) return;

  function putCopy(res) {
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
    }
    return res;
  }

  // Game CODE (page navigations + HTML/JS/CSS) is served NETWORK-FIRST so edits
  // show up immediately when online, with the cache as an offline fallback. (The
  // old cache-first strategy served stale games forever until CACHE was bumped.)
  // Static ASSETS (fonts/icons/images) stay cache-first for speed + offline.
  const isCode = req.mode === 'navigate' || /\.(html?|js|css)$/i.test(url.pathname);

  if (isCode) {
    e.respondWith(
      fetch(req).then(putCopy).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || (req.mode === 'navigate' ? caches.match('/') : Response.error());
        });
      })
    );
  } else {
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(putCopy).catch(function () { return Response.error(); });
      })
    );
  }
});
