/* Run the modern-layout suite across Chromium, Firefox and WebKit.
 *
 * Chromium runs the full 61-lesson sweep; Firefox/WebKit run representative
 * lessons (the suite selects them). A browser that cannot launch on this host
 * (WebKit usually needs `sudo npx playwright install-deps webkit`) is recorded
 * as unavailable instead of failing the whole run.
 *
 *   cd tests && node verify-browsers.mjs
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const summaryFile = path.join(root, "docs/verification/cross-browser-summary.json");
const browsers = ["chromium", "firefox", "webkit"];

function run(browser) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["verify-new.mjs"], {
      cwd: here,
      env: { ...process.env, BROWSER: browser },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 200000) stdout = stdout.slice(-200000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 200000) stderr = stderr.slice(-200000);
    });
    child.on("close", (code) => resolve({ code: code === null ? 1 : code, stdout, stderr }));
  });
}

const results = [];
for (const browser of browsers) {
  process.stdout.write("running " + browser + "…\n");
  const result = await run(browser);
  const reportFile = path.join(root, ".work/verification/new-ui-report-" + browser + ".json");
  let report = null;
  if (fs.existsSync(reportFile)) {
    try { report = JSON.parse(fs.readFileSync(reportFile, "utf8")); } catch (error) { /* unreadable */ }
  }
  const unavailable = !report && /Executable doesn't exist|missing dependencies|Host system is missing libraries/i.test(result.stderr);
  const status = unavailable ? "unavailable" : (result.code === 0 && report && report.problems.length === 0 ? "passed" : "failed");
  const reason = unavailable
    ? "browser could not launch on this host (run: sudo npx playwright install-deps " + browser + ")"
    : (report && report.problems.length ? report.problems.slice(0, 3).join(" | ") : "");
  const diagnostics = unavailable
    ? result.stderr.split("\n").filter((line) =>
        /Missing libraries|libgtk|libevent|gst|libavif|Executable doesn't exist|Host system/i.test(line)
      ).slice(0, 8).join("\n")
    : "";
  results.push({
    browser,
    status,
    checks_passed: report ? report.checks_passed : null,
    checks_total: report ? report.checks_total : null,
    full_sweep: report ? report.full_sweep : null,
    exit_code: result.code,
    reason,
    diagnostics
  });
  process.stdout.write(browser + ": " + status + (report ? " (" + report.checks_passed + "/" + report.checks_total + ")" : "") + "\n");
}

const summary = {
  generated_at: new Date().toISOString(),
  target: "file://" + root + "/index.html",
  note: "Chromium runs the full sweep; Firefox/WebKit run representative lessons. Real iPhone Safari and Android Chrome are covered by the manual device pass.",
  browsers: results
};
fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n");
console.log("summary: " + summaryFile);
if (results.some((entry) => entry.browser === "chromium" && entry.status !== "passed")) {
  process.exitCode = 1;
}
