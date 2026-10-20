/* Minimal end-to-end smoke test for the repository Playwright MCP.
 *
 * Starts the same wrapper OpenCode uses, performs the MCP handshake, lists the
 * tools, and navigates the local library page. It proves the config, wrapper,
 * Chromium path and file:// access work together.
 *
 *   cd tests && npm run mcp:smoke
 *
 * This is opt-in: the first run may download @playwright/mcp through npx.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tests = path.resolve(here, "..");
const root = path.resolve(tests, "..");
const wrapper = path.join(tests, "playwright-mcp.mjs");
const pageUrl = "file://" + path.join(root, "index.html") + "#/";
const timeoutMs = 120000;

const child = spawn(process.execPath, [wrapper], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"]
});

let sequence = 0;
let buffer = "";
const pending = new Map();
let stderr = "";

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
  if (stderr.length > 20000) stderr = stderr.slice(-20000);
  process.stderr.write(chunk);
});

function fail(message) {
  console.error("MCP smoke failed: " + message);
  try { child.kill("SIGTERM"); } catch (error) { /* already gone */ }
  process.exitCode = 1;
}

const timer = setTimeout(() => fail("timed out after " + timeoutMs + " ms"), timeoutMs);

function request(method, params) {
  const id = ++sequence;
  const message = { jsonrpc: "2.0", id: id, method: method };
  if (params !== undefined) message.params = params;
  child.stdin.write(JSON.stringify(message) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve, reject: reject });
  });
}

function notify(method, params) {
  const message = { jsonrpc: "2.0", method: method };
  if (params !== undefined) message.params = params;
  child.stdin.write(JSON.stringify(message) + "\n");
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      continue;
    }
    if (message.id === undefined || !pending.has(message.id)) continue;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }
});

child.on("error", (error) => fail(error.message));
child.on("exit", (code) => {
  if (code !== null && code !== 0 && process.exitCode !== 1) {
    fail("server exited with code " + code);
  }
});

async function main() {
  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "batapp-mcp-smoke", version: "1" }
  });
  if (!initialized || !initialized.serverInfo) throw new Error("initialize returned no serverInfo");
  notify("notifications/initialized");

  const listed = await request("tools/list", {});
  const tools = Array.isArray(listed && listed.tools) ? listed.tools : [];
  const navigate = tools.find((tool) => tool.name === "browser_navigate");
  if (!navigate) throw new Error("browser_navigate is not exposed");

  const opened = await request("tools/call", {
    name: "browser_navigate",
    arguments: { url: pageUrl }
  });
  if (!opened || opened.isError) throw new Error("browser_navigate failed");

  const snapshotTool = tools.find((tool) => tool.name === "browser_snapshot");
  let snapshot = "";
  if (snapshotTool) {
    const result = await request("tools/call", {
      name: "browser_snapshot",
      arguments: {}
    });
    if (!result || result.isError) throw new Error("browser_snapshot failed");
    snapshot = JSON.stringify(result);
    if (snapshot.indexOf("Toques") < 0 || snapshot.indexOf("Alubanche") < 0) {
      throw new Error("snapshot does not contain the library");
    }
  }

  clearTimeout(timer);
  console.log("Playwright MCP smoke OK");
  console.log("  server:  " + (initialized.serverInfo.name || "playwright") +
    " " + (initialized.serverInfo.version || ""));
  console.log("  tools:   " + tools.length);
  console.log("  page:    " + pageUrl);
  console.log("  snapshot: " + (snapshot ? "received" : "not exposed"));
  if (stderr.indexOf("Missing libraries") >= 0) {
    throw new Error("browser host libraries are missing");
  }
}

main().then(() => {
  child.stdin.end();
  const stop = setTimeout(() => {
    try { child.kill("SIGTERM"); } catch (error) { /* already gone */ }
  }, 1500);
  child.on("exit", () => clearTimeout(stop));
}).catch((error) => {
  clearTimeout(timer);
  fail(error.message);
});
