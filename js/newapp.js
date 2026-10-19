/* Modern layout runtime (index.html).
 *
 * Static, dependency-free player shared by three responsive modes:
 *   - portrait phone: one pane at a time (library or player);
 *   - landscape phone: full-bleed two-column player / two-column library;
 *   - desktop: persistent library sidebar + player/empty main pane.
 *
 * On HTTP(S) every stem is fetched into a Blob, checked against the integrity
 * manifest in js/lessons.js, and awaited before the player is shown, so the
 * lesson is truly local and iOS Safari's "never preload" rule does not block
 * the loading gate. On file:// the audio is already local and the elements are
 * awaited directly. Playback uses js/player.js.
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
  var STEM_ORDER = {
    "volume-1": ["beat", "vox", "iya", "ito", "oko"],
    "volume-2": ["beat", "iya", "ito", "oko"]
  };
  var VOLUMES = {
    "volume-1": { tab: "Toques", kicker: "Volume I" },
    "volume-2": { tab: "Oru Seco", kicker: "Volume II" }
  };
  var RING_RADIUS = 52;
  var RING_LENGTH = 2 * Math.PI * RING_RADIUS;

  var state = {
    view: "library",
    volume: "volume-1",
    libraryVolume: null,
    lesson: null,
    player: null,
    playing: false,
    loading: false,
    error: null,
    timer: 0,
    loadToken: 0
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

  function stemsFor(lesson) {
    var order = STEM_ORDER[lesson && lesson.volume] || STEM_ORDER["volume-1"];
    return order.map(function (key) {
      return STEMS.filter(function (entry) {
        return entry.key === key;
      })[0];
    }).filter(Boolean);
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

  /* --------------------------------------------------------------- teardown */

  function teardown() {
    state.loadToken += 1;
    if (state.timer) clearInterval(state.timer);
    state.timer = 0;
    if (state.player) {
      state.player.dispose();
      state.player = null;
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

  function updateLoading(view, done, total, stage) {
    var ring = view.querySelector(".ring-fg");
    var status = view.querySelector(".load-status");
    var ratio = 0;
    if (total) {
      // Each phase gets a third of the ring, so progress never jumps backwards
      // between checksum verification, WAV preparation and media readiness.
      if (stage === "verify") ratio = done / (3 * total);
      else if (stage === "wav") ratio = (total + done) / (3 * total);
      else ratio = (2 * total + done) / (3 * total);
    }
    if (ring) ring.setAttribute("stroke-dashoffset", (RING_LENGTH * (1 - ratio)).toFixed(2));
    if (status) {
      if (!total) status.textContent = "Loading stems…";
      else if (stage === "verify") status.textContent = "Checking stems " + done + "/" + total + "…";
      else if (stage === "wav") status.textContent = "Preparing WAV " + done + "/" + total + "…";
      else status.textContent = "Loading stems " + done + "/" + total + "…";
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

  function stemRow(record, player) {
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
      var muted = player.isMuted(record.stem);
      row.classList.toggle("muted", muted);
      mute.setAttribute("aria-pressed", muted ? "true" : "false");
      mute.innerHTML = muted ? ICONS.speakerOff : ICONS.speaker;
    }

    mute.addEventListener("click", function () {
      player.setMuted(record.stem, !player.isMuted(record.stem));
      paint();
    });
    slider.addEventListener("input", function () {
      var ratio = Number(slider.value) / 100;
      player.setVolume(record.stem, ratio);
      if (player.isMuted(record.stem)) player.setMuted(record.stem, false);
      setFill(slider, ratio);
      paint();
    });
    return row;
  }

  function playerView(lesson, audio) {
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
    stemsFor(lesson).map(function (entry) {
      return audio.trackFor(entry.key);
    }).filter(Boolean).forEach(function (record) {
      mixerBox.appendChild(stemRow(record, audio));
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
        audio.pause();
        state.playing = false;
        paintPlaying();
        return;
      }
      if (transportBusy) return;
      transportBusy = true;
      if (!audio.play()) {
        transportBusy = false;
        return;
      }
      state.playing = true;
      hideStatus();
      paintPlaying();
      var attempts = 0;
      function watchPlayback() {
        if (!state.playing) {
          transportBusy = false;
          return;
        }
        if (audio.playing()) {
          transportBusy = false;
          hideStatus();
          return;
        }
        attempts += 1;
        if (attempts === 4) showStatus("Preparing playback…");
        if (attempts < 20) {
          setTimeout(watchPlayback, 250);
          return;
        }
        transportBusy = false;
        state.playing = false;
        paintPlaying();
        showStatus("Playback was blocked. Tap Play again.");
      }
      setTimeout(watchPlayback, 250);
    });

    stop.addEventListener("click", function () {
      audio.stop();
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
      audio.seek(Number(seekInput.value));
      seeking = false;
    });

    audio.tracks.forEach(function (record) {
      if (!record.element) return;
      record.element.addEventListener("error", function () {
        showStatus("Couldn't play " + label(record.stem) + ".");
      });
    });

    state.timer = setInterval(function () {
      var progress = audio.progress();
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

  function renderMain(lesson) {
    mainPane.innerHTML = "";
    if (state.player) {
      state.player.dispose();
      state.player = null;
    }
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

    var audio = new window.BatappPlayer(lesson);
    state.player = audio;
    audio.load(function (done, total, stage) {
      if (token === state.loadToken) updateLoading(view, done, total, stage);
    }).then(function () {
      if (token !== state.loadToken || state.player !== audio) {
        audio.dispose();
        return;
      }
      state.loading = false;
      state.lesson = lesson;
      mainPane.innerHTML = "";
      mainPane.appendChild(playerView(lesson, audio));
    }).catch(function (error) {
      if (token !== state.loadToken || (error && error.name === "AbortError")) return;
      audio.dispose();
      if (state.player === audio) state.player = null;
      state.loading = false;
      state.lesson = lesson;
      state.error = (error && error.message) || "Load failed";
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
    if (!state.lesson || !state.player || state.loading) return;
    var pool = lessonsFor(state.lesson.volume);
    var index = pool.indexOf(state.lesson);
    var target = pool[index + delta];
    if (target) location.hash = "#/lesson/" + target.slug;
  }

  document.addEventListener("keydown", function (event) {
    if (infoPanel && !infoPanel.hidden) return;
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

  /* ------------------------------------------------------------- app info */

  var infoButton = document.getElementById("app-info-button");
  var infoPanel = document.getElementById("app-info-panel");
  var infoRows = document.getElementById("app-info-rows");
  var manifestState = "idle";
  var manifestVersion = null;

  function loadedBuild() {
    var meta = document.querySelector('meta[name="batapp-version"]');
    return meta ? meta.content : "unknown";
  }

  function scriptVersion(name) {
    var script = Array.prototype.filter.call(document.scripts, function (node) {
      var src = node.getAttribute("src") || "";
      return src.split("?")[0].split("/").pop() === name;
    })[0];
    if (!script) return "missing";
    var match = /[?&]v=([^&]+)/.exec(script.getAttribute("src") || "");
    return match ? decodeURIComponent(match[1]) : "unversioned";
  }

  function currentSource() {
    if (!state.player || !state.player.tracks.length) return "none";
    var counts = {};
    state.player.tracks.forEach(function (record) {
      var format = record.sourceFormat || "unknown";
      counts[format] = (counts[format] || 0) + 1;
    });
    return Object.keys(counts).map(function (format) {
      return format.toUpperCase() + " ×" + counts[format];
    }).join(", ");
  }

  function addInfoRow(name, value, mismatch) {
    var key = element("span", "k", name);
    var text = element("span", "v" + (mismatch ? " mismatch" : ""));
    text.textContent = value;
    infoRows.appendChild(key);
    infoRows.appendChild(text);
  }

  function renderInfo() {
    if (!infoRows) return;
    infoRows.innerHTML = "";
    var build = loadedBuild();
    addInfoRow("Loaded build", build);
    addInfoRow("Manifest", manifestState === "ready" ? manifestVersion
      : (manifestState === "local" ? "local file"
        : (manifestState === "error" ? "offline / unknown" : "checking…")),
      manifestState === "ready" && manifestVersion !== build);
    addInfoRow("Lessons data", scriptVersion("lessons.js"));
    addInfoRow("Player", scriptVersion("player.js"));
    addInfoRow("WAV encoder", scriptVersion("wav.js"));
    addInfoRow("New app runtime", scriptVersion("newapp.js"));
    addInfoRow("Current lesson", state.lesson
      ? state.lesson.number + " · " + state.lesson.title : "none");
    addInfoRow("Audio source", currentSource());

    if (manifestState === "ready" && manifestVersion && manifestVersion !== build) {
      var update = element("div", "app-info-update");
      var text = element("span");
      text.textContent = "Update available: " + manifestVersion;
      var reload = element("button", "app-info-reload", "Reload latest");
      reload.type = "button";
      reload.addEventListener("click", function () {
        location.replace(location.pathname + "?v=" +
          encodeURIComponent(manifestVersion) + location.hash);
      });
      update.appendChild(text);
      update.appendChild(reload);
      infoRows.appendChild(update);
    }
  }

  function checkManifest() {
    if (location.protocol !== "http:" && location.protocol !== "https:") {
      manifestState = "local";
      manifestVersion = null;
      renderInfo();
      return;
    }
    manifestState = "checking";
    manifestVersion = null;
    renderInfo();
    fetch("site.webmanifest?batapp-check=" + Date.now(), {
      cache: "no-store",
      credentials: "same-origin"
    }).then(function (response) {
      return response.ok ? response.json() : null;
    }).then(function (manifest) {
      manifestVersion = manifest && manifest.version || null;
      manifestState = manifestVersion ? "ready" : "error";
      renderInfo();
    }).catch(function () {
      manifestState = "error";
      manifestVersion = null;
      renderInfo();
    });
  }

  function openInfo() {
    if (!infoPanel || !infoButton) return;
    infoPanel.hidden = false;
    infoButton.setAttribute("aria-expanded", "true");
    renderInfo();
    checkManifest();
  }

  function closeInfo() {
    if (!infoPanel || !infoButton) return;
    infoPanel.hidden = true;
    infoButton.setAttribute("aria-expanded", "false");
  }

  if (infoButton && infoPanel && infoRows) {
    infoButton.addEventListener("click", function (event) {
      event.stopPropagation();
      if (infoPanel.hidden) openInfo();
      else closeInfo();
    });
    document.addEventListener("click", function (event) {
      if (infoPanel.hidden) return;
      if (infoPanel.contains(event.target) || infoButton.contains(event.target)) return;
      closeInfo();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !infoPanel.hidden) closeInfo();
    });
  }

  /* Read-only debug/testing hook (the shipped app never uses it). */
  window.__batapp_new = {
    data: D,
    state: function () {
      return {
        view: state.view,
        volume: state.volume,
        lesson: state.lesson ? state.lesson.slug : null,
        build: loadedBuild(),
        manifest: manifestVersion,
        playing: state.playing,
        mixerPlaying: state.player ? state.player.playing() : false,
        loading: state.loading,
        error: state.error,
        mode: state.player ? state.player.mode : null,
        loaded: state.player ? state.player.isLoaded() : false,
        disposed: state.player ? state.player.isDisposed() : true,
        integrity: state.player ? state.player.integritySummary() : null,
        position: state.player ? state.player.position() : 0,
        duration: state.player ? state.player.duration() : 0,
        stems: state.player ? state.player.tracks.map(function (record) { return record.stem; }) : []
      };
    },
    tracks: function () {
      if (!state.player) return [];
      return state.player.tracks.map(function (record) {
        var element = record.element;
        return {
          stem: record.stem,
          volume: record.volume,
          muted: record.muted,
          effective: record.muted ? 0 : record.volume,
          elementVolume: element ? element.volume : null,
          gain: record.gain ? record.gain.gain.value : null,
          currentTime: element ? element.currentTime : 0,
          duration: element && isFinite(element.duration) ? element.duration : (record.seconds || null),
          paused: element ? element.paused : true,
          loop: element ? element.loop : false,
          ended: element ? element.ended : false,
          error: element && element.error ? element.error.code : null,
          ready: !!record.ready,
          integrity: record.integrity,
          format: record.sourceFormat || null,
          wavBytes: record.wavBytes || null,
          wavDuration: record.wavDuration || null,
          mediaDuration: record.mediaDuration || null,
          durationDelta: record.durationDelta === undefined ? null : record.durationDelta,
          src: element && element.getAttribute("src") ? element.getAttribute("src") : null
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
