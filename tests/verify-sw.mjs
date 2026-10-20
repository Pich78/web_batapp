/* Service-worker and offline-cache lifecycle verification (modern page).
 *
 * The main suite proves the happy path (first open, cached reopen, offline
 * reload, unvisited rhythm, corrupt entry). This suite owns the lifecycle that
 * only shows up across releases and failures:
 *
 *   - shell cache contents and scope;
 *   - a new shell version replaces the old shell cache but keeps Ogg source;
 *   - Clear offline audio removes audio only; the shell still starts offline;
 *   - an evicted stem fails closed while offline and names the stem;
 *   - a failed install leaves the page usable and can recover;
 *   - index_old.html never falls back to the modern shell.
 *
 * It runs against a small in-process static server because the worker script
 * itself must change between "releases", and one shell asset must be able to
 * fail on demand. Playwright route interception is deliberately not used for
 * the worker script.
 *
 *   cd tests && node verify-sw.mjs
 *   BROWSER=firefox node verify-sw.mjs
 */
import { chromium, firefox, webkit } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserName = process.env.BROWSER || "chromium";
const engines = { chromium, firefox, webkit };
const engine = engines[browserName];
if (!engine) throw new Error("Unknown BROWSER=" + browserName);
const summaryFile = path.join(root, "docs/verification/service-worker-summary.json");
const reportFile = path.join(root, ".work/verification/service-worker-report-" + browserName + ".json");
fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
fs.mkdirSync(path.dirname(reportFile), { recursive: true });

const checks = [];
const problems = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  if (!ok) problems.push(name + (detail ? " (" + detail + ")" : ""));
  process.stdout.write((ok ? "PASS " : "FAIL ") + name + "\n");
}

const modernHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const appVersion = (modernHtml.match(/<meta name="batapp-version" content="([^"]+)">/) || [])[1];
if (!appVersion) throw new Error("index.html has no batapp-version meta");
const baseSwSource = fs.readFileSync(path.join(root, "sw.js"), "utf8");

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ogg": "audio/ogg",
  ".ico": "image/x-icon"
};

// Mutable "deployment" state. The worker picks up SHELL_VERSION when the test
// asks for a new release; failAsset simulates one shell asset returning 404.
const deployment = {
  shellVersion: appVersion,
  failAsset: null
};

function workerSource() {
  return baseSwSource.replace(
    /var SHELL_VERSION = "[^"]+";/,
    'var SHELL_VERSION = "' + deployment.shellVersion + '";'
  );
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function serveFile(req, res, pathname) {
  if (deployment.failAsset && pathname === deployment.failAsset) {
    send(res, 404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, "not found");
    return;
  }
  let relative = pathname.replace(/^\/+/, "");
  if (!relative || relative.endsWith("/")) relative += "index.html";
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) {
    send(res, 403, { "Content-Type": "text/plain; charset=utf-8" }, "forbidden");
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    send(res, 404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, "not found");
    return;
  }
  const extension = path.extname(file).toLowerCase();
  const headers = {
    "Content-Type": types[extension] || "application/octet-stream",
    "Cache-Control": "no-store",
    "Content-Length": String(fs.statSync(file).size)
  };
  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, { "Allow": "GET, HEAD" }, "");
    return;
  }
  let parsed;
  try {
    parsed = new URL(req.url, "http://127.0.0.1");
  } catch (error) {
    send(res, 400, { "Content-Type": "text/plain" }, "bad request");
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch (error) {
    send(res, 400, { "Content-Type": "text/plain" }, "bad request");
    return;
  }
  if (pathname === "/sw.js") {
    const body = workerSource();
    send(res, 200, {
      "Content-Type": types[".js"],
      "Cache-Control": "no-store",
      "Content-Length": String(Buffer.byteLength(body))
    }, body);
    return;
  }
  serveFile(req, res, pathname);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
const base = "http://127.0.0.1:" + port;
const libraryUrl = base + "/index.html#/";
const lessonSlug = "volume-1/02-tani-tani-cho-bi";
const lessonUrl = base + "/index.html#/lesson/" + lessonSlug;

const browser = await engine.launch();
const suiteWatchdog = setTimeout(() => {
  console.error("verify-sw timed out after 10 minutes");
  process.exit(1);
}, 10 * 60 * 1000);
suiteWatchdog.unref();

async function newContext() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  if (browserName === "webkit") {
    await context.addInitScript(() => { window.__batappNoMediaSource = true; });
  }
  return context;
}

async function waitForController(page) {
  await page.waitForFunction(
    () => !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    null,
    { timeout: 15000 }
  );
}

async function waitForLesson(page) {
  await page.waitForFunction(() => {
    const state = window.__batapp_new.state();
    return state.lesson && !state.loading && !state.error && state.loaded;
  }, null, { timeout: 60000 });
}

async function waitForError(page) {
  await page.waitForSelector(".loading.error", { timeout: 30000 });
}

async function waitUntil(predicate, timeout = 15000, interval = 100) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

function rootTitle() {
  return "Batá · Toques & Oru Seco";
}

async function cacheSnapshot(page) {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const shells = {};
    for (const name of names) {
      if (name.indexOf("batapp-shell-") !== 0) continue;
      const cache = await caches.open(name);
      shells[name] = (await cache.keys()).map((request) => new URL(request.url).pathname);
    }
    let audio = null;
    if (names.indexOf("batapp-audio-v1") >= 0) {
      const cache = await caches.open("batapp-audio-v1");
      audio = (await cache.keys()).map((request) => new URL(request.url).pathname);
    }
    return { names, shells, audio };
  });
}

async function openCachedLesson(context) {
  const page = await context.newPage();
  await page.goto(lessonUrl, { waitUntil: "domcontentloaded" });
  await waitForController(page);
  await waitForLesson(page);
  const snapshot = await cacheSnapshot(page);
  check("first open stores five Ogg stems in the audio cache",
    snapshot.audio && snapshot.audio.length === 5 &&
    snapshot.audio.every((path) => path.indexOf("/assets/audio/" + lessonSlug + "/") >= 0 && path.endsWith(".ogg")),
    JSON.stringify(snapshot.audio));
  return page;
}

try {
  // --- 1. shell cache contents and navigation scope ------------------------
  {
    const context = await newContext();
    const page = await context.newPage();
    await page.goto(libraryUrl, { waitUntil: "domcontentloaded" });
    await waitForController(page);
    const shellName = "batapp-shell-" + appVersion;
    const allowed = [
      "/index.html",
      "/app-new.css",
      "/js/lessons.js",
      "/js/offline.js",
      "/js/wav.js",
      "/js/player.js",
      "/js/newapp.js",
      "/site.webmanifest",
      "/assets/icon.svg",
      "/assets/icon-16.png",
      "/assets/icon-32.png",
      "/assets/icon-180.png",
      "/assets/icon-192.png",
      "/assets/icon-512.png"
    ];
    const snapshot = await cacheSnapshot(page);
    const shell = snapshot.shells[shellName] || [];
    check("the shell cache uses the release version",
      snapshot.names.filter((name) => name.indexOf("batapp-shell-") === 0).join(",") === shellName,
      JSON.stringify(snapshot.names));
    check("the shell cache contains the modern app shell only",
      shell.length > 0 &&
      shell.every((path) => allowed.indexOf(path) >= 0 || path === "/") &&
      !shell.some((path) => path.indexOf("/assets/audio/") >= 0 ||
        path.endsWith(".wav") || path.indexOf("index_old.html") >= 0),
      JSON.stringify(shell));
    check("opening the library creates no audio cache", snapshot.audio === null,
      JSON.stringify(snapshot.audio));

    await context.setOffline(true);
    await page.goto(base + "/?offline=1#/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll(".row").length === 38, null, { timeout: 10000 });
    check("the shell starts the modern app offline from the scope root",
      page.url().indexOf(base + "/") === 0 &&
      (await page.evaluate(() => document.title)) === rootTitle(),
      JSON.stringify({ url: page.url(), title: await page.evaluate(() => document.title) }));

    await page.goto(base + "/index.html#/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll(".row").length === 38, null, { timeout: 10000 });
    check("the shell starts the modern app offline from index.html",
      (await page.evaluate(() => document.title)) === rootTitle(),
      JSON.stringify({ url: page.url(), title: await page.evaluate(() => document.title) }));

    const legacyPage = await context.newPage();
    let legacyFailed = false;
    try {
      await legacyPage.goto(base + "/index_old.html", { waitUntil: "domcontentloaded", timeout: 8000 });
    } catch (error) {
      legacyFailed = /ERR_INTERNET_DISCONNECTED|NS_ERROR_OFFLINE|load failed/i.test(error.message);
    }
    const legacyTitle = legacyFailed ? "" : await legacyPage.title().catch(() => "");
    check("index_old.html is not served from the modern shell cache",
      legacyFailed || legacyTitle.indexOf("scene port") < 0,
      JSON.stringify({ failed: legacyFailed, title: legacyTitle }));
    await legacyPage.close();
    await context.setOffline(false);
    await context.close();
  }

  // --- 2. new shell release retains audio source --------------------------
  {
    const context = await newContext();
    const page = await openCachedLesson(context);
    const before = await cacheSnapshot(page);
    check("the audio cache is kept separate from the shell cache",
      before.audio.length === 5 &&
      before.names.includes("batapp-audio-v1") &&
      before.names.some((name) => name.indexOf("batapp-shell-") === 0),
      JSON.stringify(before.names));

    deployment.shellVersion = "v9.9.9";
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error("no service worker registration");
      await registration.update();
    });
    const newShell = await waitUntil(() => page.evaluate(async () => {
      const names = await caches.keys();
      return names.indexOf("batapp-shell-v9.9.9") >= 0;
    }), 30000);
    check("a new shell release installs the new cache", newShell,
      JSON.stringify(await cacheSnapshot(page)));
    const oldShellGone = await waitUntil(() => page.evaluate(async (version) => {
      const names = await caches.keys();
      return names.indexOf("batapp-shell-" + version) < 0;
    }, appVersion), 30000);
    const after = await cacheSnapshot(page);
    check("activating a new shell release deletes the old shell cache",
      oldShellGone &&
      !after.shells["batapp-shell-" + appVersion] &&
      !after.names.includes("batapp-shell-" + appVersion),
      JSON.stringify(after.names));
    check("a new shell release keeps the cached Ogg source",
      after.audio && after.audio.length === 5 &&
      after.audio.every((path) => path.endsWith(".ogg")),
      JSON.stringify(after.audio));

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForLesson(page);
    const offline = await page.evaluate(() => ({
      state: window.__batapp_new.state(),
      fromCache: window.__batapp_new.tracks().map((track) => track.fromCache)
    }));
    check("the updated shell and retained audio still open offline",
      offline.state.loaded && !offline.state.error && offline.fromCache.every(Boolean),
      JSON.stringify({ state: offline.state, fromCache: offline.fromCache }));
    await context.setOffline(false);
    await context.close();
  }

  // --- 3. Clear offline audio removes audio only ---------------------------
  {
    const context = await newContext();
    const page = await openCachedLesson(context);
    await page.locator("#app-info-button").click();
    await page.waitForFunction(
      () => document.getElementById("app-info-panel").innerText.includes("1/61 rhythms cached"),
      null,
      { timeout: 10000 }
    );
    await page.locator(".app-info-reload", { hasText: "Clear offline audio" }).click();
    const clearedOk = await waitUntil(
      () => page.evaluate(async () => !(await caches.has("batapp-audio-v1"))),
      10000
    );
    const cleared = await cacheSnapshot(page);
    check("Clear offline audio removes the audio cache", clearedOk,
      JSON.stringify(cleared.names));
    check("Clear offline audio keeps the shell cache",
      cleared.names.some((name) => name.indexOf("batapp-shell-") === 0),
      JSON.stringify(cleared.names));

    await page.keyboard.press("Escape");
    await context.setOffline(true);
    await page.goto(base + "/index.html#/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll(".row").length === 38, null, { timeout: 10000 });
    check("the shell still opens offline after clearing audio",
      (await page.evaluate(() => document.title)) === rootTitle(),
      JSON.stringify({ url: page.url(), title: await page.evaluate(() => document.title) }));

    await page.goto(lessonUrl, { waitUntil: "domcontentloaded" });
    await waitForError(page);
    const error = await page.evaluate(() => ({
      state: window.__batapp_new.state(),
      detail: (document.querySelector(".load-detail") || {}).textContent || ""
    }));
    check("a cleared rhythm is named unavailable offline",
      error.state.error && error.detail.indexOf("not available offline") >= 0,
      JSON.stringify(error));
    await context.setOffline(false);
    await context.close();
  }

  // --- 4. an evicted stem while offline fails closed -----------------------
  {
    const context = await newContext();
    const page = await openCachedLesson(context);
    await context.setOffline(true);
    await page.evaluate(async (slug) => {
      const cache = await caches.open("batapp-audio-v1");
      const key = new URL("assets/audio/" + slug + "/iya.ogg", document.baseURI).href;
      await cache.delete(new Request(key));
    }, lessonSlug);
    await page.goto(base + "/index.html#/", { waitUntil: "domcontentloaded" });
    await page.goto(lessonUrl, { waitUntil: "domcontentloaded" });
    await waitForError(page);
    const error = await page.evaluate(() => ({
      message: (document.querySelector(".load-status") || {}).textContent || "",
      detail: (document.querySelector(".load-detail") || {}).textContent || ""
    }));
    check("an evicted stem while offline fails closed and names the stem",
      error.message.indexOf("Iya") >= 0 && error.detail.indexOf("not available offline") >= 0,
      JSON.stringify(error));
    await context.setOffline(false);
    await context.close();
  }

  // --- 5. install failure leaves the page usable and recovers --------------
  {
    const context = await newContext();
    const page = await context.newPage();
    deployment.failAsset = "/js/wav.js";
    await page.goto(libraryUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const failedInstall = await page.evaluate(async () => {
      const names = (await caches.keys()).filter((name) => name.indexOf("batapp-shell-") === 0);
      const shellEntries = {};
      for (const name of names) {
        const cache = await caches.open(name);
        shellEntries[name] = (await cache.keys()).length;
      }
      return {
        controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
        shellCaches: names,
        shellEntries
      };
    });
    check("a failed shell install does not claim the page",
      !failedInstall.controller &&
      failedInstall.shellCaches.every((name) => failedInstall.shellEntries[name] === 0),
      JSON.stringify(failedInstall));
    check("the page stays usable after a failed shell install",
      (await page.evaluate(() => document.querySelectorAll(".row").length)) === 38 &&
      (await page.evaluate(() => document.title)) === rootTitle(),
      await page.evaluate(() => document.title));

    deployment.failAsset = null;
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForController(page);
    const recovered = await cacheSnapshot(page);
    check("a later install succeeds after the shell asset recovers",
      recovered.names.some((name) => name.indexOf("batapp-shell-") === 0) &&
      (await page.evaluate(() => document.querySelectorAll(".row").length)) === 38,
      JSON.stringify(recovered.names));
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  clearTimeout(suiteWatchdog);
}

const report = {
  generated_at: new Date().toISOString(),
  browser: browserName,
  target: base,
  app_version: appVersion,
  checks_passed: checks.filter((entry) => entry.ok).length,
  checks_total: checks.length,
  problems,
  checks
};
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
if (browserName === "chromium") {
  const summary = Object.assign({}, report, {
    target: "local static server (dynamic port) /index.html"
  });
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n");
}
console.log(browserName + ": " + report.checks_passed + "/" + report.checks_total +
  " checks passed; report: " + reportFile);
if (problems.length) process.exitCode = 1;
