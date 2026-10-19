/* BatApp modern player: verified loading, owned resources, clean transport.
 *
 * This file is used by index.html only. index_old.html keeps js/mixer.js, the
 * original scene-reconstruction transport.
 *
 * Resource model:
 *   - Opening the library creates no player, no Audio element and no
 *     AudioContext. Audio starts loading only after a rhythm is chosen.
 *   - On HTTP(S) every stem is fetched with cache: "no-store", checked against
 *     the byte count and SHA-256/CRC-32 in js/lessons.js, and turned into a
 *     Blob URL. The player is not shown until every stem can play through.
 *   - On file:// the browser cannot read local bytes for a checksum, so the
 *     local media elements are awaited and their durations are checked.
 *   - Back navigation aborts pending transfers, clears the media elements,
 *     revokes every Blob URL, closes the AudioContext and drops all state.
 *
 * Transport model:
 *   - One <audio> element and one GainNode per stem when Web Audio is
 *     available. The element volume stays at 1; GainNode is the only level
 *     control. Browsers that reject local-media Web Audio use element volume.
 *   - Every stem loops. At the loop boundary the transport rewinds all stems to
 *     0 together; it never chases a stem that wrapped at a different time.
 *     This also covers browsers that recalculate one stem's duration after a
 *     near-end seek.
 *   - Pause/Stop/Seek write one shared position to every stem. Pause and Stop
 *     keep the loaded buffers; only Back releases them.
 *
 * Exposes window.BatappPlayer as a classic script. No modules, no build step.
 */
(function (global) {
  "use strict";

  var TRACK_STEM_ALIAS = { bit: "beat" };
  var LOAD_TIMEOUT = 30000;
  var loadSequence = 0;
  // A fresh page session must not reuse an audio URL from an earlier session.
  var loadNonce = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);

  function clamp01(value) {
    var number = typeof value === "number" ? value : parseFloat(value);
    if (!(number >= 0)) number = 0;
    return Math.min(1, number);
  }

  function abortError() {
    try {
      return new DOMException("The operation was aborted.", "AbortError");
    } catch (error) {
      var fallback = new Error("The operation was aborted.");
      fallback.name = "AbortError";
      return fallback;
    }
  }

  function isAbort(error) {
    return !!error && error.name === "AbortError";
  }

  function loadError(failed, message) {
    var error = new Error(message);
    error.name = "BatappLoadError";
    error.failed = failed || [];
    return error;
  }

  function hexFromBuffer(buffer) {
    var bytes = new Uint8Array(buffer);
    var text = "";
    for (var index = 0; index < bytes.length; index += 1) {
      text += (bytes[index] < 16 ? "0" : "") + bytes[index].toString(16);
    }
    return text;
  }

  var CRC_TABLE = null;

  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = new Array(256);
    for (var index = 0; index < 256; index += 1) {
      var value = index;
      for (var bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      CRC_TABLE[index] = value >>> 0;
    }
    return CRC_TABLE;
  }

  function crc32(bytes) {
    var table = crcTable();
    var crc = 0xffffffff;
    for (var index = 0; index < bytes.length; index += 1) {
      crc = table[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
  }

  function readBlob(blob) {
    if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error("Could not read the audio data.")); };
      reader.readAsArrayBuffer(blob);
    });
  }

  function decodeAudio(context, buffer) {
    return new Promise(function (resolve, reject) {
      var result;
      try {
        result = context.decodeAudioData(buffer, resolve, reject);
      } catch (error) {
        reject(error);
        return;
      }
      if (result && typeof result.then === "function") {
        result.then(resolve, reject);
      }
    });
  }

  function reportProgress(callback, done, total, stage) {
    if (typeof callback !== "function") return;
    try {
      callback(done, total, stage);
    } catch (error) {
      /* A UI callback must never break loading or cleanup. */
    }
  }

  function BatappPlayer(lesson, options) {
    options = options || {};
    this.lesson = lesson;
    this.options = options;
    this.tracks = [];
    this.mode = "elements";
    this._audioBase = options.audioBase || "assets/audio/";
    this._state = "idle";
    this._offset = 0;
    this._clockOffset = 0;
    this._clockStartedAt = 0;
    this._loopDuration = 0;
    this._loopTimer = 0;
    this._loaded = false;
    this._loading = false;
    this._disposed = false;
    this._loadPromise = null;
    this._controller = null;
    this._objectUrls = [];
    this._context = null;
    this._playToken = 0;
    this._alignToken = 0;
    this._needsFreshGeneration = false;
    this._onProgress = null;
    this._buildRecords();
  }

  BatappPlayer.create = function (lesson, options) {
    var player = new BatappPlayer(lesson, options || {});
    return player.load((options || {}).onProgress).then(function () {
      return player;
    });
  };

  BatappPlayer.prototype.stemForTrack = function (track) {
    var object = track.object || "";
    var name = object.split("/").pop().toLowerCase();
    return TRACK_STEM_ALIAS[name] || name;
  };

  BatappPlayer.prototype._buildRecords = function () {
    var self = this;
    (this.lesson.audio || []).forEach(function (entry) {
      var track = (self.lesson.tracks || []).filter(function (candidate) {
        return self.stemForTrack(candidate) === entry.stem;
      })[0] || {};
      var initial = track.volume === undefined || track.volume === null ? 1 : clamp01(track.volume);
      self.tracks.push({
        stem: entry.stem,
        path: entry.path,
        clip: entry.clip_name,
        seconds: entry.seconds,
        entry: entry,
        track: track,
        element: null,
        sourceNode: null,
        gain: null,
        volume: initial,
        muted: false,
        ready: false,
        integrity: null,
        error: null,
        _alignSeeking: false
      });
    });
  };

  BatappPlayer.prototype._assetUrl = function (entry) {
    return this._audioBase + entry.path;
  };

  BatappPlayer.prototype.load = function (onProgress) {
    if (this._disposed) return Promise.reject(abortError());
    if (this._loaded) return Promise.resolve(this);
    if (this._loading) return this._loadPromise;

    var self = this;
    this._loading = true;
    this._state = "loading";
    this._onProgress = typeof onProgress === "function" ? onProgress : this.options.onProgress;
    this._controller = typeof global.AbortController === "function"
      ? new global.AbortController()
      : null;

    var protocol = (global.location && global.location.protocol) || "file:";
    var served = protocol === "http:" || protocol === "https:";
    var loading = served ? this._loadHttp() : this._loadFile();

    this._loadPromise = loading.then(function () {
      if (self._disposed) throw abortError();
      self._finalizeLoad();
      return self;
    }).catch(function (error) {
      if (self._disposed && !isAbort(error)) error = abortError();
      self._state = "error";
      self._releaseResources();
      self._disposed = true;
      throw error;
    });
    return this._loadPromise;
  };

  BatappPlayer.prototype._loadHttp = async function () {
    var self = this;
    var entries = this.lesson.audio || [];
    var total = entries.length;
    if (!total) return;
    var signal = this._controller ? this._controller.signal : undefined;
    var loadId = loadNonce + "-" + (++loadSequence);
    var verifiedCount = 0;
    var verified = new Array(total);

    await Promise.all(entries.map(function (entry, index) {
      var url = self._assetUrl(entry) + "?load=" + loadId;
      return fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        signal: signal
      }).then(function (response) {
        if (!response.ok) {
          throw loadError([entry.stem], "Server returned HTTP " + response.status + ".");
        }
        var encoding = response.headers.get("content-encoding");
        var length = response.headers.get("content-length");
        if ((!encoding || encoding === "identity") && length && entry.bytes) {
          if (Number(length) !== Number(entry.bytes)) {
            throw loadError([entry.stem], "Transfer size mismatch.");
          }
        }
        return response.blob();
      }).then(function (blob) {
        if (entry.bytes && blob.size !== Number(entry.bytes)) {
          throw loadError([entry.stem], "Downloaded size mismatch.");
        }
        return readBlob(blob).then(function (buffer) {
          return self._verify(entry, buffer).then(function (integrity) {
            verified[index] = { entry: entry, blob: blob, buffer: buffer, integrity: integrity };
            verifiedCount += 1;
            reportProgress(self._onProgress, verifiedCount, total, "verify");
          });
        });
      }).catch(function (error) {
        if (isAbort(error)) throw error;
        if (error && error.name === "BatappLoadError") throw error;
        throw loadError([entry.stem], "Could not download this stem. Check your connection and try again.");
      });
    }));

    if (this._disposed) throw abortError();
    this._objectUrls = [];
    this._ensureContext();
    var canEncodeWav = !!this._context &&
      global.BatappWav && typeof global.BatappWav.encode === "function";
    var preparedCount = 0;

    // Decode and encode one stem at a time: the finished WAV Blobs stay for
    // playback, but only one decoded AudioBuffer is alive at a time.
    for (var index = 0; index < verified.length; index += 1) {
      if (this._disposed) throw abortError();
      var item = verified[index];
      var record = this.tracks[index];
      var sourceUrl = null;
      var format = "ogg";

      if (canEncodeWav) {
        var audioBuffer = null;
        try {
          audioBuffer = await decodeAudio(this._context, item.buffer);
          item.buffer = null;
          var wav = await global.BatappWav.encode(audioBuffer);
          audioBuffer = null;
          sourceUrl = URL.createObjectURL(wav.blob);
          format = "wav";
          record.wavBytes = wav.bytes;
          record.wavDuration = wav.duration;
          record.wavSampleRate = wav.sampleRate;
          record.wavChannels = wav.channels;
          item.sourceBlob = wav.blob;
          item.blob = null;
        } catch (error) {
          item.wavError = error && (error.message || String(error));
          sourceUrl = null;
        }
      }

      if (!sourceUrl) {
        item.buffer = null;
        record.wavBytes = null;
        record.wavDuration = null;
        record.wavSampleRate = null;
        record.wavChannels = null;
        item.sourceBlob = item.blob;
        sourceUrl = URL.createObjectURL(item.blob);
        format = "ogg";
      }

      item.url = sourceUrl;
      item.format = format;
      this._objectUrls.push(sourceUrl);
      preparedCount += 1;
      reportProgress(this._onProgress, preparedCount, total, "wav");
    }

    if (this._disposed) throw abortError();
    this._createElements(verified.map(function (item, trackIndex) {
      return {
        record: self.tracks[trackIndex],
        url: item.url,
        integrity: item.integrity,
        format: item.format,
        wavError: item.wavError,
        blob: item.sourceBlob
      };
    }));

    var readyCount = 0;
    await Promise.all(this.tracks.map(function (record) {
      return self._waitForElement(record, signal, function () {
        readyCount += 1;
        reportProgress(self._onProgress, readyCount, total, "prepare");
      });
    }));

    if (this._disposed) throw abortError();
  };

  BatappPlayer.prototype._loadFile = function () {
    var self = this;
    var entries = this.lesson.audio || [];
    var total = entries.length;
    if (!total) return Promise.resolve();
    var signal = this._controller ? this._controller.signal : undefined;
    this.mode = "elements";
    this._createElements(entries.map(function (entry, index) {
      return {
        record: self.tracks[index],
        url: self._assetUrl(entry),
        integrity: "duration"
      };
    }));
    var readyCount = 0;
    return Promise.all(this.tracks.map(function (record) {
      return self._waitForElement(record, signal, function () {
        readyCount += 1;
        reportProgress(self._onProgress, readyCount, total, "prepare");
      });
    })).then(function () {
      if (self._disposed) throw abortError();
    });
  };

  BatappPlayer.prototype._verify = function (entry, buffer) {
    var expectedBytes = Number(entry.bytes);
    if (!expectedBytes || !entry.sha256 && !entry.crc32) {
      return Promise.reject(loadError([entry.stem], "Integrity data is missing."));
    }
    if (buffer.byteLength !== expectedBytes) {
      return Promise.reject(loadError([entry.stem], "Downloaded size mismatch."));
    }

    var subtle = global.crypto && global.crypto.subtle;
    if (entry.sha256 && subtle && typeof subtle.digest === "function") {
      return subtle.digest("SHA-256", buffer).then(function (digest) {
        if (hexFromBuffer(digest) !== String(entry.sha256).toLowerCase()) {
          throw loadError([entry.stem], "Integrity check failed.");
        }
        return "sha256";
      }).catch(function (error) {
        if (error && error.name === "BatappLoadError") throw error;
        if (entry.crc32) return verifyCrc(entry, buffer);
        throw loadError([entry.stem], "Integrity check could not run.");
      });
    }
    if (entry.crc32) return verifyCrc(entry, buffer);
    return Promise.reject(loadError([entry.stem], "Integrity check could not run."));
  };

  BatappPlayer.prototype._ensureContext = function () {
    if (this.options.webAudio === false) return;
    if (this._context) return;
    try {
      var Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      this._context = new Ctx();
      this.mode = "webaudio";
    } catch (error) {
      this._context = null;
      this.mode = "elements";
    }
  };

  BatappPlayer.prototype._createElements = function (items) {
    var self = this;
    this._ensureContext();
    var useWebAudio = !!this._context;
    var created = [];

    try {
      items.forEach(function (item) {
        var element = new Audio();
        element.preload = "auto";
        element.loop = true;
        element.setAttribute("playsinline", "");
        if (useWebAudio) {
          var source = self._context.createMediaElementSource(element);
          var gain = self._context.createGain();
          source.connect(gain);
          gain.connect(self._context.destination);
          item.record.sourceNode = source;
          item.record.gain = gain;
          element.volume = 1;
        }
        item.record.element = element;
        self._applyLevel(item.record);
        created.push(item.record);
      });
    } catch (error) {
      this._discardElements(created);
      this._closeContext();
      this.mode = "elements";
      items.forEach(function (item) {
        var element = new Audio();
        element.preload = "auto";
        element.loop = true;
        element.setAttribute("playsinline", "");
        item.record.element = element;
        item.record.sourceNode = null;
        item.record.gain = null;
        self._applyLevel(item.record);
      });
    }

    items.forEach(function (item) {
      var element = item.record.element;
      item.record.integrity = item.integrity;
      item.record.sourceFormat = item.format || "ogg";
      item.record.wavError = item.wavError || null;
      item.record.sourceBlob = item.blob || null;
      item.record.sourceUrl = item.url;
      item.record.objectUrl = item.blob ? item.url : null;
      element.addEventListener("error", function () {
        if (self._disposed) return;
        item.record.error = element.error ? element.error.code : -1;
        if (typeof self.options.onError === "function") {
          self.options.onError(item.record.stem, element.error || new Error("Audio error."));
        }
      });
      element.src = item.url;
    });
  };

  BatappPlayer.prototype._waitForElement = function (record, signal, onReady) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var element = record.element;
      var settled = false;
      var timer = 0;

      function cleanup() {
        element.removeEventListener("canplay", check);
        element.removeEventListener("canplaythrough", check);
        element.removeEventListener("durationchange", check);
        element.removeEventListener("loadeddata", check);
        element.removeEventListener("error", failed);
        if (signal) signal.removeEventListener("abort", aborted);
        if (timer) clearTimeout(timer);
      }
      function fail(message) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(loadError([record.stem], message));
      }
      function failed() {
        fail(element.error ? "Audio error " + element.error.code + "." : "Audio failed to load.");
      }
      function aborted() {
        if (settled) return;
        settled = true;
        cleanup();
        reject(abortError());
      }
      function check() {
        if (settled) return;
        if (element.readyState < 3) return;
        var duration = element.duration;
        // Duration is advisory: some mobile browsers estimate Blob/Ogg
        // durations. The manifest and WAV header are the canonical lengths.
        if (isFinite(duration) && duration > 0) {
          record.mediaDuration = duration;
          if (record.seconds) record.durationDelta = Math.abs(duration - record.seconds);
        } else {
          record.mediaDuration = null;
        }
        settled = true;
        cleanup();
        record.ready = true;
        record.duration = record.wavDuration ||
          (isFinite(duration) && duration > 0 ? duration : record.seconds) || 0;
        if (typeof onReady === "function") onReady();
        resolve();
      }

      element.addEventListener("canplay", check);
      element.addEventListener("canplaythrough", check);
      element.addEventListener("durationchange", check);
      element.addEventListener("loadeddata", check);
      element.addEventListener("error", failed);
      if (signal) signal.addEventListener("abort", aborted);
      timer = setTimeout(function () {
        fail("Timed out while loading.");
      }, LOAD_TIMEOUT);
      if (element.error) {
        failed();
        return;
      }
      try {
        element.load();
      } catch (error) {
        failed();
        return;
      }
      check();
    });
  };

  BatappPlayer.prototype._finalizeLoad = function () {
    // The exported duration is the musical length. Browser-reported media
    // durations can be estimates on mobile, so use the manifest when present.
    var declared = this.tracks.map(function (record) {
      return Number(record.seconds);
    }).filter(function (duration) {
      return isFinite(duration) && duration > 0;
    });
    var mediaDurations = this.tracks.map(function (record) {
      return record.element ? record.element.duration : 0;
    }).filter(function (duration) {
      return isFinite(duration) && duration > 0;
    });
    this._loopDuration = declared.length ? Math.min.apply(null, declared)
      : (mediaDurations.length ? Math.min.apply(null, mediaDurations) : 0);
    this.tracks.forEach(function (record) {
      if (!record.element) return;
      try { record.element.pause(); } catch (error) { /* not loaded */ }
      try { record.element.currentTime = 0; } catch (error) { /* not seekable */ }
    });
    this._offset = 0;
    this._clockOffset = 0;
    this._clockStartedAt = 0;
    this._needsFreshGeneration = false;
    this._loaded = true;
    this._loading = false;
    this._state = "ready";
  };

  BatappPlayer.prototype._applyLevel = function (record) {
    var level = record.muted ? 0 : record.volume;
    if (record.gain) {
      record.gain.gain.value = level;
      if (record.element) {
        record.element.volume = 1;
        record.element.muted = false;
      }
      return;
    }
    if (record.element) {
      // Keep the slider value in `volume` and apply silence separately. Some
      // browsers change the media clock when an element is fully silent
      // (volume 0 or muted); 1e-5 is below the 16-bit sample floor, so the
      // output is digitally silent while the element keeps its normal clock.
      record.element.muted = false;
      record.element.volume = record.muted ? 0.00001 : record.volume;
    }
  };

  BatappPlayer.prototype._resumeContext = function () {
    if (!this._context || this._context.state !== "suspended") return;
    try {
      var promise = this._context.resume();
      if (promise && promise.catch) promise.catch(function () {});
    } catch (error) { /* the browser reports it through play() */ }
  };

  BatappPlayer.prototype._liveTracks = function () {
    return this.tracks.filter(function (record) {
      return record.element && record.ready && !record.element.paused && !record.element.ended;
    });
  };

  BatappPlayer.prototype._pauseAll = function () {
    this.tracks.forEach(function (record) {
      if (!record.element || record.element.paused) return;
      try { record.element.pause(); } catch (error) { /* already released */ }
    });
  };

  BatappPlayer.prototype._mediaPosition = function () {
    var record = this.tracks.filter(function (item) {
      return item.element && !item.element.paused;
    })[0] || this.tracks.filter(function (item) {
      return item.element;
    })[0];
    if (record && record.element && isFinite(record.element.currentTime)) {
      return Math.max(0, Math.min(record.element.currentTime, this.duration()));
    }
    return this.position();
  };

  BatappPlayer.prototype._hasBlobSources = function () {
    return this.tracks.some(function (record) {
      return !!record.sourceBlob;
    });
  };

  BatappPlayer.prototype._silenceGeneration = function () {
    this.tracks.forEach(function (record) {
      if (record.element && !record.element.paused) {
        try { record.element.pause(); } catch (error) { /* released */ }
      }
      if (record.sourceNode) {
        try { record.sourceNode.disconnect(); } catch (error) { /* released */ }
      }
    });
  };

  BatappPlayer.prototype._disposeGeneration = function () {
    this._alignToken += 1;
    this.tracks.forEach(function (record) {
      if (record.element) {
        try { record.element.pause(); } catch (error) { /* released */ }
        try { record.element.removeAttribute("src"); } catch (error) { /* released */ }
        try { record.element.load(); } catch (error) { /* released */ }
      }
      if (record.sourceNode) {
        try { record.sourceNode.disconnect(); } catch (error) { /* released */ }
      }
      if (record.gain) {
        try { record.gain.disconnect(); } catch (error) { /* released */ }
      }
      record.element = null;
      record.sourceNode = null;
      record.gain = null;
      record.ready = false;
      record.objectUrl = null;
      record._alignSeeking = false;
    });
    this._objectUrls.forEach(function (url) {
      try { URL.revokeObjectURL(url); } catch (error) { /* already revoked */ }
    });
    this._objectUrls = [];
  };

  BatappPlayer.prototype._rebuildPlayback = function (offset) {
    var self = this;
    this._disposeGeneration();
    var items = this.tracks.map(function (record) {
      var url = record.sourceUrl;
      if (record.sourceBlob) {
        url = URL.createObjectURL(record.sourceBlob);
        self._objectUrls.push(url);
        record.sourceUrl = url;
        record.objectUrl = url;
      }
      return {
        record: record,
        url: url,
        integrity: record.integrity,
        format: record.sourceFormat,
        wavError: record.wavError,
        blob: record.sourceBlob
      };
    });
    this._createElements(items);
    this.tracks.forEach(function (record) {
      record.ready = true;
      record.duration = record.wavDuration || record.seconds || 0;
      if (!record.element) return;
      try { record.element.currentTime = offset; } catch (error) { /* not seekable yet */ }
    });
    this._needsFreshGeneration = false;
  };

  BatappPlayer.prototype._alignAll = function (seconds) {
    var self = this;
    var duration = this.duration();
    var target = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
    var token = ++this._alignToken;
    return Promise.all(this.tracks.map(function (record) {
      return self._alignRecord(record, target, token);
    })).then(function (results) {
      return token === self._alignToken && results.every(Boolean);
    });
  };

  BatappPlayer.prototype._alignRecord = function (record, target, token) {
    var self = this;
    var element = record.element;
    if (!element) return Promise.resolve(true);

    return new Promise(function (resolve) {
      var attempts = 0;
      var settled = false;

      function finish(ok) {
        if (settled) return;
        settled = true;
        resolve(ok);
      }
      function current() {
        return self._disposed || token !== self._alignToken;
      }
      function waitForSeekedThenRetry() {
        if (current()) {
          finish(false);
          return;
        }
        var timer = 0;
        var done = false;
        function cleanup() {
          element.removeEventListener("seeked", seeked);
          element.removeEventListener("error", failed);
          if (timer) clearTimeout(timer);
        }
        function seeked() {
          if (done) return;
          done = true;
          record._alignSeeking = false;
          cleanup();
          attempt();
        }
        function failed() {
          if (done) return;
          done = true;
          record._alignSeeking = false;
          cleanup();
          finish(false);
        }
        element.addEventListener("seeked", seeked);
        element.addEventListener("error", failed);
        timer = setTimeout(function () {
          if (done) return;
          done = true;
          record._alignSeeking = false;
          cleanup();
          finish(false);
        }, 600);
      }
      function attempt() {
        if (current()) {
          finish(false);
          return;
        }
        if (element.seeking || record._alignSeeking) {
          waitForSeekedThenRetry();
          return;
        }
        if (Math.abs(element.currentTime - target) <= 0.03) {
          finish(true);
          return;
        }
        if (attempts >= 4) {
          finish(false);
          return;
        }
        attempts += 1;

        var timer = 0;
        var quiet = 0;
        var done = false;
        function cleanup() {
          element.removeEventListener("seeked", seeked);
          element.removeEventListener("error", failed);
          if (timer) clearTimeout(timer);
          if (quiet) clearTimeout(quiet);
        }
        function seeked() {
          if (done) return;
          done = true;
          record._alignSeeking = false;
          cleanup();
          attempt();
        }
        function failed() {
          if (done) return;
          done = true;
          record._alignSeeking = false;
          cleanup();
          finish(false);
        }
        element.addEventListener("seeked", seeked);
        element.addEventListener("error", failed);
        record._alignSeeking = true;
        try {
          element.currentTime = target;
        } catch (error) {
          record._alignSeeking = false;
          done = true;
          cleanup();
          finish(false);
          return;
        }
        timer = setTimeout(function () {
          if (done) return;
          done = true;
          record._alignSeeking = false;
          cleanup();
          attempt();
        }, 600);
        // Some browsers do not fire seeked when the element is already at the
        // target. Give the seek a short moment to appear before accepting it.
        quiet = setTimeout(function () {
          if (done) return;
          if (!element.seeking && Math.abs(element.currentTime - target) <= 0.03) {
            done = true;
            record._alignSeeking = false;
            cleanup();
            finish(true);
          }
        }, 80);
      }

      attempt();
    });
  };

  BatappPlayer.prototype._scheduleLoop = function (token) {
    var self = this;
    if (this._loopTimer) {
      clearTimeout(this._loopTimer);
      this._loopTimer = 0;
    }
    var duration = this.duration();
    if (!duration || this._state !== "playing") return;
    var elapsed = (performance.now() - this._clockStartedAt) / 1000;
    var position = (this._clockOffset + elapsed) % duration;
    var remaining = duration - position;
    if (remaining <= 0.02) remaining = 0.02;
    // Reset just before the native loop point so a stem whose browser-reported
    // duration grew after seeking cannot loop later than the others.
    this._loopTimer = setTimeout(function () {
      self._loopTimer = 0;
      if (self._disposed || token !== self._playToken || self._state !== "playing") return;
      self._wrapLoop(token);
    }, Math.max(10, remaining * 1000 - 10));
  };

  BatappPlayer.prototype._wrapLoop = function (token) {
    var self = this;
    this.tracks.forEach(function (record) {
      if (!record.element) return;
      record._alignSeeking = false;
      try { record.element.currentTime = 0; } catch (error) { /* not seekable */ }
    });
    this._clockOffset = 0;
    this._clockStartedAt = performance.now();
    this._scheduleLoop(token);
  };

  BatappPlayer.prototype._startElements = function (token) {
    var self = this;
    var attempts = this.tracks.map(function (record) {
      if (!record.element) return Promise.resolve(null);
      var attempt;
      try {
        attempt = record.element.play();
      } catch (error) {
        return Promise.resolve({ record: record, error: error });
      }
      if (!attempt || !attempt.then) {
        if (self._disposed || token !== self._playToken || self._state !== "playing") {
          try { record.element.pause(); } catch (error) { /* released */ }
        }
        return Promise.resolve(null);
      }
      return attempt.then(function () {
        if (self._disposed || token !== self._playToken || self._state !== "playing") {
          try { record.element.pause(); } catch (error) { /* released */ }
        }
        return null;
      }, function (error) {
        return { record: record, error: error };
      });
    });

    Promise.all(attempts).then(function (results) {
      var failure = results.filter(Boolean)[0];
      if (!failure) return;
      if (self._disposed || token !== self._playToken || self._state !== "playing") return;
      var position = self._mediaPosition();
      if (self._loopTimer) {
        clearTimeout(self._loopTimer);
        self._loopTimer = 0;
      }
      self._state = "paused";
      self._pauseAll();
      var fresh = self._hasBlobSources();
      if (fresh) self._silenceGeneration();
      self._offset = position;
      self._clockOffset = position;
      self._clockStartedAt = performance.now();
      self._needsFreshGeneration = fresh;
      if (!fresh) self._alignAll(position);
      if (typeof self.options.onError === "function") {
        self.options.onError(failure.record.stem, failure.error);
      }
    });
  };

  BatappPlayer.prototype.duration = function () {
    if (this._loopDuration > 0) return this._loopDuration;
    for (var index = 0; index < this.tracks.length; index += 1) {
      var record = this.tracks[index];
      if (record.element && isFinite(record.element.duration) && record.element.duration > 0) {
        return record.element.duration;
      }
    }
    return 0;
  };

  BatappPlayer.prototype.position = function () {
    var duration = this.duration();
    if (this._state === "playing" && duration > 0) {
      var elapsed = (performance.now() - this._clockStartedAt) / 1000;
      var position = (this._clockOffset + elapsed) % duration;
      return position < 0 ? position + duration : position;
    }
    return this._offset;
  };

  BatappPlayer.prototype.progress = function () {
    return {
      current: this.position(),
      duration: this.duration()
    };
  };

  BatappPlayer.prototype.play = function () {
    if (this._disposed || !this._loaded) return false;
    if (this._state === "playing") return true;

    var self = this;
    var token = ++this._playToken;
    this._resumeContext();
    var offset = this._offset;
    var duration = this.duration();
    if (duration > 0 && offset >= duration) offset = 0;
    this._offset = offset;
    this._state = "playing";

    // After Pause or Stop on HTTP, build a fresh media generation from the
    // same Blob instead of seeking the old pipeline. This discards buffered
    // audio and guarantees the audible start position.
    if (this._needsFreshGeneration) {
      try {
        this._rebuildPlayback(offset);
      } catch (error) {
        this._state = "paused";
        this._needsFreshGeneration = this._hasBlobSources();
        if (typeof this.options.onError === "function") {
          this.options.onError(null, error);
        }
        return true;
      }
      this._clockOffset = offset;
      this._clockStartedAt = performance.now();
      this._startElements(token);
      this._scheduleLoop(token);
      return true;
    }

    // A pending seek must settle before all stems start, or one element can
    // keep its old position while the others jump to the shared offset.
    this._alignAll(offset).then(function (aligned) {
      if (self._disposed || token !== self._playToken || self._state !== "playing") return;
      if (!aligned) {
        self._state = "paused";
        self._offset = offset;
        self._clockOffset = offset;
        self._clockStartedAt = performance.now();
        if (typeof self.options.onError === "function") {
          self.options.onError(null, new Error("Could not align the stems."));
        }
        return;
      }
      self._clockOffset = offset;
      self._clockStartedAt = performance.now();
      self._startElements(token);
      self._scheduleLoop(token);
    });
    return true;
  };

  BatappPlayer.prototype.pause = function () {
    if (this._disposed || this._state !== "playing") return;
    var position = this._mediaPosition();
    this._playToken += 1;
    if (this._loopTimer) {
      clearTimeout(this._loopTimer);
      this._loopTimer = 0;
    }
    this._pauseAll();
    var fresh = this._hasBlobSources();
    if (fresh) this._silenceGeneration();
    this._offset = position;
    this._clockOffset = position;
    this._clockStartedAt = performance.now();
    this._state = "paused";
    this._needsFreshGeneration = fresh;
    if (!fresh) this._alignAll(position);
  };

  BatappPlayer.prototype.stop = function () {
    if (this._disposed) return;
    this._playToken += 1;
    if (this._loopTimer) {
      clearTimeout(this._loopTimer);
      this._loopTimer = 0;
    }
    this._pauseAll();
    var fresh = this._hasBlobSources();
    if (fresh) this._silenceGeneration();
    this._offset = 0;
    this._clockOffset = 0;
    this._clockStartedAt = performance.now();
    this._state = "stopped";
    this._needsFreshGeneration = fresh;
    if (!fresh) {
      this._alignAll(0);
    } else {
      // Keep the paused elements visually at the start even though the next
      // Play will replace them with a fresh generation.
      this.tracks.forEach(function (record) {
        if (!record.element) return;
        try { record.element.currentTime = 0; } catch (error) { /* not seekable */ }
      });
    }
  };

  BatappPlayer.prototype.seek = function (seconds) {
    if (this._disposed || !this._loaded) return 0;
    var duration = this.duration();
    var target = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
    var wasPlaying = this._state === "playing";
    this._playToken += 1;
    if (this._loopTimer) {
      clearTimeout(this._loopTimer);
      this._loopTimer = 0;
    }
    if (wasPlaying) this._pauseAll();
    this._offset = target;
    this._clockOffset = target;
    this._clockStartedAt = performance.now();
    if (wasPlaying) {
      this._state = "paused";
      this.play();
    } else {
      if (!this._needsFreshGeneration) this._alignAll(target);
      if (this._state !== "ready") this._state = "paused";
    }
    return target;
  };

  BatappPlayer.prototype.playing = function () {
    return !this._disposed && this._state === "playing" && this._liveTracks().length > 0;
  };

  BatappPlayer.prototype.isLoaded = function () {
    return !!this._loaded;
  };

  BatappPlayer.prototype.isDisposed = function () {
    return !!this._disposed;
  };

  BatappPlayer.prototype.integritySummary = function () {
    return this.tracks.map(function (record) {
      return record.stem + ":" + (record.integrity || "none");
    }).join(",");
  };

  BatappPlayer.prototype.setVolume = function (stem, value) {
    var level = clamp01(value);
    this.tracks.forEach(function (record) {
      if (record.stem !== stem) return;
      record.volume = level;
      this._applyLevel(record);
    }, this);
    return level;
  };

  BatappPlayer.prototype.setMuted = function (stem, muted) {
    this.tracks.forEach(function (record) {
      if (record.stem !== stem) return;
      record.muted = !!muted;
      this._applyLevel(record);
    }, this);
  };

  BatappPlayer.prototype.isMuted = function (stem) {
    var record = this.trackFor(stem);
    return !!(record && record.muted);
  };

  BatappPlayer.prototype.volumeOf = function (stem) {
    var record = this.trackFor(stem);
    return record ? record.volume : 0;
  };

  BatappPlayer.prototype.trackFor = function (stem) {
    return this.tracks.filter(function (record) {
      return record.stem === stem;
    })[0] || null;
  };

  BatappPlayer.prototype._discardElements = function (records) {
    records.forEach(function (record) {
      if (record.sourceNode) {
        try { record.sourceNode.disconnect(); } catch (error) { /* released */ }
        record.sourceNode = null;
      }
      if (record.gain) {
        try { record.gain.disconnect(); } catch (error) { /* released */ }
        record.gain = null;
      }
      if (record.element) {
        try { record.element.pause(); } catch (error) { /* released */ }
        try { record.element.removeAttribute("src"); } catch (error) { /* released */ }
        try { record.element.load(); } catch (error) { /* released */ }
        record.element = null;
      }
      record.ready = false;
      record.duration = 0;
      record._alignSeeking = false;
    });
  };

  BatappPlayer.prototype._closeContext = function () {
    if (!this._context) return;
    var context = this._context;
    this._context = null;
    try {
      var promise = context.close();
      if (promise && promise.catch) promise.catch(function () {});
    } catch (error) { /* already closed */ }
  };

  BatappPlayer.prototype._releaseResources = function () {
    this._playToken += 1;
    this._alignToken += 1;
    if (this._loopTimer) {
      clearTimeout(this._loopTimer);
      this._loopTimer = 0;
    }
    if (this._controller) {
      try { this._controller.abort(); } catch (error) { /* already aborted */ }
      this._controller = null;
    }
    this._pauseAll();
    this._disposeGeneration();
    this.tracks.forEach(function (record) {
      record.sourceBlob = null;
      record.sourceUrl = null;
    });
    this._closeContext();
    this._loaded = false;
    this._loading = false;
    this._offset = 0;
    this._clockOffset = 0;
    this._clockStartedAt = 0;
    this._needsFreshGeneration = false;
    this._onProgress = null;
  };

  BatappPlayer.prototype.dispose = function () {
    if (this._disposed) return;
    this._disposed = true;
    this._releaseResources();
    this._state = "disposed";
  };

  function verifyCrc(entry, buffer) {
    var expected = String(entry.crc32).toLowerCase();
    var actual = crc32(new Uint8Array(buffer));
    if (actual !== expected) {
      return Promise.reject(loadError([entry.stem], "Integrity check failed."));
    }
    return Promise.resolve("crc32");
  }

  global.BatappPlayer = BatappPlayer;
})(window);
