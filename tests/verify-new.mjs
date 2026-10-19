/* Behavioural verification of the modern layout (index_new.html).
 *
 * Opens the page over file:// and over HTTP, walks the library, exercises the
 * shared mixer (play/pause/stop, per-stem volume and mute, prev/next), sweeps
 * all 61 lessons, and records screenshots plus JSON reports.
 *
 *   cd tests && node verify-new.mjs
 */
import { chromium } from "playwright";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageUrl = "file://" + root + "/index_new.html";
const shots = path.join(root, ".work/screenshots-new");
const reportFile = path.join(root, ".work/verification/new-ui-report.json");
const summaryFile = path.join(root, "docs/verification/new-ui-sweep-summary.json");
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(path.dirname(reportFile), { recursive: true });

const checks = [];
const problems = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  if (!ok) problems.push(name + (detail ? " (" + detail + ")" : ""));
}

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"]
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
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
    () => window.__batapp_new.tracks().length > 0 &&
      window.__batapp_new.tracks().every((track) => track.duration > 1 || track.error),
    null,
    { timeout: 10000 }
  );
}

// --- library ---------------------------------------------------------------
await go("#/");
await shot("01-library-toques");
let ui = await page.evaluate(() => window.__batapp_new.ui());
check("library renders two volume tabs", ui.tabs === 2, ui.tabs + " tabs");
let rows = await page.locator(".row").count();
check("Toques lists 38 rhythms", rows === 38, rows + " rows");
const first = await page.locator(".row .name").first().textContent();
check("first toque is Alubanche", first.trim() === "Alubanche", first.trim());
const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
check("library has no horizontal overflow at 390px", fits);
const fills = await page.evaluate(() => document.getElementById("app").getBoundingClientRect().height >= window.innerHeight - 1);
check("app column fills the phone viewport", fills);

await page.locator(".tab").nth(1).click();
await page.waitForTimeout(300);
rows = await page.locator(".row").count();
check("Oru Seco lists 23 lessons", rows === 23, rows + " rows");
await shot("02-library-oru-seco");

// --- player ----------------------------------------------------------------
await go("#/lesson/volume-1/01-alubanche", 600);
await ready();
await shot("03-player-idle");
ui = await page.evaluate(() => window.__batapp_new.ui());
check("player shows the lesson title", ui.title === "Alubanche", ui.title);
check("voiced toque gets five mixer rows", ui.rows === 5, ui.rows + " rows");
const initial = await page.evaluate(() => window.__batapp_new.tracks());
check("Vox starts at volume 0", initial.find((track) => track.stem === "vox").volume === 0,
  "vox=" + initial.find((track) => track.stem === "vox").volume);
check(
  "other stems start at volume 1",
  ["iya", "ito", "oko", "beat"].every((stem) => initial.find((track) => track.stem === stem).volume === 1),
  JSON.stringify(initial.map((track) => track.stem + "=" + track.volume))
);

// Play: every stem advances, in sync, and the progress ring moves
await page.locator(".play").click();
await page.waitForTimeout(1600);
const playing = await page.evaluate(() => window.__batapp_new.tracks());
const times = playing.map((track) => track.currentTime);
const spread = Math.max(...times) - Math.min(...times);
check("Play advances every stem", times.every((time) => time > 0.4), JSON.stringify(times.map((time) => +time.toFixed(2))));
check("stems stay in sync (<120 ms spread)", spread < 0.12, "spread=" + spread.toFixed(3) + "s");
const ring = await page.evaluate(() => window.__batapp_new.ui().ringOffset);
check("progress ring advances while playing", Number(ring) >= 0 && Number(ring) < 326.7, "offset=" + ring);
await shot("04-player-playing");

// Pause / resume
await page.locator(".play").click();
await page.waitForTimeout(300);
check("Pause pauses every stem", await page.evaluate(() => window.__batapp_new.tracks().every((track) => track.paused)));
await page.locator(".play").click();
await page.waitForTimeout(400);
check("Play resumes the stems", await page.evaluate(() => window.__batapp_new.tracks().every((track) => !track.paused)));

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

// Prev / Next (DOM order: prev, next among the ghost buttons)
const ghosts = page.locator(".transport .ghost");
check("Prev is disabled on the first lesson", await ghosts.nth(0).isDisabled());
await ghosts.nth(1).click();
await page.waitForTimeout(700);
check("Next opens the next rhythm", (await page.evaluate(() => window.__batapp_new.state().lesson)) === "volume-1/02-tani-tani-cho-bi",
  await page.evaluate(() => window.__batapp_new.state().lesson));
await page.locator(".transport .ghost").nth(0).click();
await page.waitForTimeout(700);
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

// --- rotate overlay + desktop column --------------------------------------
const landscape = await browser.newPage({ viewport: { width: 844, height: 390 } });
await landscape.goto(pageUrl + "#/lesson/volume-1/01-alubanche");
await landscape.waitForTimeout(500);
const rotateState = await landscape.evaluate(() => ({
  overlay: getComputedStyle(document.getElementById("rotate")).display,
  app: getComputedStyle(document.getElementById("app")).visibility,
  size: document.getElementById("rotate").getBoundingClientRect().width
}));
check("small landscape phones show the rotate overlay",
  rotateState.overlay !== "none" && rotateState.app === "hidden" && rotateState.size > 0,
  JSON.stringify(rotateState));
await landscape.screenshot({ path: path.join(shots, "06-rotate.png") });
await landscape.close();

const desktop = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await desktop.goto(pageUrl + "#/");
await desktop.waitForTimeout(500);
const desktopState = await desktop.evaluate(() => ({
  column: document.getElementById("app").getBoundingClientRect().width,
  overlay: getComputedStyle(document.getElementById("rotate")).display
}));
check("desktop centres a portrait column (<=460px)", desktopState.column <= 460, desktopState.column + "px");
check("desktop does not show the rotate overlay", desktopState.overlay === "none", desktopState.overlay);
await desktop.screenshot({ path: path.join(shots, "07-desktop.png") });
await desktop.close();

// --- theme follows the system ---------------------------------------------
const dark = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
await dark.goto(pageUrl + "#/lesson/volume-1/01-alubanche");
await dark.waitForTimeout(700);
const darkState = await dark.evaluate(() => ({
  scheme: getComputedStyle(document.documentElement).colorScheme,
  background: getComputedStyle(document.body).backgroundColor
}));
check("dark theme follows prefers-color-scheme",
  darkState.scheme === "dark" && darkState.background === "rgb(13, 15, 19)",
  JSON.stringify(darkState));
await dark.screenshot({ path: path.join(shots, "08-dark-player.png") });
await dark.close();

// --- all 61 lessons --------------------------------------------------------
const lessons = await page.evaluate(() => window.__batapp_new.data.lessons);
const sweep = [];
for (const lesson of lessons) {
  const lessonProblems = [];
  const consoleIssues = [];
  const listener = (message) => {
    if (message.type() === "error") consoleIssues.push(message.text().slice(0, 200));
  };
  page.on("console", listener);
  await page.goto(pageUrl + "#/lesson/" + lesson.slug);
  try {
    await page.waitForFunction((slug) => window.__batapp_new.state().lesson === slug, lesson.slug, { timeout: 5000 });
    await page.waitForFunction(
      () => window.__batapp_new.tracks().every((track) => track.duration > 1 || track.error),
      null,
      { timeout: 8000 }
    );
  } catch (error) {
    lessonProblems.push("not ready: " + error.message.split("\n")[0]);
  }
  const snapshot = await page.evaluate(() => ({
    lesson: window.__batapp_new.state().lesson,
    stems: window.__batapp_new.tracks().map((track) => track.stem),
    rows: window.__batapp_new.ui().rows,
    title: window.__batapp_new.ui().title,
    errors: window.__batapp_new.tracks().filter((track) => track.error).map((track) => track.stem + ":" + track.error)
  }));
  page.off("console", listener);
  const expected = lesson.audio.map((entry) => entry.stem).sort().join(",");
  if (snapshot.lesson !== lesson.slug) lessonProblems.push("route " + snapshot.lesson);
  if (snapshot.stems.slice().sort().join(",") !== expected) lessonProblems.push("stems " + snapshot.stems.join(",") + " != " + expected);
  if (snapshot.rows !== lesson.audio.length) lessonProblems.push("rows " + snapshot.rows);
  if (snapshot.title !== lesson.title) lessonProblems.push("title " + snapshot.title);
  if (snapshot.errors.length) lessonProblems.push("audio " + snapshot.errors.join(","));
  if (consoleIssues.length) lessonProblems.push("console " + consoleIssues[0]);
  sweep.push({ slug: lesson.slug, rows: snapshot.rows, stems: snapshot.stems, passed: lessonProblems.length === 0, problems: lessonProblems });
  process.stdout.write((lessonProblems.length ? "FAIL " : "PASS ") + lesson.slug + "\n");
}
const failed = sweep.filter((result) => !result.passed);
check("all 61 lessons load in the modern layout", failed.length === 0, failed.slice(0, 3).map((result) => result.slug + ": " + result.problems.join(";")).join(" | "));
fs.writeFileSync(summaryFile, JSON.stringify({
  generated_at: new Date().toISOString(),
  target: pageUrl,
  viewport: "390x844",
  lessons: sweep.length,
  passed: sweep.length - failed.length,
  failed: failed.map((result) => result.slug),
  results: sweep
}, null, 2) + "\n");

await page.close();

// --- served over HTTP (GitHub Pages path): Web Audio gains -----------------
const port = 8153;
const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 900));
try {
  const served = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const servedErrors = [];
  served.on("console", (message) => {
    if (message.type() === "error") servedErrors.push(message.text().slice(0, 150));
  });
  served.on("pageerror", (error) => servedErrors.push("pageerror: " + error.message.slice(0, 150)));
  await served.goto(`http://127.0.0.1:${port}/index_new.html#/lesson/volume-1/01-alubanche`);
  await served.waitForFunction(
    () => window.__batapp_new && window.__batapp_new.tracks().length === 5 &&
      window.__batapp_new.tracks().every((track) => track.duration > 1 || track.error),
    null,
    { timeout: 10000 }
  );
  check("served page uses the Web Audio mixer", (await served.evaluate(() => window.__batapp_new.state().mode)) === "webaudio");
  await served.locator(".stem[data-stem='vox'] input").evaluate((input) => {
    input.value = "100";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const vox = await served.evaluate(() => window.__batapp_new.tracks().find((track) => track.stem === "vox"));
  check("Vox unmutes on HTTP (element volume stays 1, gain follows)",
    vox.gain === 1 && vox.elementVolume === 1,
    JSON.stringify({ gain: vox.gain, elementVolume: vox.elementVolume, volume: vox.volume }));
  await served.locator(".play").click();
  await served.waitForTimeout(1400);
  const servedTimes = await served.evaluate(() => window.__batapp_new.tracks().map((track) => track.currentTime));
  check("served page starts every stem together",
    servedTimes.every((time) => time > 0.3) && Math.max(...servedTimes) - Math.min(...servedTimes) < 0.12,
    JSON.stringify(servedTimes.map((time) => +time.toFixed(2))));
  check("no console errors over HTTP", servedErrors.length === 0, servedErrors.slice(0, 2).join(" | "));
  await served.close();
} finally {
  server.kill("SIGTERM");
}

await browser.close();

const fileErrors = pageErrors.filter((entry) => !entry.includes("favicon"));
check("no external network requests from the file:// page", external.length === 0, external.slice(0, 3).join(" | "));
check("no console errors during the file:// walkthrough", fileErrors.length === 0, fileErrors.slice(0, 3).join(" | "));

const report = {
  generated_at: new Date().toISOString(),
  target: pageUrl,
  checks_passed: checks.filter((entry) => entry.ok).length,
  checks_total: checks.length,
  problems,
  checks
};
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
console.log(checks.filter((entry) => entry.ok).length + "/" + checks.length + " checks passed; report: " + reportFile);
if (problems.length) {
  console.log(problems.join("\n"));
  process.exitCode = 1;
}
