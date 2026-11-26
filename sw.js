/* Engrgroup23 service worker v7: makes the site open from the PHONE, not the internet.
   - The PAGE (navigations) RACES the network against the phone's saved copy:
     if the newest page is on its way within ~1.2s it is used straight away;
     on a slow connection the saved copy opens instantly and the fresh page
     still lands in the background, ready for the next open.
   - Scripts, images, fonts and verified MCQs come from the phone first, then
     update quietly in the background (stale-while-revalidate).
   - Questions (bank) are saved by the app itself in IndexedDB and also work offline.
   - Login, database and /api are never touched by this worker (always live). */
const V = 'eg23-v7';
const CORE = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/verified-mcqs.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    /* save each file on its own: one missing file must never void the whole
       offline copy (that is exactly what silently broke offline opening before) */
    caches.open(V).then(function (c) {
      return Promise.all(CORE.map(function (u) { return c.add(u).catch(function () {}); }));
    }).then(function () { return self.skipWaiting(); })
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

/* the page: phone copy races the network (1.2s). Fast network = newest page now;
   slow network = saved copy now, fresh page saved in the background for next time.
   `update` keeps the worker alive until the background refresh has landed. */
function navFast(req, key) {
  var done;
  var update = new Promise(function (res) { done = res; });
  var net = fetch(req);
  net.then(function (r) {
    if (r && !r.redirected && r.ok) {
      return caches.open(V).then(function (c) { try { return c.put(key, r.clone()); } catch (_) {} });
    }
  }).catch(function () {}).then(function () { done(); });
  var response = caches.open(V).then(function (c) {
    return c.match(key, { ignoreSearch: true }).then(function (hit) {
      if (!hit) {
        return net.catch(function () {
          return c.match('/index.html', { ignoreSearch: true }).then(function (fb) {
            if (fb) return fb;
            throw new Error('offline');
          });
        });
      }
      return Promise.race([
        net,
        new Promise(function (res) { setTimeout(function () { res(hit); }, 1200); })
      ]).catch(function () { return hit; });
    });
  });
  return { response: response, update: update };
}

self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.method !== 'GET') return;
  var u = new URL(r.url);
  if (u.origin === location.origin) {
    if (u.pathname.indexOf('/api/') === 0 || u.pathname === '/sw.js' || u.pathname.indexOf('/__/') === 0) return;
    if (r.mode === 'navigate') { var nav = navFast(r, u.origin + u.pathname); e.respondWith(nav.response); e.waitUntil(nav.update); return; }
    if (/\.(js|css|png|jpe?g|webp|svg|ico|webmanifest|woff2?)$/i.test(u.pathname)) { e.respondWith(swr(r)); return; }
    return;
  }
  /* only the static libraries/fonts from other sites; Firestore / login / ads are never cached */
  if ((u.hostname === 'www.gstatic.com' && u.pathname.indexOf('/firebasejs/') === 0) ||
      u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') {
    e.respondWith(swr(r));
  }
});
