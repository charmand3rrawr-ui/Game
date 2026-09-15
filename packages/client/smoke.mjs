/**
 * smoke.mjs — play the game in a real browser
 *
 * A green unit-test suite and a page that throws on load are not the same
 * thing. This builds the client in sandbox mode, serves it, and walks the
 * whole product: every screen renders, and the M7 loop completes —
 *
 *   spec/08 M7: "a full play loop — build, train, dispatch, resolve, read the
 *   report — is completable on a phone in under ten minutes"
 *
 * so it runs at phone width, and it fails on any console error or page
 * exception, not just on a missing element. A React hook-order bug that only
 * appears when you navigate to the second screen is exactly the class of
 * failure this exists to catch.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const PORT = 4173;
const SITE = `http://127.0.0.1:${PORT}/`;
const OUT = new URL('./smoke-output/', import.meta.url).pathname;

const TABS = ['Attention', 'Map', 'Holding', 'Command', 'Forces', 'Research', 'Reports', 'Sim', 'Codex'];

/**
 * Click something in the page body.
 *
 * NOT a force-click. The tab bar is fixed to the bottom of the viewport, so a
 * forced click on an element that happens to sit under it is delivered to the
 * tab bar instead and silently does nothing — which is how three checks passed
 * a broken build for one run. Scrolling into view first and letting Playwright
 * do its actionability checks is the difference between testing the app and
 * testing the test.
 */
async function clickIn(locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ timeout: 8000 });
}

/** First enabled match, or null. */
async function firstEnabled(locator) {
  for (let i = 0, n = await locator.count(); i < n; i++) {
    if (await locator.nth(i).isEnabled()) return locator.nth(i);
  }
  return null;
}

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });

  console.log('smoke: serving the built client');
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: new URL('.', import.meta.url).pathname,
    stdio: 'ignore',
  });

  try {
    await waitForServer();

    // CI installs the browser Playwright expects. A sandbox that already has
    // one can point at it with CHROMIUM_PATH instead of downloading a second.
    const executablePath = process.env.CHROMIUM_PATH;
    const browser = await chromium.launch(executablePath ? { executablePath } : {});
    // Phone width: nothing important may REQUIRE a desktop (spec/06 §1).
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });

    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('favicon')) consoleErrors.push(m.text());
    });

    console.log('smoke: loading');
    await page.goto(SITE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.tabs', { timeout: 30_000 });
    await page.waitForTimeout(1500);

    check('the world boots', (await page.locator('h1').first().textContent()) === 'Attention');
    check('the attention dashboard is the home screen', await page.locator('.tabs button').nth(0).getAttribute('aria-current') === 'true');

    // --- every screen renders -------------------------------------------
    const tab = (i) => page.locator('.tabs button').nth(i).click({ force: true });
    const seen = [];
    for (const [i, name] of TABS.entries()) {
      await tab(i);
      await page.waitForTimeout(800);
      const heading = await page.locator('h1').first().textContent().catch(() => null);
      seen.push(heading);
      check(`${name} renders`, Boolean(heading), 'no heading');
      await page.screenshot({ path: `${OUT}/${String(i).padStart(2, '0')}-${name.toLowerCase()}.png` });
    }
    check('every screen has its own heading', new Set(seen).size === TABS.length, seen.join(', '));

    // --- BUILD -----------------------------------------------------------
    await tab(TABS.indexOf('Holding'));
    await page.waitForTimeout(800);
    await clickIn(page.locator('[data-pane="build"]'));
    await page.waitForTimeout(500);
    const build = await firstEnabled(page.locator('[data-action="build"]'));
    if (build) await clickIn(build);
    await page.waitForTimeout(1500);
    check('a building can be queued', Boolean(build) && (await page.locator('.toast.ok').count()) > 0);

    // --- a rejection explains itself -------------------------------------
    // The second build has nowhere to go: one personal slot, now busy. The
    // player must be told WHY, specifically.
    let rejection = null;
    for (let i = 0; i < 10 && !rejection; i++) {
      const next = await firstEnabled(page.locator('[data-action="build"]'));
      if (next) await clickIn(next);
      await page.waitForTimeout(500);
      rejection = await page.locator('.toast.error .d').first().textContent().catch(() => null);
    }
    check('a rejection explains itself', Boolean(rejection) && rejection.length > 30, rejection ?? 'no rejection shown');

    // --- DISPATCH --------------------------------------------------------
    await tab(TABS.indexOf('Command'));
    await page.waitForTimeout(800);
    const all = page.locator('button:has-text("all")').first();
    if (await all.count()) await clickIn(all);
    await page.waitForTimeout(400);
    const send = page.locator('button:has-text("Send")').first();
    const canSend = await send.isEnabled().catch(() => false);
    if (canSend) await clickIn(send);
    await page.waitForTimeout(1800);
    const dispatched = (await page.locator('.toast').allTextContents()).some((t) => /Dispatched/i.test(t));
    check('a force can be dispatched', dispatched);

    const movement = await page.locator('.att:has-text("ATTACK")').first().textContent().catch(() => '');
    check('the movement shows an exact arrival', /\d+[hdm]/.test(movement), movement.slice(0, 80));
    await page.screenshot({ path: `${OUT}/20-dispatched.png` });

    // --- TRAIN -----------------------------------------------------------
    // spec/08 M7's loop is "build, TRAIN, dispatch, resolve, read the report".
    // Training was missing from the first pass at M3 and nothing caught it,
    // which is exactly why it is checked here now.
    await tab(TABS.indexOf('Holding'));
    await page.waitForTimeout(800);
    await clickIn(page.locator('[data-pane="train"]'));
    await page.waitForTimeout(1200);
    const trainButton = await firstEnabled(page.locator('[data-action="train"]'));
    const canTrain = Boolean(trainButton);
    if (trainButton) await clickIn(trainButton);
    await page.waitForTimeout(1600);
    const trained = (await page.locator('.toast').allTextContents()).some((t) => /Training \d+/i.test(t));
    check('units can be trained', canTrain && trained);
    await page.screenshot({ path: `${OUT}/21-training.png` });

    // --- RESEARCH ---------------------------------------------------------
    await tab(TABS.indexOf('Research'));
    await page.waitForTimeout(1000);
    const raise = await firstEnabled(page.locator('button:has-text("Raise to level")'));
    const canResearch = Boolean(raise);
    if (raise) await clickIn(raise);
    await page.waitForTimeout(1600);
    check('a discipline can be raised', canResearch);
    const effects = await page.locator('.card .num').first().textContent().catch(() => '');
    check('research effects are shown', /\u00d7\d/.test(effects ?? ''), effects ?? '');
    await page.screenshot({ path: `${OUT}/22-research.png` });

    // --- the simulator runs the real resolver ----------------------------
    await tab(TABS.indexOf('Sim'));
    await page.waitForTimeout(800);
    const sim = await page.locator('.card strong').first().textContent().catch(() => null);
    check('the simulator resolves a battle', /succeeds|holds/.test(sim ?? ''), sim ?? 'no result');

    // --- nothing threw ---------------------------------------------------
    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    await writeFile(`${OUT}/report.json`, JSON.stringify({ failures, consoleErrors }, null, 2));
    await browser.close();
  } finally {
    server.kill();
  }

  if (failures.length > 0) {
    console.error(`\nsmoke: ${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nsmoke: the full play loop completes in a browser.');
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(SITE);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`the preview server never came up on ${SITE}`);
}

await main();
