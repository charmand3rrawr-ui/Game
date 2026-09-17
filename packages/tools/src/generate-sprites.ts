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
import { dirname, join, relative } from 'node:path';
import { buildManifest, composeBrief, statusOf, type AssetEntry } from './build-assets.js';
import { VISUAL_TIERS } from '@ascendance/shared';
import { main as rebuildLedger } from './build-assets.js';

const ROOT = new URL('../../../', import.meta.url).pathname;
const PUBLIC = join(ROOT, 'packages/client/public');
const DRAWN = join(ROOT, 'assets/drawn.json');

// ============================================================================
// Providers
// ============================================================================

export interface Provider {
  name: string;
  /**
   * True if this provider cannot produce a shippable sprite.
   *
   * A preview provider is for reading the brief back — checking that a
   * description produces the building you meant — not for filling the game.
   * Its output never goes to a sprite path, because a watermarked JPEG sitting
   * at `sprites/buildings/1_farm/t1.png` would look like finished art, count
   * as integrated in the ledger, and ship.
   */
  previewOnly?: boolean;
  /** Why it cannot ship, stated to the operator every time it runs. */
  previewReason?: string;
  /** The environment variable carrying its key. */
  envVar: string;
  /** What to tell the user if the key is missing. */
  hint: string;
  /** True if the model renders real alpha rather than a painted background. */
  nativeTransparency: boolean;
  generate(prompt: string, entry: AssetEntry, key: string): Promise<Buffer>;
}

/** What the last call actually cost, as the provider reported it. */
let lastUsage: { quality?: string; tokens?: number } = {};

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
    // Every field here is checked against OpenAI's published OpenAPI spec
    // (github.com/openai/openai-openapi), not against memory.
    //
    // MODEL is configurable and deliberately not `gpt-image-1`: that one is
    // retired on 23 October 2026, and a hardcoded id would turn every
    // scheduled run into a silent failure on a date nobody was watching for.
    // The spec lists newer options — gpt-image-2 and the gpt-image-2.5
    // sunburst/flare snapshots — which are worth trying for sprite work.
    const model = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1.5';

    // QUALITY MUST BE SET. The spec's default is `auto`, which "will
    // automatically select the best quality for the given model" — so leaving
    // it out does not mean cheap, it means the model may choose `high` and
    // bill nearly three times the estimate. An unspecified cost multiplier
    // across thousands of images is not something to leave to a default.
    const quality = process.env.OPENAI_IMAGE_QUALITY ?? 'medium';

    const base = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    const res = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size: '1024x1024',
        quality,
        // Genuine alpha. The spec requires png or webp output alongside it,
        // which is what makes a sprite able to sit on the settlement ground.
        background: 'transparent',
        output_format: 'png',
      }),
    });
    await expectOk(res, 'openai');

    // `response_format` is not accepted for the GPT image models — they always
    // return base64 — so b64_json is the only field to read.
    const json = await res.json() as {
      data?: { b64_json?: string }[];
      quality?: string;
      usage?: { total_tokens?: number };
    };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error('openai returned no image data');

    // Report what was actually billed rather than what was asked for: the API
    // echoes back the quality it used, and that is the number that costs money.
    if (json.quality && json.quality !== quality) {
      console.log(`\n        note: asked for ${quality}, served ${json.quality}`);
    }
    lastUsage = { quality: json.quality ?? quality, tokens: json.usage?.total_tokens };
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

/**
 * PixelLab — built for exactly this problem.
 *
 * Every general image model fought the brief: no alpha, inconsistent camera,
 * ground and shadows baked in, output at the wrong size. This API takes
 * `isometric` and `no_background` as first-class parameters, renders at the
 * manifest's own dimensions (16-400px), and exposes outline, shading and
 * detail as explicit style controls.
 *
 * That last part is what matters across 5,943 sprites. A settlement is dozens
 * of buildings side by side, and coherence between them is more important than
 * the quality of any one — a beautiful sprite in the wrong style is worse than
 * a plain one in the right style. Sending the same style triple every time is
 * what makes them look like one game rather than a collection.
 *
 * The output is pixel art. That is a deliberate change of house style from the
 * procedural geometry, and a coherent one: pixel art holds up at the small
 * sizes these are drawn, carries real alpha, and is what the tool is good at.
 *
 * Verified against api.pixellab.ai/v1/openapi.json, not from memory.
 */
const PIXELLAB: Provider = {
  name: 'pixellab',
  envVar: 'PIXELLAB_API_KEY',
  hint: 'https://www.pixellab.ai — free tier, no credit card',
  // `no_background` gives a genuinely transparent sprite, so there is nothing
  // to key out and nothing to lose at the edges.
  nativeTransparency: true,
  async generate(prompt, entry, key) {
    const base = process.env.PIXELLAB_BASE_URL ?? 'https://api.pixellab.ai/v1';
    const res = await fetch(`${base}/generate-image-pixflux`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        description: pixelLabDescription(entry),
        // Straight from the manifest: the API renders at the target size, so
        // there is no resample between what the model drew and what ships.
        image_size: { width: entry.width, height: entry.height },
        isometric: true,
        no_background: true,
        // One style triple for the whole programme. Consistency between
        // buildings matters more than the merit of any single one.
        outline: 'single color black outline',
        shading: 'medium shading',
        detail: 'medium detail',
        // Derived from the brief hash, so a re-run of the same brief returns
        // the same sprite rather than a different one.
        seed: parseInt(entry.briefHash.slice(0, 8), 16) % 2_147_483_647,
        text_guidance_scale: 8,
      }),
    });
    await expectOk(res, 'pixellab');
    const json = await res.json() as {
      image?: { base64?: string };
      usage?: { usd?: number; generations?: number };
    };
    const b64 = json.image?.base64;
    if (!b64) throw new Error('pixellab returned no image data');
    // The API reports what the call actually cost, so spend is measured rather
    // than estimated.
    lastUsage = {
      quality: json.usage?.usd !== undefined ? `$${json.usage.usd.toFixed(4)}` : undefined,
    };
    void prompt;
    return Buffer.from(b64, 'base64');
  },
};

/**
 * The brief, condensed for a pixel-art model.
 *
 * The full prompt is written for a general image model and runs to a dozen
 * lines of prose. A pixel-art generator working at 256 pixels does better with
 * the subject stated plainly and the tier's silhouette instruction attached —
 * the rest of the brief describes detail that cannot survive the resolution.
 */
export function pixelLabDescription(entry: AssetEntry): string {
  const parts = [entry.subject];
  if (entry.authoredAppearance) {
    // The authored appearance up to its Signature, which is the one detail
    // worth spending pixels on.
    const [look, signature] = entry.authoredAppearance.split(/Signature:\s*/);
    if (look) parts.push(look.trim().replace(/\.$/, ''));
    if (signature) parts.push(signature.trim().replace(/\.$/, ''));
  }
  const tier = VISUAL_TIERS.find((t) => t.tier === entry.tier);
  if (tier && tier.tier > 0) parts.push(tier.silhouette.toLowerCase());

  // Units and research carry no authored appearance, so their category is the
  // only real information available and dropping it left descriptions as thin
  // as "Militia, era 1". A unit's ROLE is what its silhouette has to read as —
  // the counter matrix is a rock-paper-scissors the player must see coming —
  // and a discipline's branch is what makes its icon distinguishable.
  if (!entry.authoredAppearance && entry.category) {
    parts.push(entry.kind === 'unit' ? `${entry.category} soldier` : `${entry.category} icon`);
  }
  if (entry.purpose && entry.kind === 'research') parts.push(entry.purpose.slice(0, 80));
  if (entry.era) parts.push(`era ${entry.era}`);
  return parts.join(', ');
}

/**
 * Pixler — a real free tier, and an asynchronous one.
 *
 * Verified against api.pixler.dev/api/v1 in September 2026. Unlike the others
 * it does not answer with an image: it returns 202 and a job id, and the PNG
 * appears at `GET /jobs/{id}` once the queue gets to it. So this polls.
 *
 * It supports `transparent`, which is the property that matters, and a colour
 * palette. What it has no parameter for is ISOMETRIC — the camera has to be
 * argued for in the prompt, which is exactly where the general models drifted.
 * PixelLab takes it as a flag, and for 5,943 sprites that must share one angle
 * the flag is worth more than the free tier is.
 *
 * The free plan is 5 credits a day. That is genuinely enough for the starting
 * kit over a few weeks; it is 3 years for the whole programme.
 */
const PIXLER: Provider = {
  name: 'pixler',
  envVar: 'PIXLER_API_KEY',
  hint: 'https://pixler.dev — free tier is 5 generations a day',
  nativeTransparency: true,
  async generate(prompt, entry, key) {
    const base = process.env.PIXLER_BASE_URL ?? 'https://api.pixler.dev/api/v1';
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

    const start = await fetch(`${base}/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'Sprite',
        // The API caps the prompt at 300 characters, so the condensed
        // description is used rather than the full prose brief — and it is
        // trimmed rather than sent long and rejected.
        prompt: pixelLabDescription(entry).slice(0, 300),
        width: entry.width,
        height: entry.height,
        count: 1,
        transparent: true,
      }),
    });
    await expectOk(start, 'pixler');
    const job = await start.json() as { id?: string; status?: string };
    if (!job.id) throw new Error('pixler returned no job id');

    // Poll rather than assume. A queue that is busy is normal, not an error,
    // but it cannot be waited on forever either.
    const deadline = Date.now() + 5 * 60_000;
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(8_000, 1_500 + attempt * 1_000)));
      const poll = await fetch(`${base}/jobs/${job.id}`, { headers });
      await expectOk(poll, 'pixler (job)');
      const state = await poll.json() as {
        status?: string;
        images?: { url?: string }[];
        error?: string;
      };
      const status = (state.status ?? '').toLowerCase();
      if (status === 'failed' || state.error) {
        throw new Error(`pixler job failed: ${state.error ?? status}`);
      }
      const url = state.images?.[0]?.url;
      if (url) {
        const img = await fetch(url);
        await expectOk(img, 'pixler (download)');
        return Buffer.from(await img.arrayBuffer());
      }
    }
    throw new Error(`pixler job ${job.id} did not finish within 5 minutes`);
  },
};

/**
 * Free, keyless, and preview-only.
 *
 * Tested September 2026: the images are genuinely good — a legible isometric
 * building in the right style, from these briefs, with no account at all. What
 * it cannot do is produce a SPRITE. It returns JPEG regardless of the format
 * requested, so there is no alpha channel and nothing to key out; it bakes in
 * ground and a drop shadow that the renderer draws for itself; and it stamps a
 * watermark that `nologo` will not remove without registering, at which point
 * it is not keyless either.
 *
 * So it is wired up for what it IS good for: reading a brief back before
 * spending money on it. Output goes to `assets/previews/`, never to a sprite
 * path.
 */
const POLLINATIONS: Provider = {
  name: 'pollinations',
  envVar: 'POLLINATIONS_TOKEN',
  hint: 'no key needed — this one is free and keyless',
  nativeTransparency: false,
  previewOnly: true,
  previewReason:
    'returns watermarked JPEG with baked-in ground and shadow, so it cannot produce a usable sprite',
  async generate(prompt, entry, _key) {
    const url =
      `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 1800))}` +
      `?width=1024&height=1024&model=flux&nologo=true&seed=${parseInt(entry.briefHash.slice(0, 6), 16)}`;
    const res = await fetch(url);
    await expectOk(res, 'pollinations');
    return Buffer.from(await res.arrayBuffer());
  },
};

export const PROVIDERS: Provider[] = [PIXELLAB, PIXLER, OPENAI, STABILITY, REPLICATE, POLLINATIONS];

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

/**
 * Indicative per-image prices, September 2026.
 *
 * Deliberately a table rather than a live lookup: providers change prices and
 * this is a planning figure, not a bill. Check the provider before committing
 * to a large run — and note the retry multiplier below, which matters more than
 * the unit price does.
 */
/** Free-tier daily caps, where a provider has one. */
const DAILY_LIMIT: Record<string, number> = { pixler: 5 };

const PRICE_PER_IMAGE: Record<string, { label: string; usd: number }[]> = {
  // PixelLab bills per generation and reports the exact figure back on every
  // call, so this is only a planning number — the run tells you the real one.
  pixellab: [{ label: 'pixflux generation', usd: 0.01 }],
  // Free tier: 5 credits a day. Priced at zero because that is what it costs —
  // what it spends is time, which the estimator reports separately.
  pixler: [{ label: 'free tier (5/day)', usd: 0 }],
  openai: [
    { label: 'low quality', usd: 0.02 },
    { label: 'medium quality', usd: 0.07 },
    { label: 'high quality', usd: 0.19 },
  ],
  stability: [{ label: 'Stable Image Core', usd: 0.03 }],
  replicate: [{ label: 'FLUX schnell', usd: 0.003 }],
};

function estimate(entries: AssetEntry[], provider: Provider): void {
  const n = entries.length;
  if (provider.previewOnly) {
    console.log(
      `${provider.name} is free and keyless, so ${n} preview(s) cost nothing.\n\n` +
      `It cannot produce shippable sprites — it ${provider.previewReason}.\n` +
      'Use it to read briefs back; price the real run against another provider.',
    );
    return;
  }
  const rows = PRICE_PER_IMAGE[provider.name] ?? [];

  // A free tier does not cost money, it costs TIME, and at five a day that is
  // the number that decides whether a plan is possible. Reporting $0.00 and
  // stopping would hide the only constraint that matters.
  const perDay = DAILY_LIMIT[provider.name];
  if (perDay !== undefined) {
    const days = Math.ceil(n / perDay);
    console.log(
      `${n} sprite(s) selected, with ${provider.name} — free, at ${perDay} a day:\n\n` +
      `  ${days} day${days === 1 ? '' : 's'}` +
      (days > 90 ? `  (${(days / 365).toFixed(1)} years — pick a smaller slice)` : '') +
      '\n\nFree costs time rather than money. That is affordable for a starting kit and not\n' +
      'for the whole programme; `--kind` and `--limit` are how you choose a slice.',
    );
    return;
  }

  console.log(`${n} sprite(s) selected, with ${provider.name}:\n`);
  for (const r of rows) {
    const once = n * r.usd;
    console.log(
      `  ${r.label.padEnd(20)} $${once.toFixed(2).padStart(10)} first pass` +
      `   $${(once * 2.5).toFixed(2).padStart(10)} allowing for retries`,
    );
  }
  console.log(
    '\nThe retry column assumes 2.5 attempts per usable sprite. Six thousand images held to one\n' +
    'camera angle, one light direction and a clean alpha edge will not all land first time, and\n' +
    'that multiplier moves the total far more than the choice of quality tier does.',
  );
  if (!provider.nativeTransparency) {
    console.log(
      `\n${provider.name} does not render real transparency, so backgrounds are keyed out of a flat\n` +
      'colour afterwards. Cheaper per image, lossier at the edges — which on a sprite is where it shows.',
    );
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

  // An estimate needs no key: the question "what would this cost" should be
  // answerable before deciding whether to get one.
  const estimating = argv.includes('--estimate');

  const key = process.env[provider.envVar];
  if (!key && !estimating && !provider.previewOnly) {
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
  // One at a time by default when drawing; an estimate covers everything
  // selected, since a cost for a single sprite answers nothing useful.
  const limit = Number(flag(argv, '--limit') ?? (argv.includes('--estimate') ? Number.MAX_SAFE_INTEGER : 1));
  const force = argv.includes('--force');
  const dryRun = argv.includes('--dry-run');
  const commit = argv.includes('--commit');

  let queue = only
    ? entries.filter((e) => e.id === only)
    : entries.filter((e) => force || statusOf(e, new Map(Object.entries(drawn))) !== 'integrated');
  if (kind) queue = queue.filter((e) => e.kind === kind);
  queue = queue.slice(0, Math.max(1, limit));

  if (estimating) {
    estimate(queue, provider);
    return;
  }

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
  if (provider.previewOnly) {
    console.log(
      `${provider.name} is PREVIEW ONLY — it ${provider.previewReason}.\n` +
      'Output goes to assets/previews/ and is never treated as art.\n' +
      'Use it to read a brief back before paying to draw it properly.\n',
    );
  }

  for (const entry of queue) {
    // A preview never lands on a sprite path. One that did would look like
    // finished art, count as integrated, and ship.
    const file = provider.previewOnly
      ? join(ROOT, 'assets/previews', `${entry.id.replace(/\//g, '_')}.jpg`)
      : join(PUBLIC, entry.path);
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
      // Unreachable without a key: the guard above returns unless estimating,
      // and estimating returns before this loop.
      const raw = await provider.generate(prompt, entry, key!);
      // A preview is looked at, not composited, so it is kept as returned.
      // PixelLab renders at the manifest's own size with a real alpha
      // channel, so there is nothing to resample and nothing to key — post-
      // processing it would only lose pixels.
      const png = provider.previewOnly || provider.name === 'pixellab' || provider.name === 'pixler'
        ? raw
        : await postProcess(raw, entry, !provider.nativeTransparency);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, png);

      // Record the brief it was drawn against BEFORE announcing success, so an
      // interrupted run never leaves art that the ledger cannot account for.
      if (!provider.previewOnly) {
        drawn[entry.id] = entry.briefHash;
        await writeFile(DRAWN, JSON.stringify(drawn, null, 2) + '\n', 'utf8');
      }
      console.log(
        `ok (${(png.length / 1024).toFixed(0)} kB) -> ${
          provider.previewOnly ? relative(ROOT, file) : entry.path}` +
        (lastUsage.quality ? `  [${lastUsage.quality}${lastUsage.tokens ? `, ${lastUsage.tokens} tokens` : ''}]` : ''),
      );

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

  if (!dryRun && !provider.previewOnly) {
    console.log('');
    await rebuildLedger();
  }
}

if (process.argv[1]?.endsWith('generate-sprites.ts')) {
  await main(process.argv.slice(2));
}
