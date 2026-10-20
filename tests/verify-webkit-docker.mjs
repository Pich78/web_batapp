/* Run the modern-page suite in WebKit without installing host libraries.
 *
 * The official Playwright image already contains WebKit and its system
 * dependencies. This wrapper mounts the checkout and runs the same
 * verify-new.mjs in the image, as the invoking uid/gid so generated files stay
 * owned by the developer.
 *
 *   cd tests && npm run verify-webkit:docker
 *
 * Requires Docker (the invoking user must be able to run it). No sudo and no
 * host WebKit installation are needed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const playwrightVersion = require("playwright/package.json").version;
const image = process.env.WEBKIT_IMAGE || "mcr.microsoft.com/playwright:v" + playwrightVersion + "-jammy";

const dockerCheck = spawnSync("docker", ["--version"], { encoding: "utf8" });
if (dockerCheck.error || dockerCheck.status !== 0) {
  console.error("Docker is required for the WebKit container run.");
  console.error("Install Docker, or install WebKit host libraries with:");
  console.error("  sudo npx playwright install-deps webkit");
  process.exit(1);
}

const args = [
  "run", "--rm", "--ipc=host",
  "-e", "HOME=/tmp",
  "-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
  "-e", "BROWSER=webkit",
  "-v", root + ":/work",
  "-w", "/work/tests"
];
if (typeof process.getuid === "function" && typeof process.getgid === "function") {
  args.push("--user", process.getuid() + ":" + process.getgid());
}
args.push(image, "node", "verify-new.mjs");

console.log("WebKit container: " + image);
console.log("checkout:        " + root);
const child = spawn("docker", args, { stdio: "inherit", env: process.env });
child.on("error", (error) => {
  console.error("Could not start Docker: " + error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = typeof code === "number" ? code : 1;
});
