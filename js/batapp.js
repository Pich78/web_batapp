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

  function placeEntry(el, entry) {
    // Renders an affine layout entry: an unrotated box around its centre plus
    // the accumulated rotation (CSS is y-down, so Unity's +z is CSS -angle).
    var w = entry.size[0] * entry.scale;
    var h = entry.size[1] * entry.scale;
    var cx = entry.center[0], cy = entry.center[1];
    el.style.left = (cx - w / 2) + "px";
    el.style.top = (STAGE_H - cy - h / 2) + "px";
    el.style.width = Math.max(0, w) + "px";
    el.style.height = Math.max(0, h) + "px";
    if (entry.angle) {
      el.style.transform = "rotate(" + (-entry.angle) + "deg)";
      el.style.transformOrigin = "center center";
    } else if (el.classList.contains("fit-center")) {
      el.style.transform = "translateX(-50%)";
    } else if (el.style.transform && el.style.transform.indexOf("rotate") === 0) {
      el.style.transform = "";
    }
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

  var tintFilters = {};
  function tintFilter(color) {
    // CSS masks cannot load file:// images, so tint sprites with an SVG filter:
    // flood the sprite's alpha with Unity's m_Color (works for 9-slice borders
    // and preserves transparent pixels).
    var key = color.slice(0, 3).map(function (channel) {
      return Math.round(channel * 255);
    }).join("-");
    if (!tintFilters[key]) {
      var svg = document.getElementById("batapp-filters");
      if (!svg) {
        svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.id = "batapp-filters";
        svg.setAttribute("aria-hidden", "true");
        svg.style.position = "absolute";
        svg.style.width = "0";
        svg.style.height = "0";
        svg.style.overflow = "hidden";
        document.body.appendChild(svg);
      }
      var id = "batapp-tint-" + key;
      var filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
      filter.id = id;
      filter.setAttribute("color-interpolation-filters", "sRGB");
      var flood = document.createElementNS("http://www.w3.org/2000/svg", "feFlood");
      flood.setAttribute("flood-color", "rgb(" + key.split("-").join(",") + ")");
      flood.setAttribute("result", "tint");
      var composite = document.createElementNS("http://www.w3.org/2000/svg", "feComposite");
      composite.setAttribute("in", "tint");
      composite.setAttribute("in2", "SourceGraphic");
      composite.setAttribute("operator", "in");
      filter.appendChild(flood);
      filter.appendChild(composite);
      svg.appendChild(filter);
      tintFilters[key] = id;
    }
    return "url(#" + tintFilters[key] + ")";
  }

  function fitStage(screen) {
    // Match-height, exactly like the shipped CanvasScaler, but against the
    // canvas RectTransform the content was authored in. The app menus and the
    // lesson player use 584.7x1169.4 (1:2); the stage keeps that height and
    // widens with the window, so a 720x1440 phone fills exactly and no
    // orientation lock or letterboxing is needed.
    var design = (screen && screen.canvas_size) || [1920, 1080];
    if (!(design[0] > 0) || !(design[1] > 0)) design = [1920, 1080];
    var vw = window.innerWidth, vh = window.innerHeight;
    STAGE_H = design[1];
    STAGE_W = STAGE_H * (vw / vh);
    var scale = vh / STAGE_H;
    stage.style.width = STAGE_W + "px";
    stage.style.height = STAGE_H + "px";
    stage.style.transform = "scale(" + scale + ")";
    stage.style.transformOrigin = "0 0";
    stage.style.left = "0px";
    stage.style.top = "0px";
  }


  function clampIntoParent(rect, size, parentRect, scale, lockX, lockY) {
    // CSS-overflow style clamp: a box never leaves its containing box. Shift it
    // back inside when it overflows, and shrink the local size when the box is
    // wider or taller than the container. Updating `size` (not just the rect)
    // makes the node's own children follow the clamped box, because they are
    // anchored to that size on the next pass.
    //
    // An oversized group whose children use fixed offsets is left alone on that
    // axis: shrinking a scroll strip, a carousel or a centred banner would
    // rewrite its children's coordinate system and stack them. Those groups are
    // clipped by the stage (or by their own Mask layer), exactly like overflow
    // content in CSS. Leaves and stretch-anchored groups shrink normally.
    var maxW = parentRect[2], maxH = parentRect[3];
    if (!lockX) {
      if (rect[2] > maxW) {
        rect[2] = Math.max(0, maxW);
        size[0] = scale > 0 ? rect[2] / scale : 0;
      }
      if (rect[0] < parentRect[0]) rect[0] = parentRect[0];
      if (rect[0] + rect[2] > parentRect[0] + maxW) {
        rect[0] = parentRect[0] + maxW - rect[2];
      }
    }
    if (!lockY) {
      if (rect[3] > maxH) {
        rect[3] = Math.max(0, maxH);
        size[1] = scale > 0 ? rect[3] / scale : 0;
      }
      if (rect[1] < parentRect[1]) rect[1] = parentRect[1];
      if (rect[1] + rect[3] > parentRect[1] + maxH) {
        rect[1] = parentRect[1] + maxH - rect[3];
      }
    }
  }

  function rotatePoint(angle, x, y) {
    var rad = angle * Math.PI / 180;
    var c = Math.cos(rad), s = Math.sin(rad);
    return [x * c - y * s, x * s + y * c];
  }

  function rectsAt(nodes, canvasW, canvasH) {
    var out = {};
    var root = {
      rect: [0, 0, canvasW, canvasH],
      size: [canvasW, canvasH],
      scale: 1,
      angle: 0,
      origin: [0, 0],
      center: [canvasW / 2, canvasH / 2]
    };
    var children = {};
    nodes.forEach(function (node) {
      if (node.parent >= 0) (children[node.parent] = children[node.parent] || []).push(node);
    });
    nodes.forEach(function (node) {
      var parent = node.parent >= 0 && out[node.parent] ? out[node.parent] : root;
      if (node.canvas && node.parent < 0) {
        out[node.id] = {
          rect: root.rect.slice(), size: root.size.slice(), scale: 1,
          angle: 0, origin: [0, 0], center: root.center.slice()
        };
        return;
      }
      if (node.plain) {
        out[node.id] = {
          rect: parent.rect, size: parent.size,
          scale: parent.scale * (node.scale || 1),
          angle: parent.angle, origin: parent.origin, center: parent.center
        };
        return;
      }
      var a = node.anchors, pivot = node.pivot, pos = node.anchored, delta = node.delta;
      var pw = parent.size[0], ph = parent.size[1];
      var minX = a[0] * pw, minY = a[1] * ph, maxX = a[2] * pw, maxY = a[3] * ph;
      var width = (maxX - minX) + delta[0], height = (maxY - minY) + delta[1];
      var pivotX = minX + (maxX - minX) * pivot[0] + pos[0];
      var pivotY = minY + (maxY - minY) * pivot[1] + pos[1];
      var nodeScale = node.scale || 1;
      var scale = parent.scale * nodeScale;
      var angle = parent.angle + (node.rotation || 0);
      // Affine frame: local (0,0) in stage coordinates plus a rotation. The
      // pivot's stage position follows the parent frame; localScale scales the
      // rectangle and its children around that pivot (Unity's RectTransform).
      var pivotOffset = rotatePoint(parent.angle, pivotX * parent.scale, pivotY * parent.scale);
      var pivotStage = [parent.origin[0] + pivotOffset[0], parent.origin[1] + pivotOffset[1]];
      var back = rotatePoint(angle, -pivot[0] * width * scale, -pivot[1] * height * scale);
      var origin = [pivotStage[0] + back[0], pivotStage[1] + back[1]];
      var forward = rotatePoint(angle, width * scale / 2, height * scale / 2);
      var center = [origin[0] + forward[0], origin[1] + forward[1]];
      var halfW = Math.abs(width * scale) / 2, halfH = Math.abs(height * scale) / 2;
      var corners = [
        rotatePoint(angle, -halfW, -halfH),
        rotatePoint(angle, halfW, -halfH),
        rotatePoint(angle, halfW, halfH),
        rotatePoint(angle, -halfW, halfH)
      ];
      var minCX = Math.min(corners[0][0], corners[1][0], corners[2][0], corners[3][0]);
      var maxCX = Math.max(corners[0][0], corners[1][0], corners[2][0], corners[3][0]);
      var minCY = Math.min(corners[0][1], corners[1][1], corners[2][1], corners[3][1]);
      var maxCY = Math.max(corners[0][1], corners[1][1], corners[2][1], corners[3][1]);
      var rect = [center[0] + minCX, center[1] + minCY, maxCX - minCX, maxCY - minCY];
      var size = [width, height];
      if (angle === 0 && parent.angle === 0) {
        var kids = children[node.id] || [];
        var fixedX = kids.some(function (kid) {
          return kid.anchors && Math.abs(kid.anchors[2] - kid.anchors[0]) < 0.001;
        });
        var fixedY = kids.some(function (kid) {
          return kid.anchors && Math.abs(kid.anchors[3] - kid.anchors[1]) < 0.001;
        });
        var lockX = kids.length > 0 && fixedX && rect[2] > parent.rect[2];
        var lockY = kids.length > 0 && fixedY && rect[3] > parent.rect[3];
        clampIntoParent(rect, size, parent.rect, scale, lockX, lockY);
        origin = [rect[0], rect[1]];
        center = [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2];
      }
      out[node.id] = {
        rect: rect, size: size, scale: scale,
        angle: angle, origin: origin, center: center
      };
    });
    return out;
  }

  function computeLayout(screen) {
    return rectsAt(screen ? (screen.layout || []) : [], STAGE_W, STAGE_H);
  }

  function relayout() {
    fitStage(state.screen);
    if (!state.screen) return;
    state.layout = computeLayout(state.screen);
    var rectFor = function (nodeId) {
      var entry = state.layout[nodeId];
      return entry ? entry.rect : null;
    };
    placed.forEach(function (item) {
      if (item.menu) {
        place(item.el, [STAGE_W * 0.60, STAGE_H * 0.90, STAGE_W * 0.38, STAGE_H * 0.08]);
        return;
      }
      var entry = state.layout[item.node];
      if (entry) placeEntry(item.el, entry);
    });
    Object.keys(clipLayers).forEach(function (key) {
      var rect = rectFor(Number(key));
      if (rect) applyClip(clipLayers[key], rect);
    });
    if (overlayLayer) place(overlayLayer, [0, 0, STAGE_W, STAGE_H]);
    layoutSpectrum();
    applySliderVisuals();
  }

  window.addEventListener("resize", relayout);
  fitStage(null);

  /* ------------------------------------------------------------ draw screen */

  function renderImage(drawable, rect, root) {
    var node = el("el img", rect);
    node.style.backgroundSize = "100% 100%";
    node.style.opacity = drawable.active && drawable.enabled === false ? "0.35" : "1";
    if (!drawable.active) node.style.display = "none";
    var color = drawable.color;
    var alpha = color && color[3] !== undefined ? color[3] : 1;
    var white = !color || (color[0] >= 0.995 && color[1] >= 0.995 && color[2] >= 0.995);
    var url = spriteUrl(drawable.sprite);
    if (!url) {
      if (color) node.style.backgroundColor = rgba(color);
      root.appendChild(node);
      return node;
    }
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
    // Unity multiplies the sprite by m_Color; the filter keeps transparent
    // pixels transparent (a plain background-color used to cover the yellow
    // band and the portrait behind white sprites).
    if (!white) node.style.filter = tintFilter(color);
    if (alpha < 1) node.style.opacity = String((drawable.enabled === false ? 0.35 : 1) * alpha);
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
    // Unity's ContentSizeFitter horizontal preference: the authored Text rect
    // can be zero-width and grows around its centre pivot (all fitted labels in
    // this build use pivot 0.5,1).
    if (drawable.fit_width) node.classList.add("fit-width", "fit-center");
    if (drawable.fit_height) node.classList.add("fit-height");
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
    this.analyser = null;
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
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyser.smoothingTimeConstant = 0.5;
        this.tracks.forEach(function (record) {
          var node = self.context.createMediaElementSource(record.element);
          var gain = self.context.createGain();
          gain.gain.value = record.volume;
          node.connect(gain);
          gain.connect(self.analyser);
          record.gain = gain;
        });
        this.analyser.connect(this.context.destination);
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
    stopSpectrum();
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
      // Clip layers stay full-stage so children keep using canvas coordinates;
      // the mask is expressed with clip-path rather than by moving the layer
      // (moving it would offset every child by the mask's own origin).
      var layer = el("layer clip", [0, 0, STAGE_W, STAGE_H]);
      applyClip(layer, rectOfNode(nodeId) || [0, 0, STAGE_W, STAGE_H]);
      clipLayers[nodeId] = layer;
      stage.appendChild(layer);
    }
    return clipLayers[nodeId];
  }

  function applyClip(layer, rect) {
    var top = STAGE_H - rect[1] - rect[3];
    var right = STAGE_W - rect[0] - rect[2];
    var bottom = rect[1];
    var left = rect[0];
    var inset = "inset(" + top + "px " + right + "px " + bottom + "px " + left + "px)";
    layer.style.clipPath = inset;
    layer.style.webkitClipPath = inset;
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
    state.screen = screen;
    fitStage(screen);
    stage.style.background = rgba(screen.background || [0, 0, 0, 1]);
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
      // Inactive scene objects do not render. The pause layer is the one
      // exception: its widgets are inactive in the shipped scenes, but the port
      // renders them into the overlay that replaces the original's pause menu.
      if (drawable.active === false && !drawable.overlay) return;
      var rect = rectOfNode(drawable.node);
      if (!rect) return;
      var container = drawable.clip_node !== undefined && drawable.clip_node !== null
        ? clipLayer(drawable.clip_node)
        : stage;
      if (drawable.overlay && !options.includeOverlay) {
        container = overlayRoot();
      }
      var node = renderDrawable(drawable, rect, container, options);
      var entry = state.layout[drawable.node];
      if (node && entry) placeEntry(node, entry);
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
    if (screen.spectrum) startSpectrum(screen.spectrum);
    return stage;
  }

  /* --------------------------------------------------------------- spectrum */

  var spectrumLayer = null;
  var spectrumBars = [];
  var spectrumValues = [];
  var spectrumInfo = null;
  var spectrumFrame = 0;

  function curveAt(curve, value) {
    var keys = curve && curve.m_Curve;
    if (!keys || !keys.length) return value;
    if (value <= keys[0].time) return keys[0].value;
    for (var i = 1; i < keys.length; i += 1) {
      if (value <= keys[i].time) {
        var span = keys[i].time - keys[i - 1].time;
        var t = span > 0 ? (value - keys[i - 1].time) / span : 0;
        return keys[i - 1].value + (keys[i].value - keys[i - 1].value) * t;
      }
    }
    return keys[keys.length - 1].value;
  }

  function layoutSpectrum() {
    if (!spectrumInfo || !spectrumLayer) return;
    var entry = state.layout && state.layout[spectrumInfo.node];
    if (!entry) return;
    var meta = spectrumInfo;
    var count = meta.bar_amount || 0;
    var scale = entry.scale || 1;
    var spacing = (meta.bar_x_spacing || 0) * scale;
    var width = Math.max(1, (meta.bar_x_scale || 1) * scale);
    var total = Math.max(width, (count - 1) * spacing + width);
    var maxHeight = Math.max(1, (meta.bar_y_scale || 1) * scale);
    spectrumLayer.style.left = (entry.center[0] - total / 2) + "px";
    spectrumLayer.style.top = (STAGE_H - entry.center[1] - maxHeight) + "px";
    spectrumLayer.style.width = total + "px";
    spectrumLayer.style.height = maxHeight + "px";
    spectrumBars.forEach(function (bar, index) {
      bar.style.left = (index * spacing) + "px";
      bar.style.width = width + "px";
    });
  }

  function startSpectrum(meta) {
    stopSpectrum();
    if (!meta || !meta.bar_amount) return;
    spectrumInfo = meta;
    spectrumValues = new Array(meta.bar_amount).fill(0);
    spectrumLayer = el("layer spectrum");
    spectrumLayer.style.zIndex = "45";
    spectrumLayer.style.pointerEvents = "none";
    for (var i = 0; i < meta.bar_amount; i += 1) {
      var bar = document.createElement("div");
      bar.className = "spectrum-bar";
      spectrumLayer.appendChild(bar);
      spectrumBars.push(bar);
    }
    stage.appendChild(spectrumLayer);
    layoutSpectrum();
    spectrumFrame = requestAnimationFrame(tickSpectrum);
  }

  function stopSpectrum() {
    if (spectrumFrame) cancelAnimationFrame(spectrumFrame);
    spectrumFrame = 0;
    if (spectrumLayer && spectrumLayer.parentNode) spectrumLayer.remove();
    spectrumLayer = null;
    spectrumBars = [];
    spectrumValues = [];
    spectrumInfo = null;
  }

  function tickSpectrum(now) {
    if (!spectrumInfo || !spectrumLayer) return;
    var meta = spectrumInfo;
    var mixer = state.mixer;
    var playing = !!(mixer && mixer.tracks.some(function (record) {
      return record.started && !record.element.paused;
    }));
    var audible = !!(mixer && mixer.tracks.some(function (record) {
      return record.started && !record.element.paused && record.volume > 0.001;
    }));
    var fft = null;
    if (mixer && mixer.analyser) {
      fft = new Uint8Array(mixer.analyser.frequencyBinCount);
      mixer.analyser.getByteFrequencyData(fft);
    }
    var time = now / 1000;
    var count = meta.bar_amount;
    var minScale = meta.bar_min_y_scale || 0;
    var maxHeight = (meta.bar_y_scale || 1) * ((state.layout[meta.node] || {}).scale || 1);
    for (var i = 0; i < count; i += 1) {
      var target = 0;
      if (fft && playing && audible) {
        var position = count > 1 ? i / (count - 1) : 0;
        var bin = meta.use_logarithmic_frequency
          ? Math.round(Math.pow(2, position * Math.log2(fft.length)) - 1)
          : Math.round(position * (fft.length - 1));
        bin = Math.max(0, Math.min(fft.length - 1, bin));
        target = fft[bin] / 255;
        if (meta.multiply_by_frequency) target *= 0.35 + 0.65 * (1 - position);
      } else if (playing && audible) {
        // file:// cannot feed local media into Web Audio; this is a
        // reconstruction shaped like a batá spectrum, not an FFT of the stems.
        var x = count > 1 ? i / (count - 1) : 0;
        target = 0.12 +
          0.46 * Math.abs(Math.sin(time * 2.3 + i * 0.68)) * (1 - 0.35 * x) +
          0.28 * Math.abs(Math.sin(time * 5.1 + i * 1.73)) * (0.4 + 0.6 * Math.sin(Math.PI * x));
        target = Math.min(1, target);
      }
      var old = spectrumValues[i] || 0;
      var damp = target > old ? (meta.attack_damp || 0.25) : (meta.decay_damp || 0.25);
      var mix = Math.min(0.95, Math.max(0.02, 1 - damp));
      var value = old + (target - old) * mix;
      spectrumValues[i] = value;
      var bar = spectrumBars[i];
      var fraction = Math.min(1, Math.max(0, value));
      bar.style.height = Math.max(1, (minScale + (1 - minScale) * fraction) * maxHeight) + "px";
      bar.style.bottom = "0px";
      if (meta.use_color_gradient) {
        var t = Math.min(1, Math.max(0, curveAt(meta.color_curve, fraction * 1.5)));
        var a = meta.color_min || [1, 1, 1, 1];
        var b = meta.color_max || a;
        bar.style.backgroundColor = "rgba(" +
          Math.round((a[0] + (b[0] - a[0]) * t) * 255) + "," +
          Math.round((a[1] + (b[1] - a[1]) * t) * 255) + "," +
          Math.round((a[2] + (b[2] - a[2]) * t) * 255) + "," +
          Math.round((a[3] + (b[3] - a[3]) * t) * 255) + ")";
      }
    }
    spectrumFrame = requestAnimationFrame(tickSpectrum);
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
    var menuHit = el("el hit", [0, 0, 10, 10]);
    menuHit.addEventListener("click", showOverlay);
    stage.appendChild(menuHit);
    placed.push({ node: null, el: menuHit, menu: true });
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
    spectrum: function () {
      return {
        bars: spectrumBars.length,
        values: spectrumValues.slice(),
        node: spectrumInfo ? spectrumInfo.node : null,
        heights: spectrumBars.map(function (bar) { return parseFloat(bar.style.height) || 0; })
      };
    },
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
