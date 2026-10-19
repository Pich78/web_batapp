/* Per-lesson browser sweep: every lesson route must load its stems, build the
 * five-slider mixer, keep every visible widget inside the canvas and leave no
 * console/network errors.  Development-only; the shipped app has no test hooks
 * beyond the read-only window.__batapp object. */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageUrl = "file://" + root + "/index.html";
const reportFile = path.join(root, ".work/verification/lesson-sweep.json");
const summaryFile = path.join(root, "docs/verification/lesson-sweep-summary.json");
const viewport = { width: 720, height: 1440 };
fs.mkdirSync(path.dirname(reportFile), { recursive: true });

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const page = await browser.newPage({ viewport });
const consoleIssues = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleIssues.push(message.text().slice(0, 220));
});
page.on("pageerror", (error) => consoleIssues.push("pageerror: " + error.message.slice(0, 220)));
page.on("requestfailed", (request) => {
  consoleIssues.push("requestfailed: " + request.url().split("/").slice(-3).join("/"));
});

await page.goto(pageUrl + "#/opening");
await page.waitForTimeout(300);
const lessons = await page.evaluate(() => window.__batapp.data.lessons);
const results = [];

/* Runs in the page; same clipping-aware metric as tests/verify.mjs. */
function geometry() {
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
      outside.push({ text: (node.textContent || "").trim().slice(0, 24), rect: [x, y, x2 - x, y2 - y].map(Math.round) });
    }
    if (node.classList.contains("slider-hit")) sliders.push({ stem: node.dataset.stem || "", width: Math.round(x2 - x) });
  });
  return { outside, sliders, canvas: [canvasW, canvasH] };
}

for (const lesson of lessons) {
  const problems = [];
  consoleIssues.length = 0;
  await page.goto(pageUrl + "#/lesson/" + lesson.slug);
  try {
    await page.waitForFunction(
      (slug) => window.__batapp.state().lesson === slug,
      lesson.slug,
      { timeout: 5000 }
    );
    await page.waitForFunction(
      () => window.__batapp.tracks().every((track) => track.duration > 1 || track.error),
      null,
      { timeout: 8000 }
    );
  } catch (error) {
    problems.push("lesson did not become ready: " + error.message.split("\n")[0]);
  }
  const state = await page.evaluate(() => ({
    lesson: window.__batapp.state().lesson,
    tracks: window.__batapp.tracks().map((track) => ({
      stem: track.stem,
      duration: track.duration,
      error: track.error,
      readyState: track.readyState
    })),
    title: document.body.innerText.slice(0, 2000)
  }));
  const expectedStems = lesson.audio.map((entry) => entry.stem).sort();
  const actualStems = state.tracks.map((track) => track.stem).sort();
  if (state.lesson !== lesson.slug) problems.push("route state is " + state.lesson);
  if (JSON.stringify(actualStems) !== JSON.stringify(expectedStems)) {
    problems.push("stems " + JSON.stringify(actualStems) + " != " + JSON.stringify(expectedStems));
  }
  state.tracks.forEach((track) => {
    if (track.error) problems.push(track.stem + " audio error " + track.error);
    else if (!(track.duration > 1)) problems.push(track.stem + " has no duration");
  });
  if (state.title.indexOf(lesson.title) < 0) problems.push("title missing: " + lesson.title);
  const layout = await page.evaluate(geometry);
  if (layout.outside.length) problems.push(layout.outside.length + " widget(s) outside canvas");
  if (layout.sliders.length !== 5) problems.push(layout.sliders.length + " sliders");
  if (layout.sliders.some((slider) => slider.width < 200)) {
    problems.push("narrow slider: " + JSON.stringify(layout.sliders));
  }
  if (consoleIssues.length) problems.push("console: " + consoleIssues.slice(0, 2).join(" | "));
  results.push({
    slug: lesson.slug,
    scene: lesson.scene_stem,
    stems: actualStems,
    sliders: layout.sliders,
    passed: problems.length === 0,
    problems
  });
  process.stdout.write((problems.length ? "FAIL " : "PASS ") + lesson.slug + "\n");
}

await browser.close();
const failures = results.filter((result) => !result.passed);
const report = {
  generated_at: new Date().toISOString(),
  target: pageUrl,
  viewport,
  lessons: results.length,
  passed: results.length - failures.length,
  failed: failures.length,
  failures,
  results
};
const summary = {
  generated_at: report.generated_at,
  target: report.target,
  viewport,
  lessons: report.lessons,
  passed: report.passed,
  failed: report.failed,
  failures: report.failures,
  checks: [
    "lesson route reaches the requested lesson",
    "stem set matches the generated audio list",
    "every stem reports a duration",
    "the lesson title is rendered",
    "five sliders, each at least 200 canvas units wide",
    "no visible widget outside the canvas",
    "no console or request errors"
  ]
};
fs.writeFileSync(reportFile, JSON.stringify(report, null, 1) + "\n");
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 1) + "\n");
console.log("\n" + report.passed + "/" + report.lessons + " lessons passed; report: " + reportFile);
process.exit(failures.length ? 1 : 0);
