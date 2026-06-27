---
name: run
description: Launch and drive the COIN tower-defence game (PixiJS + Vite) to verify a change in the real app. Use when asked to run, start, screenshot, or manually verify the game or the map-builder.
---

# Run the COIN game

Browser-driven app: PixiJS v7 + Vite + TypeScript. Two pages served by one dev
server — the game (`/`) and the map-builder editor (`/map-builder.html`).

The game canvas is rendered by PixiJS, so an accessibility snapshot shows almost
nothing of the gameplay — **observe with screenshots**. The HTML chrome (spawn
buttons, dev bar, pause menu, modals) *is* real DOM and can be clicked/snapshotted.

## 1. Start the dev server (persistent)

Start it as a real background task so it survives across turns. Do **not** use a
`&`-detached subshell — when the wrapper shell exits it can orphan/kill vite.

Use the Bash tool with `run_in_background: true`:

```bash
npm run dev
```

Port is pinned to **3000** in `vite.config.ts`. Wait for it, then confirm:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/   # expect 200
```

If `npm run dev` isn't already running, the curl returns nothing / a non-200 —
start it first.

## 2. Drive it with the Playwright MCP browser tools

Load them via ToolSearch (they're deferred):
`select:mcp__playwright__browser_navigate,mcp__playwright__browser_take_screenshot,mcp__playwright__browser_press_key,mcp__playwright__browser_snapshot,mcp__playwright__browser_click`

Then:

1. `browser_navigate` → `http://localhost:3000/` (game) or
   `http://localhost:3000/map-builder.html` (editor).
2. The game **auto-starts** — no click-to-start gate. A loading screen
   (`#loading-screen`) shows while sprites preload (`await preloadAllSprites()`),
   then fades out (gains class `fade-out`). Give it ~2–3s before screenshotting
   gameplay (a blank/loading frame means you screenshotted too early).
3. `browser_take_screenshot` and **look at it** — a battlefield with two towers,
   ground, and a HUD means it launched. A blank frame is a failure.

### Driving the game

Spawn units by clicking the DOM spawn buttons at the bottom (ids
`spawn-<type>-btn`, e.g. `spawn-warrior-btn`, `spawn-gunslinger-btn`) — only the
active tribe's roster is visible. Key bindings:

| Key | Action |
|---|---|
| `Space` | Pause / resume |
| `Escape` | Pause menu (Resume / Restart Game / Key Bindings) |
| `Z` | Character command panel (slow-mo) |
| `P` | Toggle developer bar (hidden by default) |
| `M` | Mute / unmute |
| Arrows | Pan the camera |
| `B` | Toggle collision boxes & range markers |
| `K` / `L` / `J` | Cheats: +coins player / +coins CPU / force coin drop |

Send keys with `browser_press_key` (e.g. `Escape`, `Space`, `p`). After a key or
click that changes UI, screenshot again to confirm. To act on a DOM element first
`browser_snapshot` to get its ref, then `browser_click`.

## 3. Expected console state

One **benign** console error on load: `favicon.ico 404`. Ignore it. Any *other*
error (failed module, sprite/runtime exception) is a real problem worth reporting.

## 4. Cleanup

Stop the background dev-server task when finished (TaskStop, or kill the
`run_in_background` task). Leaving it running is fine if you'll keep iterating.
