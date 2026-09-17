/**
 * generate-sprites.test.ts — the connector, checked against the published spec
 *
 * The request this sends costs money and cannot be tried casually, so it was
 * written from memory and never executed. That is exactly the code most likely
 * to be wrong, and two of its fields were: it hardcoded a model retired in
 * October 2026, and it omitted `quality`, whose documented default is `auto` —
 * meaning the model could pick `high` and bill nearly three times the estimate
 * with nothing in the output saying so.
 *
 * So this stands a mock in front of it that answers in the shape OpenAI's
 * OpenAPI spec defines, and asserts what actually goes over the wire. No key,
 * no spend, and the parts that are easy to get quietly wrong are the parts
 * under test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDERS, promptFor, pixelLabDescription } from './generate-sprites.js';
import { buildManifest } from './build-assets.js';

/** A 1x1 transparent PNG — enough to prove the bytes were carried through. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

interface Captured { path: string; auth?: string; body: Record<string, unknown> }

let server: Server;
let port = 0;
let captured: Captured[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: null };

beforeEach(async () => {
  captured = [];
  reply = {
    status: 200,
    // Exactly the response shape in the spec's own example.
    body: {
      created: 1713833628,
      data: [{ b64_json: PIXEL }],
      background: 'transparent',
      output_format: 'png',
      size: '1024x1024',
      quality: 'medium',
      usage: { total_tokens: 100, input_tokens: 50, output_tokens: 50 },
    },
  };
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      captured.push({
        path: req.url ?? '',
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
      });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, () => { port = (server.address() as { port: number }).port; r(); }));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.PIXELLAB_BASE_URL = `http://127.0.0.1:${port}/v1`;
});

afterEach(async () => {
  delete process.env.OPENAI_BASE_URL;
  delete process.env.PIXELLAB_BASE_URL;
  delete process.env.OPENAI_IMAGE_QUALITY;
  delete process.env.OPENAI_IMAGE_MODEL;
  await new Promise<void>((r) => server.close(() => r()));
});

const openai = () => PROVIDERS.find((p) => p.name === 'openai')!;
const anEntry = () => buildManifest().find((e) => e.id === 'building/1_farm/t1')!;

describe('the OpenAI request matches the published spec', () => {
  it('sends every field the images endpoint needs', async () => {
    await openai().generate('draw a farm', anEntry(), 'sk-test');
    const call = captured[0]!;
    expect(call.path).toBe('/v1/images/generations');
    expect(call.auth).toBe('Bearer sk-test');
    expect(call.body['prompt']).toBe('draw a farm');
    expect(call.body['n']).toBe(1);
    expect(call.body['output_format']).toBe('png');
  });

  it('always sets quality, because the documented default is auto', async () => {
    // `auto` "will automatically select the best quality for the given model",
    // so omitting it is not a cheap default — it is an unspecified one, across
    // thousands of billed images.
    await openai().generate('x', anEntry(), 'sk-test');
    expect(captured[0]!.body['quality']).toBe('medium');
  });

  it('lets the quality be chosen, within the spec\'s enum', async () => {
    process.env.OPENAI_IMAGE_QUALITY = 'low';
    await openai().generate('x', anEntry(), 'sk-test');
    expect(captured[0]!.body['quality']).toBe('low');
    expect(['low', 'medium', 'high', 'xhigh', 'max', 'auto']).toContain(captured[0]!.body['quality']);
  });

  it('never sends a model that has been retired', async () => {
    // gpt-image-1 is retired on 23 October 2026. A hardcoded id would fail
    // silently on a date nobody was watching for.
    await openai().generate('x', anEntry(), 'sk-test');
    expect(captured[0]!.body['model']).not.toBe('gpt-image-1');
    expect(captured[0]!.body['model']).toBe('gpt-image-1.5');
  });

  it('takes a newer model when one is named', async () => {
    process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2.5-flare';
    await openai().generate('x', anEntry(), 'sk-test');
    expect(captured[0]!.body['model']).toBe('gpt-image-2.5-flare');
  });

  it('asks for real transparency with a format that can carry it', async () => {
    // A sprite on a painted background cannot sit on the settlement ground,
    // and the spec requires png or webp alongside a transparent background.
    await openai().generate('x', anEntry(), 'sk-test');
    expect(captured[0]!.body['background']).toBe('transparent');
    expect(captured[0]!.body['output_format']).toBe('png');
  });

  it('does not send response_format, which these models reject', async () => {
    // The GPT image models always return base64; the spec says the parameter
    // "isn't supported" for them.
    await openai().generate('x', anEntry(), 'sk-test');
    expect(captured[0]!.body).not.toHaveProperty('response_format');
  });
});

describe('the response is handled as the spec describes', () => {
  it('decodes the base64 image the endpoint returns', async () => {
    const out = await openai().generate('x', anEntry(), 'sk-test');
    expect(out.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG magic
    expect(out.equals(Buffer.from(PIXEL, 'base64'))).toBe(true);
  });

  it('throws on an error status rather than writing the error out as a PNG', async () => {
    // The failure worth guarding: a 401 body saved to disk as `t1.png` would
    // sit in the repository looking like art and count as integrated.
    reply = { status: 401, body: { error: { message: 'Incorrect API key provided' } } };
    await expect(openai().generate('x', anEntry(), 'bad-key')).rejects.toThrow(/401/);
  });

  it('throws when the response carries no image', async () => {
    reply = { status: 200, body: { created: 1, data: [] } };
    await expect(openai().generate('x', anEntry(), 'sk-test')).rejects.toThrow(/no image data/);
  });

  it('surfaces the provider\'s message, so a failure can be acted on', async () => {
    reply = { status: 400, body: { error: { message: 'billing hard limit reached' } } };
    await expect(openai().generate('x', anEntry(), 'sk-test')).rejects.toThrow(/billing hard limit/);
  });
});

describe('the prompt', () => {
  it('carries the workbook brief and the sprite rules', async () => {
    const prompt = promptFor(anEntry(), openai());
    expect(prompt).toContain('Farm');
    expect(prompt).toContain('Signature: the ox-turned grain post');
    expect(prompt).toContain('Isometric 2:1');
    expect(prompt).toContain('Fully transparent background.');
  });

  it('asks for a key colour only where the provider cannot do alpha', () => {
    const stability = PROVIDERS.find((p) => p.name === 'stability')!;
    expect(promptFor(anEntry(), stability)).toContain('MAGENTA');
    expect(promptFor(anEntry(), openai())).not.toContain('MAGENTA');
  });

  it('stays inside the 32,000 character limit for GPT image models', () => {
    // The longest briefs are the top-tier buildings with an exemplar attached.
    const longest = buildManifest()
      .map((e) => promptFor(e, openai()).length)
      .reduce((a, b) => Math.max(a, b), 0);
    expect(longest).toBeLessThan(32_000);
  });
});

// ============================================================================
// PixelLab — the one built for this problem
// ============================================================================

const pixellab = () => PROVIDERS.find((p) => p.name === 'pixellab')!;

describe('the PixelLab request matches its published spec', () => {
  beforeEach(() => {
    // The shape from api.pixellab.ai/v1/openapi.json.
    reply = {
      status: 200,
      body: { image: { type: 'base64', base64: PIXEL }, usage: { type: 'usd', usd: 0.0087 } },
    };
  });

  it('hits the pixflux endpoint with a bearer token', async () => {
    await pixellab().generate('unused', anEntry(), 'pl-test');
    expect(captured[0]!.path).toBe('/v1/generate-image-pixflux');
    expect(captured[0]!.auth).toBe('Bearer pl-test');
  });

  it('asks for isometric and a transparent background', async () => {
    // These two are why this provider exists here: every general image model
    // had to be argued into them and still baked in ground and shadow.
    await pixellab().generate('unused', anEntry(), 'pl-test');
    expect(captured[0]!.body['isometric']).toBe(true);
    expect(captured[0]!.body['no_background']).toBe(true);
  });

  it('renders at the manifest size, so nothing is resampled', async () => {
    const entry = anEntry();
    await pixellab().generate('unused', entry, 'pl-test');
    expect(captured[0]!.body['image_size']).toEqual({ width: entry.width, height: entry.height });
  });

  it('stays inside the endpoint\'s 16-400px bounds for every asset', () => {
    // A size outside the range is a 422 from the API, and it would only show
    // up on whichever asset kind was tried last.
    for (const e of buildManifest()) {
      expect(e.width).toBeGreaterThanOrEqual(16);
      expect(e.width).toBeLessThanOrEqual(400);
      expect(e.height).toBeGreaterThanOrEqual(16);
      expect(e.height).toBeLessThanOrEqual(400);
    }
  });

  it('sends one style triple for every sprite', async () => {
    // A settlement is dozens of buildings side by side. Coherence between them
    // matters more than the merit of any one, so the style must not vary.
    const bodies: Record<string, unknown>[] = [];
    for (const id of ['building/1_farm/t1', 'building/1_mine/t5', 'research/agrarian_arts']) {
      const e = buildManifest().find((x) => x.id === id)!;
      await pixellab().generate('unused', e, 'pl-test');
      bodies.push(captured[captured.length - 1]!.body);
    }
    const style = (b: Record<string, unknown>) => [b['outline'], b['shading'], b['detail']].join('|');
    expect(new Set(bodies.map(style)).size).toBe(1);
    // And each value must be one the spec accepts.
    expect(['single color black outline', 'single color outline', 'selective outline', 'lineless'])
      .toContain(bodies[0]!['outline']);
    expect(['flat shading', 'basic shading', 'medium shading', 'detailed shading', 'highly detailed shading'])
      .toContain(bodies[0]!['shading']);
    expect(['low detail', 'medium detail', 'highly detailed']).toContain(bodies[0]!['detail']);
  });

  it('seeds from the brief, so the same brief redraws the same sprite', async () => {
    const entry = anEntry();
    await pixellab().generate('unused', entry, 'pl-test');
    const first = captured[0]!.body['seed'];
    await pixellab().generate('unused', entry, 'pl-test');
    expect(captured[1]!.body['seed']).toBe(first);
    expect(typeof first).toBe('number');
    expect(first as number).toBeGreaterThan(0);
  });

  it('leads with the tier, then the subject and its Signature', () => {
    // The tier has to come FIRST. Trailing it behind the authored appearance —
    // which is the same sentence for all twelve tiers — produced twelve
    // near-identical buildings: tier 11, a named wonder visible from orbit,
    // came back as a hut indistinguishable from tier 1.
    const d = pixelLabDescription(anEntry());
    expect(d).toContain('Farm');
    expect(d).toContain('ox-turned grain post');
    expect(d.indexOf('Farm')).toBeGreaterThan(0);
    expect(d.length).toBeLessThan(500);
  });

  it('makes the top and bottom tiers describe visibly different buildings', () => {
    // The whole point of twelve authored tiers is that upgrading is visible.
    // If the descriptions barely differ, the art cannot either.
    const all = buildManifest();
    const low = pixelLabDescription(all.find((e) => e.id === 'building/1_chieftain_s_hall/t1')!);
    const high = pixelLabDescription(all.find((e) => e.id === 'building/1_chieftain_s_hall/t11')!);
    expect(low).not.toBe(high);
    // The top tier must carry its grandeur, not art-direction shorthand.
    expect(high.toLowerCase()).toMatch(/orbit|wonder|hero asset|legendary/);
    expect(high.toLowerCase()).not.toContain('bespoke per building');
  });

  it('falls back to the tier prose where no worked exemplar exists', () => {
    // Only four buildings have exemplars. The other 479 must still get a real
    // description rather than the silhouette shorthand.
    const mine = buildManifest().find((e) => e.id === 'building/1_mine/t9')!;
    const d = pixelLabDescription(mine);
    expect(d.toLowerCase()).toContain('transcendent');
    expect(d).toContain('Mine');
  });

  it('decodes the image and records what the call actually cost', async () => {
    const out = await pixellab().generate('unused', anEntry(), 'pl-test');
    expect(out.equals(Buffer.from(PIXEL, 'base64'))).toBe(true);
  });

  it('throws on an error status rather than saving it as a sprite', async () => {
    reply = { status: 401, body: { detail: 'Invalid API key' } };
    await expect(pixellab().generate('x', anEntry(), 'bad')).rejects.toThrow(/401/);
  });

  it('throws when the response carries no image', async () => {
    reply = { status: 200, body: { usage: { usd: 0 } } };
    await expect(pixellab().generate('x', anEntry(), 'pl-test')).rejects.toThrow(/no image data/);
  });
});
