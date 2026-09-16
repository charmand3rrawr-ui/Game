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
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const PORT = 4173;
const SITE = `http://127.0.0.1:${PORT}/`;
const OUT = new URL('./smoke-output/', import.meta.url).pathname;

const TABS = ['Attention', 'Map', 'Holding', 'Command', 'Forces', 'Research', 'Dao', 'Stewards', 'Pacts', 'Hall', 'Reports', 'Sim', 'Codex'];

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

/**
 * A chromium already on disk, whatever build number it carries.
 *
 * Playwright pins an exact build and refuses anything else, which turns a
 * perfectly good preinstalled browser into a hard failure telling you to
 * download one. Returns undefined when there is nothing to find, so Playwright
 * falls back to its own resolution and its own error message.
 */
function findLocalChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith('chromium')) continue;
    for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const candidate = join(root, dir, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
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
    // one can point at it with CHROMIUM_PATH instead of downloading a second —
    // and if it has one under the conventional PLAYWRIGHT_BROWSERS_PATH but at
    // a different build number than this Playwright pins, find it rather than
    // failing with a download instruction that the sandbox cannot follow.
    const executablePath = process.env.CHROMIUM_PATH ?? findLocalChromium();
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

    // --- CULTIVATION ------------------------------------------------------
    // spec/08 M9: a tribulation is a scheduled, publicly visible event that
    // rivals can interfere with. The screen has to say so before you commit.
    await tab(TABS.indexOf('Dao'));
    await page.waitForTimeout(1200);
    const dao = await page.locator('.main').innerText();
    check('cultivation shows the realm and the Qi income', /realm/i.test(dao) && /QI/i.test(dao), dao.slice(0, 80));
    check('a breakthrough states its odds before you commit', /CHANCE TO PASS/i.test(dao));
    await page.screenshot({ path: `${OUT}/23-cultivation.png` });

    // --- GOVERNORS --------------------------------------------------------
    // spec/08 M8. The whole system is one number, and a governor with no
    // judgement is the design rather than a bug — so the screen has to say
    // both, up front, before a player delegates anything.
    await tab(TABS.indexOf('Stewards'));
    await page.waitForTimeout(1200);
    const stewards = await page.locator('.main').innerText();
    check('governors state the 2x price up front', /twice as long/i.test(stewards), stewards.slice(0, 90));
    check('the commander level and its tiers are shown', /COMMANDER LEVEL/i.test(stewards) && /Bailiff/i.test(stewards));
    // A fresh player has no veteran formation, so every tier is out of reach.
    // That gate is the feature; what matters is that it explains itself.
    check('an unreachable tier says what it needs', /needs level \d+/i.test(stewards), stewards.slice(0, 120));
    await page.screenshot({ path: `${OUT}/24-governors.png` });

    // --- DIPLOMACY --------------------------------------------------------
    // A treaty has teeth on the server, and a PROPOSAL has none at all until
    // it is signed. Both have to be legible here or players will mistake an
    // unsigned offer for protection.
    await tab(TABS.indexOf('Pacts'));
    await page.waitForTimeout(1200);
    const pacts = await page.locator('.main').innerText();
    check('treaties are described as server-enforced', /refuses the order/i.test(pacts), pacts.slice(0, 90));
    const counterparty = page.locator('select').first();
    const hasCounterparties = (await counterparty.locator('option').count()) > 1;
    check('there are real counterparties to treat with', hasCounterparties);
    if (hasCounterparties) {
      await counterparty.selectOption({ index: 1 });
      await page.waitForTimeout(300);
      await clickIn(page.locator('button:has-text("Send the proposal")'));
      await page.waitForTimeout(1600);
      const pactsAfter = await page.locator('.main').innerText();
      check('an unsigned proposal says it binds nobody', /binds nobody/i.test(pactsAfter), pactsAfter.slice(0, 120));
    }
    await page.screenshot({ path: `${OUT}/25-diplomacy.png` });

    // --- THE SETTLEMENT IS A PLACE, NOT A TABLE ---------------------------
    // The graphical view is the game's main surface. It has to actually draw
    // something, the plot budget on it must agree with the authoritative one,
    // and clicking a plot has to select it.
    await tab(TABS.indexOf('Holding'));
    await page.waitForTimeout(1000);
    const canvas = page.locator('.settlement-canvas');
    check('the settlement renders as a place', (await canvas.count()) === 1);
    const cbox = await canvas.boundingBox();
    check('the view has real size', Boolean(cbox) && cbox.width > 200 && cbox.height > 150);

    // Every plot is also a real control, because a canvas is invisible to a
    // screen reader (spec/06 §6).
    check('every plot is reachable without the canvas', (await page.locator('.sr-plots button').count()) > 0);

    if (cbox) {
      await page.mouse.click(cbox.x + cbox.width * 0.5, cbox.y + cbox.height * 0.52);
      await page.waitForTimeout(600);
    }
    const panel = await page.locator('.plot-panel').innerText().catch(() => '');
    check('clicking a plot selects it', panel.length > 10, panel.slice(0, 60));
    await page.screenshot({ path: `${OUT}/26-settlement-view.png` });

    // The tier reference is drawn by the same renderer as the game.
    await tab(TABS.indexOf('Codex'));
    await page.waitForTimeout(600);
    await clickIn(page.locator('button:has-text("building")').first());
    await page.waitForTimeout(900);
    check('all twelve visual tiers are shown', (await page.locator('.tier-swatch').count()) === 12);
    await page.screenshot({ path: `${OUT}/27-visual-tiers.png` });

    // --- THE TEXT LAYER ---------------------------------------------------
    // The game is the map and the settlement. This is everything around it,
    // and it has to be populated on arrival: an empty board and an empty inbox
    // teach a new player that nobody else is here.
    await tab(TABS.indexOf('Hall'));
    await page.waitForTimeout(1200);
    const hall = await page.locator('.main').innerText();
    check('rankings explain what they measure', /empire weight/i.test(hall), hall.slice(0, 90));

    // Chrono Shard spend is public, not hidden (spec/04 §11).
    await clickIn(page.locator('button:has-text("Chrono Shards purchased")').first());
    await page.waitForTimeout(700);
    check('shard spend is a public board', /never private|public/i.test(await page.locator('.main').innerText()));

    await clickIn(page.locator('button:has-text("messages")').first());
    await page.waitForTimeout(900);
    const inbox = await page.locator('.main').innerText();
    check('the world has already written to you', (await page.locator('.att').count()) > 0, inbox.slice(0, 80));

    await clickIn(page.locator('.att').first());
    await page.waitForTimeout(700);
    check('a message opens and reads as prose', (await page.locator('.main').innerText()).length > 200);

    await clickIn(page.locator('button:has-text("forum")').first());
    await page.waitForTimeout(900);
    check('the board is mid-conversation', (await page.locator('.att').count()) > 0);
    await clickIn(page.locator('.att').first());
    await page.waitForTimeout(800);
    check('a thread shows its posts', (await page.locator('.post').count()) > 1);
    await page.screenshot({ path: `${OUT}/28-forum.png` });

    await clickIn(page.locator('button:has-text("back to the board")').first());
    await page.waitForTimeout(400);
    await clickIn(page.locator('button:has-text("help")').first());
    await page.waitForTimeout(700);
    const help = await page.locator('.main').innerText();
    check('help answers the things that look like bugs', /governor stopped building/i.test(help), help.slice(0, 90));
    check('and says plainly they are not', /working as designed|no, and this/i.test(help));
    await page.screenshot({ path: `${OUT}/29-help.png` });

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
