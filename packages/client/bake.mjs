/**
 * bake.mjs — freeze the procedural sprites to files
 *
 * The renderer draws buildings from the workbook's twelve visual tiers at
 * runtime, which is the game's fallback whenever authored art is missing. This
 * bakes that same output to PNGs so it exists as ASSETS as well as as code —
 * a backup that survives whatever generated art replaces it, and one that can
 * be diffed, inspected, or dropped straight back in.
 *
 * It drives the real renderer through a browser rather than reimplementing it.
 * A backup drawn by a second copy of the drawing code would diverge from the
 * game the first time either changed, which is the one thing a backup must not
 * do.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = join(HERE, '../../');
const OUT = join(ROOT, 'assets/procedural');
const MANIFEST = join(ROOT, 'assets/manifest.jsonl');

function chromiumPath() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  for (const d of readdirSync(root)) {
    const c = join(root, d, 'chrome-linux/chrome');
    if (d.startsWith('chromium') && existsSync(c)) return c;
  }
  return undefined;
}

const entries = readFileSync(MANIFEST, 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l))
  .filter((e) => e.kind === 'building');

// Vite serves the page so the real modules resolve exactly as they do in the app.
const { createServer: createVite } = await import('vite');
const vite = await createVite({ root: HERE, server: { port: 4633 }, logLevel: 'error' });
await vite.listen(4633);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? chromiumPath() });
const page = await browser.newPage();
page.on('pageerror', (e) => { console.error('page error:', e.message); });
await page.goto('http://127.0.0.1:4633/bake.html', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__ready === true', { timeout: 30_000 });

console.log(`baking ${entries.length} procedural sprites…`);
let done = 0;
for (const e of entries) {
  const key = e.id.split('/')[1];
  const dataUrl = await page.evaluate((spec) => window.__bake(spec), {
    id: e.id, key, name: e.subject, category: e.category,
    level: e.tier === 0 ? 0 : Number(e.levelBand.split('-')[0]),
    era: e.era, width: e.width, height: e.height,
  });
  const file = join(OUT, e.path.replace(/^sprites\//, ''));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  if (++done % 500 === 0) console.log(`  ${done}/${entries.length}`);
}
console.log(`baked ${done} sprites to assets/procedural/`);

await browser.close();
await vite.close();
