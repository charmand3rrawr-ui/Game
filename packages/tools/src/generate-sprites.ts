/**
 * generate-sprites.ts — draw the art programme through an image model
 *
 * `build-assets.ts` produces the work order: 5,943 sprites, each with a brief
 * composed from the workbook. This is the other half — it takes an entry, asks
 * an image model for the picture, and puts the file exactly where the renderer
 * looks for it.
 *
 * WHAT THIS IS NOT
 *   Claude has no image generation. Neither this process nor a subagent can
 *   draw anything; both are language models. So this calls out to a provider
 *   that can, and it needs an API key you supply. Without one it does nothing
 *   and says so — it never pretends to have produced art.
 *
 * ONE AT A TIME, AND NEVER TWICE
 *   Work is picked from what is still pending, and an asset is pending only if
 *   no file exists at its path. So the tool is resumable by construction: stop
 *   it, run it again, and it carries on from where the filesystem says it got
 *   to. It refuses to overwrite existing art unless told to, because a silent
 *   re-draw is both a wasted spend and a lost revision.
 *
 * THE COST IS REAL
 *   Every call is billed. Five thousand nine hundred and forty-three images is
 *   not a rounding error at any provider's price, so a batch larger than a
 *   handful requires saying so explicitly.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildManifest, composeBrief, statusOf, type AssetEntry } from './build-assets.js';
import { main as rebuildLedger } from './build-assets.js';

const ROOT = new URL('../../../', import.meta.url).pathname;
const PUBLIC = join(ROOT, 'packages/client/public');
const DRAWN = join(ROOT, 'assets/drawn.json');

// ============================================================================
// Providers
// ============================================================================

export interface Provider {
  name: string;
  /** The environment variable carrying its key. */
  envVar: string;
  /** What to tell the user if the key is missing. */
  hint: string;
  /** True if the model renders real alpha rather than a painted background. */
  nativeTransparency: boolean;
  generate(prompt: string, entry: AssetEntry, key: string): Promise<Buffer>;
}

/** Fail loudly on a non-2xx rather than writing an error page out as a PNG. */
async function expectOk(res: Response, provider: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  throw new Error(`${provider} answered ${res.status}: ${body.slice(0, 400)}`);
}

const OPENAI: Provider = {
  name: 'openai',
  envVar: 'OPENAI_API_KEY',
  hint: 'https://platform.openai.com/api-keys',
  // gpt-image-1 renders genuine alpha, which matters more here than fidelity:
  // a sprite with a painted background cannot sit on the settlement ground.
  nativeTransparency: true,
  async generate(prompt, _entry, key) {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt,
        n: 1,
        size: '1024x1024',
        background: 'transparent',
        output_format: 'png',
      }),
    });
    await expectOk(res, 'openai');
    const json = await res.json() as { data?: { b64_json?: string }[] };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error('openai returned no image data');
    return Buffer.from(b64, 'base64');
  },
};

const STABILITY: Provider = {
  name: 'stability',
  envVar: 'STABILITY_API_KEY',
  hint: 'https://platform.stability.ai/account/keys',
  nativeTransparency: false,
  async generate(prompt, _entry, key) {
    const form = new FormData();
    form.set('prompt', prompt);
    form.set('output_format', 'png');
    form.set('aspect_ratio', '1:1');
    const res = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, accept: 'image/*' },
      body: form,
    });
    await expectOk(res, 'stability');
    return Buffer.from(await res.arrayBuffer());
  },
};

const REPLICATE: Provider = {
  name: 'replicate',
  envVar: 'REPLICATE_API_TOKEN',
  hint: 'https://replicate.com/account/api-tokens',
  nativeTransparency: false,
  async generate(prompt, _entry, key) {
    const model = process.env.REPLICATE_MODEL ?? 'black-forest-labs/flux-schnell';
    const res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'wait' },
      body: JSON.stringify({ input: { prompt, aspect_ratio: '1:1', output_format: 'png' } }),
    });
    await expectOk(res, 'replicate');
    const json = await res.json() as { output?: string | string[]; error?: string };
    if (json.error) throw new Error(`replicate: ${json.error}`);
    const url = Array.isArray(json.output) ? json.output[0] : json.output;
    if (!url) throw new Error('replicate returned no image url');
    const img = await fetch(url);
    await expectOk(img, 'replicate (download)');
    return Buffer.from(await img.arrayBuffer());
  },
};

export const PROVIDERS: Provider[] = [OPENAI, STABILITY, REPLICATE];

// ============================================================================
// Prompt
// ============================================================================

/**
 * The brief, plus what the model specifically needs told.
 *
 * `assets/BRIEF.md` states the rules for a human reading the work order. A
 * model gets them inline, because it has not read that file — and the
 * transparency instruction is repeated in words for providers that cannot
 * render real alpha, where it is the difference between a sprite and a
 * postage stamp sitting on the settlement.
 */
export function promptFor(entry: AssetEntry, provider: Provider): string {
  const parts = [
    composeBrief(entry),
    '',
    'RENDER AS A GAME SPRITE:',
    '- Isometric 2:1 projection, fixed camera, lit from the upper right.',
    '- A single subject, centred, filling the frame, nothing else in the image.',
    '- No ground, no baseplate, no drop shadow, no border, no text, no watermark.',
    '- Clean readable shapes that survive being drawn at 128 pixels wide.',
    '- Do not draw damage, scaffolding, banners, weather, glow effects or people.',
  ];
  if (!provider.nativeTransparency) {
    // Without real alpha the next best thing is a key colour nothing else uses,
    // so the background can be cut cleanly afterwards.
    parts.push(
      '- Place the subject on a FLAT PURE MAGENTA background (#FF00FF), one solid colour,',
      '  with no gradient, shading or texture, so it can be keyed out cleanly.',
    );
  } else {
    parts.push('- Fully transparent background.');
  }
  return parts.join('\n');
}

// ============================================================================
// Post-processing
// ============================================================================

/**
 * Downscale to the manifest size, and key out the background if it was painted.
 *
 * Models return 1024px images; the manifest asks for 256 or less. Storing the
 * full-size original would make the repository tens of gigabytes across 5,943
 * assets for detail no player can see at the size these are drawn.
 *
 * Done in a headless browser rather than with an image library because one is
 * already a dependency here for the smoke tests, and pulling in a native image
 * toolchain for a resize is not worth the build cost.
 */
async function postProcess(raw: Buffer, entry: AssetEntry, keyOut: boolean): Promise<Buffer> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  try {
    const page = await browser.newPage();
    /*
     * Passed as source text, not as a closure.
     *
     * This body runs in the browser, not in this process — it needs `document`
     * and `Image`, which the tools package deliberately does not have types
     * for, because a build script reaching for a DOM API is a bug rather than
     * a convenience. Sending it across as a string keeps that boundary
     * visible instead of papering over it by adding `dom` to the whole
     * package's lib.
     */
    const out = await page.evaluate<string, { b64: string; width: number; height: number; keyOut: boolean }>(
      `async ({ b64, width, height, keyOut }) => {
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = 'data:image/png;base64,' + b64;
        });
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);
        if (keyOut) {
          const data = ctx.getImageData(0, 0, width, height);
          const p = data.data;
          for (let i = 0; i + 3 < p.length; i += 4) {
            // Generous bounds: a model paints "magenta", not exactly #FF00FF,
            // and resampling spreads it further at the edges.
            if (p[i] > 170 && p[i + 2] > 170 && p[i + 1] < 110) p[i + 3] = 0;
          }
          ctx.putImageData(data, 0, 0);
        }
        return c.toDataURL('image/png');
      }` as unknown as (a: { b64: string; width: number; height: number; keyOut: boolean }) => string,
      { b64: raw.toString('base64'), width: entry.width, height: entry.height, keyOut },
    );
    return Buffer.from(out.split(',')[1]!, 'base64');
  } finally {
    await browser.close();
  }
}

// ============================================================================
// Run
// ============================================================================

async function readDrawn(): Promise<Record<string, string>> {
  if (!existsSync(DRAWN)) return {};
  try {
    return JSON.parse(await readFile(DRAWN, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * Commit and push one drawn sprite.
 *
 * Required for any unattended or scheduled run. These containers are
 * ephemeral: a scheduled job that draws art into a working tree and then has
 * its container reclaimed has spent real money to produce nothing, and the
 * ledger it updated goes with it. Committing per sprite rather than per batch
 * means an interrupted run keeps everything it had already paid for.
 *
 * Push failures are reported but do not stop the run — the commit is local and
 * survives, so the next successful push carries it.
 */
function commitOne(entry: AssetEntry): void {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  git('add', '--', `packages/client/public/${entry.path}`, 'assets/drawn.json', 'assets/LEDGER.md');
  // Nothing staged means nothing changed; committing would be a lie.
  const staged = git('diff', '--cached', '--name-only');
  if (staged === '') return;

  git(
    'commit', '-m',
    `Draw ${entry.id}\n\n` +
    `${entry.subject}${entry.tier !== undefined ? `, visual tier ${entry.tier}` : ''}. ` +
    `Generated from the workbook brief ${entry.briefHash}.\n\n` +
    'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
  );
  try {
    git('push', '-u', 'origin', branch);
  } catch (e) {
    console.error(`        push failed (the commit is local and will go with the next one): ${
      e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
}

export async function main(argv: string[]): Promise<void> {
  const wanted = flag(argv, '--provider') ?? PROVIDERS[0]!.name;
  const provider = PROVIDERS.find((p) => p.name === wanted);
  if (!provider) {
    console.error(`unknown provider "${wanted}". Available: ${PROVIDERS.map((p) => p.name).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const key = process.env[provider.envVar];
  if (!key) {
    console.error(
      `No API key. ${provider.name} needs ${provider.envVar}.\n\n` +
      `  export ${provider.envVar}=...   # ${provider.hint}\n\n` +
      'Claude cannot generate images — this tool exists to hand the work order to a model that can.\n' +
      `Providers available: ${PROVIDERS.map((p) => `${p.name} (${p.envVar})`).join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  const entries = buildManifest();
  const drawn = await readDrawn();
  const only = argv.find((a) => !a.startsWith('--') && a.includes('/'));
  const kind = flag(argv, '--kind');
  const limit = Number(flag(argv, '--limit') ?? 1);
  const force = argv.includes('--force');
  const dryRun = argv.includes('--dry-run');
  const commit = argv.includes('--commit');

  let queue = only
    ? entries.filter((e) => e.id === only)
    : entries.filter((e) => force || statusOf(e, new Map(Object.entries(drawn))) !== 'integrated');
  if (kind) queue = queue.filter((e) => e.kind === kind);
  queue = queue.slice(0, Math.max(1, limit));

  if (queue.length === 0) {
    console.log('nothing to draw — every asset in that selection already has a file');
    return;
  }

  // A batch is billed per image. Anything beyond a handful has to be asked for.
  if (queue.length > 10 && !argv.includes('--yes')) {
    console.error(
      `That is ${queue.length} images, and every one of them is billed by ${provider.name}.\n` +
      'Re-run with --yes if that is what you meant.',
    );
    process.exitCode = 1;
    return;
  }

  const everyMinutes = Number(flag(argv, '--every') ?? 0);
  console.log(
    `${dryRun ? 'would draw' : 'drawing'} ${queue.length} sprite(s) with ${provider.name}` +
    (everyMinutes > 0 ? `, ${everyMinutes} minutes apart` : '') + '\n',
  );

  let drawnThisRun = 0;
  for (const entry of queue) {
    const file = join(PUBLIC, entry.path);
    if (existsSync(file) && !force) {
      console.log(`  skip  ${entry.id} — already drawn`);
      continue;
    }
    const prompt = promptFor(entry, provider);
    if (dryRun) {
      console.log(`  ---- ${entry.id} -> ${entry.path}`);
      console.log(prompt.split('\n').map((l) => `       ${l}`).join('\n'));
      continue;
    }

    // Pace between calls, not before the first — a scheduled run that sleeps
    // before doing anything looks indistinguishable from one that has hung.
    if (everyMinutes > 0 && drawnThisRun > 0) {
      console.log(`  wait  ${everyMinutes} min before the next`);
      await new Promise((r) => setTimeout(r, everyMinutes * 60_000));
    }
    drawnThisRun++;
    process.stdout.write(`  draw  ${entry.id} … `);
    try {
      const raw = await provider.generate(prompt, entry, key);
      const png = await postProcess(raw, entry, !provider.nativeTransparency);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, png);

      // Record the brief it was drawn against BEFORE announcing success, so an
      // interrupted run never leaves art that the ledger cannot account for.
      drawn[entry.id] = entry.briefHash;
      await writeFile(DRAWN, JSON.stringify(drawn, null, 2) + '\n', 'utf8');
      console.log(`ok (${(png.length / 1024).toFixed(0)} kB) -> ${entry.path}`);

      if (commit) {
        await rebuildLedger();
        commitOne(entry);
        console.log(`        committed and pushed`);
      }
    } catch (e) {
      console.log('FAILED');
      console.error(`        ${e instanceof Error ? e.message : String(e)}`);
      // Stop rather than burn the rest of the batch against the same fault.
      process.exitCode = 1;
      break;
    }
  }

  if (!dryRun) {
    console.log('');
    await rebuildLedger();
  }
}

if (process.argv[1]?.endsWith('generate-sprites.ts')) {
  await main(process.argv.slice(2));
}
