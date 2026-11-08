/* Engrgroup23: minimal service worker so the browser offers "Install app".
   It does not cache anything, so users always get the latest version. */
self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('fetch',function(){});
