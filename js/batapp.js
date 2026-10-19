/* BatApp static port runtime.
 *
 * Renders the geometry and wiring that tools/build_app_data.py lifted out of the
 * shipped Unity scenes, and plays the lessons from the remuxed Ogg stems.
 *
 * Two playback modes, chosen at runtime:
 *   - file:// (double-clicked page): five <audio> elements, per-element volume,
 *     drift correction. Web Audio cannot read local media without a server.
 *   - http(s) (e.g. GitHub Pages): Web Audio graph with one GainNode per stem,
 *     started in the same tick, plus master transport actions.
 */
(function () {
  "use strict";

  var D = window.BATAPP;
  var STAGE_H = 1080;          // canvas height in reference units (match-height)
  var STAGE_W = 1920;          // updated from the viewport aspect on every layout pass
  var stage = document.getElementById("stage");
  var viewport = document.getElementById("viewport");
  var STEM_ORDER = ["iya", "ito", "oko", "vox", "beat"];

  /* ---------------------------------------------------------------- helpers */

  function rgba(color) {
    if (!color) return "rgba(255,255,255,1)";
    var r = Math.round(color[0] * 255), g = Math.round(color[1] * 255);
    var b = Math.round(color[2] * 255), a = color[3] === undefined ? 1 : color[3];
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  function cssRect(rect) {
    // Unity rects are y-up from the bottom-left; CSS is y-down from the top-left.
    return {
      left: rect[0] + "px",
      top: (STAGE_H - rect[1] - rect[3]) + "px",
      width: Math.max(0, rect[2]) + "px",
      height: Math.max(0, rect[3]) + "px"
    };
  }

  function place(el, rect) {
    var box = cssRect(rect);
    el.style.left = box.left;
    el.style.top = box.top;
    el.style.width = box.width;
    el.style.height = box.height;
    return el;
  }

  function el(className, rect) {
    var node = document.createElement("div");
    node.className = className;
    return rect ? place(node, rect) : node;
  }

  function spriteUrl(name) {
    var path = D.sprites[name];
    return path ? "assets/img/" + path : null;
  }

  function fitStage() {
    // Match-height, exactly like the shipped CanvasScaler: the canvas keeps 1080
    // units of height and widens with the window. Narrow canvases are handled by
    // reflowForNarrowCanvas instead of letterboxing, so the app stays usable in
    // any shape without an orientation lock.
    var vw = window.innerWidth, vh = window.innerHeight;
    STAGE_H = 1080;
    STAGE_W = STAGE_H * (vw / vh);
    var scale = vh / STAGE_H;
    stage.style.width = STAGE_W + "px";
    stage.style.height = STAGE_H + "px";
    stage.style.transform = "scale(" + scale + ")";
    stage.style.transformOrigin = "0 0";
    stage.style.left = "0px";
    stage.style.top = "0px";
  }


  var LAYOUT_KEYS = ["canvas", "canvas_order", "plain", "scale", "anchors", "pivot", "anchored", "delta"];

  function cloneNodes(nodes) {
    return nodes.map(function (node) {
      var copy = { id: node.id, parent: node.parent };
      LAYOUT_KEYS.forEach(function (key) {
        if (node[key] !== undefined) copy[key] = Array.isArray(node[key]) ? node[key].slice() : node[key];
      });
      return copy;
    });
  }

  function authoredLayout(screen) {
    if (!screen) return [];
    if (!screen.layoutAuthored) screen.layoutAuthored = cloneNodes(screen.layout || []);
    return cloneNodes(screen.layoutAuthored);
  }

  function rectsAt(nodes, canvasW, canvasH) {
    var out = {};
    var canvasRect = [0, 0, canvasW, canvasH];
    nodes.forEach(function (node) {
      var parent = node.parent >= 0 && out[node.parent]
        ? out[node.parent]
        : { rect: canvasRect, size: [canvasW, canvasH], scale: 1 };
      if (node.canvas) {
        out[node.id] = { rect: canvasRect.slice(), size: [canvasW, canvasH], scale: 1 };
        return;
      }
      if (node.plain) {
        out[node.id] = { rect: parent.rect, size: parent.size, scale: parent.scale * (node.scale || 1) };
        return;
      }
      var a = node.anchors, pivot = node.pivot, pos = node.anchored, delta = node.delta;
      var pw = parent.size[0], ph = parent.size[1];
      var minX = a[0] * pw, minY = a[1] * ph, maxX = a[2] * pw, maxY = a[3] * ph;
      var width = (maxX - minX) + delta[0], height = (maxY - minY) + delta[1];
      var pivotX = minX + (maxX - minX) * pivot[0] + pos[0];
      var pivotY = minY + (maxY - minY) * pivot[1] + pos[1];
      var localX = pivotX - width * pivot[0], localY = pivotY - height * pivot[1];
      var scale = parent.scale * (node.scale || 1);
      out[node.id] = {
        rect: [
          parent.rect[0] + localX * parent.scale,
          parent.rect[1] + localY * parent.scale,
          width * scale,
          height * scale
        ],
        size: [width, height],
        scale: scale
      };
    });
    return out;
  }

  function reflowForNarrowCanvas(nodes, reference) {
    var canvasW = Math.max(STAGE_W, 1);
    var dx = canvasW / 2 - 960;
    var byId = {};
    nodes.forEach(function (node) { byId[node.id] = node; });
    var isCanvasChild = function (node) {
      var parent = node.parent >= 0 ? byId[node.parent] : null;
      return !parent || parent.canvas;
    };
    nodes.forEach(function (node) {
      if (node.canvas || node.plain || !node.anchors) return;
      // Only canvas-level groups move; descendants follow their parents, so a
      // translation here shifts a whole subtree exactly once.
      if (!isCanvasChild(node)) return;
      var rect = (reference[node.id] || {}).rect;
      if (!rect) return;
      var spanX = node.anchors[2] - node.anchors[0];
      if (rect[2] >= 1915 && Math.abs(rect[0]) < 6) {
        node.anchors = [0, 0, 1, 1];
        node.pivot = [0, 0];
        node.anchored = [0, 0];
        node.delta = [0, 0];
        return;
      }
      if (rect[2] > 900 && rect[2] < 1915 && Math.abs(spanX) < 0.001) {
        var yFrac = rect[1] / 1080;
        var hFrac = rect[3] / 1080;
        node.anchors = [0.03, yFrac, 0.97, yFrac + hFrac];
        node.pivot = [0, 0];
        node.anchored = [0, 0];
        node.delta = [0, 0];
        return;
      }
      if (spanX < 0.001) node.anchored = [node.anchored[0] + dx, node.anchored[1]];
    });
    return nodes;
  }

  function computeLayout(screen) {
    var nodes = authoredLayout(screen);
    if (STAGE_W < 1700) nodes = reflowForNarrowCanvas(nodes, rectsAt(nodes, 1920, 1080));
    return rectsAt(nodes, STAGE_W, STAGE_H);
  }

  function relayout() {
    fitStage();
    if (!state.screen) return;
    state.layout = computeLayout(state.screen);
    var rectFor = function (nodeId) {
      var entry = state.layout[nodeId];
      return entry ? entry.rect : null;
    };
    placed.forEach(function (item) {
      var rect = rectFor(item.node);
      if (rect) place(item.el, rect);
    });
    Object.keys(clipLayers).forEach(function (key) {
      var rect = rectFor(Number(key));
      if (rect) place(clipLayers[key], rect);
    });
    if (overlayLayer) place(overlayLayer, [0, 0, STAGE_W, STAGE_H]);
    applySliderVisuals();
  }

  window.addEventListener("resize", relayout);
  fitStage();

  /* ------------------------------------------------------------ draw screen */

  function renderImage(drawable, rect, root) {
    var node = el("el img", rect);
    node.style.backgroundSize = "100% 100%";
    node.style.opacity = drawable.active && drawable.enabled === false ? "0.35" : "1";
    if (!drawable.active) node.style.display = "none";
    if (drawable.color) node.style.backgroundColor = rgba(drawable.color);
    var url = spriteUrl(drawable.sprite);
    if (url) {
      var meta = (D.sprite_meta || {})[drawable.sprite] || {};
      var border = meta.border || [0, 0, 0, 0];
      var sliced = drawable.image_type === "sliced" && border.some(function (v) { return v > 0; });
      if (sliced) {
        node.style.backgroundImage = "none";
        node.style.borderStyle = "solid";
        node.style.borderWidth = border[1] + "px " + border[3] + "px " + border[0] + "px " + border[2] + "px";
        node.style.borderImage = "url('" + url + "') " + border[0] + " " + border[3] + " " + border[2] + " " + border[1] + " stretch";
        node.style.boxSizing = "border-box";
      } else {
        node.style.backgroundImage = "url('" + url + "')";
        if (drawable.preserve_aspect) {
          node.style.backgroundSize = "contain";
        } else if (drawable.image_type === "tiled") {
          node.style.backgroundSize = meta.width ? meta.width + "px " + meta.height + "px" : "auto";
          node.style.backgroundRepeat = "repeat";
        }
      }
    }
    root.appendChild(node);
    return node;
  }

  var ALIGN_FLEX = {
    "upper-left": ["flex-start", "flex-start", "left"],
    "upper-center": ["center", "flex-start", "center"],
    "upper-right": ["flex-end", "flex-start", "right"],
    "middle-left": ["flex-start", "center", "left"],
    "middle-center": ["center", "center", "center"],
    "middle-right": ["flex-end", "center", "right"],
    "lower-left": ["flex-start", "flex-end", "left"],
    "lower-center": ["center", "flex-end", "center"],
    "lower-right": ["flex-end", "flex-end", "right"]
  };

  function renderText(drawable, rect, root) {
    var node = el("el txt", rect);
    var align = ALIGN_FLEX[drawable.alignment] || ALIGN_FLEX["middle-center"];
    node.style.justifyContent = align[0];
    node.style.alignItems = align[1];
    node.style.textAlign = align[2];
    node.style.color = rgba(drawable.color);
    node.style.fontSize = (drawable.font_size || 36) + "px";
    node.style.fontWeight = drawable.font_style && drawable.font_style.indexOf("bold") >= 0 ? "bold" : "normal";
    node.style.fontStyle = drawable.font_style && drawable.font_style.indexOf("italic") >= 0 ? "italic" : "normal";
    node.style.lineHeight = ((drawable.font_size || 36) * 1.16).toFixed(1) + "px";
    if (drawable.horizontal_overflow === "overflow") node.classList.add("nowrap");
    node.classList.add(drawable.vertical_overflow === "overflow" ? "overflow" : "truncate");
    if (drawable.active === false) node.style.display = "none";
    node.textContent = (drawable.text || "").replace(/\\n/g, "\n");
    root.appendChild(node);
    return node;
  }

  /* --------------------------------------------------------------- transport */

  function Mixer(lesson) {
    this.lesson = lesson;
    this.audio = document.createElement("audio");
    this.tracks = [];
    this.context = null;
    this.gains = {};
    this.mode = location.protocol === "http:" || location.protocol === "https:" ? "webaudio" : "elements";
    this.build();
  }

  Mixer.prototype.stemForTrack = function (track) {
    var object = track.object || "";
    var name = object.split("/").pop().toLowerCase();
    return name;
  };

  Mixer.prototype.build = function () {
    var self = this;
    (this.lesson.audio || []).forEach(function (entry) {
      var track = (self.lesson.tracks || []).filter(function (t) {
        return self.stemForTrack(t) === entry.stem;
      })[0] || {};
      var source = new Audio("assets/audio/" + entry.path);
      source.preload = "auto";
      source.loop = !!track.loop;
      var initial = track.volume === undefined || track.volume === null ? 1 : track.volume;
      var startedAt = null;
      var record = {
        stem: entry.stem,
        path: entry.path,
        clip: entry.clip_name,
        seconds: entry.seconds,
        track: track,
        element: source,
        gain: null,
        volume: initial,
        started: false
      };
      source.volume = initial;
      self.tracks.push(record);
    });
    if (this.mode === "webaudio") {
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        this.context = new Ctx();
        this.tracks.forEach(function (record) {
          var node = self.context.createMediaElementSource(record.element);
          var gain = self.context.createGain();
          gain.gain.value = record.volume;
          node.connect(gain);
          gain.connect(self.context.destination);
          record.gain = gain;
        });
      } catch (error) {
        this.mode = "elements";
        this.context = null;
      }
    }
    this.tracks.forEach(function (record) {
      record.element.addEventListener("ended", function () {
        if (!record.element.loop) record.started = false;
      });
    });
  };

  Mixer.prototype.resume = function () {
    if (this.context && this.context.state === "suspended") this.context.resume();
  };

  Mixer.prototype.play = function () {
    this.resume();
    var self = this;
    // The original calls AudioSource.Play() on all five stems, so a stem at
    // volume 0 (Vox uses VolumeValueChangefromzero) still advances and can be
    // unmuted mid-playback.
    var active = this.tracks;
    var reference = null;
    active.forEach(function (record) {
      if (reference === null) reference = record;
      var target = reference.started ? reference.element.currentTime : 0;
      try {
        record.element.currentTime = target;
        var promise = record.element.play();
        if (promise && promise.catch) promise.catch(function () {});
        record.started = true;
      } catch (error) { /* ignored: the browser will report it on the element */ }
    });
    this.startSync(reference);
  };

  Mixer.prototype.startSync = function (reference) {
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

  Mixer.prototype.pause = function () {
    this.tracks.forEach(function (record) {
      if (!record.element.paused) record.element.pause();
    });
  };

  Mixer.prototype.stop = function () {
    this.tracks.forEach(function (record) {
      record.element.pause();
      try { record.element.currentTime = 0; } catch (error) { /* not seekable yet */ }
      record.started = false;
    });
  };

  Mixer.prototype.setVolume = function (stem, value) {
    this.tracks.forEach(function (record) {
      if (record.stem !== stem) return;
      record.volume = value;
      if (record.gain) {
        record.gain.gain.value = value;
      } else {
        record.element.volume = value;
      }
    });
  };

  Mixer.prototype.zoom = function () { return this.tracks.length; };

  /* ------------------------------------------------------------------ router */

  var state = { screen: null, lesson: null, mixer: null, overlay: null };

  function stopMixer() {
    if (state.mixer) {
      state.mixer.stop();
      if (state.mixer.syncTimer) clearInterval(state.mixer.syncTimer);
      if (state.mixer.context) {
        try { state.mixer.context.close(); } catch (error) { /* already closed */ }
      }
      state.mixer = null;
    }
  }

  function clearStage() {
    stage.innerHTML = "";
    state.screen = null;
  }

  function screenFor(name) {
    if (name === "player") return D.player || D.screens.player;
    return (D.screens && D.screens[name]) || (name && name.indexOf("level") === 0 ? D.player : null);
  }

  var overlayLayer = null;
  var clipLayers = {};        // clip node id -> clipping container
  var elementsByNode = {};    // layout node id -> rendered elements
  var sliderRecords = [];
  var placed = [];
  var pointerTargets = [];    // {rect, canvasRank, order, drawable, el}

  function overlayRoot() {
    if (!overlayLayer) {
      overlayLayer = el("layer", [0, 0, STAGE_W, STAGE_H]);
      overlayLayer.style.background = "rgba(6,8,12,0.95)";
      overlayLayer.style.display = "none";
      overlayLayer.style.zIndex = 70;
      overlayLayer.style.pointerEvents = "auto";
      stage.appendChild(overlayLayer);
    }
    return overlayLayer;
  }

  function resetFrames() {
    if (overlayLayer) { overlayLayer.remove(); overlayLayer = null; }
    clipLayers = {};
    elementsByNode = {};
    sliderRecords = [];
    placed = [];
    pointerTargets = [];
    state.layout = null;
  }

  function register(nodeId, node) {
    if (nodeId === undefined || nodeId === null || !node) return;
    (elementsByNode[nodeId] = elementsByNode[nodeId] || []).push(node);
  }

  function rectOfNode(nodeId) {
    var entry = state.layout && state.layout[nodeId];
    return entry ? entry.rect : null;
  }

  function clipLayer(nodeId) {
    if (!clipLayers[nodeId]) {
      clipLayers[nodeId] = el("layer clip", rectOfNode(nodeId) || [0, 0, STAGE_W, STAGE_H]);
      stage.appendChild(clipLayers[nodeId]);
    }
    return clipLayers[nodeId];
  }

  function renderDrawable(drawable, rect, container, options) {
    if (drawable.kind === "image") return renderImage(drawable, rect, container);
    if (drawable.kind === "text") return renderText(drawable, rect, container);
    if (drawable.kind === "video-placeholder") {
      var video = el("el video", rect);
      video.textContent = (options && options.videoLabel) || "video";
      container.appendChild(video);
      return video;
    }
    if (drawable.kind === "button") {
      var button = el("el hit", rect);
      var primary = (drawable.hooks || [])[0] || {};
      button.dataset.method = primary.method || "";
      if (primary.target_lesson) button.dataset.lesson = primary.target_lesson;
      if (primary.string_argument) button.dataset.scene = primary.string_argument;
      if (primary.target) button.dataset.target = primary.target;
      if (options && options.registerHit) options.registerHit(drawable, rect, button);
      container.appendChild(button);
      return button;
    }
    if (drawable.kind === "slider") return attachSlider(drawable, rect, container, options);
    return null;
  }

  function renderScreen(screen, options) {
    clearStage();
    resetFrames();
    options = options || {};
    fitStage();
    state.screen = screen;
    state.layout = computeLayout(screen);

    // Unity draws canvases by sorting order: reproduce it so a widget in a higher
    // canvas wins pointer hits over one in a lower canvas.
    var orders = [];
    (screen.drawables || []).forEach(function (drawable) {
      var order = drawable.canvas_order || 0;
      if (orders.indexOf(order) < 0) orders.push(order);
    });
    orders.sort(function (a, b) { return a - b; });
    var canvasZ = function (order) {
      var rank = orders.indexOf(order || 0);
      return rank < 0 ? 0 : rank;
    };

    var drawn = 0;
    (screen.drawables || []).forEach(function (drawable) {
      if (drawable.enabled === false && drawable.kind !== "button" && drawable.kind !== "slider") return;
      var rect = rectOfNode(drawable.node);
      if (!rect) return;
      var container = drawable.clip_node !== undefined && drawable.clip_node !== null
        ? clipLayer(drawable.clip_node)
        : stage;
      if (drawable.overlay && !options.includeOverlay) {
        renderDrawable(drawable, rect, overlayRoot(), options);
        return;
      }
      var node = renderDrawable(drawable, rect, container, options);
      if (drawable.kind === "button" && node) {
        pointerTargets.push({
          rect: rect,
          canvasRank: canvasZ(drawable.canvas_order),
          order: drawn,
          drawable: drawable,
          inner: node,
          options: options,
          layer: container
        });
      }
      drawn += 1;
      if (node) {
        register(drawable.node, node);
        placed.push({ node: drawable.node, el: node });
        node.dataset.z = String(canvasZ(drawable.canvas_order) * 1000 + drawn);
        node.dataset.area = String(rect[2] * rect[3]);
      }
    });
    applySliderVisuals();

    // Pointer hits are resolved the way Unity does it, not by DOM stacking:
    // among the widgets whose rect contains the point, the one in the highest
    // canvas wins, and within that canvas the smallest (most specific) wins.
    // This also makes a label inside a button clickable, which is what the
    // shipped scenes rely on.
    var byCanvas = {};
    pointerTargets.forEach(function (target) {
      (byCanvas[target.canvasRank] = byCanvas[target.canvasRank] || []).push(target);
    });
    Object.keys(byCanvas).forEach(function (rank) {
      byCanvas[rank]
        .sort(function (a, b) { return Number(a.rect[2] * a.rect[3]) - Number(b.rect[2] * b.rect[3]); })
        .forEach(function (target, index) {
          target.inner.style.zIndex = String(Number(rank) * 1000 + 900 - index);
        });
    });
    return stage;
  }

  function attachSlider(drawable, rect, container, options) {
    var input = document.createElement("input");
    input.type = "range";
    input.className = "el slider-hit";
    place(input, rect);
    input.min = drawable.min === undefined ? 0 : drawable.min;
    input.max = drawable.max === undefined ? 1 : drawable.max;
    input.step = drawable.whole_numbers ? 1 : 0.01;
    input.value = drawable.value === undefined ? 1 : drawable.value;
    var target = (drawable.hooks || [])[0] || {};
    var stem = (target.game_object || target.target || "").split("/").pop().toLowerCase();
    input.dataset.stem = stem;
    input.dataset.initial = String(input.value);
    var record = { drawable: drawable, input: input, fill: null, handle: null };
    sliderRecords.push(record);
    if (options && options.onSlider) options.onSlider(stem, parseFloat(input.value), drawable);
    input.addEventListener("input", function () {
      var value = parseFloat(input.value);
      updateSliderVisual(record);
      if (options && options.onSlider) options.onSlider(stem, value, drawable);
    });
    container.appendChild(input);
    return input;
  }

  function applySliderVisuals() {
    sliderRecords.forEach(function (record) {
      if (!record.fill && record.drawable.fill_node !== undefined && record.drawable.fill_node !== null) {
        record.fill = (elementsByNode[record.drawable.fill_node] || [])[0] || null;
      }
      if (!record.handle && record.drawable.handle_node !== undefined && record.drawable.handle_node !== null) {
        record.handle = (elementsByNode[record.drawable.handle_node] || [])[0] || null;
      }
      updateSliderVisual(record);
    });
  }

  function updateSliderVisual(record) {
    var drawable = record.drawable;
    var value = parseFloat(record.input.value);
    var min = drawable.min === undefined ? 0 : drawable.min;
    var max = drawable.max === undefined ? 1 : drawable.max;
    var ratio = max === min ? 0 : (value - min) / (max - min);
    var direction = drawable.direction || "left-to-right";
    var horizontal = direction === "left-to-right" || direction === "right-to-left";
    var inverted = direction === "right-to-left" || direction === "top-to-bottom";
    if (record.fill) {
      if (horizontal) {
        record.fill.style.transformOrigin = inverted ? "right center" : "left center";
        record.fill.style.transform = "scaleX(" + ratio + ")";
      } else {
        record.fill.style.transformOrigin = inverted ? "center top" : "center bottom";
        record.fill.style.transform = "scaleY(" + ratio + ")";
      }
    }
    var fillRect = drawable.fill_node !== undefined && drawable.fill_node !== null ? rectOfNode(drawable.fill_node) : null;
    var handleRect = drawable.handle_node !== undefined && drawable.handle_node !== null ? rectOfNode(drawable.handle_node) : null;
    if (record.handle && fillRect && handleRect) {
      var travel = horizontal ? (fillRect[2] - handleRect[2]) : (fillRect[3] - handleRect[3]);
      var offset = travel * (inverted ? 1 - ratio : ratio);
      record.handle.style.transform = horizontal
        ? "translateX(" + offset + "px)"
        : "translateY(" + (-offset) + "px)";
    }
  }

  function hitTest(clientX, clientY) {
    var box = stage.getBoundingClientRect();
    var unitPerPx = STAGE_W / box.width;
    var x = (clientX - box.left) * unitPerPx;
    var y = STAGE_H - (clientY - box.top) * unitPerPx;   // CSS is y-down, canvas is y-up
    var best = null;
    pointerTargets.forEach(function (target) {
      if (!target.inner.offsetParent && target.inner.style.display !== "none") return;   // hidden layer
      var rect = target.rect;
      if (x < rect[0] || y < rect[1] || x > rect[0] + rect[2] || y > rect[1] + rect[3]) return;
      var area = rect[2] * rect[3];
      if (area <= 0) return;
      if (!best ||
          target.canvasRank > best.canvasRank ||
          (target.canvasRank === best.canvasRank && area < best.area)) {
        best = { target: target, area: area, canvasRank: target.canvasRank };
      }
    });
    return best ? best.target : null;
  }

  stage.addEventListener("click", function (event) {
    if (event.target && event.target.tagName === "INPUT") return;   // sliders handle themselves
    var target = hitTest(event.clientX, event.clientY);
    if (target) fireHooks(target.drawable.hooks, target.options);
  });

  function fireHooks(hooks, options) {
    if (!hooks || !hooks.length) {
      if (options && options.onTap) options.onTap();
      return;
    }
    hooks.forEach(function (hook) {
      var method = hook.method;
      if (method === "Play" || method === "Pause" || method === "Stop") {
        if (state.mixer) state.mixer[method.toLowerCase()]();
      } else if (method === "SetVolume" && options && options.onSlider) {
        options.onSlider((hook.game_object || hook.target || "").split("/").pop().toLowerCase(), hook.float_argument || 1, hook);
      } else if (method === "LoadNextLevel" || method === "LoadPrevLevel") {
        stepLesson(method === "LoadNextLevel" ? 1 : -1);
      } else if (method === "Hide") {
        hideOverlay();
      } else if (method === "ChangeScene") {
        // A lesson slug from the data needs the lesson route; a scene name is
        // mapped by routeForScene (which already returns a full route).
        var target = hook.target_lesson ? "lesson/" + hook.target_lesson : routeForScene(hook.string_argument, options);
        if (target) location.hash = "#/" + target;
      } else if (hook.script === "WebURLScript") {
        var url = hook.url || D.credits.site;
        window.open(url, "_blank");
      } else if (options && options.onTap) {
        options.onTap(hook);
      }
    });
  }

  function routeForScene(sceneName, options) {
    // Scene names arrive exactly as the shipped UnityEvents store them, e.g.
    // "00 - Main Scene_Specific Toque", "2 - Lezione 1 - Elegba", "Volume Selector".
    if (!sceneName) return options && options.fallbackRoute ? options.fallbackRoute : null;
    if (sceneName.indexOf("Oru Seco") >= 0) return "volume-2";
    if (sceneName.indexOf("Specific Toque") >= 0) return "volume-1";
    if (sceneName.indexOf("Main Scene") >= 0) return "volume-1";
    if (sceneName.indexOf("Volume Selector") >= 0) return "volumes";
    if (sceneName.indexOf("Lezione") >= 0) {
      var slug = D.scene_stem_to_slug && D.scene_stem_to_slug[sceneName];
      if (slug) return "lesson/" + slug;
    }
    return options && options.fallbackRoute ? options.fallbackRoute : null;
  }

  function stepLesson(delta) {
    if (!state.lesson) return;
    var volume = state.lesson.volume;
    var pool = D.lessons.filter(function (lesson) { return lesson.volume === volume; });
    var index = pool.indexOf(state.lesson) + delta;
    if (index < 0) index = 0;
    if (index >= pool.length) index = pool.length - 1;
    location.hash = "#/lesson/" + pool[index].slug;
  }

  function showOverlay() {
    if (overlayLayer) {
      overlayLayer.style.display = "block";
      if (state.mixer) state.mixer.pause();
    }
  }

  function hideOverlay() {
    if (overlayLayer) overlayLayer.style.display = "none";
  }

  /* ----------------------------------------------------------------- screens */

  function showOpening() {
    stopMixer();
    var screen = screenFor("opening");
    if (!screen) return showVolumes();
    renderScreen(screen, {
      onTap: function () { location.hash = "#/volumes"; }
    });
    var hit = el("el hit", [0, 0, STAGE_W, STAGE_H]);
    hit.style.zIndex = 5;
    hit.addEventListener("click", function () { location.hash = "#/volumes"; });
    stage.appendChild(hit);
  }

  function showVolumes() {
    stopMixer();
    renderScreen(screenFor("volumeSelector"), {
      videoLabel: "Libri Video\n(streamed in the original app)",
      onTap: function () { location.hash = "#/credits"; }
    });
    var credits = el("el hit", [0, 0, 260, 90]);
    credits.textContent = "";
    credits.addEventListener("click", function () { location.hash = "#/credits"; });
    stage.appendChild(credits);
  }

  function showIndex(volume) {
    stopMixer();
    var screen = screenFor(volume === "volume-2" ? "oruSecoIndex" : "toqueIndex");
    if (!screen) return showVolumes();
    var lessons = D.lessons.filter(function (lesson) { return lesson.volume === volume; });
    renderScreen(screen, {
      fallbackRoute: volume,
      onTap: function (hook) {
        if (hook && hook.string_argument && hook.target_lesson) {
          location.hash = "#/lesson/" + hook.target_lesson;
        }
      }
    });
    // map every button that names a lesson onto that lesson, then add a scroll
    // strip so the whole volume is reachable exactly as in the original.
    var strip = document.createElement("div");
    strip.className = "layer";
    strip.style.left = "0px";
    strip.style.top = (STAGE_H - 300) + "px";
    strip.style.width = STAGE_W + "px";
    strip.style.height = "300px";
    strip.style.display = "flex";
    strip.style.gap = "20px";
    strip.style.alignItems = "flex-end";
    strip.style.pointerEvents = "auto";
    strip.style.overflowX = "auto";
    strip.style.zIndex = 40;
    strip.style.background = "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.65) 40%, rgba(0,0,0,0.85) 100%)";
    lessons.forEach(function (lesson) {
      var card = document.createElement("div");
      card.style.minWidth = "300px";
      card.style.height = "220px";
      card.style.padding = "18px 16px";
      card.style.color = "#fff";
      card.style.background = "rgba(18,24,32,0.9)";
      card.style.border = "2px solid rgba(255,255,255,0.14)";
      card.style.borderRadius = "10px";
      card.style.cursor = "pointer";
      card.style.fontSize = "22px";
      card.style.flex = "0 0 auto";
      var number = document.createElement("div");
      number.textContent = String(lesson.number || "");
      number.style.fontSize = "40px";
      number.style.opacity = "0.5";
      var title = document.createElement("div");
      title.textContent = lesson.title || "";
      title.style.marginTop = "8px";
      title.style.fontSize = "26px";
      var play = document.createElement("div");
      play.textContent = "PLAY";
      play.style.marginTop = "26px";
      play.style.color = "#7fc4ff";
      card.appendChild(number); card.appendChild(title); card.appendChild(play);
      card.addEventListener("click", function () {
        location.hash = "#/lesson/" + lesson.slug;
      });
      strip.appendChild(card);
    });
    stage.appendChild(strip);
  }

  function showLesson(slug) {
    stopMixer();
    var lesson = D.lessons.filter(function (item) { return item.slug === slug; })[0];
    if (!lesson) return showIndex("volume-1");
    state.lesson = lesson;
    var screen = screenFor(lesson.level) || screenFor("player") || D.player;
    var mixer = new Mixer(lesson);
    state.mixer = mixer;
    renderScreen(screen, {
      fallbackRoute: lesson.volume,
      onSlider: function (stem, value) {
        if (mixer) mixer.setVolume(stem, value);
      }
    });
    // the lesson scenes differ from the blueprint mainly in this title string
    var titlePattern = /^(Toque|Lezione|Oru)/i;
    Array.prototype.forEach.call(document.querySelectorAll("#stage .el.txt"), function (node) {
      if (titlePattern.test((node.textContent || "").trim())) {
        node.textContent = (lesson.volume === "volume-2" ? "Oru Seco " : "Toque ") +
          (lesson.number || "") + " - " + (lesson.title || "");
      }
    });
    // lesson-specific label over the blueprint title
    var label = el("el txt", [660, 840, 600, 60]);
    label.style.justifyContent = "center";
    label.style.alignItems = "center";
    label.style.color = "#ffffff";
    label.style.fontSize = "36px";
    label.style.pointerEvents = "none";
    label.textContent = (lesson.volume === "volume-2" ? "Oru Seco " : "Toque ") +
      (lesson.number || "") + " - " + (lesson.title || "");
    stage.appendChild(label);

    var missing = [];
    STEM_ORDER.forEach(function (stem) {
      var track = (lesson.tracks || []).filter(function (item) {
        return (item.object || "").split("/").pop().toLowerCase() === stem;
      })[0];
      if (track && !track.clip) missing.push(stem);
    });
    if (missing.length) {
      var note = el("badge");
      note.textContent = "no audio for: " + missing.join(", ");
      stage.appendChild(note);
    }
    // the shipped scene keeps its own pause layer inactive; it now holds the
    // original overlay controls (Prev / Next / Home / Cambia / Torna).
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        if (overlayLayer && overlayLayer.style.display === "block") hideOverlay();
        else showOverlay();
      }
    });
    var menuHit = el("el hit", [520, 860, 300, 60]);
    menuHit.addEventListener("click", showOverlay);
    stage.appendChild(menuHit);
  }

  function showCredits() {
    stopMixer();
    var existing = document.getElementById("credits");
    if (existing) existing.remove();
    var box = document.createElement("div");
    box.id = "credits";
    var title = document.createElement("h1");
    title.textContent = "BatApp - Diario di un Omo Aña";
    var subtitle = document.createElement("h2");
    subtitle.textContent = "Static port of the original Android app. Content, recordings and scores belong to Paolo Batà Bianconcini.";
    box.appendChild(title); box.appendChild(subtitle);
    [["site", "batangoma.it — didattica"], ["facebook", "Facebook — BataNgoma"],
     ["instagram", "Instagram — paolobatablanco"], ["youtube", "YouTube — paoloBata"],
     ["itunes", "iTunes — Batà Ngoma"]].forEach(function (pair) {
      var link = document.createElement("a");
      link.href = D.credits[pair[0]];
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = pair[1];
      box.appendChild(link);
    });
    var note = document.createElement("p");
    note.textContent = D.credits.note + " The volume selector in the original streams a video (" +
      "Libri Video); this offline port shows a placeholder instead.";
    box.appendChild(note);
    var close = document.createElement("div");
    close.className = "close";
    close.textContent = "✕";
    close.addEventListener("click", function () { box.remove(); history.back(); });
    box.appendChild(close);
    document.body.appendChild(box);
  }

  /* ------------------------------------------------------------------- routes */

  function route() {
    var hash = location.hash.replace(/^#\/?/, "");
    if (!hash) return showOpening();
    if (hash === "volumes") return showVolumes();
    if (hash === "volume-1") return showIndex("volume-1");
    if (hash === "volume-2") return showIndex("volume-2");
    if (hash === "credits") return showCredits();
    var lessonMatch = hash.match(/^lesson\/(.+)$/);
    if (lessonMatch) return showLesson(decodeURIComponent(lessonMatch[1]));
    showOpening();
  }

  window.addEventListener("hashchange", route);
  if (!location.hash) location.hash = "#/opening";
  route();

  /* Debug/testing hook: used by tests/verify.mjs to inspect the mixer state
     without reaching into closures. Read-only; the app never needs it. */
  window.__batapp = {
    data: D,
    state: function () {
      return {
        screen: state.screen ? state.screen.slug : null,
        lesson: state.lesson ? state.lesson.slug : null,
        overlayVisible: !!(overlayLayer && overlayLayer.style.display === "block"),
        wayfinding: document.querySelectorAll(".el.hit").length
      };
    },
    hit: function (clientX, clientY) {
      var target = hitTest(clientX, clientY);
      if (!target) return null;
      var hook = (target.drawable.hooks || [])[0] || {};
      return { method: hook.method, scene: hook.string_argument, lesson: hook.target_lesson, path: target.drawable.path, rect: target.rect.map(Math.round) };
    },
    targets: function () { return pointerTargets.length; },
    tracks: function () {
      if (!state.mixer) return [];
      return state.mixer.tracks.map(function (record) {
        return {
          stem: record.stem,
          path: record.path,
          volume: record.element.volume,
          gain: record.gain ? record.gain.gain.value : null,
          currentTime: record.element.currentTime,
          paused: record.element.paused,
          duration: record.element.duration || null,
          readyState: record.element.readyState,
          error: record.element.error ? record.element.error.code : null
        };
      });
    }
  };
})();
