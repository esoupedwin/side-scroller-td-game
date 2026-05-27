// Use file:// URL for Windows path
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/the_e/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1400, height: 900 });

const errors = [];
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', err => errors.push(err.message));

// ── Game ──────────────────────────────────────────────────────────────────────
await page.goto('http://localhost:3000', { waitUntil: 'networkidle', timeout: 15000 });
try {
  await page.waitForFunction(
    () => !document.getElementById('loading-overlay') ||
           document.getElementById('loading-overlay').style.display === 'none',
    { timeout: 8000 }
  );
} catch { /* screenshot whatever state we're in */ }
await page.waitForTimeout(1000);
await page.screenshot({ path: 'screenshot-game.png' });
console.log('game done');

// ── Map builder ───────────────────────────────────────────────────────────────
await page.goto('http://localhost:3000/map-builder.html', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(2000);
await page.screenshot({ path: 'screenshot-mapbuilder.png' });
console.log('mapbuilder done');

await browser.close();
if (errors.length) console.error('Console errors:', errors);
