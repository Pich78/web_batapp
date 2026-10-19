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
    var protocol = (global.location && global.location.protocol) || "file:";
    var served = protocol === "http:" || protocol === "https:";
    this.mode = options.webAudio === undefined ? (served ? "webaudio" : "elements")
      : (options.webAudio ? "webaudio" : "elements");
    this.build(options);
  }

  BatappMixer.prototype.stemForTrack = function (track) {
    var object = track.object || "";
    return object.split("/").pop().toLowerCase();
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
      source.loop = !!track.loop;
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
        started: false
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
        if (!record.element.loop) record.started = false;
      });
    });
  };

  BatappMixer.prototype.applyLevel = function (record) {
    var level = record.muted ? 0 : record.volume;
    if (record.gain) record.gain.gain.value = level;
    else record.element.volume = level;
  };

  BatappMixer.prototype.resume = function () {
    if (this.context && this.context.state === "suspended") this.context.resume();
  };

  BatappMixer.prototype.play = function () {
    this.resume();
    var self = this;
    // The original calls AudioSource.Play() on all five stems, so a stem at
    // volume 0 (Vox uses VolumeValueChangefromzero) still advances and can be
    // unmuted mid-playback.
    var reference = this.tracks[0] || null;
    var target = reference && reference.started ? reference.element.currentTime : 0;
    this.tracks.forEach(function (record) {
      try {
        record.element.currentTime = target;
        var promise = record.element.play();
        if (promise && promise.catch) promise.catch(function () {});
        record.started = true;
      } catch (error) { /* ignored: the browser reports it on the element */ }
    });
    this.startSync(reference);
  };

  BatappMixer.prototype.startSync = function (reference) {
    var self = this;
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (!reference) return;
    this.syncTimer = setInterval(function () {
      var target = reference.element.currentTime;
      self.tracks.forEach(function (record) {
        if (record === reference || !record.started || record.element.paused) return;
        if (Math.abs(record.element.currentTime - target) > 0.08) {
          record.element.currentTime = target;
        }
      });
    }, 500);
  };

  BatappMixer.prototype.pause = function () {
    this.tracks.forEach(function (record) {
      if (!record.element.paused) record.element.pause();
    });
  };

  BatappMixer.prototype.stop = function () {
    this.tracks.forEach(function (record) {
      record.element.pause();
      try { record.element.currentTime = 0; } catch (error) { /* not seekable yet */ }
      record.started = false;
    });
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
    return this.tracks.some(function (record) {
      return record.started && !record.element.paused;
    });
  };

  BatappMixer.prototype.progress = function () {
    var reference = this.tracks[0];
    if (!reference) return { current: 0, duration: 0 };
    var duration = reference.element.duration;
    return {
      current: reference.element.currentTime || 0,
      duration: duration && isFinite(duration) ? duration : 0
    };
  };

  BatappMixer.prototype.seek = function (seconds) {
    // One position for every stem: the drift loop keeps them together after
    // the seek, whether playback is paused or running.
    var duration = this.progress().duration;
    var target = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
    this.tracks.forEach(function (record) {
      try { record.element.currentTime = target; } catch (error) { /* not seekable yet */ }
    });
    return target;
  };

  BatappMixer.prototype.dispose = function () {
    this.stop();
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
