/* Service worker for "Elise and Luke's Games".
   Offline-first: precache the launcher + every game + fonts/icons, serve
   cache-first, and let cross-origin requests (e.g. the photo games) pass
   through to the network untouched.

   MAINTENANCE: when you add a new game, add its "<game>/" to PAGES below and
   bump CACHE (e.g. el-games-v2) so clients pick up the new precache list. */
const CACHE = 'el-games-v29';

const PAGES = [
  '/',
  'battleships/', 'bunny-dig/', 'catch-the-treats/', 'chameleons/', 'crossy-pets/', 'flappy-dog/',
  'fly-or-die/', 'frog-feast/', 'fruit-merge/', 'grindy-vet/', 'hungry-pig/', 'kit-clash/', 'kitten-jump/',
  'match-it/', 'mob-soccer/', 'monkey-swing/', 'naughty-shelf/', 'picwits/', 'scroot-rooms/',
  'snakes-and-ladders/', 'sumo/', 'twisted-system/', 'wavelength/', 'whack-a-mole/'
];
const ASSETS = [
  'manifest.webmanifest', 'pwa.js',
  'fonts/fonts.css', 'fonts/nunito.woff2', 'fonts/pacifico.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png',
  'icons/apple-touch-icon.png', 'icons/favicon.png'
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

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        // offline + not cached: for a page navigation, fall back to launcher
        if (req.mode === 'navigate') return caches.match('/');
        return Response.error();
      });
    })
  );
});
