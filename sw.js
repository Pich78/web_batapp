/* BatApp app-shell service worker (HTTP/HTTPS only).
 *
 * It caches only the shell. Audio is deliberately not handled here: the page
 * stores immutable Ogg source bytes in Cache Storage and rebuilds WAV in RAM
 * on every load. This keeps unverified audio out of the service-worker cache
 * and preserves the no-WAV-cache rule.
 *
 * The version is kept equal to the repository tag by tools/set_version.py.
 */
"use strict";

var SHELL_VERSION = "v1.4.1";
var SHELL_CACHE = "batapp-shell-" + SHELL_VERSION;
var SHELL_ASSETS = [
  "./",
  "./index.html",
  "./app-new.css?v=" + SHELL_VERSION,
  "./js/lessons.js?v=" + SHELL_VERSION,
  "./js/offline.js?v=" + SHELL_VERSION,
  "./js/wav.js?v=" + SHELL_VERSION,
  "./js/player.js?v=" + SHELL_VERSION,
  "./js/newapp.js?v=" + SHELL_VERSION,
  "./site.webmanifest?v=" + SHELL_VERSION,
  "./assets/icon.svg?v=" + SHELL_VERSION,
  "./assets/icon-16.png?v=" + SHELL_VERSION,
  "./assets/icon-32.png?v=" + SHELL_VERSION,
  "./assets/icon-180.png?v=" + SHELL_VERSION,
  "./assets/icon-192.png?v=" + SHELL_VERSION,
  "./assets/icon-512.png?v=" + SHELL_VERSION
];

function scopeUrl(path) {
  return new URL(path, self.registration.scope).href;
}

function shellPaths() {
  var paths = {};
  SHELL_ASSETS.forEach(function (asset) {
    paths[new URL(asset, self.registration.scope).pathname] = true;
  });
  return paths;
}

function canonical(url) {
  var parsed = new URL(url);
  return new URL(parsed.pathname, self.location.origin).href;
}

function indexUrl() {
  return scopeUrl("index.html");
}

function cacheResponse(key, response) {
  if (!response || !response.ok) return;
  var copy = response.clone();
  caches.open(SHELL_CACHE).then(function (cache) {
    return cache.put(key, copy);
  }).catch(function () { /* cache quota or private mode */ });
}

function networkFirst(request, fallback) {
  return fetch(request).then(function (response) {
    if (response && response.ok) {
      cacheResponse(request.mode === "navigate" ? indexUrl() : canonical(request.url), response);
    }
    return response;
  }).catch(function () {
    return caches.match(request, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return caches.match(fallback || canonical(request.url), { ignoreSearch: true });
    });
  });
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.addAll(SHELL_ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key.indexOf("batapp-shell-") === 0 && key !== SHELL_CACHE) {
          return caches.delete(key);
        }
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Audio is page-managed so only verified Ogg bytes are stored.
  if (url.pathname.indexOf("/assets/audio/") >= 0) return;

  if (request.mode === "navigate") {
    // Only the modern app root/index may use the shell fallback. A navigation
    // to index_old.html (or any other document) stays a normal network request.
    var root = new URL("./", self.registration.scope).pathname;
    var index = new URL("index.html", self.registration.scope).pathname;
    if (url.pathname !== root && url.pathname !== index) return;
    event.respondWith(networkFirst(request, indexUrl()));
    return;
  }

  if (shellPaths()[url.pathname]) {
    event.respondWith(networkFirst(request));
  }
});
