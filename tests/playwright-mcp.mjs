/* Launch the Playwright MCP server for this repository.
 *
 * OpenCode starts this wrapper through `opencode.json`. Keeping the launch
 * here (instead of hard-coding a machine-specific Chrome path in the config)
 * lets the MCP reuse the Chromium that the Playwright test suite already has.
 *
 * Development only: Node, Playwright and @playwright/mcp are not part of the
 * shipped app.
 *
 *   node tests/playwright-mcp.mjs --print   # show the resolved command
 *   node tests/playwright-mcp.mjs           # start the stdio MCP server
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const executable = chromium.executablePath();
const outputDir = path.join(root, ".work", "playwright-mcp");
const mcpPackage = process.env.PLAYWRIGHT_MCP_PACKAGE || "@playwright/mcp@0.0.83";
const localBinary = path.join(here, "node_modules", ".bin",
  process.platform === "win32" ? "playwright-mcp.cmd" : "playwright-mcp");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const useLocal = fs.existsSync(localBinary);
const command = useLocal ? localBinary : npx;
const args = useLocal ? [] : ["-y", mcpPackage];
if (process.env.MCP_HEADED !== "1") args.push("--headless");
args.push(
  "--allow-unrestricted-file-access",
  "--console-level", process.env.MCP_CONSOLE_LEVEL || "warning",
  "--output-dir", outputDir,
  "--isolated",
  "--viewport-size", process.env.MCP_VIEWPORT || "390x844",
  "--executable-path", executable
);

if (process.argv.includes("--print")) {
  process.stdout.write(JSON.stringify({
    command: command,
    args: args,
    executable: executable,
    outputDir: outputDir,
    cwd: root
  }, null, 2) + "\n");
  process.exit(0);
}

if (!fs.existsSync(executable)) {
  process.stderr.write(
    "Playwright Chromium is missing at " + executable + ".\n" +
    "Install the test browser once with: cd tests && npx playwright install chromium\n"
  );
  process.exit(1);
}
if (!useLocal) {
  process.stderr.write(
    "@playwright/mcp is not installed locally; using npx " + mcpPackage + ".\n" +
    "The first MCP start may need network access to fetch that package.\n"
  );
}
fs.mkdirSync(outputDir, { recursive: true });

const child = spawn(command, args, {
  cwd: root,
  env: process.env,
  stdio: "inherit"
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, function () {
    try { child.kill(signal); } catch (error) { /* already gone */ }
  });
}
child.on("error", function (error) {
  process.stderr.write("Could not start Playwright MCP: " + error.message + "\n");
  process.exitCode = 1;
});
child.on("exit", function (code, signal) {
  if (signal) {
    process.exitCode = 0;
    return;
  }
  process.exitCode = typeof code === "number" ? code : 1;
});
