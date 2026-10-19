/* Modern layout runtime (index.html).
 *
 * Static, dependency-free player shared by three responsive modes:
 *   - portrait phone: one pane at a time (library or player);
 *   - landscape phone: full-bleed two-column player / two-column library;
 *   - desktop: persistent library sidebar + player/empty main pane.
 *
 * On HTTP(S) every stem is fetched into a Blob before Play is enabled, so the
 * lesson is truly local and iOS Safari's "never preload" rule does not block
 * the loading gate. On file:// the audio is already local and the elements are
 * awaited directly. Playback uses the shared transport in js/mixer.js.
 */
(function () {
  "use strict";

  var D = window.BATAPP;
  var libraryPane = document.getElementById("library-pane");
  var mainPane = document.getElementById("main-pane");

  var STEMS = [
    { key: "beat", label: "Beat" },
    { key: "ito", label: "Itotele" },
    { key: "iya", label: "Iya" },
    { key: "oko", label: "Okonkolo" },
    { key: "vox", label: "Vox" }
  ];
  var VOLUMES = {
    "volume-1": { tab: "Toques", kicker: "Volume I" },
    "volume-2": { tab: "Oru Seco", kicker: "Volume II" }
  };
  var RING_RADIUS = 52;
  var RING_LENGTH = 2 * Math.PI * RING_RADIUS;
  var LOAD_TIMEOUT = 30000;

  var state = {
    view: "library",
    volume: "volume-1",
    libraryVolume: null,
    lesson: null,
    mixer: null,
    playing: false,
    loading: false,
    error: null,
    timer: 0,
    loadToken: 0,
    loadAbort: null,
    objectUrls: []
  };

  /* ------------------------------------------------------------------ icons */

  function icon(body, stroke) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" ' +
      (stroke
        ? 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
        : 'fill="currentColor"') +
      ">" + body + "</svg>";
  }

  var ICONS = {
    chevron: icon('<path d="M9.5 6l6 6-6 6"/>', true),
    back: icon('<path d="M14.5 6l-6 6 6 6"/>', true),
    play: icon('<path d="M8 5.5v13l11-6.5z"/>'),
    pause: icon('<path d="M8 5.5h3.2v13H8zM12.8 5.5H16v13h-3.2z"/>'),
    stop: icon('<rect x="7" y="7" width="10" height="10" rx="1.6"/>'),
    prev: icon('<path d="M7 5.5h2v13H7zM19 5.5l-9 6.5 9 6.5z"/>'),
    next: icon('<path d="M15 5.5h2v13h-2zM5 5.5l9 6.5-9 6.5z"/>'),
    speaker: icon('<path d="M4 9.5v5h3.4L12 18.4V5.6L7.4 9.5H4z"/><path d="M15 9.2a4 4 0 0 1 0 5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
    speakerOff: icon('<path d="M4 9.5v5h3.4L12 18.4V5.6L7.4 9.5H4z"/><path d="M16 9.5l4 5M20 9.5l-4 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>')
  };

  /* ---------------------------------------------------------------- helpers */

  function element(tag, className, html) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  function lessonsFor(volume) {
    return D.lessons.filter(function (lesson) {
      return lesson.volume === volume;
    });
  }

  function lessonFor(slug) {
    return D.lessons.filter(function (lesson) {
      return lesson.slug === slug;
    })[0] || null;
  }

  function label(stem) {
    var match = STEMS.filter(function (entry) {
      return entry.key === stem;
    })[0];
    return match ? match.label : stem;
  }

  function hashForLibrary(volume) {
    return "#/v/" + (volume === "volume-2" ? "2" : "1");
  }

  function setFill(slider, ratio) {
    slider.style.setProperty("--fill", (Math.max(0, Math.min(1, ratio)) * 100).toFixed(1) + "%");
  }

  function formatTime(seconds) {
    var value = Math.max(0, Math.floor(seconds || 0));
    return Math.floor(value / 60) + ":" + String(value % 60).padStart(2, "0");
  }

  function titleSuffix(lesson) {
    return lesson.volume === "volume-1" ? "Toque" : "Oru Seco";
  }

  function setDocumentTitle(lesson, volume, explicitVolume) {
    if (lesson) {
      document.title = lesson.title + " · " + titleSuffix(lesson) + " " + lesson.number + " · Batá";
    } else if (explicitVolume) {
      document.title = VOLUMES[volume].tab + " · Batá";
    } else {
      document.title = "Batá · Toques & Oru Seco";
    }
  }

  function revokeObjectUrls() {
    state.objectUrls.forEach(function (url) {
      try { URL.revokeObjectURL(url); } catch (error) { /* already revoked */ }
    });
    state.objectUrls = [];
  }

  /* --------------------------------------------------------------- teardown */

  function teardown() {
    state.loadToken += 1;
    if (state.loadAbort) {
      try { state.loadAbort.abort(); } catch (error) { /* already aborted */ }
      state.loadAbort = null;
    }
    revokeObjectUrls();
    if (state.timer) clearInterval(state.timer);
    state.timer = 0;
    if (state.mixer) {
      state.mixer.dispose();
      state.mixer = null;
    }
    state.playing = false;
    state.loading = false;
    state.error = null;
    state.lesson = null;
  }

  /* --------------------------------------------------------------- library */

  function renderLibrary(volume, activeSlug) {
    state.volume = volume;
    if (state.libraryVolume !== volume) {
      state.libraryVolume = volume;
      libraryPane.innerHTML = "";
      var view = element("div", "library-view");
      view.appendChild(element("header", "brand",
        "<h1>Batá</h1><p>Toques &amp; Oru Seco</p>"));

      var tabs = element("div", "tabs");
      tabs.setAttribute("role", "tablist");
      Object.keys(VOLUMES).forEach(function (id) {
        var button = element("button", "tab" + (id === volume ? " active" : ""), VOLUMES[id].tab);
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", id === volume ? "true" : "false");
        button.addEventListener("click", function () {
          location.hash = hashForLibrary(id);
        });
        tabs.appendChild(button);
      });
      view.appendChild(tabs);

      var list = element("div", "list");
      lessonsFor(volume).forEach(function (lesson) {
        var row = element("button", "row",
          '<span class="num">' + lesson.number + '</span>' +
          '<span class="name"></span>' + ICONS.chevron);
        row.dataset.slug = lesson.slug;
        row.querySelector(".name").textContent = lesson.title;
        row.setAttribute("aria-label", VOLUMES[volume].kicker + ", " + lesson.number + " " + lesson.title);
        row.addEventListener("click", function () {
          location.hash = "#/lesson/" + lesson.slug;
        });
        list.appendChild(row);
      });
      view.appendChild(list);
      libraryPane.appendChild(view);
    }

    var active = null;
    Array.prototype.forEach.call(libraryPane.querySelectorAll(".row"), function (row) {
      var selected = !!activeSlug && row.dataset.slug === activeSlug;
      row.classList.toggle("active", selected);
      if (selected) {
        row.setAttribute("aria-current", "true");
        active = row;
      } else {
        row.removeAttribute("aria-current");
      }
    });
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function emptyView() {
    return element("div", "empty",
      '<div class="glyph">' + ICONS.play + "</div>" +
      "<h2>Choose a rhythm</h2>" +
      "<p>Select a toque or an oru seco from the library.</p>");
  }

  /* ---------------------------------------------------------------- player */

  function playerTop(lesson) {
    var top = element("div", "player-top");
    var back = element("button", "icon-btn", ICONS.back);
    back.setAttribute("aria-label", "Back to the rhythm list");
    back.addEventListener("click", function () {
      location.hash = hashForLibrary(lesson.volume);
    });
    top.appendChild(back);

    var title = element("div", "player-title",
      '<div class="kicker"></div><h2></h2>');
    title.querySelector(".kicker").textContent = VOLUMES[lesson.volume].kicker + " · " + lesson.number;
    title.querySelector("h2").textContent = lesson.title;
    top.appendChild(title);
    return top;
  }

  function loadingView(lesson) {
    var view = element("div", "player-view");
    view.appendChild(playerTop(lesson));
    var box = element("div", "loading",
      '<div class="dial">' +
      '<svg class="ring" viewBox="0 0 120 120" aria-hidden="true">' +
      '<circle class="ring-bg" cx="60" cy="60" r="' + RING_RADIUS + '"></circle>' +
      '<circle class="ring-fg" cx="60" cy="60" r="' + RING_RADIUS + '" ' +
      'stroke-dasharray="' + RING_LENGTH.toFixed(2) + '" stroke-dashoffset="' + RING_LENGTH.toFixed(2) + '"></circle>' +
      "</svg>" +
      '<div class="play"><span class="spinner"></span></div>' +
      "</div>" +
      '<p class="load-status" role="status" aria-live="polite">Loading stems 0/' + (lesson.audio || []).length + "…</p>");
    view.appendChild(box);
    return view;
  }

  function updateLoading(view, done, total) {
    var ring = view.querySelector(".ring-fg");
    var status = view.querySelector(".load-status");
    var ratio = total ? done / total : 0;
    if (ring) ring.setAttribute("stroke-dashoffset", (RING_LENGTH * (1 - ratio)).toFixed(2));
    if (status) {
      status.textContent = total
        ? "Loading stems " + done + "/" + total + "…"
        : "Loading stems…";
    }
  }

  function errorView(lesson, error) {
    var failed = (error && error.failed) || [];
    var message = failed.length
      ? "Couldn't load " + failed.map(label).join(", ") + "."
      : "Couldn't load the stems.";
    var view = element("div", "player-view");
    view.appendChild(playerTop(lesson));
    var box = element("div", "loading error",
      '<div class="dial"><div class="play error-mark">!</div></div>' +
      '<p class="load-status">' + message + "</p>" +
      (error && error.message ? '<p class="load-detail"></p>' : "") +
      '<button class="retry" type="button">Retry</button>');
    if (error && error.message) box.querySelector(".load-detail").textContent = error.message;
    box.querySelector(".retry").addEventListener("click", function () {
      renderMain(lesson);
    });
    view.appendChild(box);
    return view;
  }

  function stemRow(record, mixer) {
    var row = element("div", "stem");
    row.dataset.stem = record.stem;

    var name = element("span", "stem-name");
    name.textContent = label(record.stem);
    row.appendChild(name);

    var mute = element("button", "mute", ICONS.speaker);
    mute.setAttribute("aria-pressed", "false");
    mute.setAttribute("aria-label", "Mute " + label(record.stem));
    row.appendChild(mute);

    var slider = element("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(Math.round(record.volume * 100));
    slider.setAttribute("aria-label", label(record.stem) + " volume");
    setFill(slider, record.volume);
    row.appendChild(slider);

    function paint() {
      var muted = mixer.isMuted(record.stem);
      row.classList.toggle("muted", muted);
      mute.setAttribute("aria-pressed", muted ? "true" : "false");
      mute.innerHTML = muted ? ICONS.speakerOff : ICONS.speaker;
    }

    mute.addEventListener("click", function () {
      mixer.setMuted(record.stem, !mixer.isMuted(record.stem));
      paint();
    });
    slider.addEventListener("input", function () {
      var ratio = Number(slider.value) / 100;
      mixer.setVolume(record.stem, ratio);
      if (mixer.isMuted(record.stem)) mixer.setMuted(record.stem, false);
      setFill(slider, ratio);
      paint();
    });
    return row;
  }

  function playerView(lesson, mixer) {
    var pool = lessonsFor(lesson.volume);
    var index = pool.indexOf(lesson);
    var player = element("div", "player-view");
    player.appendChild(playerTop(lesson));

    var seek = element("div", "seek",
      '<span class="time current">0:00</span>' +
      '<input class="seek-input" type="range" min="0" max="0" step="0.1" value="0" aria-label="Seek">' +
      '<span class="time total">0:00</span>');
    var seekInput = seek.querySelector("input");
    var currentTime = seek.querySelector(".current");
    var totalTime = seek.querySelector(".total");
    seekInput.disabled = true;
    player.appendChild(seek);

    var status = element("p", "player-status");
    status.hidden = true;
    player.appendChild(status);

    var body = element("div", "player-body");
    var hero = element("div", "hero");

    var transport = element("div", "transport");
    var prev = element("button", "ghost", ICONS.prev);
    prev.setAttribute("aria-label", "Previous rhythm");
    prev.disabled = index <= 0;
    var next = element("button", "ghost", ICONS.next);
    next.setAttribute("aria-label", "Next rhythm");
    next.disabled = index >= pool.length - 1;

    var dial = element("div", "dial",
      '<svg class="ring" viewBox="0 0 120 120" aria-hidden="true">' +
      '<circle class="ring-bg" cx="60" cy="60" r="' + RING_RADIUS + '"></circle>' +
      '<circle class="ring-fg" cx="60" cy="60" r="' + RING_RADIUS + '" ' +
      'stroke-dasharray="' + RING_LENGTH.toFixed(2) + '" stroke-dashoffset="' + RING_LENGTH.toFixed(2) + '"></circle>' +
      "</svg>");
    var ring = dial.querySelector(".ring-fg");
    var play = element("button", "play", ICONS.play);
    play.setAttribute("aria-label", "Play");
    dial.appendChild(play);

    [prev, dial, next].forEach(function (node) { transport.appendChild(node); });
    hero.appendChild(transport);

    var stopRow = element("div", "stop-row");
    var stop = element("button", "stop", ICONS.stop + "<span>Stop</span>");
    stop.setAttribute("aria-label", "Stop");
    stopRow.appendChild(stop);
    hero.appendChild(stopRow);
    body.appendChild(hero);

    var mixerBox = element("div", "mixer");
    STEMS.map(function (entry) {
      return mixer.trackFor(entry.key);
    }).filter(Boolean).forEach(function (record) {
      mixerBox.appendChild(stemRow(record, mixer));
    });
    body.appendChild(mixerBox);
    player.appendChild(body);

    var seeking = false;
    var duration = 0;
    var transportBusy = false;

    function showStatus(message) {
      status.textContent = message;
      status.hidden = false;
    }
    function hideStatus() {
      status.hidden = true;
    }

    function paintPlaying() {
      play.innerHTML = state.playing ? ICONS.pause : ICONS.play;
      play.setAttribute("aria-label", state.playing ? "Pause" : "Play");
    }

    play.addEventListener("click", function () {
      if (state.playing) {
        mixer.pause();
        state.playing = false;
        paintPlaying();
        return;
      }
      if (transportBusy) return;
      transportBusy = true;
      mixer.play();
      state.playing = true;
      hideStatus();
      paintPlaying();
      setTimeout(function () {
        transportBusy = false;
        if (!state.playing) return;
        if (!mixer.playing()) {
          state.playing = false;
          paintPlaying();
          showStatus("Playback was blocked. Tap Play again.");
        }
      }, 500);
    });

    stop.addEventListener("click", function () {
      mixer.stop();
      state.playing = false;
      transportBusy = false;
      paintPlaying();
      hideStatus();
      seeking = false;
      seekInput.value = "0";
      currentTime.textContent = "0:00";
      setFill(seekInput, 0);
      ring.setAttribute("stroke-dashoffset", RING_LENGTH.toFixed(2));
    });

    prev.addEventListener("click", function () {
      if (index > 0) location.hash = "#/lesson/" + pool[index - 1].slug;
    });
    next.addEventListener("click", function () {
      if (index < pool.length - 1) location.hash = "#/lesson/" + pool[index + 1].slug;
    });

    seekInput.addEventListener("input", function () {
      seeking = true;
      var value = Number(seekInput.value);
      currentTime.textContent = formatTime(value);
      setFill(seekInput, duration > 0 ? value / duration : 0);
    });
    seekInput.addEventListener("change", function () {
      mixer.seek(Number(seekInput.value));
      seeking = false;
    });

    mixer.tracks.forEach(function (record) {
      record.element.addEventListener("error", function () {
        showStatus("Couldn't play " + label(record.stem) + ".");
      });
    });

    state.timer = setInterval(function () {
      var progress = mixer.progress();
      if (progress.duration > 0) {
        duration = progress.duration;
        seekInput.disabled = false;
        seekInput.max = String(duration);
        totalTime.textContent = formatTime(duration);
      }
      if (!seeking) {
        seekInput.value = String(progress.current || 0);
        currentTime.textContent = formatTime(progress.current);
        setFill(seekInput, duration > 0 ? progress.current / duration : 0);
      }
      var ratio = duration > 0 ? Math.min(1, progress.current / duration) : 0;
      ring.setAttribute("stroke-dashoffset", (RING_LENGTH * (1 - ratio)).toFixed(2));
    }, 250);

    return player;
  }

  /* ----------------------------------------------------------- load / route */

  function loadHttp(lesson, onProgress) {
    var entries = lesson.audio || [];
    var total = entries.length;
    var done = 0;
    var urls = [];
    var controller = new AbortController();
    state.loadAbort = controller;
    var timeoutId;
    var timeout = new Promise(function (resolve, reject) {
      timeoutId = setTimeout(function () {
        reject({ failed: [], message: "Timed out while loading" });
      }, LOAD_TIMEOUT);
    });

    var fetches = Promise.all(entries.map(function (entry) {
      return fetch("assets/audio/" + entry.path, {
        signal: controller.signal,
        credentials: "same-origin"
      }).then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.blob();
      }).then(function (blob) {
        urls.push({ path: entry.path, url: URL.createObjectURL(blob) });
        done += 1;
        onProgress(done, total);
      }).catch(function (error) {
        if (error && error.name === "AbortError") throw error;
        throw {
          failed: [entry.stem],
          message: /^HTTP \d/.test(error && error.message)
            ? "Server returned " + error.message.slice(5)
            : "Check your connection and try again."
        };
      });
    }));

    return Promise.race([fetches, timeout]).then(function () {
      clearTimeout(timeoutId);
      var byPath = {};
      urls.forEach(function (entry) { byPath[entry.path] = entry.url; });
      state.objectUrls = urls.map(function (entry) { return entry.url; });
      state.loadAbort = null;
      return new window.BatappMixer(lesson, {
        analyser: false,
        resolveSource: function (entry) { return byPath[entry.path]; }
      });
    }).catch(function (error) {
      clearTimeout(timeoutId);
      try { controller.abort(); } catch (abortError) { /* already aborted */ }
      state.loadAbort = null;
      urls.forEach(function (entry) {
        try { URL.revokeObjectURL(entry.url); } catch (revokeError) { /* already revoked */ }
      });
      state.objectUrls = [];
      if (error && error.name === "AbortError") throw error;
      throw error;
    });
  }

  function waitForElements(mixer, onProgress) {
    var records = mixer.tracks;
    var total = records.length;
    var done = 0;
    return Promise.all(records.map(function (record) {
      return new Promise(function (resolve, reject) {
        var element = record.element;
        var settled = false;
        var timer = 0;

        function cleanup() {
          element.removeEventListener("loadeddata", ready);
          element.removeEventListener("canplaythrough", ready);
          element.removeEventListener("error", failed);
          if (timer) clearTimeout(timer);
        }
        function ready() {
          if (settled) return;
          settled = true;
          cleanup();
          done += 1;
          onProgress(done, total);
          resolve();
        }
        function failed() {
          if (settled) return;
          settled = true;
          cleanup();
          reject({ failed: [record.stem], message: "Audio failed to load" });
        }

        if (element.readyState >= 2) {
          ready();
          return;
        }
        timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          cleanup();
          reject({ failed: [record.stem], message: "Timed out while loading" });
        }, 10000);
        element.addEventListener("loadeddata", ready);
        element.addEventListener("canplaythrough", ready);
        element.addEventListener("error", failed);
        try { element.load(); } catch (error) { failed(); }
      });
    })).then(function () { return mixer; });
  }

  function loadFile(lesson, onProgress) {
    var mixer = new window.BatappMixer(lesson, { analyser: false });
    return waitForElements(mixer, onProgress).catch(function (error) {
      mixer.dispose();
      throw error;
    });
  }

  function loadLesson(lesson, onProgress) {
    if (location.protocol === "http:" || location.protocol === "https:") {
      return loadHttp(lesson, onProgress);
    }
    return loadFile(lesson, onProgress);
  }

  function renderMain(lesson) {
    mainPane.innerHTML = "";
    if (!lesson) {
      state.loading = false;
      state.error = null;
      mainPane.appendChild(emptyView());
      return;
    }

    var token = ++state.loadToken;
    state.loading = true;
    state.error = null;
    state.playing = false;
    var view = loadingView(lesson);
    mainPane.appendChild(view);

    loadLesson(lesson, function (done, total) {
      if (token === state.loadToken) updateLoading(view, done, total);
    }).then(function (mixer) {
      if (token !== state.loadToken) {
        mixer.dispose();
        revokeObjectUrls();
        return;
      }
      state.loading = false;
      state.lesson = lesson;
      state.mixer = mixer;
      mainPane.innerHTML = "";
      mainPane.appendChild(playerView(lesson, mixer));
    }).catch(function (error) {
      if (token !== state.loadToken || (error && error.name === "AbortError")) return;
      state.loading = false;
      state.lesson = lesson;
      state.error = (error && error.message) || "Load failed";
      revokeObjectUrls();
      if (state.mixer) {
        state.mixer.dispose();
        state.mixer = null;
      }
      mainPane.innerHTML = "";
      mainPane.appendChild(errorView(lesson, error));
    });
  }

  /* ----------------------------------------------------------------- router */

  function route() {
    teardown();
    var hash = location.hash.replace(/^#\/?/, "");
    var volume = state.volume;
    var lesson = null;
    var explicitVolume = false;

    if (hash === "v/2") {
      volume = "volume-2";
      explicitVolume = true;
    } else if (hash === "v/1") {
      volume = "volume-1";
      explicitVolume = true;
    } else {
      var lessonMatch = hash.match(/^lesson\/(.+)$/);
      if (lessonMatch) {
        lesson = lessonFor(decodeURIComponent(lessonMatch[1]));
        if (!lesson) {
          location.hash = "#/";
          return;
        }
        volume = lesson.volume;
      }
    }

    state.view = lesson ? "player" : "library";
    document.body.dataset.view = state.view;
    setDocumentTitle(lesson, volume, explicitVolume);
    renderLibrary(volume, lesson ? lesson.slug : null);
    renderMain(lesson);
  }

  function step(delta) {
    if (!state.lesson || !state.mixer || state.loading) return;
    var pool = lessonsFor(state.lesson.volume);
    var index = pool.indexOf(state.lesson);
    var target = pool[index + delta];
    if (target) location.hash = "#/lesson/" + target.slug;
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && state.view === "player") {
      location.hash = hashForLibrary(state.volume);
      return;
    }
    // Let focused controls handle their own activation; otherwise Space on the
    // play button would fire both the native click and the synthetic one.
    if (event.target && event.target.closest &&
        event.target.closest("button, input, textarea, select, a")) return;
    if (state.view === "player" && event.key === " ") {
      event.preventDefault();
      var play = document.querySelector("button.play");
      if (play) play.click();
    } else if (state.view === "player" && event.key === "ArrowLeft") {
      step(-1);
    } else if (state.view === "player" && event.key === "ArrowRight") {
      step(1);
    }
  });

  window.addEventListener("hashchange", route);
  if (!location.hash) location.hash = "#/";
  route();

  /* Read-only debug/testing hook (the shipped app never uses it). */
  window.__batapp_new = {
    data: D,
    state: function () {
      return {
        view: state.view,
        volume: state.volume,
        lesson: state.lesson ? state.lesson.slug : null,
        playing: state.playing,
        mixerPlaying: state.mixer ? state.mixer.playing() : false,
        loading: state.loading,
        error: state.error,
        mode: state.mixer ? state.mixer.mode : null,
        stems: state.mixer ? state.mixer.tracks.map(function (record) { return record.stem; }) : []
      };
    },
    tracks: function () {
      if (!state.mixer) return [];
      return state.mixer.tracks.map(function (record) {
        return {
          stem: record.stem,
          volume: record.volume,
          muted: record.muted,
          effective: record.muted ? 0 : record.volume,
          elementVolume: record.element.volume,
          gain: record.gain ? record.gain.gain.value : null,
          currentTime: record.element.currentTime,
          duration: record.element.duration || null,
          paused: record.element.paused,
          loop: record.element.loop,
          ended: record.element.ended,
          error: record.element.error ? record.element.error.code : null
        };
      });
    },
    ui: function () {
      var active = document.querySelector(".row.active");
      var play = document.querySelector("button.play");
      return {
        rows: document.querySelectorAll(".stem").length,
        tabs: document.querySelectorAll(".tab").length,
        title: (document.querySelector(".player-title h2") || {}).textContent || null,
        documentTitle: document.title,
        ringOffset: (document.querySelector(".ring-fg") || {}).getAttribute
          ? document.querySelector(".ring-fg").getAttribute("stroke-dashoffset")
          : null,
        empty: !!document.querySelector(".empty"),
        loader: !!document.querySelector(".loading"),
        loadStatus: (document.querySelector(".load-status") || {}).textContent || null,
        playEnabled: !!(play && !play.disabled),
        seekValue: (document.querySelector(".seek-input") || {}).value || null,
        active: active ? active.querySelector(".name").textContent : null,
        libraryVisible: !!(libraryPane.getClientRects().length),
        mainVisible: !!(mainPane.getClientRects().length)
      };
    }
  };
})();
