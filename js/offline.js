/* BatApp offline support (modern page only).
 *
 * The repository ships compressed Ogg files. The player converts them to
 * linear WAV in memory on every load; WAV is never persisted. This module owns
 * only the immutable source cache:
 *
 *   - Cache Storage holds one Ogg entry per stem, keyed by its stable URL.
 *   - A rhythm is downloaded lazily the first time it is opened.
 *   - Cached bytes are verified by the player against the SHA-256/CRC-32
 *     manifest in js/lessons.js before they are used.
 *   - A service worker caches only the app shell, never audio, so an installed
 *     or previously visited app can start offline.
 *
 * file:// has no Cache Storage/service worker; local Ogg playback is used as
 * before. Tests can set window.__batappNoOffline = true to exercise the
 * network-only path without registering a service worker or touching caches.
 */
(function (global) {
  "use strict";

  var AUDIO_CACHE = "batapp-audio-v1";
  var AUDIO_BASE = "assets/audio/";
  var persistRequested = false;

  function isHttp() {
    return global.location &&
      (global.location.protocol === "http:" || global.location.protocol === "https:");
  }

  function disabled() {
    return !!global.__batappNoOffline;
  }

  function cacheSupported() {
    return !disabled() && isHttp() && !!global.caches &&
      typeof global.caches.open === "function";
  }

  function swSupported() {
    return !disabled() && isHttp() && !!global.navigator &&
      "serviceWorker" in global.navigator;
  }

  function absolute(value) {
    return new URL(value, document.baseURI).href;
  }

  function audioUrl(path) {
    return absolute(AUDIO_BASE + path);
  }

  function openCache() {
    return global.caches.open(AUDIO_CACHE);
  }

  // Reading must not recreate a cache that Clear offline audio just deleted.
  // `caches.open()` creates the cache in some browsers, so read paths check
  // for it first and only open an existing one.
  function openExisting() {
    return global.caches.keys().then(function (names) {
      return names.indexOf(AUDIO_CACHE) >= 0 ? openCache() : null;
    }).catch(function () {
      return null;
    });
  }

  function settle(promise, fallback, milliseconds) {
    return Promise.race([
      Promise.resolve(promise).catch(function () { return fallback; }),
      new Promise(function (resolve) {
        setTimeout(function () { resolve(fallback); }, milliseconds);
      })
    ]);
  }

  function get(url) {
    if (!cacheSupported()) return Promise.resolve(null);
    return openExisting().then(function (cache) {
      return cache ? cache.match(absolute(url)) : null;
    }).then(function (response) {
      return response ? response.arrayBuffer() : null;
    }).catch(function () {
      return null;
    });
  }

  function put(url, buffer) {
    if (!cacheSupported()) return Promise.resolve(false);
    return openCache().then(function (cache) {
      var response = new Response(buffer, {
        headers: {
          "Content-Type": "audio/ogg",
          "Content-Length": String(buffer.byteLength)
        }
      });
      return cache.put(new Request(absolute(url)), response);
    }).then(function () {
      requestPersistence();
      return true;
    }).catch(function () {
      return false;
    });
  }

  function remove(url) {
    if (!cacheSupported()) return Promise.resolve(false);
    return openExisting().then(function (cache) {
      return cache ? cache.delete(absolute(url)) : false;
    }).catch(function () {
      return false;
    });
  }

  function clearAudio() {
    if (!cacheSupported()) return Promise.resolve(false);
    return global.caches.delete(AUDIO_CACHE).catch(function () {
      return false;
    });
  }

  function requestPersistence() {
    if (persistRequested || !global.navigator || !global.navigator.storage ||
        typeof global.navigator.storage.persist !== "function") return;
    persistRequested = true;
    try {
      var result = global.navigator.storage.persist();
      if (result && typeof result.catch === "function") result.catch(function () {});
    } catch (error) { /* best effort */ }
  }

  function status(lessons) {
    if (!cacheSupported()) {
      return Promise.resolve({
        supported: false,
        online: !!(global.navigator && global.navigator.onLine !== false),
        cachedLessons: 0,
        cachedStems: 0,
        totalLessons: lessons ? lessons.length : 0,
        usage: null,
        persisted: false
      });
    }
    // Cache keys and storage estimates are independent; run them together so
    // the app-info panel is not held up by a slow storage implementation.
    var keysPromise = settle(openExisting().then(function (cache) {
      return cache ? cache.keys() : [];
    }), [], 2000);
    var estimate = global.navigator && global.navigator.storage &&
      typeof global.navigator.storage.estimate === "function"
      ? settle(global.navigator.storage.estimate(), null, 1000)
      : Promise.resolve(null);
    var persisted = global.navigator && global.navigator.storage &&
      typeof global.navigator.storage.persisted === "function"
      ? settle(global.navigator.storage.persisted(), false, 1000)
      : Promise.resolve(false);
    return Promise.all([keysPromise, estimate, persisted]).then(function (values) {
      var urls = {};
      values[0].forEach(function (key) { urls[key.url] = true; });
      var cachedLessons = 0;
      var cachedStems = 0;
      lessons.forEach(function (lesson) {
        var all = lesson.audio.length > 0;
        lesson.audio.forEach(function (entry) {
          var hit = !!urls[audioUrl(entry.path)];
          if (hit) cachedStems += 1;
          else all = false;
        });
        if (all) cachedLessons += 1;
      });
      return {
        supported: true,
        online: !!(global.navigator && global.navigator.onLine !== false),
        cachedLessons: cachedLessons,
        cachedStems: cachedStems,
        totalLessons: lessons.length,
        usage: values[1] && typeof values[1].usage === "number" ? values[1].usage : null,
        persisted: !!values[2]
      };
    }).catch(function () {
      return {
        supported: true,
        online: !!(global.navigator && global.navigator.onLine !== false),
        cachedLessons: 0,
        cachedStems: 0,
        totalLessons: lessons ? lessons.length : 0,
        usage: null,
        persisted: false
      };
    });
  }

  function register() {
    if (!swSupported()) return Promise.resolve(null);
    var meta = document.querySelector('meta[name="batapp-version"]');
    var version = meta ? meta.content : "";
    return global.navigator.serviceWorker.register(
      "sw.js?v=" + encodeURIComponent(version),
      { scope: "./" }
    ).then(function (registration) {
      return registration;
    }).catch(function () {
      return null;
    });
  }

  global.BatappOffline = {
    audioUrl: audioUrl,
    cacheName: AUDIO_CACHE,
    clearAudio: clearAudio,
    get: get,
    put: put,
    register: register,
    remove: remove,
    status: status,
    supported: cacheSupported,
    swSupported: swSupported
  };
})(window);
