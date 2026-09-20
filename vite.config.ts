import { defineConfig } from 'vite';
import { resolve } from 'path';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ── App version (shown on the loading screen) ──────────────────────────────
// Base semver from package.json + the short commit SHA, so the version string
// changes on every push. On Vercel we prefer VERCEL_GIT_COMMIT_SHA (always set);
// locally we fall back to `git`, then to 'dev' if neither is available.
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };
let commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7);
if (!commit) {
  try { commit = execSync('git rev-parse --short HEAD').toString().trim(); } catch { commit = 'dev'; }
}
const APP_VERSION = `v${pkg.version} (${commit})`;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  server: {
    port: 3000,
    // Playwright MCP drops screenshots/logs here while driving the game; they
    // must not count as project changes or the page reloads mid-verification.
    watch: { ignored: ['**/.playwright-mcp/**'] },
  },
  build: {
    // es2022 so the top-level `await preloadAllSprites()` in main.ts survives the
    // build — the default 'es2020' target rejects top-level await and fails the build.
    target: 'es2022',
    rollupOptions: {
      input: {
        main:        resolve(__dirname, 'index.html'),
        mapBuilder:  resolve(__dirname, 'map-builder.html'),
      },
    },
  },
});
