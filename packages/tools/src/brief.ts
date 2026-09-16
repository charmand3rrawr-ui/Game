/**
 * brief.ts — print the full art prompt for one asset
 *
 * `manifest.jsonl` carries only what is unique to each asset; the tier rules,
 * the era material and the worked exemplars live once in `BRIEF.md`. This
 * joins them back, so a single command produces the complete text an artist or
 * an image tool works from:
 *
 *     pnpm run brief building/1_farm/t3
 *     pnpm run brief --pending --kind building --limit 5
 *
 * The point of composing on demand rather than storing 5,943 copies is that a
 * change to how briefs are written lands everywhere at once, and correctly
 * marks already-drawn art stale through `briefHash`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildManifest, composeBrief, statusOf, type AssetEntry } from './build-assets.js';
import { existsSync } from 'node:fs';

const ROOT = new URL('../../../', import.meta.url).pathname;

async function drawnHashes(): Promise<Map<string, string>> {
  const file = join(ROOT, 'assets/drawn.json');
  if (!existsSync(file)) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(await readFile(file, 'utf8')) as Record<string, string>));
  } catch {
    return new Map();
  }
}

function usage(): void {
  console.log(
    'usage:\n' +
    '  pnpm run brief <asset-id>              print one full prompt\n' +
    '  pnpm run brief --pending [--kind K] [--limit N]\n' +
    '                                         print the next prompts still to draw\n',
  );
}

export async function main(argv: string[]): Promise<void> {
  const entries = buildManifest();
  const byId = new Map(entries.map((e) => [e.id, e]));

  if (argv.length === 0) return usage();

  if (!argv[0]!.startsWith('--')) {
    const entry = byId.get(argv[0]!);
    if (!entry) {
      console.error(`no such asset: ${argv[0]}`);
      process.exitCode = 1;
      return;
    }
    print(entry);
    return;
  }

  const kind = valueOf(argv, '--kind');
  const limit = Number(valueOf(argv, '--limit') ?? 3);
  const drawn = await drawnHashes();

  const pending = entries
    .filter((e) => statusOf(e, drawn) !== 'integrated')
    .filter((e) => kind === undefined || e.kind === kind)
    .slice(0, Math.max(1, limit));

  if (pending.length === 0) {
    console.log('nothing pending — every sprite in that selection is already integrated');
    return;
  }
  for (const e of pending) {
    print(e);
    console.log('\n' + '─'.repeat(72) + '\n');
  }
}

function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

function print(entry: AssetEntry): void {
  console.log(`# ${entry.id}`);
  console.log(`# file:  packages/client/public/${entry.path}`);
  console.log(`# size:  ${entry.width}x${entry.height}`);
  console.log(`# hash:  ${entry.briefHash}   <- record this in assets/drawn.json when drawn`);
  console.log('# rules: assets/BRIEF.md applies to every sprite and is not repeated here');
  console.log('');
  console.log(composeBrief(entry));
}

await main(process.argv.slice(2));
