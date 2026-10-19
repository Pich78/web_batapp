/* Behavioural verification of the modern layout (index.html).
 *
 * Opens the page over file:// and over HTTP, walks the library, exercises the
 * load gate, seek bar, shared mixer and layouts, sweeps the lessons, and writes
 * screenshots plus JSON reports.
 *
 *   cd tests && node verify-new.mjs                  # Chromium, full sweep
 *   BROWSER=firefox node verify-new.mjs              # representative lessons
 *   BROWSER=webkit node verify-new.mjs
 */
import { chromium, firefox, webkit } from "playwright";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import vm from "vm";
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
check("slim lessons match the full data (with modern Vox at 100%)",
  JSON.stringify(slim.lessons) === JSON.stringify(full.lessons.map(projectLesson)),
  "slim=" + slim.lessons.length + " full=" + full.lessons.length);
const slimBytes = fs.statSync(path.join(root, "js/lessons.js")).size;
check("slim modern data stays compact", slimBytes < 200000, slimBytes + " bytes");
const modernHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const legacyHtml = fs.readFileSync(path.join(root, "index_old.html"), "utf8");
check("modern page loads lessons.js only",
  modernHtml.includes("js/lessons.js") && !modernHtml.includes("js/data.js"));
check("modern assets are cache-versioned",
  /app-new\.css\?v=/.test(modernHtml) && /newapp\.js\?v=/.test(modernHtml) && /mixer\.js\?v=/.test(modernHtml));
check("legacy page keeps the full data.js",
  legacyHtml.includes("js/data.js") && !legacyHtml.includes("js/lessons.js"));

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

/* Count real media elements and play/pause calls in the test page. */
function installMediaProbe() {
  window.__mediaProbe = { audios: [], plays: 0, pauses: 0 };
  const Native = window.Audio;
  window.Audio = function (src) {
    const audio = new Native(src);
    audio.__probeStem = (src || "").split("/").slice(-1)[0];
    window.__mediaProbe.audios.push(audio);
    return audio;
  };
  window.Audio.prototype = Native.prototype;
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
  window.__mediaProbeSummary = function () {
    const audios = window.__mediaProbe.audios;
    return {
      created: audios.length,
      active: audios.filter((audio) => !audio.paused).length,
      loops: audios.map((audio) => audio.loop),
      rates: Array.from(new Set(audios.map((audio) => audio.playbackRate))),
      stems: audios.map((audio) => audio.__probeStem),
      plays: window.__mediaProbe.plays,
      pauses: window.__mediaProbe.pauses
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
const iconLinks = await page.evaluate(() =>
  Array.from(document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]'))
    .map((link) => link.getAttribute("href")));
check("modern page links the icon set",
  iconLinks.includes("assets/icon.svg") && iconLinks.includes("assets/icon-32.png") &&
  iconLinks.includes("assets/icon-180.png") && iconLinks.includes("site.webmanifest"),
  iconLinks.join(", "));

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

// Prev / Next (DOM order: prev, next among the ghost buttons)
const ghosts = page.locator(".transport .ghost");
check("Prev is disabled on the first lesson", await ghosts.nth(0).isDisabled());
await ghosts.nth(1).click();
await page.waitForTimeout(700);
await ready();
check("Next opens the next rhythm", (await page.evaluate(() => window.__batapp_new.state().lesson)) === "volume-1/02-tani-tani-cho-bi",
  await page.evaluate(() => window.__batapp_new.state().lesson));
await page.locator(".transport .ghost").nth(0).click();
await page.waitForTimeout(700);
await ready();
check("Prev steps back", (await page.evaluate(() => window.__batapp_new.state().lesson)) === "volume-1/01-alubanche",
  await page.evaluate(() => window.__batapp_new.state().lesson));

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
const sequence = await transport.evaluate(() => ({
  media: window.__mediaProbeSummary(),
  tracks: window.__batapp_new.tracks(),
  state: window.__batapp_new.state()
}));
check("pause + mute + play + backward seek keeps five active stems",
  sequence.media.created === 5 && sequence.media.active === 5 &&
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
check("loop boundary keeps all five stems together",
  wrappedConverged &&
  wrapped.media.created === 5 && wrapped.media.active === 5 && wrapped.media.loops.every(Boolean) &&
  wrapTimes.every((time) => time < 2.5) &&
  Math.max(...wrapTimes) - Math.min(...wrapTimes) < 0.12,
  JSON.stringify({ media: wrapped.media, times: wrapTimes.map((time) => +time.toFixed(2)) }));

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
const afterWrap = await transport.evaluate(() => ({
  media: window.__mediaProbeSummary(),
  tracks: window.__batapp_new.tracks()
}));
const afterTimes = afterWrap.tracks.map((track) => track.currentTime);
check("pause + mute + backward seek after the loop keeps Beat playing",
  afterWrap.media.created === 5 && afterWrap.media.active === 5 &&
  afterWrap.tracks.find((track) => track.stem === "beat").paused === false &&
  afterTimes.every((time) => time >= 2.9) &&
  Math.max(...afterTimes) - Math.min(...afterTimes) < 0.12,
  JSON.stringify({ media: afterWrap.media, times: afterTimes.map((time) => +time.toFixed(2)) }));
await transport.close();

// Volume II: four stems, no Vox row
await go("#/lesson/volume-2/1-elegba", 600);
await ready();
ui = await page.evaluate(() => window.__batapp_new.ui());
check("instrumental lesson gets four mixer rows", ui.rows === 4, ui.rows + " rows");
check("instrumental lesson has no Vox", !(await page.evaluate(() => window.__batapp_new.state().stems.includes("vox"))));

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

// --- mobile landscape ------------------------------------------------------
const landscape = await browser.newPage({ viewport: { width: 844, height: 390 } });
await landscape.bringToFront();
await landscape.goto(pageUrl + "#/lesson/volume-1/01-alubanche");
await landscape.waitForTimeout(800);
await landscape.waitForFunction(() => window.__batapp_new.state().lesson && !window.__batapp_new.state().loading, null, { timeout: 20000 });
const landscapeLayout = await landscape.evaluate(() => {
  const box = (node) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  };
  const rows = Array.from(document.querySelectorAll(".stem")).map(box);
  const app = document.getElementById("app").getBoundingClientRect();
  return {
    hero: box(document.querySelector(".hero")),
    mixer: box(document.querySelector(".mixer")),
    seek: box(document.querySelector(".seek")),
    rows,
    app: { left: app.left, top: app.top, right: app.right, bottom: app.bottom },
    viewport: [window.innerWidth, window.innerHeight],
    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight]
  };
});
check("landscape player uses two columns",
  landscapeLayout.hero.right <= landscapeLayout.mixer.left + 2,
  JSON.stringify({ hero: landscapeLayout.hero, mixer: landscapeLayout.mixer }));
check("landscape shows the seek bar inside the viewport",
  landscapeLayout.seek.top >= 0 && landscapeLayout.seek.bottom <= landscapeLayout.viewport[1],
  JSON.stringify(landscapeLayout.seek));
check("landscape shows all five mixer rows inside the viewport",
  landscapeLayout.rows.length === 5 && landscapeLayout.rows.every((row) =>
    row.top >= -1 && row.bottom <= landscapeLayout.viewport[1] + 1 &&
    row.left >= -1 && row.right <= landscapeLayout.viewport[0] + 1),
  JSON.stringify(landscapeLayout.rows));
check("landscape player fills the viewport without page scroll",
  landscapeLayout.app.left === 0 &&
  landscapeLayout.app.right === landscapeLayout.viewport[0] &&
  landscapeLayout.scroll[0] <= landscapeLayout.viewport[0] &&
  landscapeLayout.scroll[1] <= landscapeLayout.viewport[1],
  JSON.stringify(landscapeLayout));
await landscape.locator("button.play").click();
await landscape.waitForTimeout(2200);
const landscapeTimes = await landscape.evaluate(() => window.__batapp_new.tracks().map((track) => track.currentTime));
check("landscape playback starts every stem together",
  landscapeTimes.every((time) => time > 0.3) && Math.max(...landscapeTimes) - Math.min(...landscapeTimes) < 0.12,
  JSON.stringify(landscapeTimes.map((time) => +time.toFixed(2))));
await landscape.screenshot({ path: path.join(shots, "06-landscape-player.png") });

await landscape.goto(pageUrl + "#/v/1");
await landscape.waitForTimeout(500);
const landscapeLibrary = await landscape.evaluate(() => {
  const lefts = Array.from(document.querySelectorAll(".row")).slice(0, 4)
    .map((row) => Math.round(row.getBoundingClientRect().left));
  return {
    columns: new Set(lefts).size,
    lefts,
    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    viewport: [window.innerWidth, window.innerHeight]
  };
});
check("landscape library uses two columns", landscapeLibrary.columns === 2, JSON.stringify(landscapeLibrary.lefts));
check("landscape library does not scroll the page",
  landscapeLibrary.scroll[0] <= landscapeLibrary.viewport[0] &&
  landscapeLibrary.scroll[1] <= landscapeLibrary.viewport[1],
  JSON.stringify(landscapeLibrary));
await landscape.screenshot({ path: path.join(shots, "07-landscape-library.png") });
await landscape.close();

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
  return {
    lesson: window.__batapp_new.state().lesson,
    active: window.__batapp_new.ui().active,
    libraryWidth: library.width,
    twoCols: hero.right <= mixer.left + 2,
    mixerRows: document.querySelectorAll(".stem").length,
    seek: !!document.querySelector(".seek"),
    backVisible: !!(back && back.getClientRects().length),
    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    viewport: [window.innerWidth, window.innerHeight]
  };
});
check("desktop sidebar persists while a lesson is open", desktopPlayer.libraryWidth >= 340, desktopPlayer.libraryWidth + "px");
check("desktop marks the active sidebar row", desktopPlayer.active === "Alubanche", desktopPlayer.active);
check("desktop player shows hero and mixer side by side", desktopPlayer.twoCols, JSON.stringify(desktopPlayer));
check("desktop player has the seek bar", desktopPlayer.seek);
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
const tabletState = await tablet.evaluate(() => ({
  libraryWidth: document.getElementById("library-pane").getBoundingClientRect().width,
  columns: getComputedStyle(document.querySelector(".player-body")).gridTemplateColumns,
  mixer: !!document.querySelector(".mixer"),
  scrollWidth: document.documentElement.scrollWidth,
  viewportWidth: window.innerWidth
}));
check("tablet keeps the sidebar and stacks the player",
  tabletState.libraryWidth >= 340 && tabletState.columns.split(" ").length === 1 && tabletState.mixer,
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
  const served = await browser.newPage({ viewport });
  await served.bringToFront();
  await served.addInitScript(installMediaProbe);
  const servedErrors = [];
  served.on("console", (message) => {
    if (message.type() === "error") servedErrors.push(message.text().slice(0, 150));
  });
  served.on("pageerror", (error) => servedErrors.push("pageerror: " + error.message.slice(0, 150)));
  await served.goto(servedUrl + "#/lesson/volume-1/01-alubanche");
  await ready(served);
  check("served page uses the Web Audio mixer", (await served.evaluate(() => window.__batapp_new.state().mode)) === "webaudio");
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
  await served.locator("button.play").click();
  await served.waitForTimeout(700);
  await served.locator(".seek-input").evaluate((input) => {
    input.value = "10";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await served.waitForTimeout(500);
  const servedSequence = await served.evaluate(() => ({
    media: window.__mediaProbeSummary(),
    tracks: window.__batapp_new.tracks(),
    state: window.__batapp_new.state()
  }));
  check("HTTP pause + mute + play + backward seek keeps five active stems",
    servedSequence.media.created === 5 && servedSequence.media.active === 5 &&
    servedSequence.media.rates.length === 1 && servedSequence.state.mixerPlaying === true &&
    servedSequence.tracks.every((track) => track.currentTime >= 9.9 && track.currentTime < 12) &&
    servedSequence.tracks.find((track) => track.stem === "iya").muted === true,
    JSON.stringify({ media: servedSequence.media, tracks: servedSequence.tracks.map((track) => ({ stem: track.stem, t: +track.currentTime.toFixed(2), muted: track.muted })) }));
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

  // Error + Retry: abort the Vox fetch, then retry with the route removed.
  const failing = await browser.newPage({ viewport });
  await failing.bringToFront();
  await failing.route("**/vox.ogg", (route) => route.abort());
  await failing.goto(servedUrl + "#/lesson/volume-1/01-alubanche");
  await failing.waitForSelector(".loading.error", { timeout: 15000 });
  await failing.waitForTimeout(250);
  const errorText = (await failing.locator(".load-status").textContent()).trim();
  check("failed stem is named in the error state", errorText.indexOf("Vox") >= 0, errorText);
  await failing.screenshot({ path: path.join(shots, "14-http-error.png") });
  await failing.unroute("**/vox.ogg");
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
