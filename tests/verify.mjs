/* Behavioural verification of the static port with a real browser.
 *
 * Opens index.html over file:// (exactly how a user double-clicks it), walks
 * every screen, exercises the mixer, and records screenshots plus a JSON report.
 *
 *   cd tests && npm run verify
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageUrl = "file://" + root + "/index.html";
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
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, lesson: el.dataset.lesson };
  });
  check(label + " shows clickable lesson cards", !!card, card ? card.lesson : "no card with data-lesson found");
  if (card) {
    await page.mouse.click(card.x, card.y);
    await page.waitForTimeout(900);
    const opened = await page.evaluate(() => window.__batapp.state().lesson);
    check(label + " card click opens the lesson player", opened === card.lesson, "opened " + opened + " from " + card.lesson);
    const sliderCount = await page.locator("#stage .el.slider-hit").count();
    check(label + " card click reaches a working mixer", sliderCount === 5, sliderCount + " sliders");
  }
}

await go("#/volumes", 900);
const selectorTargets = await page.evaluate(() =>
  Array.from(document.querySelectorAll("#stage .el.hit"))
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

// --- credits ---------------------------------------------------------------
await go("#/credits", 500);
await shot("09-credits");
const links = await page.locator("#credits a").count();
check("credits exposes the author's links", links >= 5, links + " links");

// --- file:// contract ------------------------------------------------------
const shipped = ["js/batapp.js", "js/data.js"];
for (const file of shipped) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  const bad = /\bfetch\s*\(|type\s*=\s*["']module["']|import\s+.*from\s+["']/.test(text);
  check(file + " contains no fetch/ES-module usage", !bad, bad ? "banned construct found" : "clean");
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
