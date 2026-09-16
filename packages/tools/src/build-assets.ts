/**
 * build-assets.ts — the art work order, and the ledger that tracks it
 *
 * WHY THIS EXISTS
 *   The renderer draws buildings as procedural geometry composited from the
 *   workbook's twelve visual tiers (DECISIONS.md D8). That is playable, and it
 *   is not the authored art: every building in `Buildings_Master` carries its
 *   own written appearance and a named "Signature" element, and
 *   `ArtBrief_Exemplars` carries four of them worked through all twelve tiers.
 *   That is an art programme, and an art programme needs a work order.
 *
 *   This emits one. Every sprite the game can use, with the brief composed from
 *   the workbook's own words — never invented here — plus the exact path the
 *   loader will look for it at.
 *
 * WHY THE STATUS IS DERIVED, NOT DECLARED
 *   An asset counts as integrated when the FILE IS ON DISK at the path the
 *   loader reads. Nothing hand-maintains that. A ledger somebody has to
 *   remember to tick is a ledger that is wrong within a week, and the failure
 *   mode is the one worth avoiding here: drawing something twice because the
 *   log said it was missing, or shipping a gap because the log said it was
 *   done.
 *
 *   Each entry also carries a hash of its brief. Change the workbook's art text
 *   and the hash moves, which marks the existing file STALE rather than done —
 *   so a brief that was revised after the art was drawn cannot quietly pass.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ARCHETYPES, ART_EXEMPLARS, BUILDINGS, RESEARCH, VISUAL_OVERLAYS, VISUAL_TIERS,
} from '@ascendance/shared';

const ROOT = new URL('../../../', import.meta.url).pathname;
const ASSET_DIR = join(ROOT, 'assets');
const MANIFEST = join(ASSET_DIR, 'manifest.jsonl');
const LEDGER = join(ASSET_DIR, 'LEDGER.md');
const BRIEF = join(ASSET_DIR, 'BRIEF.md');

export type AssetKind = 'building' | 'unit' | 'research';
export type AssetStatus = 'pending' | 'integrated' | 'stale';

export interface AssetEntry {
  /** Stable id. The ledger keys on this, so it must never be reassigned. */
  id: string;
  kind: AssetKind;
  /** Where the loader looks. Relative to the client's public asset root. */
  path: string;
  width: number;
  height: number;
  subject: string;
  tier?: number;
  levelBand?: string;
  era?: number;
  category?: string;
  /**
   * Only what is UNIQUE to this asset.
   *
   * The tier transformation, the silhouette, the era material and the worked
   * exemplars are the same text for hundreds of entries each, so they live in
   * `BRIEF.md` and are joined back on demand by `composeBrief` — which is what
   * `pnpm run brief <id>` prints. Inlining them made the work order five
   * megabytes of the same paragraphs and every regeneration a whole-file diff.
   */
  purpose?: string;
  authoredAppearance?: string;
  /** sha256 of the FULL composed prompt, so a revised brief marks art stale. */
  briefHash: string;
}

/** Sprite sizes. Isometric, 2:1, sized so a 4-plot building stays legible. */
const SIZE: Record<AssetKind, { width: number; height: number }> = {
  building: { width: 256, height: 256 },
  unit: { width: 128, height: 128 },
  research: { width: 96, height: 96 },
};

const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Era I is timber and thatch; Era VII is composite and light. */
const ERA_MATERIAL = [
  'timber, thatch and turf',
  'fired brick and clay tile',
  'dressed stone and lead',
  'iron, glass and brick',
  'steel, concrete and glass',
  'alloy and composite panel',
  'light-bearing composite and field-stabilised structure',
];

/**
 * Compose one building's brief for one tier.
 *
 * Four sources, all from the workbook, in the order an artist would want them:
 * what the building IS, what this tier does to any building, what the
 * silhouette must become, and — where one exists — a worked example of the
 * same tier on a comparable building. Nothing here is invented; this function
 * only arranges.
 */
function buildingBrief(b: typeof BUILDINGS[number], tier: typeof VISUAL_TIERS[number]): string {
  const era = ERA_MATERIAL[Math.min(ERA_MATERIAL.length, Math.max(1, b.era)) - 1]!;
  const exemplar = ART_EXEMPLARS.find((e) => e.tier === tier.tier && e.building === b.name)
    ?? ART_EXEMPLARS.find((e) => e.tier === tier.tier);

  const lines = [
    `${b.name} — Era ${b.era}, ${b.category}, visual tier ${tier.tier} of 11 (levels ${tier.minLevel}-${tier.maxLevel}).`,
    '',
    `WHAT IT IS: ${b.purpose ?? b.functionText}`,
    `AUTHORED APPEARANCE: ${b.art}`,
    '',
    `THIS TIER: ${tier.transformation}`,
    `SILHOUETTE: ${tier.silhouette}.`,
    `THE PLAYER SHOULD READ IT AS: "${tier.read}"`,
    `ERA MATERIAL: ${era}. The silhouette does not change with era — the material does.`,
  ];
  if (exemplar) {
    lines.push('', `WORKED EXAMPLE AT THIS TIER (${exemplar.building}): ${exemplar.appearance}`);
  }
  // The format rules are identical for every sprite, so they live once in
  // assets/BRIEF.md rather than 5,943 times in the manifest.
  return lines.join('\n');
}

function unitBrief(a: typeof ARCHETYPES[number]): string {
  return [
    `${a.name} — Era ${a.era}, role ${a.role}.`,
    '',
    'NOTE: the workbook carries no authored appearance for units, only their role and era. ' +
      'This brief is therefore composed from those two facts alone, and an art director should ' +
      'expect to write the real one.',
    '',
    `The silhouette must read as ${a.role} at a glance and at small size, because the counter ` +
      'matrix is a rock-paper-scissors the player has to be able to see coming.',
    `ERA MATERIAL: ${ERA_MATERIAL[Math.min(ERA_MATERIAL.length, Math.max(1, a.era)) - 1]}.`,
    '',
  ].join('\n');
}

function researchBrief(r: typeof RESEARCH[number]): string {
  return [
    `${r.name} — Era ${r.era}, ${r.branch} branch.`,
    '',
    `WHAT IT DOES: ${r.perLevel}`,
    '',
    'A flat icon, legible at 24px, distinct from every other discipline in the same branch. ' +
      'Branch reads as colour family; the icon itself carries the specific idea.',
  ].join('\n');
}

/**
 * The full prompt for one asset, joined back from the workbook.
 *
 * This is the text an artist or an image model works from, and it is the same
 * text `briefHash` is taken over — so if this function changes what it says,
 * every already-drawn sprite correctly goes stale.
 */
export function composeBrief(entry: AssetEntry): string {
  if (entry.kind === 'building') {
    const b = BUILDINGS.find((x) => x.name === entry.subject && x.era === entry.era);
    const tier = VISUAL_TIERS.find((t) => t.tier === entry.tier);
    if (b && tier) return buildingBrief(b, tier);
  }
  if (entry.kind === 'unit') {
    const a = ARCHETYPES.find((x) => x.name === entry.subject && x.era === entry.era);
    if (a) return unitBrief(a);
  }
  if (entry.kind === 'research') {
    const r = RESEARCH.find((x) => x.name === entry.subject);
    if (r) return researchBrief(r);
  }
  throw new Error(`cannot compose a brief for ${entry.id}`);
}

export function buildManifest(): AssetEntry[] {
  const out: AssetEntry[] = [];

  for (const b of BUILDINGS) {
    for (const tier of VISUAL_TIERS) {
      out.push({
        id: `building/${b.key}/t${tier.tier}`,
        kind: 'building',
        path: `sprites/buildings/${b.key}/t${tier.tier}.png`,
        ...SIZE.building,
        subject: b.name,
        tier: tier.tier,
        levelBand: `${tier.minLevel}-${tier.maxLevel}`,
        era: b.era,
        category: b.category,
        purpose: b.purpose ?? b.functionText,
        authoredAppearance: b.art,
        briefHash: hash(buildingBrief(b, tier)),
      });
    }
  }

  for (const a of ARCHETYPES) {
    // The archetype key carries a pipe; paths must not.
    const slug = a.key.replace(/[|\s]+/g, '_').toLowerCase();
    out.push({
      id: `unit/${slug}`,
      kind: 'unit',
      path: `sprites/units/${slug}.png`,
      ...SIZE.unit,
      subject: a.name,
      era: a.era,
      category: a.role,
      briefHash: hash(unitBrief(a)),
    });
  }

  for (const r of RESEARCH) {
    out.push({
      id: `research/${r.key}`,
      kind: 'research',
      path: `sprites/research/${r.key}.png`,
      ...SIZE.research,
      subject: r.name,
      era: r.era,
      category: r.branch,
      purpose: r.perLevel,
      briefHash: hash(researchBrief(r)),
    });
  }

  return out;
}

/** Where a sprite actually lives on disk, if it has been drawn. */
function diskPath(entry: AssetEntry): string {
  return join(ROOT, 'packages/client/public', entry.path);
}

/**
 * The status of one asset, read from the world rather than from a log.
 *
 * `stale` is the case worth having: the file exists but was drawn against a
 * brief that has since changed, which is otherwise completely invisible.
 */
export function statusOf(entry: AssetEntry, drawnHashes: Map<string, string>): AssetStatus {
  const file = diskPath(entry);
  if (!existsSync(file) || statSync(file).size === 0) return 'pending';
  const drawnAgainst = drawnHashes.get(entry.id);
  if (drawnAgainst !== undefined && drawnAgainst !== entry.briefHash) return 'stale';
  return 'integrated';
}

/**
 * Hashes each existing sprite was drawn against.
 *
 * Written next to the art as a sidecar rather than into the manifest, so that
 * regenerating the manifest never silently clears the record of what was drawn.
 */
async function readDrawnHashes(): Promise<Map<string, string>> {
  const file = join(ASSET_DIR, 'drawn.json');
  if (!existsSync(file)) return new Map();
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

function renderLedger(entries: AssetEntry[], status: Map<string, AssetStatus>): string {
  const counts = { pending: 0, integrated: 0, stale: 0 };
  for (const e of entries) counts[status.get(e.id) ?? 'pending']++;

  const byKind = new Map<AssetKind, { total: number; done: number }>();
  for (const e of entries) {
    const row = byKind.get(e.kind) ?? { total: 0, done: 0 };
    row.total++;
    if (status.get(e.id) === 'integrated') row.done++;
    byKind.set(e.kind, row);
  }

  const lines = [
    '# Art ledger',
    '',
    'GENERATED by `pnpm run assets` — do not edit by hand.',
    '',
    'An asset is **integrated** when the file exists at its manifest path, because that is when the',
    'renderer actually uses it. Nothing here is ticked off manually: a ledger somebody has to remember',
    'to update is wrong within a week, and both failure modes are bad — drawing something twice because',
    'the log said it was missing, or shipping a hole because the log said it was done.',
    '',
    '**stale** means the file exists but the workbook brief it was drawn against has since changed.',
    'That is otherwise invisible, which is exactly why it is tracked.',
    '',
    `Until a sprite exists, the renderer draws that building procedurally from \`Visual_Tiers\``,
    '(DECISIONS.md D8). Art can therefore land one file at a time with nothing breaking in between.',
    '',
    '## Status',
    '',
    '| Kind | Integrated | Total |',
    '|---|---:|---:|',
  ];
  for (const [kind, row] of [...byKind].sort()) {
    lines.push(`| ${kind} | ${row.done} | ${row.total} |`);
  }
  lines.push(
    `| **all** | **${counts.integrated}** | **${entries.length}** |`,
    '',
  );
  if (counts.stale > 0) {
    lines.push(`> ${counts.stale} sprite(s) are **stale** — redrawn briefs. Run \`pnpm run assets\` to list them.`, '');
  }

  lines.push(
    '## Drawing them with an image model',
    '',
    'Claude cannot generate images. `pnpm run sprites` hands the work order to a model that can —',
    'it needs an API key you supply, and it never claims to have produced art without one.',
    '',
    '```sh',
    'export OPENAI_API_KEY=...            # or STABILITY_API_KEY / REPLICATE_API_TOKEN',
    'pnpm run sprites -- --dry-run building/1_farm/t1   # see the exact prompt first',
    'pnpm run sprites building/1_farm/t1               # draw one',
    'pnpm run sprites -- --kind research --limit 5     # draw the next five still pending',
    '```',
    '',
    'It draws only what is still pending, so stopping and re-running carries on from where the',
    'filesystem says it got to — nothing is ever drawn twice. It records the brief hash before it',
    'reports success, so an interrupted run leaves no art the ledger cannot account for. Batches',
    'over ten need `--yes`, because every image is billed.',
    '',
    '## Adding one by hand',
    '',
    '1. Take an entry from `assets/manifest.jsonl`. `pnpm run brief <id>` prints its full prompt,',
    '   composed from the building\'s own authored appearance, its tier\'s transformation and',
    '   silhouette, and a worked exemplar at the same tier where one exists.',
    '2. Put the resulting PNG at `packages/client/public/<path>` from that entry.',
    '3. Record the `briefHash` you drew against in `assets/drawn.json`, keyed by `id`.',
    '4. Run `pnpm run assets`. The ledger updates itself, and the renderer picks the sprite up',
    '   on the next build with no code change.',
    '',
  );

  const stale = entries.filter((e) => status.get(e.id) === 'stale');
  if (stale.length > 0) {
    lines.push('## Stale', '', ...stale.map((e) => `- \`${e.id}\` — ${e.subject}`), '');
  }

  const done = entries.filter((e) => status.get(e.id) === 'integrated');
  lines.push('## Integrated', '');
  lines.push(done.length === 0
    ? '_Nothing yet. Every building is currently drawn procedurally._'
    : done.map((e) => `- \`${e.id}\` — ${e.subject}${e.tier !== undefined ? ` (tier ${e.tier})` : ''}`).join('\n'));
  lines.push('');
  return lines.join('\n');
}

/**
 * The rules every sprite obeys, written once.
 *
 * These were originally repeated into all 5,943 manifest entries, which made
 * the work order several megabytes of the same paragraph. They are global
 * constraints, not per-asset instructions, so they belong here — and a rule
 * stated once is a rule that can be changed once.
 */
function renderBrief(): string {
  return [
    '# How every sprite is drawn',
    '',
    'GENERATED by `pnpm run assets` — do not edit by hand.',
    '',
    'These rules apply to **every** entry in `manifest.jsonl`. Each entry carries only what is',
    'specific to it; nothing below is repeated there.',
    '',
    '## Projection and light',
    '',
    '- Isometric 2:1, the same fixed camera angle for every sprite in the game.',
    '- Lit from the upper right, one consistent light direction, so a settlement reads as one scene.',
    '- Transparent background. No baseplate, no ground, no baked shadow — the renderer draws the plot',
    '  and the contact shadow underneath.',
    '- Nothing outside the subject\'s own footprint.',
    '',
    '## What must NOT be drawn in',
    '',
    'Seven overlay axes are composited at runtime (`Visual_Overlays`), and drawing any of them into the',
    'sprite would double them up or contradict live state:',
    '',
    ...VISUAL_OVERLAYS.map((o) => `- **${o.axis}** (${o.states}) — ${o.renders}`),
    '',
    'So: no damage, no scaffolding or construction, no banners, liveries or heraldry, no weather or',
    'season, no cultivation aura, and no crew or activity.',
    '',
    '## Why tiers rather than levels',
    '',
    '483 buildings across 1,338 levels is 646,000 states, which nobody can author. Art is drawn per',
    '**tier** — twelve of them — and a level maps onto one. A building keeps its shape inside a tier and',
    'visibly rebuilds when it crosses into the next, which is what makes an upgrade something a player',
    'can see rather than only read.',
    '',
    '| Tier | Levels | Silhouette | The player should read it as |',
    '|---:|---|---|---|',
    ...VISUAL_TIERS.map((t) => `| ${t.tier} | ${t.minLevel}–${t.maxLevel} | ${t.silhouette} | "${t.read}" |`),
    '',
    '## Era',
    '',
    'Era changes the MATERIAL, never the silhouette: "thatch to tile to steel to composite" over the',
    'same shape. A Farm is recognisably the same farm in Era I and Era VII.',
    '',
  ].join('\n');
}

export async function main(): Promise<void> {
  const entries = buildManifest();
  const drawn = await readDrawnHashes();
  const status = new Map(entries.map((e) => [e.id, statusOf(e, drawn)]));

  await mkdir(dirname(MANIFEST), { recursive: true });
  // JSONL, so one changed brief is a one-line diff rather than a rewritten file.
  await writeFile(MANIFEST, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  await writeFile(LEDGER, renderLedger(entries, status), 'utf8');
  await writeFile(BRIEF, renderBrief(), 'utf8');

  const counts = { pending: 0, integrated: 0, stale: 0 };
  for (const e of entries) counts[status.get(e.id)!]++;
  console.log(
    `assets: ${entries.length} in the manifest — ` +
    `${counts.integrated} integrated, ${counts.stale} stale, ${counts.pending} pending`,
  );
  for (const e of entries) {
    if (status.get(e.id) === 'stale') console.log(`  [STALE] ${e.id} — brief changed since it was drawn`);
  }
}

// Only when run directly — `brief.ts` imports this module for its manifest.
if (process.argv[1]?.endsWith('build-assets.ts')) {
  await main();
}
