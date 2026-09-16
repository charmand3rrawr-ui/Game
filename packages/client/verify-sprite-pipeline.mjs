/**
 * verify-sprite-pipeline.mjs — proves authored art can land one file at a time
 *
 * The renderer draws buildings procedurally until a sprite exists at the path
 * `assets/manifest.jsonl` names, at which point the sprite takes over with no
 * code change. That claim is the whole reason 5,943 pieces of art can be drawn
 * over months without a migration, and it is exactly the kind of claim that
 * quietly stops being true.
 *
 * So this tests it end to end, against a real browser and a real static server:
 * drop a file in, confirm the pixels reach the page, take it out again.
 *
 * It generates its own sprite rather than committing one, because a fake Farm
 * in the repository would eventually be mistaken for real art, and would make
 * the ledger claim an asset was done when nobody had drawn it.
 *
 *     node packages/client/verify-sprite-pipeline.mjs
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const PUBLIC = join(HERE, 'public');
const DIST = join(HERE, 'dist');
/** A building the seeded world always has, at the tier its level falls in. */
const TARGET = 'sprites/buildings/1_farm/t1.png';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.map': 'application/json' };

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};

function chromiumPath() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith('chromium')) continue;
    const c = join(root, dir, 'chrome-linux/chrome');
    if (existsSync(c)) return c;
  }
  return undefined;
}

/** A deliberately unmistakable sprite: nothing procedural is this colour. */
async function writeMarkerSprite(browser, file) {
  const page = await browser.newPage();
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const x = c.getContext('2d');
    x.fillStyle = '#ff00ff';
    x.fillRect(40, 90, 176, 130);
    return c.toDataURL('image/png');
  });
  await page.close();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

/**
 * Count marker pixels by reading the canvas in the page.
 *
 * The first version of this decoded the screenshot PNG by hand and never
 * reversed the per-row filters, so every reading was noise that happened to
 * look plausible — it reported a sprite as drawn before one existed. Asking
 * the canvas for its own pixels is exact, needs no decoder, and measures the
 * thing actually in question rather than a re-encoding of it.
 */
async function markerPixelsOnCanvas(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.settlement-canvas');
    if (!canvas) return -1;
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let n = 0;
    for (let i = 0; i + 3 < data.length; i += 4) {
      if (data[i] > 240 && data[i + 1] < 60 && data[i + 2] > 240 && data[i + 3] > 200) n++;
    }
    return n;
  });
}

async function shoot(browser, port) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const seen = [];
  page.on('response', (r) => { if (r.url().includes('/sprites/')) seen.push([r.status(), r.url().split('/sprites/')[1]]); });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const labels = await page.locator('.tabs button').allTextContents();
  await page.locator('.tabs button').nth(labels.findIndex((l) => /Holding/.test(l))).click({ force: true });
  await page.waitForTimeout(2200);
  const markers = await markerPixelsOnCanvas(page);
  await page.close();
  return { seen, markers };
}

const build = () => execFileSync('npx', ['vite', 'build'], {
  cwd: HERE, env: { ...process.env, ASCENDANCE_LOCAL: '1' }, stdio: 'ignore',
});

const server = createServer((q, s) => {
  const url = (q.url || '/').split('?')[0];
  let p = join(DIST, url);
  // A missing sprite must 404 exactly as static hosting does. Falling back to
  // index.html would hand the loader an HTML page as an image and prove nothing.
  if (url.startsWith('/sprites/') && !existsSync(p)) { s.writeHead(404); s.end('not found'); return; }
  if (!existsSync(p) || p.endsWith('/')) p = join(DIST, 'index.html');
  s.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
  s.end(readFileSync(p));
});

const file = join(PUBLIC, TARGET);
let browser;
try {
  await new Promise((r) => server.listen(4623, r));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? chromiumPath() });

  console.log('sprite pipeline: with no art on disk');
  rmSync(dirname(file), { recursive: true, force: true });
  build();
  const before = await shoot(browser, 4623);
  check('the renderer asks for sprites it does not have', before.seen.length > 0);
  check('and every one of them 404s', before.seen.every(([code]) => code === 404), JSON.stringify(before.seen.slice(0, 2)));
  check('each is requested exactly once', new Set(before.seen.map(([, p]) => p)).size === before.seen.length);
  check('nothing from a sprite is on the canvas', before.markers === 0, `${before.markers} marker pixels before any art`);

  console.log('sprite pipeline: with one file dropped in');
  await writeMarkerSprite(browser, file);
  build();
  const after = await shoot(browser, 4623);
  const target = after.seen.find(([, p]) => p === TARGET.replace('sprites/', ''));
  check('the dropped file is served', target?.[0] === 200, JSON.stringify(after.seen.slice(0, 3)));
  check('and is actually drawn on the canvas', after.markers > 200, `${after.markers} marker pixels`);
  check('everything else still falls back', after.seen.filter(([code]) => code === 404).length > 0);

  console.log(failures === 0
    ? '\nsprite pipeline: art can land one file at a time, with no code change.'
    : `\nsprite pipeline: ${failures} check(s) failed.`);
} finally {
  rmSync(dirname(file), { recursive: true, force: true });
  await browser?.close();
  server.close();
  build();
}
process.exit(failures === 0 ? 0 : 1);
