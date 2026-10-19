/* Modern layout runtime (index.html).
 *
 * Static, dependency-free player shared by three responsive modes:
 *   - portrait phone: one pane at a time (library or player);
 *   - landscape phone: full-bleed two-column player / two-column library;
 *   - desktop: persistent library sidebar + player/empty main pane.
 *
 * Playback is the shared transport in js/mixer.js, so all stems start in the
 * same tick and stay aligned exactly like the shipped-layout page.
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

  var state = {
    view: "library",
    volume: "volume-1",
    libraryVolume: null,
    lesson: null,
    mixer: null,
    playing: false,
    timer: 0
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

  /* --------------------------------------------------------------- teardown */

  function teardown() {
    if (state.timer) clearInterval(state.timer);
    state.timer = 0;
    if (state.mixer) {
      state.mixer.dispose();
      state.mixer = null;
    }
    state.playing = false;
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

  function playerView(lesson) {
    state.volume = lesson.volume;
    state.lesson = lesson;
    state.playing = false;

    var mixer = new window.BatappMixer(lesson, { analyser: false });
    state.mixer = mixer;

    var pool = lessonsFor(lesson.volume);
    var index = pool.indexOf(lesson);
    var player = element("div", "player-view");

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
    player.appendChild(top);

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

    function paintPlaying() {
      play.innerHTML = state.playing ? ICONS.pause : ICONS.play;
      play.setAttribute("aria-label", state.playing ? "Pause" : "Play");
    }

    play.addEventListener("click", function () {
      if (state.playing) mixer.pause();
      else mixer.play();
      state.playing = !state.playing;
      paintPlaying();
    });
    stop.addEventListener("click", function () {
      mixer.stop();
      state.playing = false;
      paintPlaying();
      ring.setAttribute("stroke-dashoffset", RING_LENGTH.toFixed(2));
    });
    prev.addEventListener("click", function () {
      if (index > 0) location.hash = "#/lesson/" + pool[index - 1].slug;
    });
    next.addEventListener("click", function () {
      if (index < pool.length - 1) location.hash = "#/lesson/" + pool[index + 1].slug;
    });

    state.timer = setInterval(function () {
      var progress = mixer.progress();
      var ratio = progress.duration > 0 ? Math.min(1, progress.current / progress.duration) : 0;
      ring.setAttribute("stroke-dashoffset", (RING_LENGTH * (1 - ratio)).toFixed(2));
    }, 250);

    return player;
  }

  function renderMain(lesson) {
    mainPane.innerHTML = "";
    mainPane.appendChild(lesson ? playerView(lesson) : emptyView());
  }

  /* ----------------------------------------------------------------- router */

  function route() {
    teardown();
    var hash = location.hash.replace(/^#\/?/, "");
    var volume = state.volume;
    var lesson = null;

    if (hash === "v/2") {
      volume = "volume-2";
    } else if (hash === "v/1") {
      volume = "volume-1";
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
    renderLibrary(volume, lesson ? lesson.slug : null);
    renderMain(lesson);
  }

  function step(delta) {
    if (!state.lesson || !state.mixer) return;
    var pool = lessonsFor(state.lesson.volume);
    var index = pool.indexOf(state.lesson);
    var target = pool[index + delta];
    if (target) location.hash = "#/lesson/" + target.slug;
  }

  document.addEventListener("keydown", function (event) {
    if (event.target && event.target.tagName === "INPUT") return;
    if (event.key === "Escape" && state.view === "player") {
      location.hash = hashForLibrary(state.volume);
    } else if (state.view === "player" && event.key === " ") {
      event.preventDefault();
      var play = document.querySelector(".play");
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
          error: record.element.error ? record.element.error.code : null
        };
      });
    },
    ui: function () {
      var active = document.querySelector(".row.active");
      return {
        rows: document.querySelectorAll(".stem").length,
        tabs: document.querySelectorAll(".tab").length,
        title: (document.querySelector(".player-title h2") || {}).textContent || null,
        ringOffset: (document.querySelector(".ring-fg") || {}).getAttribute
          ? document.querySelector(".ring-fg").getAttribute("stroke-dashoffset")
          : null,
        empty: !!document.querySelector(".empty"),
        active: active ? active.querySelector(".name").textContent : null,
        libraryVisible: !!(libraryPane.getClientRects().length),
        mainVisible: !!(mainPane.getClientRects().length)
      };
    }
  };
})();
