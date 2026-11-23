/* Engrgroup23 service worker v4: makes the site open from the PHONE, not the internet.
   - Page + images + Firebase scripts + fonts + verified MCQs come from the phone first,
     then update quietly in the background (stale-while-revalidate).
   - Questions (bank) are saved by the app itself in IndexedDB and also work offline.
   - Login, database and /api are never touched by this worker (always live). */
const V = 'eg23-v4';
const CORE = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/verified-mcqs.js', '/ai.js', '/writer-core.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(V).then(function (c) { return c.addAll(CORE).catch(function () {}); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== V; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

/* stale-while-revalidate: answer from the phone instantly, refresh the copy in the background */
function swr(req, key) {
  return caches.open(V).then(function (c) {
    return c.match(key || req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (r) {
        if (r && !r.redirected && (r.ok || r.type === 'opaque')) { try { c.put(key || req, r.clone()); } catch (_) {} }
        return r;
      }).catch(function () { return hit; });
      return hit || net;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.method !== 'GET') return;
  var u = new URL(r.url);
  if (u.origin === location.origin) {
    if (u.pathname.indexOf('/api/') === 0 || u.pathname === '/sw.js' || u.pathname.indexOf('/__/') === 0) return;
    if (r.mode === 'navigate') { e.respondWith(swr(r, u.origin + u.pathname)); return; }
    if (/\.(js|css|png|jpe?g|webp|svg|ico|webmanifest|woff2?)$/i.test(u.pathname)) { e.respondWith(swr(r)); return; }
    return;
  }
  /* only the static libraries/fonts from other sites; Firestore / login / ads are never cached */
  if ((u.hostname === 'www.gstatic.com' && u.pathname.indexOf('/firebasejs/') === 0) ||
      u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') {
    e.respondWith(swr(r));
  }
});
