/* Behavioural verification of the static port with a real browser.
 *
 * Opens index_old.html over file:// (exactly how a user double-clicks it), walks
 * every screen, exercises the mixer, and records screenshots plus a JSON report.
 *
 *   cd tests && npm run verify
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageUrl = "file://" + root + "/index_old.html";
const shots = path.join(root, ".work/screenshots");
const reportFile = path.join(root, ".work/verification/playwright-report.json");
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
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const consoleIssues = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleIssues.push(message.text().slice(0, 200));
});
page.on("pageerror", (error) => consoleIssues.push("pageerror: " + error.message.slice(0, 200)));
page.on("requestfailed", (request) => {
  consoleIssues.push("requestfailed: " + request.url().split("/").slice(-2).join("/"));
});

async function shot(name) {
  await page.screenshot({ path: path.join(shots, name + ".png") });
}

async function go(hash, wait = 700) {
  await page.goto(pageUrl + hash);
  await page.waitForTimeout(wait);
}

/* Runs in the page: report widgets whose rendered box leaves the canvas.
 * Clipping ancestors (stage masks / scroll viewports) are applied first, so
 * content that is intentionally scrolled out of view is not counted. */
function widgetGeometry() {
  const stage = document.getElementById("stage");
  const sb = stage.getBoundingClientRect();
  const scale = sb.width / parseFloat(stage.style.width);
  const canvasW = parseFloat(stage.style.width);
  const canvasH = parseFloat(stage.style.height);
  const isWidget = (node) =>
    node.classList.contains("hit") || node.classList.contains("txt") || node.classList.contains("slider-hit");
  const outside = [];
  const sliders = [];
  document.querySelectorAll("#stage .el").forEach((node) => {
    if (!isWidget(node) || !node.offsetParent) return;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return;
    const box = node.getBoundingClientRect();
    let x = (box.left - sb.left) / scale;
    let y = (box.top - sb.top) / scale;
    let x2 = x + box.width / scale;
    let y2 = y + box.height / scale;
    for (let parent = node.parentElement; parent && parent !== stage; parent = parent.parentElement) {
      const pcs = getComputedStyle(parent);
      if (pcs.overflowX !== "hidden" && pcs.overflowY !== "hidden") continue;
      const pb = parent.getBoundingClientRect();
      const px = (pb.left - sb.left) / scale;
      const py = (pb.top - sb.top) / scale;
      if (pcs.overflowX === "hidden") {
        x = Math.max(x, px);
        x2 = Math.min(x2, px + pb.width / scale);
      }
      if (pcs.overflowY === "hidden") {
        y = Math.max(y, py);
        y2 = Math.min(y2, py + pb.height / scale);
      }
    }
    if (x2 <= x || y2 <= y || box.width < 1 || box.height < 1) return;
    if (x < -0.5 || y < -0.5 || x2 > canvasW + 0.5 || y2 > canvasH + 0.5) {
      outside.push({
        cls: node.className,
        text: (node.textContent || "").trim().slice(0, 24),
        rect: [x, y, x2 - x, y2 - y].map(Math.round)
      });
    }
    if (node.classList.contains("slider-hit")) {
      sliders.push({ stem: node.dataset.stem || "", width: Math.round(x2 - x) });
    }
  });
  return {
    outside,
    sliders,
    canvas: [canvasW, canvasH],
    stage: [sb.width, sb.height],
    viewport: [window.innerWidth, window.innerHeight]
  };
}

// --- opening ---------------------------------------------------------------
await go("#/opening");
await shot("01-opening");
let surface = await page.locator("#stage > *").count();
check("opening renders", surface > 0, surface + " nodes");

await page.mouse.click(800, 450);
await page.waitForTimeout(500);
check("tap on opening opens the volume selector", page.url().includes("#/volumes"), page.url());

// --- volume selector -------------------------------------------------------
await shot("02-volume-selector");
const selectorButtons = await page.locator("#stage .el.hit").count();
check("volume selector has clickable widgets", selectorButtons > 0, selectorButtons + " hits");

// --- toque index (Volume I) ------------------------------------------------
await go("#/volume-1", 1000);
await shot("03-toque-index");
const lessonButtons = await page.locator("#stage .el.hit[data-lesson]").count();
check("toque index maps buttons to lessons", lessonButtons > 20, lessonButtons + " lesson buttons");

// --- oru seco index (Volume II) --------------------------------------------
await go("#/volume-2", 1000);
await shot("04-oru-seco-index");
const v2Buttons = await page.locator("#stage .el.hit[data-lesson]").count();
check("oru seco index maps buttons to lessons", v2Buttons > 10, v2Buttons + " lesson buttons");

// --- lesson player ---------------------------------------------------------
const lessonSlug = "volume-1/02-tani-tani-cho-bi";
await go("#/lesson/" + lessonSlug, 1200);
await shot("05-lesson-player");

const sliders = await page.locator("#stage .el.slider-hit").count();
check("player has five volume sliders", sliders === 5, sliders + " sliders");

const initial = await page.evaluate(() => window.__batapp.tracks().map((t) => ({ stem: t.stem, volume: t.volume })));
const byStem = Object.fromEntries(initial.map((t) => [t.stem, t.volume]));
check("all five stems are wired to audio files", initial.length === 5, JSON.stringify(initial.map((t) => t.stem)));
check("Vox starts at volume 0 (VolumeValueChangefromzero)", byStem.vox === 0, "vox=" + byStem.vox);
check(
  "other stems start at volume 1",
  ["iya", "ito", "oko", "beat"].every((stem) => byStem[stem] === 1),
  JSON.stringify(byStem)
);

const durations = await page.evaluate(() => window.__batapp.tracks().map((t) => t.duration));
check("audio metadata loads (durations known)", durations.every((d) => d && d > 1), JSON.stringify(durations));

// Play: every stem must advance, and stay in sync
await page.locator("#stage .el.hit[data-method='Play']").first().click();
await page.waitForTimeout(1600);
const playing = await page.evaluate(() => window.__batapp.tracks());
const times = playing.map((t) => t.currentTime);
const spread = Math.max(...times) - Math.min(...times);
check("Play advances every stem", times.every((t) => t > 0.4), JSON.stringify(times.map((t) => +t.toFixed(2))));
check("stems stay in sync (<120 ms spread)", spread < 0.12, "spread=" + spread.toFixed(3) + "s");
const spectrum = await page.evaluate(() => window.__batapp.spectrum());
check("SimpleSpectrum builds its authored 40 bars", spectrum.bars === 40, spectrum.bars + " bars");
check(
  "SimpleSpectrum bars animate while playing",
  spectrum.values.some((value) => value > 0.1),
  "max=" + Math.max(...spectrum.values).toFixed(3)
);
await shot("06-lesson-playing");

// Slider drives the stem volume
await page.locator("#stage .el.slider-hit[data-stem='iya']").evaluate((input) => {
  input.value = "0.3";
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(200);
const iyaVolume = await page.evaluate(() =>
  window.__batapp.tracks().filter((t) => t.stem === "iya")[0].volume
);
check("dragging a slider sets that stem's volume", Math.abs(iyaVolume - 0.3) < 0.02, "iya=" + iyaVolume);

// Pause / Stop
await page.locator("#stage .el.hit[data-method='Pause']").first().click();
await page.waitForTimeout(300);
const paused = await page.evaluate(() => window.__batapp.tracks().filter((t) => !t.paused).length);
check("Pause pauses every stem", paused === 0, paused + " still playing");

await page.locator("#stage .el.hit[data-method='Stop']").first().click();
await page.waitForTimeout(400);
const stopped = await page.evaluate(() => window.__batapp.tracks().map((t) => t.currentTime));
check("Stop rewinds every stem", stopped.every((t) => t < 0.25), JSON.stringify(stopped.map((t) => +t.toFixed(2))));

// Pause layer (the shipped scene's own inactive overlay)
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
let overlay = await page.evaluate(() => window.__batapp.state().overlayVisible);
check("Esc opens the pause layer", overlay, "overlayVisible=" + overlay);
await shot("07-pause-layer");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
overlay = await page.evaluate(() => window.__batapp.state().overlayVisible);
check("Esc closes the pause layer", !overlay, "overlayVisible=" + overlay);

// Prev / Next lesson
await page.locator("#stage .el.hit[data-method='LoadNextLevel']").first().click();
await page.waitForTimeout(700);
check("Next lesson advances", page.url().includes("03-oyankota"), page.url());
await page.locator("#stage .el.hit[data-method='LoadPrevLevel']").first().click();
await page.waitForTimeout(700);
check("Prev lesson steps back", page.url().includes("02-tani-tani-cho-bi"), page.url());

// A lesson with no voice stem (Volume II keeps Vox empty)
await go("#/lesson/volume-2/1-elegba", 1200);
const v2 = await page.evaluate(() => window.__batapp.tracks().map((t) => t.stem));
check("Volume II lesson loads its four stems", v2.length === 4 && !v2.includes("vox"), JSON.stringify(v2));
await shot("08-volume-2-lesson");

// --- navigation: mouse clicks, not just hash routing ----------------------
for (const [route, label] of [["#/volume-1", "toque index"], ["#/volume-2", "oru seco index"]]) {
  await go(route, 1000);
  const card = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("#stage .el.hit")).find((h) => h.dataset.lesson && h.getBoundingClientRect().width > 10);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const resolved = window.__batapp.hit(cx, cy);
    return { x: cx, y: cy, lesson: el.dataset.lesson, resolved: resolved && resolved.lesson };
  });
  check(label + " shows clickable lesson cards", !!card, card ? card.lesson : "no card with data-lesson found");
  if (card) {
    await page.mouse.click(card.x, card.y);
    await page.waitForTimeout(900);
    const opened = await page.evaluate(() => window.__batapp.state().lesson);
    // overlapping card strips exist in the shipped scenes; assert the click
    // opened the lesson the hit-test resolved at that point
    check(label + " card click opens the lesson player", !!opened && (opened === card.resolved || opened === card.lesson),
      "opened " + opened + " (element " + card.lesson + ", hit-test " + card.resolved + ")");
    const sliderCount = await page.locator("#stage .el.slider-hit").count();
    check(label + " card click reaches a working mixer", sliderCount === 5, sliderCount + " sliders");
  }
}

await go("#/volumes", 900);
const selectorTargets = await page.evaluate(() =>
  Array.from(document.querySelectorAll("#stage .el.hit[data-method]"))
    .filter((el) => el.getBoundingClientRect().width > 10)
    .map((el) => {
      const r = el.getBoundingClientRect();
      const info = window.__batapp.hit(r.left + r.width / 2, r.top + r.height / 2);
      return info ? info.method + ":" + (info.scene || "") : "none";
    })
);
check("volume selector resolves a hit for every visible button",
  selectorTargets.every((entry) => entry !== "none"),
  selectorTargets.filter((entry) => entry === "none").length + " dead");
const volumeTwo = await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll("#stage .el.hit")).find((h) => (h.dataset.scene || "").indexOf("Oru Seco") >= 0 && h.getBoundingClientRect().width > 10);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
if (volumeTwo) {
  await page.mouse.click(volumeTwo.x, volumeTwo.y);
  await page.waitForTimeout(800);
  check("selector 'Oru Seco' opens the Volume II index", page.url().includes("#/volume-2"), page.url().split("#")[1]);
}

// --- reactive layout across shapes ----------------------------------------
// The port must follow the live canvas in portrait as well as landscape: no
// orientation lock, no letterboxing, and nested widgets clamped into their
// parents (the lesson sliders used to sit at x=-15 on a 540-unit canvas).
const layoutSizes = [[720, 1440], [1080, 1920], [1600, 900], [2560, 1080]];
for (const [width, height] of layoutSizes) {
  const probe = await browser.newPage({ viewport: { width, height } });
  for (const [route, label, wait] of [
    ["#/lesson/" + lessonSlug, "lesson player", 1000],
    ["#/volumes", "volume selector", 600],
    ["#/volume-1", "toque index", 700]
  ]) {
    await probe.goto(pageUrl + route);
    await probe.waitForTimeout(wait);
    const geometry = await probe.evaluate(widgetGeometry);
    check(
      "reactive layout " + width + "x" + height + ": " + label + " has no widget outside the canvas",
      geometry.outside.length === 0,
      geometry.outside.length + " outside: " + JSON.stringify(geometry.outside.slice(0, 3))
    );
    const fills = Math.abs(geometry.stage[0] - geometry.viewport[0]) < 1 &&
      Math.abs(geometry.stage[1] - geometry.viewport[1]) < 1;
    check(
      "reactive layout " + width + "x" + height + ": " + label + " fills the viewport",
      fills,
      "stage=" + geometry.stage.map(Math.round).join("x") + " viewport=" + geometry.viewport.join("x")
    );
    if (route.indexOf("lesson") >= 0) {
      check(
        "reactive layout " + width + "x" + height + ": five sliders stay at least 200 units wide",
        geometry.sliders.length === 5 && geometry.sliders.every((slider) => slider.width >= 200),
        JSON.stringify(geometry.sliders)
      );
    }
  }
  await probe.close();
}

// --- no credit / shop / external-link surface -----------------------------
// The port ships the practice player only: no author names, no shop links and
// no third-party URLs anywhere in the rendered screens.
const bannedSurface = /Bianconcini|batangoma|Buy the book|Where to buy|Libri Video|Amazon|iTunes|Apple music|Instagram|Facebook|YouTube/i;
const bannedSeen = [];
for (const route of ["#/credits", "#/opening", "#/volumes", "#/volume-1", "#/volume-2"]) {
  await go(route, 600);
  const found = await page.evaluate((pattern) => {
    const source = document.body.innerText;
    const match = source.match(new RegExp(pattern, "i"));
    const external = Array.from(document.querySelectorAll("a[href], img[src], script[src], link[href]"))
      .map((element) => element.getAttribute("href") || element.getAttribute("src") || "")
      .filter((url) => /^https?:/i.test(url));
    return { hit: match ? match[0] : null, external };
  }, bannedSurface.source);
  if (found.hit) bannedSeen.push(route + " text:" + found.hit);
  if (found.external.length) bannedSeen.push(route + " url:" + found.external.join(","));
}
check("no author/shop text or external URL on any screen", bannedSeen.length === 0, bannedSeen.join(" | "));

// --- file:// contract ------------------------------------------------------
const shipped = ["js/batapp.js", "js/data.js", "js/lessons.js", "js/wav.js", "js/player.js", "js/newapp.js", "js/mixer.js"];
for (const file of shipped) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  const moduleUse = /type\s*=\s*["']module["']|import\s+.*from\s+["']/.test(text);
  // The modern player fetches its own audio on HTTP(S) to satisfy the load gate
  // and checksum verification. The legacy scene page keeps the fetch-free
  // mixer, and no shipped script contains an absolute URL.
  const fetchUse = /\bfetch\s*\(/.test(text);
  const externalUrl = /https?:\/\//.test(text);
  check(file + " is a classic script (no modules)", !moduleUse, moduleUse ? "module syntax found" : "clean");
  if (file === "js/player.js") {
    check(file + " fetches only same-origin audio", fetchUse && !externalUrl,
      fetchUse ? (externalUrl ? "absolute URL found" : "relative-only") : "fetch hook missing");
  } else {
    check(file + " contains no fetch()", !fetchUse, fetchUse ? "fetch found" : "clean");
  }
}

check("no console errors during the walkthrough", consoleIssues.length === 0, consoleIssues.slice(0, 3).join(" | "));

await browser.close();

const report = {
  generated_at: new Date().toISOString(),
  target: pageUrl,
  checks_passed: checks.filter((c) => c.ok).length,
  checks_total: checks.length,
  problems,
  console_issues: consoleIssues,
  checks,
  screenshots: fs.readdirSync(shots).sort()
};
fs.writeFileSync(reportFile, JSON.stringify(report, null, 1) + "\n");
console.log(
  checks.map((c) => (c.ok ? "PASS  " : "FAIL  ") + c.name + (c.detail && !c.ok ? "  -> " + c.detail : "")).join("\n")
);
console.log("\n" + report.checks_passed + "/" + report.checks_total + " checks passed; report: " + reportFile);
process.exit(problems.length ? 1 : 0);
