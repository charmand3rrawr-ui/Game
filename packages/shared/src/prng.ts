/**
 * prng.ts — the only source of randomness in the simulation
 *
 * INVARIANT §2.2: simulation is deterministic and replayable. Given the same
 * event log and the same seed, a world replays identically. Every random draw
 * comes from here, keyed by (worldId, eventId), so the same event always
 * produces the same draws — which is what makes archaeology, dispute
 * resolution, the World Atlas and every balance simulation possible.
 *
 * NEVER call Math.random() in simulation code. A resolver that does is not
 * replayable and is a defect, not a shortcut.
 *
 * SPEC: spec/03_simulation_engine.md §2
 */

/** A deterministic draw in [0, 1). */
export type Rng = () => number;

/**
 * xoshiro128** — small, fast, and well-distributed over 32-bit state.
 *
 * Chosen over a Mersenne Twister (far too much state to seed per event) and
 * over an LCG (visible structure in the low bits, which shows up as patterns in
 * ambush and crit rolls that players WILL find and complain about).
 *
 * All arithmetic is kept in 32-bit integer space via `| 0` and `>>> 0`, so the
 * sequence is identical on every JS engine and CPU. That portability is the
 * whole point: a battle must replay byte-identically on another machine
 * (spec/08 M4 acceptance).
 */
export function xoshiro128ss(a: number, b: number, c: number, d: number): Rng {
  let s0 = a | 0;
  let s1 = b | 0;
  let s2 = c | 0;
  let s3 = d | 0;
  // A zero state is absorbing — it would emit zeroes forever.
  if ((s0 | s1 | s2 | s3) === 0) s0 = 0x9e3779b9 | 0;

  return function next(): number {
    const t = Math.imul(s1, 5);
    const r = Math.imul((t << 7) | (t >>> 25), 9);
    const u = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= u;
    s3 = (s3 << 11) | (s3 >>> 21);
    // >>> 0 lifts to unsigned before the divide; 2^32 keeps the result in [0,1).
    return (r >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a over a string, expanded into four well-mixed 32-bit words.
 *
 * A plain hash reused four times would leave the streams correlated, which
 * shows up as suspiciously similar outcomes in adjacent phases of the same
 * battle. Each word is separately avalanched.
 */
export function seedFromString(s: string): [number, number, number, number] {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    out.push(h | 0);
  }
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

/**
 * The simulation's entry point for randomness.
 *
 * Keying on (worldId, eventId) — never on wall-clock time, a counter, or
 * anything about when the event actually ran — is what lets a recorded event
 * log be replayed into an empty database and produce a byte-identical world
 * (spec/08, "the single most valuable test in the codebase").
 */
export function prng(worldId: string, eventId: string): Rng {
  const [a, b, c, d] = seedFromString(`${worldId}:${eventId}`);
  return xoshiro128ss(a, b, c, d);
}

/** A battle's seed, stored on the row so the fight can be re-run exactly. */
export function battleSeed(worldId: string, eventId: string): bigint {
  const [a, b] = seedFromString(`${worldId}:${eventId}`);
  return (BigInt(a >>> 0) << 32n) | BigInt(b >>> 0);
}

/** Re-create a generator from a stored battle seed. */
export function rngFromSeed(seed: bigint): Rng {
  const hi = Number((seed >> 32n) & 0xffffffffn);
  const lo = Number(seed & 0xffffffffn);
  const [a, b, c, d] = seedFromString(`${hi}:${lo}`);
  return xoshiro128ss(a, b, c, d);
}

/** Integer in [0, n). Uses one draw, so draw counts stay stable. */
export function rngInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

/**
 * Deterministic shuffle (Fisher-Yates). Draw count depends only on array
 * LENGTH, never on the values — a draw count that varied with content would
 * desynchronise a replay (spec/03 §2).
 */
export function rngShuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rngInt(rng, i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}
