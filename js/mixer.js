/* BatApp shared transport.
 *
 * One mixer implementation for every page of the port. It keeps the original
 * behaviour: every stem is an <audio> element, all five start in the same tick,
 * each clip loops, and a drift-correction timer re-seeks a stem that falls more
 * than 80 ms behind the reference.
 *
 * Two level-control modes:
 *   - "webaudio" (http/https): one GainNode per stem. The element volume stays
 *     at 1 on purpose: an <audio> routed through MediaElementAudioSourceNode is
 *     still scaled by its own `volume`, so a stem that started at 0 could never
 *     be raised again through the graph alone. This mode also works on iOS,
 *     where HTMLMediaElement.volume ignores writes.
 *   - "elements" (file://, double-clicked page): Web Audio cannot read local
 *     media, so the element volume is the level control.
 *
 * Exposes window.BatappMixer as a classic script. No modules, no build step.
 */
(function (global) {
  "use strict";

  // Scene track objects use "Bit"; the exported audio stem is "beat".
  var TRACK_STEM_ALIAS = { bit: "beat" };

  function clamp01(value) {
    var number = typeof value === "number" ? value : parseFloat(value);
    if (!(number >= 0)) number = 0;
    return Math.min(1, number);
  }

  function BatappMixer(lesson, options) {
    options = options || {};
    this.lesson = lesson;
    this.tracks = [];
    this.context = null;
    this.analyser = null;
    this.syncTimer = 0;
    this.reference = null;
    this.seekToken = 0;
    this.transportState = "idle";
    this.stopped = false;
    this.stopCheckTimer = 0;
    var protocol = (global.location && global.location.protocol) || "file:";
    var served = protocol === "http:" || protocol === "https:";
    this.mode = options.webAudio === undefined ? (served ? "webaudio" : "elements")
      : (options.webAudio ? "webaudio" : "elements");
    this.build(options);
  }

  BatappMixer.prototype.stemForTrack = function (track) {
    var object = track.object || "";
    var name = object.split("/").pop().toLowerCase();
    return TRACK_STEM_ALIAS[name] || name;
  };

  BatappMixer.prototype.build = function (options) {
    var self = this;
    (this.lesson.audio || []).forEach(function (entry) {
      var track = (self.lesson.tracks || []).filter(function (candidate) {
        return self.stemForTrack(candidate) === entry.stem;
      })[0] || {};
      var source = new Audio(options.resolveSource
        ? options.resolveSource(entry)
        : "assets/audio/" + entry.path);
      source.preload = "auto";
      // Missing metadata must never silently stop a stem: the original loops
      // every AudioSource, so default to true.
      source.loop = track.loop === undefined ? true : !!track.loop;
      var initial = track.volume === undefined || track.volume === null ? 1 : clamp01(track.volume);
      var record = {
        stem: entry.stem,
        path: entry.path,
        clip: entry.clip_name,
        seconds: entry.seconds,
        track: track,
        element: source,
        gain: null,
        volume: initial,
        muted: false,
        started: false,
        lastTime: 0
      };
      self.tracks.push(record);
      self.applyLevel(record);
    });
    if (this.mode === "webaudio") {
      try {
        var Ctx = global.AudioContext || global.webkitAudioContext;
        this.context = new Ctx();
        var destination = this.context.destination;
        if (options.analyser !== false) {
          this.analyser = this.context.createAnalyser();
          this.analyser.fftSize = 512;
          this.analyser.smoothingTimeConstant = 0.5;
          destination = this.analyser;
        }
        this.tracks.forEach(function (record) {
          var node = self.context.createMediaElementSource(record.element);
          var gain = self.context.createGain();
          node.connect(gain);
          gain.connect(destination);
          record.gain = gain;
          record.element.volume = 1;   // level lives in the GainNode (see header)
          self.applyLevel(record);
        });
        if (this.analyser) this.analyser.connect(this.context.destination);
      } catch (error) {
        this.mode = "elements";
        this.context = null;
        this.analyser = null;
        this.tracks.forEach(function (record) {
          record.gain = null;
          record.element.volume = 1;
          self.applyLevel(record);
        });
      }
    }
    this.tracks.forEach(function (record) {
      record.element.addEventListener("ended", function () {
        if (record.element.loop) return;
        record.started = false;
        if (self.reference === record) self.pickReference();
      });
    });
    this.reference = this.tracks[0] || null;
  };

  BatappMixer.prototype.applyLevel = function (record) {
    var level = record.muted ? 0 : record.volume;
    if (record.gain) record.gain.gain.value = level;
    else record.element.volume = level;
  };

  BatappMixer.prototype.resume = function () {
    if (this.context && this.context.state === "suspended") this.context.resume();
  };

  BatappMixer.prototype.liveTracks = function () {
    return this.tracks.filter(function (record) {
      return record.started && !record.element.paused && !record.element.ended;
    });
  };

  BatappMixer.prototype.pickReference = function () {
    var live = this.liveTracks();
    this.reference = live[0] || this.tracks[0] || null;
    return this.reference;
  };

  BatappMixer.prototype.play = function () {
    var self = this;
    this.resume();
    this.stopped = false;
    this.transportState = "playing";
    var token = ++this.seekToken;
    if (this.stopCheckTimer) {
      clearTimeout(this.stopCheckTimer);
      this.stopCheckTimer = 0;
    }
    // A second play() while every stem is already running must not reset the
    // transport to the reference position again.
    if (this.tracks.length && this.liveTracks().length === this.tracks.length) {
      this.startSync();
      return;
    }
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = 0;

    var live = this.liveTracks();
    var reference = live[0] || (this.reference && this.reference.started ? this.reference : this.tracks[0] || null);
    var target = reference && reference.started ? reference.element.currentTime : 0;
    this.reference = reference;

    this.tracks.forEach(function (record) {
      try {
        record.element.currentTime = target;
        var promise = record.element.play();
        if (promise && promise.then) {
          promise.then(function () {
            // A pending play() may resolve after Pause/Stop; the later action
            // must win, or the stem would start again behind the user's back.
            if (self.seekToken === token || self.transportState === "playing") return;
            record.element.pause();
            if (self.transportState === "stopped") {
              try { record.element.currentTime = 0; } catch (error) { /* not seekable yet */ }
            }
          }).catch(function () {});
        }
        record.started = true;
        record.lastTime = target;
      } catch (error) { /* ignored: the browser reports it on the element */ }
    });
    this.startSync();
  };

  BatappMixer.prototype.startSync = function () {
    var self = this;
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (!this.tracks.length) return;
    this.tracks.forEach(function (record) {
      record.lastTime = record.element.currentTime || 0;
    });
    this.syncTimer = setInterval(function () {
      var records = self.tracks.filter(function (record) {
        return record.started && !record.element.paused && !record.element.ended;
      });
      if (!records.length) return;

      var reference = self.reference;
      if (!reference || !reference.started || reference.element.paused || reference.element.ended) {
        reference = records[0];
        self.reference = reference;
      }

      // A native loop restarts each element independently. Detect any element
      // that wrapped and pull the whole transport to the same new position;
      // otherwise a just-wrapped stem would look "seconds behind" and be sent
      // back to the end.
      var wrapped = null;
      records.forEach(function (record) {
        var now = record.element.currentTime;
        if (record.lastTime && now + 0.25 < record.lastTime) wrapped = wrapped || record;
        record.lastTime = now;
      });
      if (wrapped) {
        var position = wrapped.element.currentTime;
        records.forEach(function (record) {
          record.lastTime = position;
          if (record === wrapped) return;
          record.element.currentTime = position;
        });
        return;
      }

      var target = reference.element.currentTime;
      records.forEach(function (record) {
        if (record === reference) return;
        if (Math.abs(record.element.currentTime - target) > 0.08) {
          record.element.currentTime = target;
        }
        record.lastTime = record.element.currentTime;
      });
    }, 250);
  };

  BatappMixer.prototype.pause = function () {
    if (this.stopped) return;
    this.transportState = "paused";
    this.seekToken += 1;
    if (this.stopCheckTimer) {
      clearTimeout(this.stopCheckTimer);
      this.stopCheckTimer = 0;
    }
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = 0;
    this.tracks.forEach(function (record) {
      if (!record.element.paused) record.element.pause();
    });
  };

  BatappMixer.prototype.stop = function () {
    var self = this;
    this.transportState = "stopped";
    this.stopped = true;
    this.seekToken += 1;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = 0;
    this.tracks.forEach(function (record) {
      record.element.pause();
      try { record.element.currentTime = 0; } catch (error) { /* not seekable yet */ }
      record.started = false;
      record.lastTime = 0;
    });
    this.reference = this.tracks[0] || null;

    // A play() promise issued just before Stop can resolve after it. Verify
    // once more after the event loop settles that the transport is still
    // stopped and every stem is at the beginning.
    if (this.stopCheckTimer) clearTimeout(this.stopCheckTimer);
    this.stopCheckTimer = setTimeout(function () {
      self.stopCheckTimer = 0;
      if (self.transportState !== "stopped") return;
      self.tracks.forEach(function (record) {
        if (!record.element.paused) record.element.pause();
        if (Math.abs(record.element.currentTime) > 0.05) {
          try { record.element.currentTime = 0; } catch (error) { /* not seekable yet */ }
        }
        record.started = false;
        record.lastTime = 0;
      });
    }, 120);
  };

  BatappMixer.prototype.setVolume = function (stem, value) {
    var level = clamp01(value);
    this.tracks.forEach(function (record) {
      if (record.stem !== stem) return;
      record.volume = level;
      this.applyLevel(record);
    }, this);
    return level;
  };

  BatappMixer.prototype.setMuted = function (stem, muted) {
    this.tracks.forEach(function (record) {
      if (record.stem !== stem) return;
      record.muted = !!muted;
      this.applyLevel(record);
    }, this);
  };

  BatappMixer.prototype.isMuted = function (stem) {
    var record = this.trackFor(stem);
    return !!(record && record.muted);
  };

  BatappMixer.prototype.volumeOf = function (stem) {
    var record = this.trackFor(stem);
    return record ? record.volume : 0;
  };

  BatappMixer.prototype.trackFor = function (stem) {
    return this.tracks.filter(function (record) {
      return record.stem === stem;
    })[0] || null;
  };

  BatappMixer.prototype.playing = function () {
    if (this.stopped) return false;
    return this.tracks.some(function (record) {
      return record.started && !record.element.paused && !record.element.ended;
    });
  };

  BatappMixer.prototype.progress = function () {
    var reference = this.reference || this.tracks[0];
    if (!reference) return { current: 0, duration: 0 };
    var duration = reference.element.duration;
    return {
      current: this.stopped ? 0 : (reference.element.currentTime || 0),
      duration: duration && isFinite(duration) ? duration : 0
    };
  };

  BatappMixer.prototype.seek = function (seconds) {
    if (this.stopped) return 0;
    // Keep playing (the UI applies the value on release) but suspend the drift
    // loop while the elements seek, so it cannot drag a backward jump forward
    // again before the browser has applied it.
    var self = this;
    var wasPlaying = this.playing();
    var duration = this.progress().duration;
    var target = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = 0;
    var token = ++this.seekToken;
    var pending = [];

    this.tracks.forEach(function (record) {
      try { record.element.currentTime = target; } catch (error) { /* not seekable yet */ }
      record.lastTime = target;
      if (record.element.paused) return;
      pending.push(new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(done, 600);
        function cleanup() {
          record.element.removeEventListener("seeked", done);
          clearTimeout(timer);
        }
        function done() {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        }
        if (Math.abs(record.element.currentTime - target) < 0.05) {
          done();
          return;
        }
        record.element.addEventListener("seeked", done);
      }));
    });

    Promise.all(pending).then(function () {
      if (token !== self.seekToken) return;
      if (wasPlaying && self.playing()) self.startSync();
    });
    return target;
  };

  BatappMixer.prototype.dispose = function () {
    this.seekToken += 1;
    this.stop();
    if (this.stopCheckTimer) {
      clearTimeout(this.stopCheckTimer);
      this.stopCheckTimer = 0;
    }
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = 0;
    if (this.context) {
      try { this.context.close(); } catch (error) { /* already closed */ }
    }
    this.context = null;
    this.analyser = null;
  };

  global.BatappMixer = BatappMixer;
})(window);
