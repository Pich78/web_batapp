/* Check the repository-level Playwright MCP wiring without starting a browser.
 *
 *   cd tests && npm run mcp:check
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tests = path.resolve(here, "..");
const root = path.resolve(tests, "..");
const wrapper = path.join(tests, "playwright-mcp.mjs");
const configFile = path.join(root, "opencode.json");
const problems = [];

let config = null;
try {
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
} catch (error) {
  problems.push("opencode.json is not readable JSON: " + error.message);
}

const server = config && config.mcp && config.mcp.servers &&
  config.mcp.servers["batapp-playwright"];
if (!server) {
  problems.push("opencode.json is missing mcp.servers.batapp-playwright");
} else {
  if (server.type !== "local") problems.push("batapp-playwright must be type local");
  if (!Array.isArray(server.command) || server.command.length < 2) {
    problems.push("batapp-playwright has no command");
  }
  if (server.disabled === true) problems.push("batapp-playwright is disabled");
}

let spec = null;
try {
  spec = JSON.parse(execFileSync(process.execPath, [wrapper, "--print"], {
    cwd: root,
    encoding: "utf8"
  }));
} catch (error) {
  problems.push("wrapper --print failed: " + (error.stderr || error.message).trim());
}

if (spec) {
  if (!fs.existsSync(spec.executable)) {
    problems.push("Playwright Chromium is missing: " + spec.executable);
  }
  if (spec.outputDir.indexOf(path.join(".work", "playwright-mcp")) < 0) {
    problems.push("MCP output dir is not under .work: " + spec.outputDir);
  }
  for (const flag of ["--headless", "--allow-unrestricted-file-access",
    "--executable-path", "--output-dir", "--isolated"]) {
    if (spec.args.indexOf(flag) < 0) problems.push("wrapper is missing " + flag);
  }
}

if (problems.length) {
  console.error("Playwright MCP configuration check failed:");
  for (const problem of problems) console.error(" - " + problem);
  process.exitCode = 1;
} else {
  console.log("Playwright MCP configuration OK");
  console.log("  config:     " + path.relative(root, configFile));
  console.log("  wrapper:    " + path.relative(root, wrapper));
  console.log("  command:    " + spec.command + " " + spec.args.join(" "));
  console.log("  chromium:   " + spec.executable);
  console.log("  output:     " + spec.outputDir);
}
