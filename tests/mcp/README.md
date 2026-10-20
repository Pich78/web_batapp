# Playwright MCP (development only)

This repository carries its own Playwright MCP server configuration so an
agent can inspect the app with the same browser installation as the test suite.
It is development tooling only: the shipped app remains plain HTML/CSS/classic
JavaScript with no Node or MCP dependency.

## Files

| file | purpose |
|---|---|
| `opencode.json` | project-level OpenCode config; registers `batapp-playwright` under `mcp.servers` |
| `tests/playwright-mcp.mjs` | wrapper; resolves the test Chromium and launches the pinned MCP package |
| `tests/mcp/config-check.mjs` | fast check of the config, wrapper, browser path and flags |
| `tests/mcp/smoke.mjs` | opt-in end-to-end MCP handshake + file:// navigation |
| `tests/mcp/README.md` | this playbook |

OpenCode V2 places servers under `mcp.servers`; a server name is not a direct
child of `mcp`.

## Setup

The Playwright test browser must already be installed:

```bash
cd tests
npm ci
npx playwright install chromium
```

Check the wiring without starting a browser:

```bash
cd tests
npm run mcp:check
```

Expected result:

```text
Playwright MCP configuration OK
```

Start the MCP from OpenCode with `opencode mcp list`; `batapp-playwright` should
be connected. The menu item `/mcps` shows the same state.

The wrapper uses a locally installed `@playwright/mcp` when present. Otherwise
it runs the pinned `@playwright/mcp@0.0.83` through `npx`; the first start may
need network access. Set `PLAYWRIGHT_MCP_PACKAGE` to test another pin.

The wrapper reuses the Chromium reported by `tests/node_modules/playwright`.
That avoids a second browser download and keeps the MCP on the same engine as
the regression suite. Override the viewport with `MCP_VIEWPORT`, or run headed
with `MCP_HEADED=1`.

## Smoke test

```bash
cd tests
npm run mcp:smoke
```

This starts the same wrapper OpenCode uses, performs the MCP handshake, lists
the tools, navigates to `file://.../index.html#/`, and requests a snapshot. It
does not test audible playback.

## Playbook

Use the MCP for exploration and visual checks; use `tests/verify-new.mjs` as the
deterministic regression gate.

### Library

1. Navigate to `file://<absolute repo root>/index.html#/`.
2. Snapshot the page; expect the Toques / Oru Seco tabs and 38 rows.
3. Resize to `390x844`, `480x320`, `768x1024`, `900x600` and `1440x900`.
4. Confirm the app-info button stays inside the app shell and does not cover
   the brand.

### Lesson and transport

1. Navigate to `#/lesson/volume-1/01-alubanche`.
2. Wait for the loading gate to finish; expect the title, seek bar, speed
   controls and five mixer rows.
3. Use `browser_evaluate` with the read-only hook:
   `window.__batapp_new.state()`, `window.__batapp_new.tracks()`,
   `window.__batapp_new.ui()`.
4. Click Play/Pause/Stop and check the hook after each action.
5. Do not claim audible correctness: headless Chromium can verify state,
   positions, element counts and network activity, but not sound. The manual
   device pass remains authoritative for audio.

### HTTP load gate

1. Start a local server from the repository root:
   `python3 -m http.server 8153 --bind 127.0.0.1`.
2. Navigate to `http://127.0.0.1:8153/index.html#/lesson/volume-1/01-alubanche`.
3. Confirm the network panel shows five verified stem requests, the player only
   appears after the last one, and the app-info panel reports `WAV ×5`.
4. Never publish or commit captured audio or private network data.

### Offline source cache

- Open a lesson online and wait for it to become ready.
- Inspect `caches.open("batapp-audio-v1").keys()` with `browser_evaluate`:
  entries must be `.ogg` only, never `.wav`.
- Reload that lesson: the second open must make no `/assets/audio/` request and
  `window.__batapp_new.tracks()` must report `fromCache: true`.
- The service worker must be active for the app shell. Playwright's
  `context.setOffline(true)` is the deterministic offline test; the MCP browser
  UI does not expose a network-offline toggle.
- Open an unvisited rhythm offline: it must fail with “This rhythm is not
  available offline.”
- App-info must show cached-rhythm count, storage use and Clear offline audio.

### Error and edge cases

- Malformed hash: `#/lesson/%E0%A4%A` must recover to `#/`.
- Unknown slug: `#/lesson/not-a-lesson` must recover to `#/`.
- Rapid speed clicks and a speed click followed by Pause must preserve the
  playback position; these are covered by `verify-new.mjs`.
- Stalled transfers must fail with a named timeout error; covered by
  `verify-new.mjs`.

## Artifacts

The wrapper writes generated snapshots and screenshots under
`.work/playwright-mcp/`, which is git-ignored. Do not commit those artifacts or
copy the stale `.playwright-mcp/` snapshots from another checkout; regenerate
them here when needed.

## Security

`--allow-unrestricted-file-access` is required so the MCP can open this
repository's `file://` URLs. Use this server for local repository pages only;
do not point it at untrusted sites or expose it over a network.
