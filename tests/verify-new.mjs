/* Behavioural verification of the modern layout (index.html).
 *
 * Opens the page over file:// and over HTTP, walks the library, exercises the
 * integrity load gate, seek bar, verified player, resource teardown and
 * layouts, sweeps the lessons, and writes screenshots plus JSON reports.
 *
 *   cd tests && node verify-new.mjs                  # Chromium, full sweep
 *   BROWSER=firefox node verify-new.mjs              # representative lessons
 *   BROWSER=webkit node verify-new.mjs
 */
import { chromium, firefox, webkit } from "playwright";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import vm from "vm";
import zlib from "zlib";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageUrl = "file://" + root + "/index.html";
const browserName = process.env.BROWSER || "chromium";
const engines = { chromium, firefox, webkit };
const engine = engines[browserName];
if (!engine) throw new Error("Unknown BROWSER=" + browserName);
const fullSweep = browserName === "chromium" || process.env.FULL_SWEEP === "1";
const shots = path.join(root, ".work/screenshots-new", browserName);
const reportFile = path.join(root, ".work/verification/new-ui-report-" + browserName + ".json");
const summaryFile = browserName === "chromium"
  ? path.join(root, "docs/verification/new-ui-sweep-summary.json")
  : path.join(root, ".work/verification/new-ui-sweep-" + browserName + ".json");
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(path.dirname(reportFile), { recursive: true });

const checks = [];
const problems = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  if (!ok) problems.push(name + (detail ? " (" + detail + ")" : ""));
}

function loadData(file) {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  return context.window.BATAPP;
}

// --- static data checks ----------------------------------------------------
const full = loadData("js/data.js");
const slim = loadData("js/lessons.js");
function projectLesson(lesson) {
  return {
    slug: lesson.slug,
    volume: lesson.volume,
    number: lesson.number,
    title: lesson.title,
    tracks: lesson.tracks.map((track) => ({
      object: track.object,
      stem: track.stem,
      clip: track.clip,
      volume: track.stem === "vox" ? 1 : track.volume,
      loop: track.loop,
      play_on_awake: track.play_on_awake
    })),
    audio: lesson.audio.map((entry) => ({
      stem: entry.stem,
      path: entry.path,
      clip_name: entry.clip_name,
      seconds: entry.seconds
    }))
  };
}
function coreLessons(lessons) {
  return lessons.map((lesson) => ({
    ...projectLesson(lesson),
    audio: lesson.audio.map((entry) => ({
      stem: entry.stem,
      path: entry.path,
      clip_name: entry.clip_name,
      seconds: entry.seconds
    }))
  }));
}
check("slim lessons match the full data (with modern Vox at 100%)",
  JSON.stringify(coreLessons(slim.lessons)) === JSON.stringify(coreLessons(full.lessons)),
  "slim=" + slim.lessons.length + " full=" + full.lessons.length);

const integrityProblems = [];
for (const lesson of slim.lessons) {
  for (const entry of lesson.audio) {
    const file = path.join(root, "assets/audio", entry.path);
    if (!fs.existsSync(file)) {
      integrityProblems.push(entry.path + ": missing");
      continue;
    }
    const bytes = fs.readFileSync(file);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const crc32 = (zlib.crc32(bytes) >>> 0).toString(16).padStart(8, "0");
    if (entry.bytes !== bytes.length) integrityProblems.push(entry.path + ": bytes");
    if (entry.sha256 !== sha256) integrityProblems.push(entry.path + ": sha256");
    if (entry.crc32 !== crc32) integrityProblems.push(entry.path + ": crc32");
  }
}
check("every slim stem carries a matching byte count, SHA-256 and CRC-32",
  integrityProblems.length === 0, integrityProblems.slice(0, 3).join(", "));

const slimBytes = fs.statSync(path.join(root, "js/lessons.js")).size;
check("slim modern data stays compact", slimBytes < 200000, slimBytes + " bytes");
const modernHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const legacyHtml = fs.readFileSync(path.join(root, "index_old.html"), "utf8");
check("modern page loads lessons.js, wav.js and the new player only",
  modernHtml.includes("js/lessons.js") && modernHtml.includes("js/wav.js") &&
  modernHtml.includes("js/player.js") &&
  !modernHtml.includes("js/data.js") && !modernHtml.includes("js/mixer.js"));
check("modern assets are cache-versioned",
  /app-new\.css\?v=/.test(modernHtml) && /lessons\.js\?v=/.test(modernHtml) &&
  /wav\.js\?v=/.test(modernHtml) && /newapp\.js\?v=/.test(modernHtml) &&
  /player\.js\?v=/.test(modernHtml));
check("legacy page keeps the full data.js and old mixer",
  legacyHtml.includes("js/data.js") && legacyHtml.includes("js/mixer.js") &&
  !legacyHtml.includes("js/lessons.js"));

const versionMatch = modernHtml.match(/<meta name="batapp-version" content="([^"]+)">/);
const appVersion = versionMatch ? versionMatch[1] : "";
const manifestVersion = JSON.parse(fs.readFileSync(path.join(root, "site.webmanifest"), "utf8"));
check("the single app version is tag-shaped", /^v\d+\.\d+\.\d+$/.test(appVersion), appVersion);
check("PWA manifest carries the same version and a versioned start_url",
  !!versionMatch && manifestVersion.version === appVersion &&
  manifestVersion.start_url === "./?v=" + appVersion,
  JSON.stringify({ page: appVersion, manifest: manifestVersion.version, start_url: manifestVersion.start_url }));
check("both pages use one release query",
  modernHtml.includes("js/player.js?v=" + (versionMatch ? versionMatch[1] : "")) &&
  legacyHtml.includes("js/mixer.js?v=" + (versionMatch ? versionMatch[1] : "")) &&
  legacyHtml.includes("app.css?v=" + (versionMatch ? versionMatch[1] : "")),
  JSON.stringify({ modern: /v=[\d.]+/.exec(modernHtml), legacy: /v=[\d.]+/.exec(legacyHtml) }));

const iconFiles = [
  "assets/icon.svg", "assets/icon-16.png", "assets/icon-32.png",
  "assets/icon-180.png", "assets/icon-192.png", "assets/icon-512.png",
  "site.webmanifest"
];
const missingIcons = iconFiles.filter((file) => !fs.existsSync(path.join(root, file)));
check("icon set and manifest exist", missingIcons.length === 0, missingIcons.join(", "));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "site.webmanifest"), "utf8"));
check("manifest lists the 192 and 512 icons",
  manifest.icons.some((icon) => icon.sizes === "192x192") &&
  manifest.icons.some((icon) => icon.sizes === "512x512"),
  JSON.stringify(manifest.icons));
const pngHeader = fs.readFileSync(path.join(root, "assets/icon-32.png")).subarray(1, 4).toString();
check("icon PNGs are valid", pngHeader === "PNG", pngHeader);

// --- browser ---------------------------------------------------------------
const browser = await engine.launch(browserName === "chromium"
  ? { args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] }
  : {});
const viewport = { width: 390, height: 844 };
const page = await browser.newPage({ viewport });
const external = [];
const pageErrors = [];
page.on("request", (request) => {
  const url = request.url();
  if (!url.startsWith("file:") && !url.startsWith("data:")) external.push(url);
});
page.on("console", (message) => {
  if (message.type() === "error") pageErrors.push(message.text().slice(0, 200));
});
page.on("pageerror", (error) => pageErrors.push("pageerror: " + error.message.slice(0, 200)));
page.on("requestfailed", (request) => {
  pageErrors.push("requestfailed: " + request.url().split("/").slice(-2).join("/"));
});

async function shot(name) {
  await page.screenshot({ path: path.join(shots, name + ".png") });
}
async function go(hash, wait = 500) {
  await page.goto(pageUrl + hash);
  await page.waitForTimeout(wait);
}
async function ready(scope = page) {
  await scope.waitForFunction(
    () => {
      const state = window.__batapp_new.state();
      const tracks = window.__batapp_new.tracks();
      return state.lesson && !state.loading && tracks.length > 0 &&
        tracks.every((track) => track.duration > 1 || track.error);
    },
    null,
    { timeout: 25000 }
  );
}
async function stepSpeed(scope, delta, times = 1) {
  await scope.evaluate(({ delta, times }) => {
    const button = document.querySelector('.speed-step[data-delta="' + delta + '"]');
    for (let index = 0; index < times; index += 1) button.click();
  }, { delta, times });
}

/* Count real media elements, contexts, seeks and play/pause calls. */
function installMediaProbe() {
  window.__mediaProbe = { audios: [], plays: 0, pauses: 0, contexts: 0, seeks: [] };
  const Native = window.Audio;
  window.Audio = function (src) {
    const audio = new Native(src);
    audio.__probeStem = (src || "").split("/").slice(-1)[0];
    window.__mediaProbe.audios.push(audio);
    return audio;
  };
  window.Audio.prototype = Native.prototype;
  const NativeContext = window.AudioContext || window.webkitAudioContext;
  if (NativeContext) {
    const CountingContext = function () {
      window.__mediaProbe.contexts += 1;
      const context = new NativeContext();
      window.__mediaProbe.context = context;
      return context;
    };
    CountingContext.prototype = NativeContext.prototype;
    window.AudioContext = CountingContext;
    if (window.webkitAudioContext) window.webkitAudioContext = CountingContext;
  }
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    window.__mediaProbe.plays += 1;
    return nativePlay.call(this);
  };
  const nativePause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function () {
    window.__mediaProbe.pauses += 1;
    return nativePause.call(this);
  };
  const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
  if (descriptor && descriptor.get && descriptor.set) {
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: function () { return descriptor.get.call(this); },
      set: function (value) {
        window.__mediaProbe.seeks.push({ value: Number(value), at: performance.now() });
        return descriptor.set.call(this, value);
      }
    });
  }
  window.__mediaProbeSummary = function () {
    const audios = window.__mediaProbe.audios;
    return {
      created: audios.length,
      active: audios.filter((audio) => !audio.paused).length,
      loops: audios.map((audio) => audio.loop),
      rates: Array.from(new Set(audios.map((audio) => audio.playbackRate))),
      stems: audios.map((audio) => audio.__probeStem),
      plays: window.__mediaProbe.plays,
      pauses: window.__mediaProbe.pauses,
      contexts: window.__mediaProbe.contexts,
      seeks: window.__mediaProbe.seeks.slice()
    };
  };
}

// --- library ---------------------------------------------------------------
await go("#/");
await shot("01-library-toques");
let ui = await page.evaluate(() => window.__batapp_new.ui());
check("library renders two volume tabs", ui.tabs === 2, ui.tabs + " tabs");
check("root page title", ui.documentTitle === "Batá · Toques & Oru Seco", ui.documentTitle);
let rows = await page.locator(".row").count();
check("Toques lists 38 rhythms", rows === 38, rows + " rows");
const first = await page.locator(".row .name").first().textContent();
check("first toque is Alubanche", first.trim() === "Alubanche", first.trim());
const toqueOrder = await page.locator(".row .num").allTextContents();
check("Toques follows lesson order 01…38",
  toqueOrder[0] === "01" && toqueOrder[9] === "10" && toqueOrder[toqueOrder.length - 1] === "38" &&
  toqueOrder.join(",") === Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, "0")).join(","),
  toqueOrder.join(","));
const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
check("library has no horizontal overflow at 390px", fits);
const fills = await page.evaluate(() => document.getElementById("app").getBoundingClientRect().height >= window.innerHeight - 1);
check("app column fills the phone viewport", fills);
const startup = await browser.newPage({ viewport });
await startup.addInitScript(installMediaProbe);
const startupRequests = [];
startup.on("request", (request) => {
  if (request.url().includes("/assets/audio/")) startupRequests.push(request.url());
});
await startup.goto(pageUrl + "#/");
await startup.waitForTimeout(500);
const startupProbe = await startup.evaluate(() => ({
  media: window.__mediaProbeSummary(),
  state: window.__batapp_new.state()
}));
check("opening the library creates no audio element, context or request",
  startupProbe.media.created === 0 && startupProbe.media.contexts === 0 &&
  startupRequests.length === 0 && startupProbe.state.stems.length === 0,
  JSON.stringify({ media: { created: startupProbe.media.created, contexts: startupProbe.media.contexts }, requests: startupRequests }));
await startup.close();

const iconLinks = await page.evaluate(() =>
  Array.from(document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]'))
    .map((link) => link.getAttribute("href").split("?")[0]));
check("modern page links the icon set",
  iconLinks.includes("assets/icon.svg") && iconLinks.includes("assets/icon-32.png") &&
  iconLinks.includes("assets/icon-180.png") && iconLinks.includes("site.webmanifest"),
  iconLinks.join(", "));

await page.locator("#app-info-button").click();
await page.waitForTimeout(250);
const infoPanel = await page.evaluate(() => ({
  hidden: document.getElementById("app-info-panel").hidden,
  text: document.getElementById("app-info-panel").innerText,
  expanded: document.getElementById("app-info-button").getAttribute("aria-expanded"),
  build: window.__batapp_new.state().build
}));
check("app menu shows exactly one version and no script-version rows",
  !infoPanel.hidden && infoPanel.expanded === "true" &&
  infoPanel.build === appVersion &&
  infoPanel.text.split(appVersion).length - 1 === 1 &&
  infoPanel.text.indexOf("Version") >= 0 &&
  infoPanel.text.indexOf("Screen awake") >= 0 &&
  infoPanel.text.indexOf("Loaded build") < 0 &&
  infoPanel.text.indexOf("Manifest") < 0 &&
  infoPanel.text.indexOf("Lessons data") < 0 &&
  infoPanel.text.indexOf("WAV encoder") < 0 &&
  infoPanel.text.indexOf("New app runtime") < 0,
  JSON.stringify(infoPanel));
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
check("Escape closes the app menu",
  await page.evaluate(() => document.getElementById("app-info-panel").hidden));

await page.locator(".tab").nth(1).click();
await page.waitForTimeout(300);
rows = await page.locator(".row").count();
check("Oru Seco lists 23 lessons", rows === 23, rows + " rows");
check("Oru Seco tab title", (await page.evaluate(() => window.__batapp_new.ui())).documentTitle === "Oru Seco · Batá",
  await page.evaluate(() => document.title));
const oruOrder = await page.locator(".row .num").allTextContents();
check("Oru Seco follows natural lesson order 1, 2, … 20A, 20B, 21, 22",
  oruOrder.join(",") === "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20A,20B,21,22",
  oruOrder.join(","));
await shot("02-library-oru-seco");

// --- player ----------------------------------------------------------------
await go("#/lesson/volume-1/01-alubanche", 600);
await ready();
await shot("03-player-idle");
ui = await page.evaluate(() => window.__batapp_new.ui());
check("player shows the lesson title", ui.title === "Alubanche", ui.title);
check("lesson page title", ui.documentTitle === "Alubanche · Toque 01 · Batá", ui.documentTitle);
check("voiced toque gets five mixer rows", ui.rows === 5, ui.rows + " rows");
check("loading gate is gone and Play is enabled", !ui.loader && ui.playEnabled, JSON.stringify(ui));
check("speed control defaults to 100%",
  ui.speedValue === "100%", JSON.stringify(ui));
check("speed control has minus and plus buttons",
  (await page.locator(".speed-step").count()) === 2);
const speedPlacement = await page.evaluate(() => {
  const box = (selector) => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  };
  const speed = document.querySelector(".speed-controls");
  const mixer = document.querySelector(".mixer");
  return {
    transport: box(".transport"),
    speed: box(".speed-controls"),
    mixer: box(".mixer"),
    beforeMixer: !!(speed.compareDocumentPosition(mixer) & Node.DOCUMENT_POSITION_FOLLOWING),
    tempoRows: document.querySelectorAll(".tempo").length
  };
});
check("speed controls sit below Play and before the mixer",
  speedPlacement.speed.top >= speedPlacement.transport.bottom - 1 &&
  speedPlacement.speed.bottom <= speedPlacement.mixer.top + 1 &&
  speedPlacement.beforeMixer && speedPlacement.tempoRows === 0,
  JSON.stringify(speedPlacement));
const stopPlacement = await page.locator(".stop").evaluate((node) => {
  const box = node.getBoundingClientRect();
  const next = node.previousElementSibling.getBoundingClientRect();
  const transport = node.closest(".transport").getBoundingClientRect();
  return {
    width: box.width,
    height: box.height,
    afterNext: box.left >= next.right - 1,
    sameRow: Math.abs((box.top + box.bottom) / 2 - (next.top + next.bottom) / 2) < 2,
    insideTransport: box.left >= transport.left && box.right <= transport.right,
    stopRows: document.querySelectorAll(".stop-row").length
  };
});
check("Stop is a compact icon beside Next in the transport",
  stopPlacement.width >= 40 && stopPlacement.height >= 40 &&
  stopPlacement.afterNext && stopPlacement.sameRow &&
  stopPlacement.insideTransport && stopPlacement.stopRows === 0,
  JSON.stringify(stopPlacement));
const initial = await page.evaluate(() => window.__batapp_new.tracks());
check("Vox starts at 100%",
  initial.find((track) => track.stem === "vox").volume === 1,
  "vox=" + initial.find((track) => track.stem === "vox").volume);
check("all stems start at 100%",
  initial.every((track) => track.volume === 1),
  JSON.stringify(initial.map((track) => track.stem + "=" + track.volume)));
check("every stem loops, including Beat",
  initial.every((track) => track.loop === true),
  JSON.stringify(initial.map((track) => track.stem + ":loop=" + track.loop)));
const toqueStemOrder = await page.locator(".stem").evaluateAll((nodes) => nodes.map((node) => node.dataset.stem));
check("Toques mixer order is Beat, Vox, Iya, Itotele, Okonkolo",
  toqueStemOrder.join(",") === "beat,vox,iya,ito,oko", JSON.stringify(toqueStemOrder));

// Play: every stem advances, in sync, and the progress ring moves
await page.locator("button.play").click();
await page.waitForTimeout(1600);
const playing = await page.evaluate(() => window.__batapp_new.tracks());
const times = playing.map((track) => track.currentTime);
const spread = Math.max(...times) - Math.min(...times);
check("Play advances every stem", times.every((time) => time > 0.4), JSON.stringify(times.map((time) => +time.toFixed(2))));
check("stems stay in sync (<120 ms spread)", spread < 0.12, "spread=" + spread.toFixed(3) + "s");
const ring = await page.evaluate(() => window.__batapp_new.ui().ringOffset);
check("progress ring advances while playing", Number(ring) >= 0 && Number(ring) < 326.7, "offset=" + ring);
await shot("04-player-playing");

// Pause, seek while paused, resume
await page.locator("button.play").click();
await page.waitForTimeout(300);
check("Pause pauses every stem", await page.evaluate(() => window.__batapp_new.tracks().every((track) => track.paused)));
await page.locator(".seek-input").evaluate((input) => {
  input.value = "10";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(350);
const seeked = await page.evaluate(() => window.__batapp_new.tracks());
const seekTimes = seeked.map((track) => track.currentTime);
check("seek moves every stem to 10 s",
  seekTimes.every((time) => Math.abs(time - 10) < 0.3),
  JSON.stringify(seekTimes.map((time) => +time.toFixed(2))));
check("seek keeps the stems together",
  Math.max(...seekTimes) - Math.min(...seekTimes) < 0.12,
  "spread=" + (Math.max(...seekTimes) - Math.min(...seekTimes)).toFixed(3));
check("seek time label follows",
  (await page.locator(".time.current").textContent()).trim() === "0:10",
  await page.locator(".time.current").textContent());
await page.locator("button.play").click();
await page.waitForTimeout(500);
const resumed = await page.evaluate(() => window.__batapp_new.tracks().map((track) => track.currentTime));
check("Play resumes from the seek point", resumed.every((time) => time > 9.5), JSON.stringify(resumed.map((time) => +time.toFixed(2))));

// Dragging the seek bar keeps the current audio running; release rebuilds the
// media generation at the new position (file:// path).
const dragStart = await page.evaluate(() => ({
  times: window.__batapp_new.tracks().map((track) => track.currentTime),
  playing: window.__batapp_new.state().playing
}));
await page.locator(".seek-input").evaluate((input) => {
  input.value = "20";
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(500);
const dragDuring = await page.evaluate(() => ({
  times: window.__batapp_new.tracks().map((track) => track.currentTime),
  tracks: window.__batapp_new.tracks(),
  playing: window.__batapp_new.state().playing
}));
check("dragging the seek bar keeps file playback running",
  dragStart.playing && dragDuring.playing &&
  dragDuring.tracks.every((track) => !track.paused) &&
  dragDuring.times.every((time, index) => time > dragStart.times[index] + 0.2),
  JSON.stringify({ start: dragStart.times.map((time) => +time.toFixed(2)), during: dragDuring.times.map((time) => +time.toFixed(2)) }));
await page.locator(".seek-input").evaluate((input) => {
  input.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(700);
const dragAfter = await page.evaluate(() => window.__batapp_new.tracks());
check("releasing the seek bar restarts at the new point",
  dragAfter.every((track) => !track.paused && track.currentTime >= 19.9 && track.currentTime < 22) &&
  Math.max(...dragAfter.map((track) => track.currentTime)) -
    Math.min(...dragAfter.map((track) => track.currentTime)) < 0.12,
  JSON.stringify(dragAfter.map((track) => +track.currentTime.toFixed(2))));

// Near-end starts must rebuild, align and play every stem every time.
const nearEndDuration = await page.evaluate(() => window.__batapp_new.state().duration);
for (let round = 1; round <= 2; round += 1) {
  for (const offset of [0.01, 0.1, 0.5, 1]) {
    await page.locator(".seek-input").evaluate((input, value) => {
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, nearEndDuration - offset);
    await page.waitForTimeout(700);
    const nearEnd = await page.evaluate(() => ({
      state: window.__batapp_new.state(),
      tracks: window.__batapp_new.tracks()
    }));
    check(`file:// near-end seek ${round}:${offset}s starts every stem`,
      nearEnd.state.playing && nearEnd.state.mixerPlaying &&
      nearEnd.tracks.every((track) => !track.paused && !track.ended),
      JSON.stringify({ offset, state: nearEnd.state, tracks: nearEnd.tracks.map((track) => ({ stem: track.stem, t: +track.currentTime.toFixed(2), paused: track.paused })) }));
  }
}

// Volume slider + fill
await page.locator(".stem[data-stem='iya'] input").evaluate((input) => {
  input.value = "30";
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
let iya = await page.evaluate(() => window.__batapp_new.tracks().find((track) => track.stem === "iya"));
check("slider sets that stem's volume", Math.abs(iya.volume - 0.3) < 0.02, "iya=" + iya.volume);
const fill = await page.locator(".stem[data-stem='iya'] input").evaluate((input) => input.style.getPropertyValue("--fill"));
check("slider fill reflects the value", fill.indexOf("30") === 0, "--fill=" + fill);

// Mute: silences without losing the slider value
await page.locator(".stem[data-stem='iya'] .mute").click();
iya = await page.evaluate(() => window.__batapp_new.tracks().find((track) => track.stem === "iya"));
check("mute silences the stem", iya.muted === true && iya.effective === 0, JSON.stringify(iya));
check("mute preserves the slider value", Math.abs(iya.volume - 0.3) < 0.02, "stored=" + iya.volume);
check("muted row is marked", await page.locator(".stem[data-stem='iya']").evaluate((row) => row.classList.contains("muted")));
await shot("05-player-muted");
await page.locator(".stem[data-stem='iya'] .mute").click();
iya = await page.evaluate(() => window.__batapp_new.tracks().find((track) => track.stem === "iya"));
check("unmute restores the level", iya.muted === false && Math.abs(iya.effective - 0.3) < 0.02, JSON.stringify(iya));

// Stop
await page.locator(".stop").click();
await page.waitForTimeout(400);
check("Stop rewinds every stem", await page.evaluate(() => window.__batapp_new.tracks().every((track) => track.currentTime < 0.25)));
check("Stop resets the seek label", (await page.locator(".time.current").textContent()).trim() === "0:00");

// Speed buttons: holding keeps the current audio running; release applies one
// 1% step and rebuilds every stem at the current position.
const plusBox = await page.locator('.speed-step[data-delta="1"]').boundingBox();
await page.locator("button.play").click();
await page.waitForTimeout(700);
const beforeHold = await page.evaluate(() => ({
  state: window.__batapp_new.state(),
  tracks: window.__batapp_new.tracks()
}));
await page.mouse.move(plusBox.x + plusBox.width / 2, plusBox.y + plusBox.height / 2);
await page.mouse.down();
await page.waitForTimeout(600);
const whileHeld = await page.evaluate(() => ({
  state: window.__batapp_new.state(),
  tracks: window.__batapp_new.tracks()
}));
check("holding + keeps playback running without changing speed",
  beforeHold.state.playing && whileHeld.state.playing &&
  whileHeld.state.rate === 1 &&
  whileHeld.tracks.every((track) => !track.paused) &&
  whileHeld.state.position > beforeHold.state.position + 0.3,
  JSON.stringify({ before: beforeHold.state.position, held: whileHeld.state.position, rate: whileHeld.state.rate }));
await page.mouse.up();
await page.waitForTimeout(800);
const afterHold = await page.evaluate(() => ({
  state: window.__batapp_new.state(),
  tracks: window.__batapp_new.tracks(),
  ui: window.__batapp_new.ui()
}));
check("releasing + applies 1% to every stem and keeps the position",
  afterHold.state.rate === 1.01 && afterHold.ui.speedValue === "101%" &&
  afterHold.tracks.every((track) => Math.abs(track.rate - 1.01) < 0.001) &&
  afterHold.tracks.every((track) => !track.paused) &&
  afterHold.state.position > whileHeld.state.position - 0.3 &&
  afterHold.state.position < whileHeld.state.position + 1.5,
  JSON.stringify({ rate: afterHold.state.rate, speed: afterHold.ui.speedValue, before: whileHeld.state.position, after: afterHold.state.position }));
check("speed changes preserve the recorded pitch",
  afterHold.tracks.every((track) => track.preservesPitch === true),
  JSON.stringify(afterHold.tracks.map((track) => track.stem + "=" + track.preservesPitch)));
await stepSpeed(page, -1);
await page.waitForTimeout(500);
check("minus returns to 100%",
  (await page.evaluate(() => window.__batapp_new.state().rate)) === 1 &&
  (await page.evaluate(() => window.__batapp_new.ui().speedValue)) === "100%",
  await page.evaluate(() => JSON.stringify(window.__batapp_new.ui())));

// Boundaries and rate-aware clock.
await page.locator(".stop").click();
await page.waitForTimeout(300);
await stepSpeed(page, 1, 60);
const topSpeed = await page.evaluate(() => ({
  state: window.__batapp_new.state(),
  ui: window.__batapp_new.ui(),
  plusDisabled: document.querySelector('.speed-step[data-delta="1"]').disabled,
  minusDisabled: document.querySelector('.speed-step[data-delta="-1"]').disabled
}));
check("plus stops at 150% and disables itself",
  topSpeed.state.rate === 1.5 && topSpeed.ui.speedValue === "150%" &&
  topSpeed.plusDisabled && !topSpeed.minusDisabled,
  JSON.stringify(topSpeed));
await page.locator("button.play").click();
await page.waitForTimeout(1400);
const fast = await page.evaluate(() => window.__batapp_new.state());
check("150% advances the shared clock at 1.5x",
  fast.rate === 1.5 && fast.position > 1.6 && fast.position < 2.5,
  JSON.stringify(fast));
await page.locator(".stop").click();
await page.waitForTimeout(300);

await stepSpeed(page, -1, 110);
const bottomSpeed = await page.evaluate(() => ({
  state: window.__batapp_new.state(),
  ui: window.__batapp_new.ui(),
  plusDisabled: document.querySelector('.speed-step[data-delta="1"]').disabled,
  minusDisabled: document.querySelector('.speed-step[data-delta="-1"]').disabled
}));
check("minus stops at 50% and disables itself",
  bottomSpeed.state.rate === 0.5 && bottomSpeed.ui.speedValue === "50%" &&
  bottomSpeed.minusDisabled && !bottomSpeed.plusDisabled,
  JSON.stringify(bottomSpeed));

// The loop timer follows the speed too: at 50%, one second of media takes two
// seconds of wall time, so the shared rewind must not fire early.
const loopDuration = await page.evaluate(() => window.__batapp_new.state().duration);
await page.locator(".seek-input").evaluate((input, value) => {
  input.value = String(value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}, loopDuration - 1);
await page.waitForTimeout(350);
await page.locator("button.play").click();
await page.waitForTimeout(1200);
const slowLoopEarly = await page.evaluate(() => window.__batapp_new.tracks().map((track) => track.currentTime));
check("50% loop does not rewind before the media reaches the end",
  slowLoopEarly.every((time) => time > loopDuration - 0.7),
  JSON.stringify({ duration: loopDuration, times: slowLoopEarly.map((time) => +time.toFixed(2)) }));
await page.waitForTimeout(1200);
const slowLoopWrapped = await page.evaluate(() => window.__batapp_new.tracks().map((track) => track.currentTime));
check("50% loop rewinds together after the rate-adjusted boundary",
  slowLoopWrapped.every((time) => time < 1) &&
  Math.max(...slowLoopWrapped) - Math.min(...slowLoopWrapped) < 0.12,
  JSON.stringify(slowLoopWrapped.map((time) => +time.toFixed(2))));

await page.locator(".stop").click();
await page.waitForTimeout(300);
await stepSpeed(page, 1, 50);
check("100% restores the original speed",
  (await page.evaluate(() => window.__batapp_new.state().rate)) === 1 &&
  (await page.evaluate(() => window.__batapp_new.ui().speedValue)) === "100%");

// Prev / Next (Stop is the third ghost; navigation is the first two)
await stepSpeed(page, -1, 25);
const ghosts = page.locator(".transport .ghost:not(.stop)");
check("Prev is disabled on the first lesson", await ghosts.nth(0).isDisabled());
await ghosts.nth(1).click();
await page.waitForTimeout(700);
await ready();
check("Next opens the next rhythm", (await page.evaluate(() => window.__batapp_new.state().lesson)) === "volume-1/02-tani-tani-cho-bi",
  await page.evaluate(() => window.__batapp_new.state().lesson));
check("selected speed follows the next rhythm",
  (await page.evaluate(() => window.__batapp_new.state().rate)) === 0.75 &&
  (await page.evaluate(() => window.__batapp_new.ui().speedValue)) === "75%",
  await page.evaluate(() => JSON.stringify(window.__batapp_new.ui())));
await page.locator(".transport .ghost:not(.stop)").nth(0).click();
await page.waitForTimeout(700);
await ready();
check("Prev steps back", (await page.evaluate(() => window.__batapp_new.state().lesson)) === "volume-1/01-alubanche",
  await page.evaluate(() => window.__batapp_new.state().lesson));
check("selected speed survives stepping back",
  (await page.evaluate(() => window.__batapp_new.state().rate)) === 0.75,
  await page.evaluate(() => window.__batapp_new.state().rate));
await stepSpeed(page, 1, 25);

// Keyboard
await page.evaluate(() => document.activeElement && document.activeElement.blur());
await page.keyboard.press("Space");
await page.waitForTimeout(400);
check("Space starts playback", await page.evaluate(() => window.__batapp_new.state().playing));
await page.keyboard.press("Space");
await page.waitForTimeout(300);
check("Space pauses playback", !(await page.evaluate(() => window.__batapp_new.state().playing)));
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check("Escape returns to the library", (await page.evaluate(() => window.__batapp_new.state().view)) === "library");

// --- screen wake lock while playing ----------------------------------------
const wake = await browser.newPage({ viewport });
await wake.bringToFront();
await wake.addInitScript(() => {
  window.__wakeLog = { requests: 0, releases: 0, active: 0 };
  const fakeWakeLock = {
    request: function () {
      window.__wakeLog.requests += 1;
      window.__wakeLog.active += 1;
      const sentinel = new EventTarget();
      sentinel.released = false;
      sentinel.release = function () {
        if (sentinel.released) return Promise.resolve();
        sentinel.released = true;
        window.__wakeLog.releases += 1;
        window.__wakeLog.active -= 1;
        sentinel.dispatchEvent(new Event("release"));
        return Promise.resolve();
      };
      return Promise.resolve(sentinel);
    }
  };
  try {
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: fakeWakeLock });
  } catch (error) {
    Object.defineProperty(Object.getPrototypeOf(navigator), "wakeLock",
      { configurable: true, value: fakeWakeLock });
  }
});
await wake.goto(pageUrl + "#/lesson/volume-1/01-alubanche");
await ready(wake);
await wake.locator("button.play").click();
await wake.waitForTimeout(700);
let wakeState = await wake.evaluate(() => ({
  log: window.__wakeLog,
  app: window.__batapp_new.state()
}));
check("playing requests a screen wake lock",
  wakeState.log.requests === 1 && wakeState.log.active === 1 &&
  wakeState.app.wakeLock === "active",
  JSON.stringify(wakeState));
await wake.locator("button.play").click();
await wake.waitForTimeout(300);
wakeState = await wake.evaluate(() => ({
  log: window.__wakeLog,
  app: window.__batapp_new.state()
}));
check("pausing releases the screen wake lock",
  wakeState.log.requests === 1 && wakeState.log.releases === 1 &&
  wakeState.log.active === 0 && wakeState.app.wakeLock === "off",
  JSON.stringify(wakeState));
await wake.locator("button.play").click();
await wake.waitForTimeout(400);
await wake.locator(".stop").click();
await wake.waitForTimeout(300);
wakeState = await wake.evaluate(() => ({
  log: window.__wakeLog,
  app: window.__batapp_new.state()
}));
check("Stop releases the screen wake lock",
  wakeState.log.requests === 2 && wakeState.log.releases === 2 &&
  wakeState.log.active === 0 && wakeState.app.wakeLock === "off",
  JSON.stringify(wakeState));
await wake.close();

// --- transport regression: pause → mute → play → backward seek ------------
const transport = await browser.newPage({ viewport });
await transport.bringToFront();
await transport.addInitScript(installMediaProbe);
await transport.goto(pageUrl + "#/lesson/volume-1/01-alubanche");
await transport.waitForFunction(
  () => window.__batapp_new && window.__batapp_new.state().lesson === "volume-1/01-alubanche" &&
    !window.__batapp_new.state().loading,
  null,
  { timeout: 25000 }
);
let media = await transport.evaluate(() => window.__mediaProbeSummary());
let generations = media.created;
check("one media element per stem", media.created === 5 && media.active === 0, JSON.stringify(media));
check("all five media elements loop", media.loops.length === 5 && media.loops.every(Boolean), JSON.stringify(media.loops));

await transport.locator("button.play").click();
await transport.waitForTimeout(900);
media = await transport.evaluate(() => window.__mediaProbeSummary());
check("transport plays exactly five elements at rate 1",
  media.created === 5 && media.active === 5 && media.rates.length === 1 && media.rates[0] === 1,
  JSON.stringify(media));

await transport.locator("button.play").click();
await transport.waitForTimeout(250);
await transport.locator(".stem[data-stem='iya'] .mute").click();
await transport.waitForTimeout(200);
await transport.locator("button.play").click();
await transport.waitForTimeout(700);
await transport.locator(".seek-input").evaluate((input) => {
  input.value = "2";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
});
await transport.waitForTimeout(500);
generations += 5; // seek release rebuilds the media generation
const sequence = await transport.evaluate(() => ({
  media: window.__mediaProbeSummary(),
  tracks: window.__batapp_new.tracks(),
  state: window.__batapp_new.state()
}));
check("pause + mute + play + backward seek keeps five active stems",
  sequence.media.created === generations && sequence.media.active === 5 &&
  sequence.media.rates.length === 1 && sequence.media.rates[0] === 1 &&
  sequence.state.mixerPlaying === true,
  JSON.stringify(sequence.media));
check("the backward seek lands every stem at ~2 s",
  sequence.tracks.every((track) => track.currentTime >= 1.9 && track.currentTime < 4) &&
  Math.max(...sequence.tracks.map((track) => track.currentTime)) -
    Math.min(...sequence.tracks.map((track) => track.currentTime)) < 0.12,
  JSON.stringify(sequence.tracks.map((track) => ({ stem: track.stem, t: +track.currentTime.toFixed(2) }))));
check("the mute survives the seek",
  sequence.tracks.find((track) => track.stem === "iya").muted === true);

// Cross the loop boundary after the same interactions.
const duration = await transport.evaluate(() => window.__batapp_new.tracks()[0].duration);
await transport.locator(".seek-input").evaluate((input, value) => {
  input.value = String(value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}, duration - 0.7);
generations += 5; // seek release rebuilds the media generation
await transport.waitForTimeout(300);
await transport.evaluate(() => { window.__mediaProbe.seeks = []; });
let wrappedConverged = true;
try {
  await transport.waitForFunction(() => {
    const times = window.__batapp_new.tracks().map((track) => track.currentTime);
    return times.every((time) => time < 2.5) &&
      Math.max(...times) - Math.min(...times) < 0.1;
  }, null, { timeout: 5000 });
} catch (error) {
  wrappedConverged = false;
}
const wrapped = await transport.evaluate(() => ({
  media: window.__mediaProbeSummary(),
  tracks: window.__batapp_new.tracks()
}));
const wrapTimes = wrapped.tracks.map((track) => track.currentTime);
const wrapSeeks = wrapped.media.seeks.slice(-5);
check("loop boundary keeps all five stems together",
  wrappedConverged &&
  wrapped.media.created === generations && wrapped.media.active === 5 && wrapped.media.loops.every(Boolean) &&
  wrapTimes.every((time) => time < 2.5) &&
  Math.max(...wrapTimes) - Math.min(...wrapTimes) < 0.12,
  JSON.stringify({ media: { created: wrapped.media.created, active: wrapped.media.active, loops: wrapped.media.loops }, times: wrapTimes.map((time) => +time.toFixed(2)) }));
check("loop restart rewinds every stem to zero together",
  wrapSeeks.length === 5 && wrapSeeks.every((seek) => seek.value === 0),
  JSON.stringify(wrapSeeks));

await transport.locator("button.play").click();
await transport.waitForTimeout(250);
await transport.locator(".stem[data-stem='vox'] .mute").click();
await transport.waitForTimeout(150);
await transport.locator("button.play").click();
await transport.waitForTimeout(700);
await transport.locator(".seek-input").evaluate((input) => {
  input.value = "3";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
});
await transport.waitForTimeout(500);
generations += 5; // seek release rebuilds the media generation
const afterWrap = await transport.evaluate(() => ({
  media: window.__mediaProbeSummary(),
  tracks: window.__batapp_new.tracks()
}));
const afterTimes = afterWrap.tracks.map((track) => track.currentTime);
check("pause + mute + backward seek after the loop keeps Beat playing",
  afterWrap.media.created === generations && afterWrap.media.active === 5 &&
  afterWrap.tracks.find((track) => track.stem === "beat").paused === false &&
  afterTimes.every((time) => time >= 2.9) &&
  Math.max(...afterTimes) - Math.min(...afterTimes) < 0.12,
  JSON.stringify({ media: afterWrap.media, times: afterTimes.map((time) => +time.toFixed(2)) }));

// Stop resets every stem; the next Play starts from the beginning.
await transport.locator(".stop").click();
await transport.waitForTimeout(400);
const stopped = await transport.evaluate(() => ({
  media: window.__mediaProbeSummary(),
  tracks: window.__batapp_new.tracks(),
  state: window.__batapp_new.state(),
  ui: window.__batapp_new.ui()
}));
check("Stop pauses and rewinds every stem to 0",
  stopped.media.created === generations && stopped.media.active === 0 &&
  stopped.tracks.every((track) => track.paused === true && track.currentTime < 0.1) &&
  stopped.state.playing === false && stopped.state.mixerPlaying === false &&
  stopped.ui.seekValue === "0",
  JSON.stringify({ media: stopped.media, tracks: stopped.tracks.map((track) => ({ stem: track.stem, ct: +track.currentTime.toFixed(2), paused: track.paused })), ui: stopped.ui.seekValue }));
await transport.locator("button.play").click();
await transport.waitForTimeout(900);
const restarted = await transport.evaluate(() => ({
  media: window.__mediaProbeSummary(),
  tracks: window.__batapp_new.tracks()
}));
const restartTimes = restarted.tracks.map((track) => track.currentTime);
check("Play after Stop starts every stem from the beginning",
  restarted.media.active === 5 &&
  restartTimes.every((time) => time >= 0.4 && time < 2) &&
  Math.max(...restartTimes) - Math.min(...restartTimes) < 0.12,
  JSON.stringify({ media: restarted.media, times: restartTimes.map((time) => +time.toFixed(2)) }));

// A play() promise that resolves after Stop must not start the stems again.
await transport.locator(".stop").click();
await transport.waitForTimeout(50);
await transport.locator("button.play").click();
await transport.waitForTimeout(100);
await transport.locator(".stop").click();
await transport.waitForTimeout(500);
const race = await transport.evaluate(() => ({
  media: window.__mediaProbeSummary(),
  tracks: window.__batapp_new.tracks(),
  state: window.__batapp_new.state(),
  ui: window.__batapp_new.ui()
}));
check("Stop wins against a pending Play",
  race.media.active === 0 &&
  race.tracks.every((track) => track.paused === true && track.currentTime < 0.1) &&
  race.state.playing === false && race.state.mixerPlaying === false &&
  race.ui.seekValue === "0",
  JSON.stringify({ media: race.media, tracks: race.tracks.map((track) => ({ stem: track.stem, ct: +track.currentTime.toFixed(2), paused: track.paused })), ui: race.ui.seekValue }));
await transport.locator("button.play").click();
await transport.waitForTimeout(800);
const afterRace = await transport.evaluate(() => ({
  media: window.__mediaProbeSummary(),
  tracks: window.__batapp_new.tracks()
}));
const afterRaceTimes = afterRace.tracks.map((track) => track.currentTime);
check("Play after the quick Stop starts at the beginning",
  afterRace.media.active === 5 &&
  afterRaceTimes.every((time) => time >= 0.4 && time < 1.5) &&
  Math.max(...afterRaceTimes) - Math.min(...afterRaceTimes) < 0.12,
  JSON.stringify({ media: afterRace.media, times: afterRaceTimes.map((time) => +time.toFixed(2)) }));
await transport.close();

// Volume II: four stems, no Vox row
await go("#/lesson/volume-2/1-elegba", 600);
await ready();
ui = await page.evaluate(() => window.__batapp_new.ui());
check("instrumental lesson gets four mixer rows", ui.rows === 4, ui.rows + " rows");
check("instrumental lesson has no Vox", !(await page.evaluate(() => window.__batapp_new.state().stems.includes("vox"))));
const oruStemOrder = await page.locator(".stem").evaluateAll((nodes) => nodes.map((node) => node.dataset.stem));
check("Oru Seco mixer order is Beat, Iya, Itotele, Okonkolo",
  oruStemOrder.join(",") === "beat,iya,ito,oko", JSON.stringify(oruStemOrder));

// --- no credit / external surface -----------------------------------------
const banned = /Bianconcini|batangoma|Buy the book|Where to buy|Libri Video|Amazon|iTunes|Apple music|Instagram|Facebook|YouTube/i;
const surface = [];
for (const hash of ["#/", "#/v/2", "#/lesson/volume-1/01-alubanche", "#/lesson/volume-2/1-elegba"]) {
  await go(hash, 500);
  const found = await page.evaluate((pattern) => {
    const match = document.body.innerText.match(new RegExp(pattern, "i"));
    const links = Array.from(document.querySelectorAll("a[href]")).map((anchor) => anchor.href);
    const sources = Array.from(document.querySelectorAll("[src], link[href]"))
      .map((node) => node.getAttribute("src") || node.getAttribute("href"))
      .filter((url) => /^https?:/i.test(url));
    return { hit: match ? match[0] : null, links: links.length, sources };
  }, banned.source);
  if (found.hit) surface.push(hash + " text:" + found.hit);
  if (found.links) surface.push(hash + " anchors:" + found.links);
  if (found.sources.length) surface.push(hash + " urls:" + found.sources.join(","));
}
check("no author/shop text, no links, no external URLs", surface.length === 0, surface.join(" | "));

// --- fixed portrait app shell ----------------------------------------------
const portraitSizes = [[390, 844], [375, 667], [360, 640], [320, 568], [414, 896]];
for (const [width, height] of portraitSizes) {
  const label = width + "x" + height;
  const page = await browser.newPage({ viewport: { width, height } });
  await page.bringToFront();
  await page.goto(pageUrl + "#/lesson/volume-1/01-alubanche");
  await ready(page);
  await page.waitForTimeout(400);
  const snap = await page.evaluate(() => {
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    };
    const main = document.getElementById("main-pane");
    const playerView = document.querySelector(".player-view");
    const mixer = document.querySelector(".mixer");
    const speed = document.querySelector(".speed-controls");
    return {
      app: box(document.getElementById("app")),
      menu: box(document.getElementById("app-info-button")),
      seek: box(document.querySelector(".seek")),
      speed: box(speed),
      mixer: box(mixer),
      beforeMixer: !!(speed.compareDocumentPosition(mixer) & Node.DOCUMENT_POSITION_FOLLOWING),
      transport: box(document.querySelector(".transport")),
      next: box(document.querySelectorAll(".transport .ghost")[1]),
      stop: box(document.querySelector(".stop")),
      rows: Array.from(document.querySelectorAll(".stem")).map(box),
      viewport: [window.innerWidth, window.innerHeight],
      scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      mainScroll: [main.scrollWidth, main.scrollHeight, main.clientWidth, main.clientHeight],
      playerScroll: [playerView.scrollWidth, playerView.scrollHeight, playerView.clientWidth, playerView.clientHeight],
      mixerScroll: [mixer.scrollWidth, mixer.scrollHeight, mixer.clientWidth, mixer.clientHeight]
    };
  });
  check(label + " portrait has no page scroll",
    snap.app.left === 0 && snap.app.right === snap.viewport[0] &&
    snap.app.top === 0 && snap.app.bottom === snap.viewport[1] &&
    snap.scroll[0] <= snap.viewport[0] && snap.scroll[1] <= snap.viewport[1],
    JSON.stringify({ app: snap.app, scroll: snap.scroll, viewport: snap.viewport }));
  check(label + " portrait player fits without internal scroll",
    snap.playerScroll[1] <= snap.playerScroll[3] + 1 &&
    snap.mixerScroll[1] <= snap.mixerScroll[3] + 1 &&
    snap.mainScroll[1] <= snap.mainScroll[3] + 1 &&
    snap.seek.top >= 0 && snap.seek.bottom <= snap.viewport[1] &&
    snap.speed.top >= snap.transport.bottom - 1 &&
    snap.speed.top >= 0 && snap.speed.bottom <= snap.viewport[1] &&
    snap.speed.bottom <= snap.mixer.top + 1 && snap.beforeMixer &&
    snap.stop.top >= 0 && snap.stop.bottom <= snap.viewport[1] &&
    snap.rows.length === 5 && snap.rows.every((row) =>
      row.top >= -1 && row.bottom <= snap.viewport[1] + 1),
    JSON.stringify({ player: snap.playerScroll, mixer: snap.mixerScroll, main: snap.mainScroll, seek: snap.seek, speed: snap.speed, mixerBox: snap.mixer, beforeMixer: snap.beforeMixer, stop: snap.stop, rows: snap.rows }));
  check(label + " portrait places Stop beside Next",
    snap.stop.left >= snap.next.right - 1 &&
    Math.abs((snap.stop.top + snap.stop.bottom) / 2 - (snap.next.top + snap.next.bottom) / 2) < 2 &&
    snap.stop.right <= snap.viewport[0],
    JSON.stringify({ transport: snap.transport, next: snap.next, stop: snap.stop }));
  check(label + " portrait keeps the app menu in the top-left safe area",
    snap.menu.left >= 0 && snap.menu.top >= 0 &&
    snap.menu.right <= 52 && snap.menu.bottom <= 52,
    JSON.stringify(snap.menu));
  if (label === "320x568") {
    await page.screenshot({ path: path.join(shots, "07-portrait-small.png") });
  }
  await page.close();
}

const portraitLibrary = await browser.newPage({ viewport: { width: 390, height: 844 } });
await portraitLibrary.bringToFront();
await portraitLibrary.goto(pageUrl + "#/v/1");
await portraitLibrary.waitForTimeout(500);
const portraitLibrarySnap = await portraitLibrary.evaluate(() => {
  const list = document.querySelector(".list");
  return {
    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    viewport: [window.innerWidth, window.innerHeight],
    listScroll: [list.scrollWidth, list.scrollHeight, list.clientWidth, list.clientHeight]
  };
});
check("portrait library does not scroll the page",
  portraitLibrarySnap.scroll[0] <= portraitLibrarySnap.viewport[0] &&
  portraitLibrarySnap.scroll[1] <= portraitLibrarySnap.viewport[1],
  JSON.stringify(portraitLibrarySnap));
check("portrait library scrolls only inside the lesson list",
  portraitLibrarySnap.listScroll[1] > portraitLibrarySnap.listScroll[3],
  JSON.stringify(portraitLibrarySnap.listScroll));
await portraitLibrary.close();

// --- mobile landscape ------------------------------------------------------
function landscapeSnapshot(page) {
  return page.evaluate(() => {
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const main = document.getElementById("main-pane");
    const playerView = document.querySelector(".player-view");
    const mixer = document.querySelector(".mixer");
    const speed = document.querySelector(".speed-controls");
    return {
      hero: box(document.querySelector(".hero")),
      transport: box(document.querySelector(".transport")),
      next: box(document.querySelectorAll(".transport .ghost")[1]),
      stop: box(document.querySelector(".stop")),
      mixer: box(mixer),
      seek: box(document.querySelector(".seek")),
      speed: box(speed),
      beforeMixer: !!(speed.compareDocumentPosition(mixer) & Node.DOCUMENT_POSITION_FOLLOWING),
      rows: Array.from(document.querySelectorAll(".stem")).map(box),
      app: box(document.getElementById("app")),
      viewport: [window.innerWidth, window.innerHeight],
      scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      mainScroll: [main.scrollWidth, main.scrollHeight, main.clientWidth, main.clientHeight],
      playerScroll: [playerView.scrollWidth, playerView.scrollHeight, playerView.clientWidth, playerView.clientHeight],
      mixerScroll: [mixer.scrollWidth, mixer.scrollHeight, mixer.clientWidth, mixer.clientHeight]
    };
  });
}

const landscapeSizes = [[844, 390], [740, 360], [667, 375], [568, 320], [480, 320]];
for (const [width, height] of landscapeSizes) {
  const label = width + "x" + height;
  const page = await browser.newPage({ viewport: { width, height } });
  await page.bringToFront();
  await page.goto(pageUrl + "#/lesson/volume-1/01-alubanche");
  await ready(page);
  await page.waitForTimeout(400);
  const snap = await landscapeSnapshot(page);
  check(label + " landscape has no page scroll",
    snap.app.left === 0 && snap.app.right === snap.viewport[0] &&
    snap.scroll[0] <= snap.viewport[0] && snap.scroll[1] <= snap.viewport[1],
    JSON.stringify({ app: snap.app, scroll: snap.scroll, viewport: snap.viewport }));
  check(label + " landscape player and mixer keep all content visible",
    snap.playerScroll[1] <= snap.playerScroll[3] + 1 &&
    snap.mixerScroll[1] <= snap.mixerScroll[3] + 1 &&
    snap.mainScroll[1] <= snap.mainScroll[3] + 1,
    JSON.stringify({ player: snap.playerScroll, mixer: snap.mixerScroll, main: snap.mainScroll }));
  check(label + " landscape shows the speed controls, seek bar and all mixer rows",
    snap.seek.top >= 0 && snap.seek.bottom <= snap.viewport[1] &&
    snap.speed.top >= snap.transport.bottom - 1 &&
    snap.speed.top >= 0 && snap.speed.bottom <= snap.viewport[1] &&
    snap.beforeMixer &&
    snap.rows.length === 5 && snap.rows.every((row) =>
      row.top >= -1 && row.bottom <= snap.viewport[1] + 1 &&
      row.left >= -1 && row.right <= snap.viewport[0] + 1),
    JSON.stringify({ seek: snap.seek, speed: snap.speed, transport: snap.transport, beforeMixer: snap.beforeMixer, rows: snap.rows }));
  check(label + " landscape places Stop beside Next in the transport",
    snap.stop.left >= snap.next.right - 1 &&
    Math.abs((snap.stop.top + snap.stop.bottom) / 2 - (snap.next.top + snap.next.bottom) / 2) < 2 &&
    snap.stop.left >= 0 && snap.stop.right <= snap.viewport[0] &&
    snap.stop.top >= 0 && snap.stop.bottom <= snap.viewport[1] &&
    snap.hero.right <= snap.mixer.left + 2,
    JSON.stringify({ transport: snap.transport, next: snap.next, stop: snap.stop, hero: snap.hero, mixer: snap.mixer }));
  if (label === "844x390") {
    await page.locator("button.play").click();
    await page.waitForTimeout(2200);
    const times = await page.evaluate(() => window.__batapp_new.tracks().map((track) => track.currentTime));
    check("landscape playback starts every stem together",
      times.every((time) => time > 0.3) && Math.max(...times) - Math.min(...times) < 0.12,
      JSON.stringify(times.map((time) => +time.toFixed(2))));
    await page.screenshot({ path: path.join(shots, "06-landscape-player.png") });
  }
  if (label === "568x320") {
    await page.screenshot({ path: path.join(shots, "07-landscape-player-small.png") });
  }
  await page.close();
}

// Library landscape: the page must not scroll; the lesson list may scroll
// inside its own pane because 38 rows cannot fit a short phone height.
const landscapeLibrary = await browser.newPage({ viewport: { width: 844, height: 390 } });
await landscapeLibrary.bringToFront();
await landscapeLibrary.goto(pageUrl + "#/v/1");
await landscapeLibrary.waitForTimeout(500);
const librarySnap = await landscapeLibrary.evaluate(() => {
  const lefts = Array.from(document.querySelectorAll(".row")).slice(0, 4)
    .map((row) => Math.round(row.getBoundingClientRect().left));
  const pane = document.getElementById("library-pane");
  return {
    columns: new Set(lefts).size,
    lefts,
    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    viewport: [window.innerWidth, window.innerHeight],
    paneScroll: [pane.scrollWidth, pane.scrollHeight, pane.clientWidth, pane.clientHeight]
  };
});
check("landscape library uses two columns", librarySnap.columns === 2, JSON.stringify(librarySnap.lefts));
check("landscape library does not scroll the page",
  librarySnap.scroll[0] <= librarySnap.viewport[0] &&
  librarySnap.scroll[1] <= librarySnap.viewport[1],
  JSON.stringify(librarySnap));
await landscapeLibrary.screenshot({ path: path.join(shots, "08-landscape-library.png") });
await landscapeLibrary.close();

// --- desktop ---------------------------------------------------------------
const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await desktop.bringToFront();
await desktop.goto(pageUrl + "#/");
await desktop.waitForTimeout(500);
const desktopEmpty = await desktop.evaluate(() => {
  const library = document.getElementById("library-pane").getBoundingClientRect();
  const main = document.getElementById("main-pane").getBoundingClientRect();
  return {
    library: { width: library.width, left: library.left },
    main: { width: main.width, left: main.left },
    empty: !!document.querySelector(".empty"),
    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    viewport: [window.innerWidth, window.innerHeight]
  };
});
check("desktop shows the library sidebar and main pane",
  desktopEmpty.library.width >= 340 && desktopEmpty.library.width <= 380 &&
  desktopEmpty.main.width > 800 && desktopEmpty.main.left >= desktopEmpty.library.width - 1,
  JSON.stringify(desktopEmpty));
check("desktop shows the empty state before a rhythm is selected", desktopEmpty.empty);
check("desktop layout has no page overflow",
  desktopEmpty.scroll[0] <= desktopEmpty.viewport[0] &&
  desktopEmpty.scroll[1] <= desktopEmpty.viewport[1],
  JSON.stringify(desktopEmpty.scroll));
await desktop.screenshot({ path: path.join(shots, "08-desktop-empty.png") });

await desktop.locator(".row").first().click();
await desktop.waitForTimeout(800);
await ready(desktop);
const desktopPlayer = await desktop.evaluate(() => {
  const library = document.getElementById("library-pane").getBoundingClientRect();
  const hero = document.querySelector(".hero").getBoundingClientRect();
  const mixer = document.querySelector(".mixer").getBoundingClientRect();
  const back = document.querySelector(".player-top .icon-btn");
  const speed = document.querySelector(".speed-controls");
  const speedBox = speed.getBoundingClientRect();
  const transportBox = document.querySelector(".transport").getBoundingClientRect();
  return {
    lesson: window.__batapp_new.state().lesson,
    active: window.__batapp_new.ui().active,
    libraryWidth: library.width,
    twoCols: hero.right <= mixer.left + 2,
    mixerRows: document.querySelectorAll(".stem").length,
    seek: !!document.querySelector(".seek"),
    speed: !!speed,
    speedBelowTransport: speedBox.top >= transportBox.bottom - 1,
    speedBeforeMixer: !!(speed.compareDocumentPosition(document.querySelector(".mixer")) &
      Node.DOCUMENT_POSITION_FOLLOWING),
    stopInTransport: !!document.querySelector(".transport .stop"),
    backVisible: !!(back && back.getClientRects().length),
    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    viewport: [window.innerWidth, window.innerHeight]
  };
});
check("desktop sidebar persists while a lesson is open", desktopPlayer.libraryWidth >= 340, desktopPlayer.libraryWidth + "px");
check("desktop marks the active sidebar row", desktopPlayer.active === "Alubanche", desktopPlayer.active);
check("desktop player shows hero and mixer side by side", desktopPlayer.twoCols, JSON.stringify(desktopPlayer));
check("desktop player has the seek bar and speed controls below Play",
  desktopPlayer.seek && desktopPlayer.speed &&
  desktopPlayer.speedBelowTransport && desktopPlayer.speedBeforeMixer,
  JSON.stringify(desktopPlayer));
check("desktop keeps Stop in the transport", desktopPlayer.stopInTransport);
check("desktop hides the back button", !desktopPlayer.backVisible);
check("desktop mixer has five rows", desktopPlayer.mixerRows === 5, desktopPlayer.mixerRows + " rows");
check("desktop player has no page overflow",
  desktopPlayer.scroll[0] <= desktopPlayer.viewport[0] &&
  desktopPlayer.scroll[1] <= desktopPlayer.viewport[1],
  JSON.stringify(desktopPlayer.scroll));
await desktop.screenshot({ path: path.join(shots, "09-desktop-player.png") });

await desktop.locator(".transport .ghost").nth(1).click();
await desktop.waitForTimeout(700);
await ready(desktop);
const desktopNext = await desktop.evaluate(() => ({
  lesson: window.__batapp_new.state().lesson,
  active: window.__batapp_new.ui().active
}));
check("desktop next updates the lesson and the active row",
  desktopNext.lesson === "volume-1/02-tani-tani-cho-bi" && desktopNext.active === "Tani tani cho bi",
  JSON.stringify(desktopNext));
await desktop.close();

// Narrow desktop/tablet: both panes must remain, player stacks vertically.
const tablet = await browser.newPage({ viewport: { width: 1024, height: 768 } });
await tablet.bringToFront();
await tablet.goto(pageUrl + "#/lesson/volume-1/01-alubanche");
await tablet.waitForTimeout(700);
await tablet.waitForFunction(() => window.__batapp_new.state().lesson && !window.__batapp_new.state().loading, null, { timeout: 20000 });
const tabletState = await tablet.evaluate(() => {
  const speed = document.querySelector(".speed-controls").getBoundingClientRect();
  const mixer = document.querySelector(".mixer").getBoundingClientRect();
  const player = document.querySelector(".player-view");
  return {
    libraryWidth: document.getElementById("library-pane").getBoundingClientRect().width,
    columns: getComputedStyle(document.querySelector(".player-body")).gridTemplateColumns,
    mixer: !!document.querySelector(".mixer"),
    speedBottom: speed.bottom,
    mixerTop: mixer.top,
    playerScroll: [player.scrollHeight, player.clientHeight],
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight
  };
});
check("tablet keeps the sidebar and stacks the player",
  tabletState.libraryWidth >= 340 && tabletState.columns.split(" ").length === 1 && tabletState.mixer,
  JSON.stringify(tabletState));
check("tablet keeps the speed controls above the mixer without scrolling",
  tabletState.speedBottom <= tabletState.mixerTop + 1 &&
  tabletState.playerScroll[0] <= tabletState.playerScroll[1] + 1 &&
  tabletState.scrollHeight <= tabletState.viewportHeight + 1,
  JSON.stringify(tabletState));
check("tablet layout has no horizontal overflow", tabletState.scrollWidth <= tabletState.viewportWidth + 1,
  tabletState.scrollWidth + " > " + tabletState.viewportWidth);
await tablet.screenshot({ path: path.join(shots, "10-tablet-player.png") });
await tablet.close();

// --- theme follows the system ---------------------------------------------
const dark = await browser.newPage({ viewport, colorScheme: "dark" });
await dark.bringToFront();
await dark.goto(pageUrl + "#/lesson/volume-1/01-alubanche");
await dark.waitForTimeout(700);
await dark.waitForFunction(() => window.__batapp_new.state().lesson && !window.__batapp_new.state().loading, null, { timeout: 20000 });
const darkState = await dark.evaluate(() => ({
  scheme: getComputedStyle(document.documentElement).colorScheme,
  background: getComputedStyle(document.body).backgroundColor
}));
check("dark theme follows prefers-color-scheme",
  darkState.scheme === "dark" && darkState.background === "rgb(13, 15, 19)",
  JSON.stringify(darkState));
await dark.screenshot({ path: path.join(shots, "11-dark-player.png") });
await dark.close();

const darkDesktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
await darkDesktop.bringToFront();
await darkDesktop.goto(pageUrl + "#/lesson/volume-1/14-oya-otagua");
await darkDesktop.waitForTimeout(800);
await darkDesktop.waitForFunction(() => window.__batapp_new.state().lesson && !window.__batapp_new.state().loading, null, { timeout: 20000 });
await darkDesktop.screenshot({ path: path.join(shots, "12-dark-desktop.png") });
await darkDesktop.close();

// --- lesson sweep (full in Chromium, representative elsewhere) -------------
const lessons = await page.evaluate(() => window.__batapp_new.data.lessons);
const representatives = new Set([
  "volume-1/01-alubanche",
  "volume-1/19-egbi-pami",
  "volume-2/1-elegba"
]);
const sweepLessons = fullSweep ? lessons : lessons.filter((lesson) => representatives.has(lesson.slug));
const sweep = [];
for (const lesson of sweepLessons) {
  const lessonProblems = [];
  const consoleIssues = [];
  const listener = (message) => {
    if (message.type() === "error") consoleIssues.push(message.text().slice(0, 200));
  };
  page.on("console", listener);
  await page.goto(pageUrl + "#/lesson/" + lesson.slug);
  try {
    await page.waitForFunction((slug) => {
      const state = window.__batapp_new.state();
      return state.lesson === slug && !state.loading;
    }, lesson.slug, { timeout: 10000 });
    await page.waitForFunction(
      () => window.__batapp_new.tracks().every((track) => track.duration > 1 || track.error),
      null,
      { timeout: 10000 }
    );
  } catch (error) {
    lessonProblems.push("not ready: " + error.message.split("\n")[0]);
  }
  const snapshot = await page.evaluate(() => ({
    lesson: window.__batapp_new.state().lesson,
    stems: window.__batapp_new.tracks().map((track) => track.stem),
    loops: window.__batapp_new.tracks().map((track) => track.loop),
    rows: window.__batapp_new.ui().rows,
    title: window.__batapp_new.ui().title,
    documentTitle: document.title,
    errors: window.__batapp_new.tracks().filter((track) => track.error).map((track) => track.stem + ":" + track.error)
  }));
  page.off("console", listener);
  const expected = lesson.audio.map((entry) => entry.stem).sort().join(",");
  if (snapshot.lesson !== lesson.slug) lessonProblems.push("route " + snapshot.lesson);
  if (snapshot.stems.slice().sort().join(",") !== expected) lessonProblems.push("stems " + snapshot.stems.join(",") + " != " + expected);
  if (!snapshot.loops.every(Boolean)) lessonProblems.push("loops " + JSON.stringify(snapshot.loops));
  if (snapshot.rows !== lesson.audio.length) lessonProblems.push("rows " + snapshot.rows);
  if (snapshot.title !== lesson.title) lessonProblems.push("title " + snapshot.title);
  if (snapshot.documentTitle.indexOf(lesson.title) !== 0) lessonProblems.push("document title " + snapshot.documentTitle);
  if (snapshot.errors.length) lessonProblems.push("audio " + snapshot.errors.join(","));
  if (consoleIssues.length) lessonProblems.push("console " + consoleIssues[0]);
  sweep.push({ slug: lesson.slug, rows: snapshot.rows, stems: snapshot.stems, passed: lessonProblems.length === 0, problems: lessonProblems });
  process.stdout.write((lessonProblems.length ? "FAIL " : "PASS ") + lesson.slug + "\n");
}
const failed = sweep.filter((result) => !result.passed);
check((fullSweep ? "all 61 lessons" : "representative lessons") + " load in the modern layout",
  failed.length === 0,
  failed.slice(0, 3).map((result) => result.slug + ": " + result.problems.join(";")).join(" | "));
fs.writeFileSync(summaryFile, JSON.stringify({
  generated_at: new Date().toISOString(),
  browser: browserName,
  target: pageUrl,
  viewport: "390x844",
  full_sweep: fullSweep,
  lessons: sweep.length,
  passed: sweep.length - failed.length,
  failed: failed.map((result) => result.slug),
  results: sweep
}, null, 2) + "\n");

await page.close();

// --- served over HTTP (GitHub Pages path): fetch gate + Web Audio gains -----
const port = 8153;
const servedUrl = `http://127.0.0.1:${port}/index.html`;
const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 900));
try {
  const servedStartup = await browser.newPage({ viewport });
  await servedStartup.addInitScript(installMediaProbe);
  const servedStartupAudio = [];
  servedStartup.on("request", (request) => {
    if (request.url().includes("/assets/audio/")) servedStartupAudio.push(request.url());
  });
  await servedStartup.goto(servedUrl + "#/");
  await servedStartup.waitForTimeout(500);
  const servedStartupProbe = await servedStartup.evaluate(() => ({
    media: window.__mediaProbeSummary(),
    state: window.__batapp_new.state()
  }));
  check("served library opens without loading audio",
    servedStartupAudio.length === 0 && servedStartupProbe.media.created === 0 &&
    servedStartupProbe.media.contexts === 0 && servedStartupProbe.state.stems.length === 0,
    JSON.stringify({ requests: servedStartupAudio, media: { created: servedStartupProbe.media.created, contexts: servedStartupProbe.media.contexts } }));
  await servedStartup.close();

  // PWA version check: a matching manifest is a no-op.
  const versionOk = await browser.newPage({ viewport });
  await versionOk.goto(servedUrl + "#/");
  await versionOk.waitForTimeout(700);
  check("PWA version check does not reload when the manifest matches",
    !versionOk.url().includes("?v="), versionOk.url());
  await versionOk.close();

  // PWA version check: a newer manifest forces one cache-busted reload.
  const versionNew = await browser.newPage({ viewport });
  await versionNew.route("**/site.webmanifest*", (route) => route.fulfill({
    status: 200,
    contentType: "application/manifest+json",
    body: JSON.stringify({
      name: "Batá · Toques & Oru Seco",
      short_name: "Batá",
      version: "9.9.9",
      start_url: "./?v=9.9.9",
      scope: "./",
      icons: []
    })
  }));
  await versionNew.goto(servedUrl + "#/");
  await versionNew.waitForFunction(() => location.search.indexOf("v=9.9.9") >= 0, null, { timeout: 10000 });
  check("PWA version check reloads with the new version", true, versionNew.url());
  await versionNew.waitForTimeout(600);
  check("PWA version reload happens only once",
    (versionNew.url().match(/v=9\.9\.9/g) || []).length === 1, versionNew.url());
  await versionNew.close();

  // Opening the app menu after deployment must expose a manifest newer than
  // the loaded page and offer a manual cache-busting reload.
  const infoUpdate = await browser.newPage({ viewport });
  await infoUpdate.goto(servedUrl + "#/");
  await infoUpdate.waitForTimeout(700);
  await infoUpdate.route("**/site.webmanifest*", (route) => route.fulfill({
    status: 200,
    contentType: "application/manifest+json",
    body: JSON.stringify({
      name: "Batá · Toques & Oru Seco",
      short_name: "Batá",
      version: "9.9.9",
      start_url: "./?v=9.9.9",
      scope: "./",
      icons: []
    })
  }));
  await infoUpdate.locator("#app-info-button").click();
  await infoUpdate.waitForFunction(() => {
    return document.getElementById("app-info-panel").innerText
      .indexOf("A newer version is available") >= 0;
  }, null, { timeout: 10000 });
  check("app menu exposes a newer deployed manifest and a reload action",
    await infoUpdate.locator(".app-info-reload").isVisible());
  await infoUpdate.close();

  const served = await browser.newPage({ viewport });
  await served.bringToFront();
  await served.addInitScript(installMediaProbe);
  const servedAudioRequests = [];
  served.on("request", (request) => {
    if (request.url().includes("/assets/audio/")) servedAudioRequests.push(request.url());
  });
  const servedErrors = [];
  served.on("console", (message) => {
    if (message.type() === "error") servedErrors.push(message.text().slice(0, 150));
  });
  served.on("pageerror", (error) => servedErrors.push("pageerror: " + error.message.slice(0, 150)));
  await served.goto(servedUrl + "#/lesson/volume-1/01-alubanche");
  await ready(served);
  const firstLoadIds = Array.from(new Set(servedAudioRequests.map((url) => new URL(url).searchParams.get("load"))));
  check("first lesson load fetches five versioned stems",
    servedAudioRequests.length === 5 && firstLoadIds.length === 1,
    JSON.stringify(servedAudioRequests));
  check("served page uses the Web Audio mixer", (await served.evaluate(() => window.__batapp_new.state().mode)) === "webaudio");
  const wavInfo = await served.evaluate(async () => {
    const tracks = window.__batapp_new.tracks();
    const track = tracks[0];
    const buffer = await (await fetch(track.src)).arrayBuffer();
    const view = new DataView(buffer);
    const ascii = (offset, length) => Array.from(new Uint8Array(buffer, offset, length))
      .map((value) => String.fromCharCode(value)).join("");
    return {
      formats: tracks.map((item) => item.format),
      wavBytes: tracks.map((item) => item.wavBytes),
      bytes: buffer.byteLength,
      riff: ascii(0, 4),
      wave: ascii(8, 4),
      fmt: ascii(12, 4),
      audioFormat: view.getUint16(20, true),
      channels: view.getUint16(22, true),
      sampleRate: view.getUint32(24, true),
      bits: view.getUint16(34, true),
      dataSize: view.getUint32(40, true),
      duration: view.getUint32(40, true) /
        (view.getUint32(24, true) * view.getUint16(22, true) * 2),
      transportDuration: window.__batapp_new.state().duration
    };
  });
  check("HTTP stems are decoded into 16-bit PCM WAV",
    wavInfo.formats.every((format) => format === "wav") &&
    wavInfo.riff === "RIFF" && wavInfo.wave === "WAVE" && wavInfo.fmt === "fmt " &&
    wavInfo.audioFormat === 1 && wavInfo.bits === 16 && wavInfo.channels === 2 &&
    (wavInfo.sampleRate === 44100 || wavInfo.sampleRate === 48000) &&
    wavInfo.dataSize > 0 && wavInfo.bytes === wavInfo.dataSize + 44,
    JSON.stringify(wavInfo));
  check("WAV duration is exact and matches the manifest transport length",
    Math.abs(wavInfo.duration - wavInfo.transportDuration) < 0.1 &&
    wavInfo.wavBytes.every((bytes) => bytes === wavInfo.bytes),
    JSON.stringify({ wav: wavInfo.duration, transport: wavInfo.transportDuration, wavBytes: wavInfo.wavBytes, file: wavInfo.bytes }));

  await served.locator("#app-info-button").click();
  await served.waitForFunction(
    (expected) => window.__batapp_new.state().manifest === expected,
    appVersion,
    { timeout: 10000 }
  );
  const servedInfo = await served.evaluate(() => ({
    text: document.getElementById("app-info-panel").innerText,
    hidden: document.getElementById("app-info-panel").hidden,
    build: window.__batapp_new.state().build,
    manifest: window.__batapp_new.state().manifest
  }));
  check("HTTP app menu reports the single version and WAV source",
    !servedInfo.hidden && servedInfo.build === appVersion &&
    servedInfo.manifest === appVersion &&
    servedInfo.text.split(appVersion).length - 1 === 1 &&
    servedInfo.text.indexOf("Current lesson") >= 0 &&
    servedInfo.text.indexOf("Alubanche") >= 0 &&
    servedInfo.text.indexOf("WAV ×5") >= 0,
    JSON.stringify(servedInfo));
  await served.keyboard.press("Escape");
  await served.waitForTimeout(100);
  check("HTTP app menu closes with Escape",
    await served.evaluate(() => document.getElementById("app-info-panel").hidden));
  let vox = await served.evaluate(() => window.__batapp_new.tracks().find((track) => track.stem === "vox"));
  check("Vox starts at 100% on HTTP",
    vox.volume === 1 && vox.gain === 1 && vox.elementVolume === 1,
    JSON.stringify({ gain: vox.gain, elementVolume: vox.elementVolume, volume: vox.volume }));
  await served.locator(".stem[data-stem='vox'] input").evaluate((input) => {
    input.value = "50";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  vox = await served.evaluate(() => window.__batapp_new.tracks().find((track) => track.stem === "vox"));
  check("Vox gain follows its slider on HTTP", vox.gain === 0.5 && vox.elementVolume === 1,
    JSON.stringify({ gain: vox.gain, elementVolume: vox.elementVolume }));
  await served.locator(".stem[data-stem='vox'] input").evaluate((input) => {
    input.value = "100";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const initialGeneration = await served.evaluate(() => ({
    created: window.__mediaProbeSummary().created,
    src: window.__batapp_new.tracks()[0].src
  }));
  await served.locator("button.play").click();
  await served.waitForTimeout(1400);
  const servedTimes = await served.evaluate(() => window.__batapp_new.tracks().map((track) => track.currentTime));
  check("served page starts every stem together",
    servedTimes.every((time) => time > 0.3) && Math.max(...servedTimes) - Math.min(...servedTimes) < 0.12,
    JSON.stringify(servedTimes.map((time) => +time.toFixed(2))));
  await served.locator("button.play").click();
  await served.waitForTimeout(250);
  await served.locator(".stem[data-stem='iya'] .mute").click();
  await served.waitForTimeout(150);
  const pausedPosition = await served.evaluate(() => window.__batapp_new.state().position);
  await served.locator("button.play").click();
  await served.waitForTimeout(700);
  const resumedTracks = await served.evaluate(() => window.__batapp_new.tracks());
  const resumedTimes = resumedTracks.map((track) => track.currentTime);
  check("HTTP Pause -> Play resumes at the pause point on a fresh generation",
    Math.max(...resumedTimes) - Math.min(...resumedTimes) < 0.12 &&
    resumedTimes.every((time) => Math.abs(time - (pausedPosition + 0.7)) < 0.35) &&
    resumedTracks.find((track) => track.stem === "iya").muted === true,
    JSON.stringify({ paused: +pausedPosition.toFixed(3), times: resumedTimes.map((time) => +time.toFixed(3)) }));
  const resumedSequence = await served.evaluate(() => ({
    media: window.__mediaProbeSummary(),
    tracks: window.__batapp_new.tracks(),
    state: window.__batapp_new.state()
  }));
  check("HTTP pause + mute + play rebuilds a fresh generation at the same point",
    initialGeneration.created === 5 &&
    resumedSequence.media.created === initialGeneration.created + 5 &&
    resumedSequence.media.active === 5 &&
    resumedSequence.media.rates.length === 1 && resumedSequence.state.mixerPlaying === true &&
    resumedSequence.tracks.every((track) => !track.paused) &&
    resumedSequence.tracks.find((track) => track.stem === "iya").muted === true &&
    resumedSequence.tracks[0].src !== initialGeneration.src,
    JSON.stringify({ media: resumedSequence.media, tracks: resumedSequence.tracks.map((track) => ({ stem: track.stem, t: +track.currentTime.toFixed(2), muted: track.muted })) }));

  // Dragging the seek bar must keep playback alive; releasing it rebuilds the
  // media pipeline at the new position so buffered old-position audio cannot
  // replay (the same rule as Pause/Stop).
  const beforeSeek = await served.evaluate(() => ({
    created: window.__mediaProbeSummary().created,
    seeks: window.__mediaProbeSummary().seeks.length,
    src: window.__batapp_new.tracks()[0].src,
    position: window.__batapp_new.state().position
  }));
  await served.locator(".seek-input").evaluate((input) => {
    input.value = "10";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await served.waitForTimeout(600);
  const dragging = await served.evaluate(() => ({
    media: window.__mediaProbeSummary(),
    tracks: window.__batapp_new.tracks(),
    state: window.__batapp_new.state()
  }));
  check("HTTP dragging the seek bar keeps playback running",
    dragging.media.created === beforeSeek.created &&
    dragging.media.seeks.length === beforeSeek.seeks &&
    dragging.media.active === 5 && dragging.state.mixerPlaying === true &&
    dragging.tracks.every((track) => !track.paused) &&
    dragging.state.position > beforeSeek.position + 0.3,
    JSON.stringify({ before: beforeSeek, media: dragging.media, position: dragging.state.position }));
  await served.locator(".seek-input").evaluate((input) => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await served.waitForTimeout(700);
  const servedSequence = await served.evaluate(() => ({
    media: window.__mediaProbeSummary(),
    tracks: window.__batapp_new.tracks(),
    state: window.__batapp_new.state()
  }));
  check("HTTP releasing the seek bar rebuilds a fresh generation at the new point",
    servedSequence.media.created === beforeSeek.created + 5 &&
    servedSequence.media.active === 5 &&
    servedSequence.media.rates.length === 1 && servedSequence.state.mixerPlaying === true &&
    servedSequence.tracks.every((track) => track.currentTime >= 9.9 && track.currentTime < 12) &&
    servedSequence.tracks.find((track) => track.stem === "iya").muted === true &&
    servedSequence.tracks[0].src !== beforeSeek.src,
    JSON.stringify({ media: servedSequence.media, tracks: servedSequence.tracks.map((track) => ({ stem: track.stem, t: +track.currentTime.toFixed(2), muted: track.muted })) }));

  // A released speed button must rebuild the same way and keep the position,
  // without downloading the stems again.
  const beforeSpeed = await served.evaluate(() => ({
    created: window.__mediaProbeSummary().created,
    src: window.__batapp_new.tracks()[0].src,
    position: window.__batapp_new.state().position
  }));
  await served.locator('.speed-step[data-delta="1"]').click();
  await served.waitForTimeout(700);
  const afterSpeed = await served.evaluate(() => ({
    media: window.__mediaProbeSummary(),
    tracks: window.__batapp_new.tracks(),
    state: window.__batapp_new.state(),
    ui: window.__batapp_new.ui()
  }));
  check("HTTP speed release rebuilds a fresh generation at 101%",
    afterSpeed.media.created === beforeSpeed.created + 5 &&
    afterSpeed.media.active === 5 &&
    afterSpeed.state.rate === 1.01 && afterSpeed.ui.speedValue === "101%" &&
    afterSpeed.tracks.every((track) => Math.abs(track.rate - 1.01) < 0.001 && !track.paused) &&
    afterSpeed.tracks[0].src !== beforeSpeed.src &&
    afterSpeed.state.position >= beforeSpeed.position - 0.3 &&
    afterSpeed.state.position < beforeSpeed.position + 1.8 &&
    servedAudioRequests.length === 5,
    JSON.stringify({ media: afterSpeed.media, rate: afterSpeed.state.rate, before: beforeSpeed.position, after: afterSpeed.state.position, requests: servedAudioRequests.length }));
  await served.locator('.speed-step[data-delta="-1"]').click();
  await served.waitForTimeout(500);

  // Near-end starts must work on the served/PWA path as well.
  const servedDuration = await served.evaluate(() => window.__batapp_new.state().duration);
  for (const offset of [0.01, 0.1, 0.5, 1]) {
    await served.locator(".seek-input").evaluate((input, value) => {
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, servedDuration - offset);
    await served.waitForTimeout(1200);
    const servedNearEnd = await served.evaluate(() => ({
      state: window.__batapp_new.state(),
      tracks: window.__batapp_new.tracks()
    }));
    check(`HTTP near-end seek ${offset}s starts every stem`,
      servedNearEnd.state.playing && servedNearEnd.state.mixerPlaying &&
      servedNearEnd.tracks.every((track) => !track.paused && !track.ended),
      JSON.stringify({ offset, state: servedNearEnd.state, tracks: servedNearEnd.tracks.map((track) => ({ stem: track.stem, t: +track.currentTime.toFixed(2), paused: track.paused })) }));
  }

  // Returning from the background with a suspended AudioContext must not
  // leave a moving silent timeline: the UI returns to Play, and the next tap
  // rebuilds/resumes the context inside the gesture.
  const backgroundBefore = await served.evaluate(() => ({
    state: window.__batapp_new.state(),
    hasContext: !!window.__mediaProbe.context,
    label: document.querySelector("button.play").getAttribute("aria-label")
  }));
  check("HTTP player has a running AudioContext before backgrounding",
    backgroundBefore.hasContext && backgroundBefore.state.contextRunning === true &&
    backgroundBefore.state.playing === true && backgroundBefore.label === "Pause",
    JSON.stringify(backgroundBefore));
  await served.evaluate(async () => {
    const context = window.__mediaProbe.context;
    window.__batappSavedResume = context.resume.bind(context);
    await context.suspend();
    context.resume = () => Promise.reject(new Error("blocked"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden"
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await served.waitForTimeout(200);
  await served.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible"
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await served.waitForTimeout(900);
  const backgroundAfter = await served.evaluate(() => ({
    state: window.__batapp_new.state(),
    label: document.querySelector("button.play").getAttribute("aria-label"),
    status: (document.querySelector(".player-status") || {}).textContent || ""
  }));
  check("returning with a suspended AudioContext shows Play, not a silent clock",
    backgroundAfter.state.playing === false &&
    backgroundAfter.state.contextRunning === false &&
    backgroundAfter.label === "Play" &&
    backgroundAfter.status.indexOf("Playback paused") >= 0,
    JSON.stringify(backgroundAfter));
  await served.evaluate(() => {
    window.__mediaProbe.context.resume = window.__batappSavedResume;
  });
  await served.locator("button.play").click();
  await served.waitForTimeout(1200);
  const backgroundResumed = await served.evaluate(() => ({
    state: window.__batapp_new.state(),
    tracks: window.__batapp_new.tracks()
  }));
  check("Play after background rebuilds and resumes every stem",
    backgroundResumed.state.playing && backgroundResumed.state.mixerPlaying &&
    backgroundResumed.state.contextRunning === true &&
    backgroundResumed.tracks.every((track) => !track.paused),
    JSON.stringify({ state: backgroundResumed.state, tracks: backgroundResumed.tracks.map((track) => ({ stem: track.stem, paused: track.paused })) }));

  // Stop -> Play must create another fresh generation at zero, without
  // downloading any audio again.
  const beforeStop = await served.evaluate(() => ({
    created: window.__mediaProbeSummary().created,
    src: window.__batapp_new.tracks()[0].src
  }));
  await served.locator(".stop").click();
  await served.waitForTimeout(300);
  const stoppedGeneration = await served.evaluate(() => ({
    state: window.__batapp_new.state(),
    tracks: window.__batapp_new.tracks()
  }));
  check("HTTP Stop resets the visible timeline immediately",
    stoppedGeneration.state.position === 0 &&
    stoppedGeneration.tracks.every((track) => track.paused && track.currentTime < 0.1),
    JSON.stringify({ position: stoppedGeneration.state.position, tracks: stoppedGeneration.tracks.map((track) => ({ stem: track.stem, t: track.currentTime, paused: track.paused })) }));
  await served.locator("button.play").click();
  await served.waitForTimeout(1200);
  const afterStopPlay = await served.evaluate(() => ({
    media: window.__mediaProbeSummary(),
    tracks: window.__batapp_new.tracks(),
    state: window.__batapp_new.state()
  }));
  check("HTTP Stop -> Play builds a fresh generation from zero",
    afterStopPlay.media.created === beforeStop.created + 5 &&
    afterStopPlay.media.active === 5 &&
    afterStopPlay.state.mixerPlaying === true &&
    afterStopPlay.tracks.every((track) => track.currentTime > 0 && track.currentTime < 1.8) &&
    afterStopPlay.tracks[0].src !== beforeStop.src &&
    servedAudioRequests.length === 5,
    JSON.stringify({ created: afterStopPlay.media.created, times: afterStopPlay.tracks.map((track) => +track.currentTime.toFixed(2)), requests: servedAudioRequests.length }));

  // Volume and mute must not touch the transport.
  const beforeLevel = await served.evaluate(() => ({
    media: window.__mediaProbeSummary(),
    position: window.__batapp_new.state().position
  }));
  await served.locator(".stem[data-stem='oko'] input").evaluate((input) => {
    input.value = "40";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await served.locator(".stem[data-stem='iya'] .mute").click();
  await served.waitForTimeout(700);
  const afterLevel = await served.evaluate(() => ({
    media: window.__mediaProbeSummary(),
    tracks: window.__batapp_new.tracks(),
    state: window.__batapp_new.state()
  }));
  const oko = afterLevel.tracks.find((track) => track.stem === "oko");
  const iya = afterLevel.tracks.find((track) => track.stem === "iya");
  check("volume and mute change only the gain, never the transport",
    afterLevel.media.created === beforeLevel.media.created &&
    afterLevel.media.plays === beforeLevel.media.plays &&
    afterLevel.media.pauses === beforeLevel.media.pauses &&
    afterLevel.media.seeks.length === beforeLevel.media.seeks.length &&
    afterLevel.state.mixerPlaying === true &&
    afterLevel.state.position > beforeLevel.position + 0.4 &&
    Math.abs(oko.volume - 0.4) < 0.02 && Math.abs(oko.gain - 0.4) < 0.02 &&
    iya.muted === false && Math.abs(iya.gain - iya.volume) < 0.02,
    JSON.stringify({ before: { plays: beforeLevel.media.plays, pauses: beforeLevel.media.pauses, seeks: beforeLevel.media.seeks.length }, after: { plays: afterLevel.media.plays, pauses: afterLevel.media.pauses, seeks: afterLevel.media.seeks.length }, oko: { volume: oko.volume, gain: oko.gain }, iya: { muted: iya.muted, gain: iya.gain, volume: iya.volume } }));

  // Back releases every audio resource; reopening downloads fresh stems.
  await served.locator(".player-top .icon-btn").click();
  await served.waitForTimeout(400);
  const unloaded = await served.evaluate(() => ({
    state: window.__batapp_new.state(),
    media: window.__mediaProbeSummary(),
    elements: window.__mediaProbe.audios.map((audio) => ({
      src: audio.getAttribute("src"),
      paused: audio.paused,
      readyState: audio.readyState
    }))
  }));
  check("Back unloads every stem, Blob and context",
    unloaded.state.lesson === null && unloaded.state.loaded === false &&
    unloaded.state.disposed === true && unloaded.media.active === 0 &&
    unloaded.elements.every((element) => !element.src &&
      element.paused && element.readyState === 0),
    JSON.stringify({ state: { lesson: unloaded.state.lesson, loaded: unloaded.state.loaded, disposed: unloaded.state.disposed }, media: { active: unloaded.media.active }, elements: unloaded.elements }));

  await served.locator(".row[data-slug='volume-1/01-alubanche']").click();
  await ready(served);
  const reloadIds = Array.from(new Set(servedAudioRequests.map((url) => new URL(url).searchParams.get("load"))));
  check("reopening a rhythm downloads all stems again from scratch",
    servedAudioRequests.length === 10 && reloadIds.length === 2 &&
    firstLoadIds.every((id) => reloadIds.indexOf(id) >= 0),
    JSON.stringify({ requests: servedAudioRequests.length, loadIds: reloadIds }));

  check("no console errors over HTTP", servedErrors.length === 0, servedErrors.slice(0, 2).join(" | "));
  await served.close();

  // Load gate: delay the audio responses, then assert Play is disabled.
  const slow = await browser.newPage({ viewport });
  await slow.bringToFront();
  await slow.route("**/assets/audio/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  await slow.goto(servedUrl + "#/lesson/volume-1/01-alubanche");
  await slow.waitForSelector(".loading", { timeout: 5000 });
  await slow.waitForTimeout(250);
  const gated = await slow.evaluate(() => ({
    loader: !!document.querySelector(".loading"),
    playEnabled: window.__batapp_new.ui().playEnabled,
    status: (document.querySelector(".load-status") || {}).textContent || "",
    seek: !!document.querySelector(".seek")
  }));
  check("HTTP load gate shows a loader with Play disabled",
    gated.loader && !gated.playEnabled && !gated.seek,
    JSON.stringify(gated));
  await slow.screenshot({ path: path.join(shots, "13-http-loading.png") });
  await ready(slow);
  const readyState = await slow.evaluate(() => ({
    loader: !!document.querySelector(".loading"),
    playEnabled: window.__batapp_new.ui().playEnabled,
    seek: !!document.querySelector(".seek")
  }));
  check("load gate opens only after all stems are local",
    !readyState.loader && readyState.playEnabled && readyState.seek,
    JSON.stringify(readyState));
  await slow.close();

  // One slow stem must keep the playing screen hidden until it is ready.
  const oneSlow = await browser.newPage({ viewport });
  await oneSlow.bringToFront();
  await oneSlow.route("**/vox.ogg*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1800));
    await route.continue();
  });
  await oneSlow.goto(servedUrl + "#/lesson/volume-1/01-alubanche");
  await oneSlow.waitForSelector(".loading", { timeout: 5000 });
  await oneSlow.waitForTimeout(900);
  const held = await oneSlow.evaluate(() => ({
    loader: !!document.querySelector(".loading"),
    mixer: !!document.querySelector(".mixer"),
    play: !!document.querySelector("button.play"),
    status: (document.querySelector(".load-status") || {}).textContent || ""
  }));
  check("playing screen stays hidden until the last stem is ready",
    held.loader && !held.mixer && !held.play,
    JSON.stringify(held));
  await ready(oneSlow);
  check("the last stem opens the playing screen",
    await oneSlow.evaluate(() => !!document.querySelector(".mixer") && !window.__batapp_new.state().loading));
  await oneSlow.close();

  // A corrupted transfer must fail closed before the player is shown.
  const corrupt = await browser.newPage({ viewport });
  await corrupt.bringToFront();
  await corrupt.route("**/vox.ogg*", (route) => route.fulfill({
    status: 200,
    contentType: "audio/ogg",
    body: Buffer.from("corrupt")
  }));
  await corrupt.goto(servedUrl + "#/lesson/volume-1/01-alubanche");
  await corrupt.waitForSelector(".loading.error", { timeout: 15000 });
  await corrupt.waitForTimeout(250);
  const corruptState = await corrupt.evaluate(() => ({
    text: (document.querySelector(".load-status") || {}).textContent || "",
    detail: (document.querySelector(".load-detail") || {}).textContent || "",
    mixer: !!document.querySelector(".mixer"),
    play: !!document.querySelector("button.play"),
    state: window.__batapp_new.state()
  }));
  check("corrupted stem fails the integrity gate and names the stem",
    corruptState.text.indexOf("Vox") >= 0 && !corruptState.mixer && !corruptState.play &&
    corruptState.state.loading === false && !!corruptState.state.error,
    JSON.stringify(corruptState));
  await corrupt.screenshot({ path: path.join(shots, "14-http-checksum-error.png") });
  await corrupt.unroute("**/vox.ogg*");
  await corrupt.locator(".retry").click();
  await ready(corrupt);
  check("Retry recovers after an integrity failure",
    await corrupt.evaluate(() => !window.__batapp_new.state().loading && window.__batapp_new.ui().playEnabled));
  await corrupt.close();

  // Mobile browsers may estimate media duration. The WAV path must not reject
  // a verified stem just because that estimate differs from the manifest.
  const estimated = await browser.newPage({ viewport });
  await estimated.bringToFront();
  await estimated.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "duration");
    Object.defineProperty(HTMLMediaElement.prototype, "duration", {
      configurable: true,
      get() {
        const real = descriptor.get.call(this);
        return Number.isFinite(real) && real > 1 ? real + 2 : real;
      }
    });
  });
  await estimated.goto(servedUrl + "#/lesson/volume-1/01-alubanche");
  await ready(estimated);
  const estimatedState = await estimated.evaluate(() => ({
    state: window.__batapp_new.state(),
    tracks: window.__batapp_new.tracks()
  }));
  check("estimated mobile durations do not fail the WAV gate",
    !estimatedState.state.error && estimatedState.state.loaded &&
    estimatedState.tracks.every((track) => track.ready && track.format === "wav") &&
    Math.abs(estimatedState.state.duration - 69.407) < 0.01 &&
    estimatedState.tracks.every((track) => Math.abs(track.durationDelta - 2) < 0.2),
    JSON.stringify({ state: estimatedState.state, tracks: estimatedState.tracks.map((track) => ({ stem: track.stem, format: track.format, delta: track.durationDelta })) }));
  await estimated.close();

  // If the browser cannot decode Ogg for WAV conversion, the player falls
  // back to the verified Ogg Blob rather than failing the lesson.
  const decodeFail = await browser.newPage({ viewport });
  await decodeFail.bringToFront();
  await decodeFail.addInitScript(() => {
    function wrap(Native) {
      if (!Native) return Native;
      const Wrapped = function () {
        const context = new Native();
        context.decodeAudioData = function () {
          return Promise.reject(new Error("decode unavailable"));
        };
        return context;
      };
      Wrapped.prototype = Native.prototype;
      return Wrapped;
    }
    if (window.AudioContext) window.AudioContext = wrap(window.AudioContext);
    if (window.webkitAudioContext) window.webkitAudioContext = wrap(window.webkitAudioContext);
  });
  await decodeFail.goto(servedUrl + "#/lesson/volume-1/01-alubanche");
  await ready(decodeFail);
  const decodeFailState = await decodeFail.evaluate(() => ({
    state: window.__batapp_new.state(),
    tracks: window.__batapp_new.tracks()
  }));
  check("Ogg decode failure falls back to direct Ogg playback",
    !decodeFailState.state.error && decodeFailState.state.loaded &&
    decodeFailState.tracks.every((track) => track.ready && track.format === "ogg") &&
    Math.abs(decodeFailState.state.duration - 69.407) < 0.01,
    JSON.stringify({ state: decodeFailState.state, tracks: decodeFailState.tracks.map((track) => ({ stem: track.stem, format: track.format })) }));
  await decodeFail.close();

  // The largest lesson must also convert completely (about 139 MB of WAV).
  const largest = await browser.newPage({ viewport });
  await largest.bringToFront();
  await largest.goto(servedUrl + "#/lesson/volume-1/31-tui-tui");
  await largest.waitForFunction(() => {
    const state = window.__batapp_new.state();
    return state.lesson === "volume-1/31-tui-tui" && !state.loading &&
      (state.loaded || !!state.error);
  }, null, { timeout: 120000 });
  const largestState = await largest.evaluate(() => ({
    state: window.__batapp_new.state(),
    tracks: window.__batapp_new.tracks()
  }));
  check("largest lesson converts every stem to WAV",
    !largestState.state.error && largestState.state.loaded &&
    largestState.tracks.every((track) => track.ready && track.format === "wav") &&
    largestState.tracks.reduce((total, track) => total + (track.wavBytes || 0), 0) > 120000000,
    JSON.stringify({ state: largestState.state, bytes: largestState.tracks.reduce((total, track) => total + (track.wavBytes || 0), 0), formats: largestState.tracks.map((track) => track.format) }));
  await largest.close();

  // Error + Retry: abort the Vox fetch, then retry with the route removed.
  const failing = await browser.newPage({ viewport });
  await failing.bringToFront();
  await failing.route("**/vox.ogg*", (route) => route.abort());
  await failing.goto(servedUrl + "#/lesson/volume-1/01-alubanche");
  await failing.waitForSelector(".loading.error", { timeout: 15000 });
  await failing.waitForTimeout(250);
  const errorText = (await failing.locator(".load-status").textContent()).trim();
  check("failed stem is named in the error state", errorText.indexOf("Vox") >= 0, errorText);
  await failing.screenshot({ path: path.join(shots, "14-http-error.png") });
  await failing.unroute("**/vox.ogg*");
  await failing.locator(".retry").click();
  await ready(failing);
  check("Retry completes the load after a failure",
    (await failing.evaluate(() => !window.__batapp_new.state().loading && window.__batapp_new.ui().playEnabled)));
  await failing.close();
} finally {
  server.kill("SIGTERM");
}

await browser.close();

const fileErrors = pageErrors.filter((entry) => !entry.includes("favicon"));
check("no external network requests from the file:// page", external.length === 0, external.slice(0, 3).join(" | "));
check("no console errors during the file:// walkthrough", fileErrors.length === 0, fileErrors.slice(0, 3).join(" | "));

const report = {
  generated_at: new Date().toISOString(),
  browser: browserName,
  target: pageUrl,
  full_sweep: fullSweep,
  checks_passed: checks.filter((entry) => entry.ok).length,
  checks_total: checks.length,
  problems,
  checks
};
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
console.log(browserName + ": " + checks.filter((entry) => entry.ok).length + "/" + checks.length + " checks passed; report: " + reportFile);
if (problems.length) {
  console.log(problems.join("\n"));
  process.exitCode = 1;
}
