/**
 * roster.test.ts — M3 acceptance, plus determinism of the PRNG.
 *
 * spec/08 M3: "2,268 unit definitions generate from the parameter sheets and
 * match Units_Master exactly; a Mythic Path Avatar trains in 4,383 hours."
 *
 * The importer verifies the roster against the workbook at build time. These
 * tests verify it against the SHIPPED constants, so the property survives into
 * the running game rather than living only in the build.
 */

import { describe, it, expect } from 'vitest';
import { ROSTER, unitDef, counterMultiplier, counterMatrixByName, ROLES } from './roster.js';
import { ARCHETYPES, UNIT_GRADES, UNIT_PATHS, BUILDINGS, HOLDINGS, VETERANCY_TIERS, EQUIPMENT, RESEARCH } from './generated/refdata.js';
import { C, ASSUMED_CONSTANTS, BALANCE_REVISION, CONSTANT_META } from './generated/constants.js';
import { prng, rngShuffle, battleSeed, rngFromSeed } from './prng.js';

describe('M3 acceptance — the roster generates rather than being stored', () => {
  it('produces exactly 2,268 units from 126 archetypes x 3 paths x 6 grades', () => {
    expect(ARCHETYPES.length).toBe(126);
    expect(UNIT_PATHS.length).toBe(3);
    expect(UNIT_GRADES.length).toBe(6);
    expect(ROSTER.length).toBe(2268);
  });

  it('gives every unit a unique key', () => {
    expect(new Set(ROSTER.map((u) => u.unitKey)).size).toBe(ROSTER.length);
  });

  it('trains a Mythic Path Avatar in exactly 4,383 hours', () => {
    const avatar = ROSTER.find((u) => u.archetype === 'Path Avatar' && u.grade === 'Mythic' && u.path.startsWith('Orthodox'));
    expect(avatar?.trainHours).toBe(4383);
  });

  it('reproduces the published Era I militia line', () => {
    const militia = unitDef('1|Militia|Orthodox (Balanced)|Mortal');
    expect([militia.atk, militia.def, militia.hp, militia.speed, militia.upkeep]).toEqual([8, 14, 60, 18, 2]);
    const elite = unitDef('1|Militia|Asura (Offense)|Elite');
    expect([elite.atk, elite.def, elite.hp]).toEqual([17.3, 21.4, 103]);
    expect(elite.name).toBe('Elite Asura Militia');
  });

  it('keeps the identity paths genuinely distinct', () => {
    const o = unitDef('1|Shield Bearer|Orthodox (Balanced)|Mortal');
    const a = unitDef('1|Shield Bearer|Asura (Offense)|Mortal');
    const g = unitDef('1|Shield Bearer|Guardian (Defense)|Mortal');
    expect(a.atk).toBeGreaterThan(o.atk);
    expect(a.def).toBeLessThan(o.def);
    expect(g.def).toBeGreaterThan(o.def);
    expect(g.speed).toBeLessThan(o.speed);
  });

  it('makes high-grade units strategic capital rather than consumables', () => {
    // Losing a Mythic Titan costs a dynasty weeks of production. That is what
    // makes capital engagements fearful and shipyard raids worth planning.
    // Judged at the top of the tech tree, where capital units actually live:
    // an Era I Mythic militiaman is still a militiaman.
    const mythic = ROSTER.filter((u) => u.grade === 'Mythic' && u.era === 7);
    const median = mythic.map((u) => u.trainHours).sort((x, y) => x - y)[Math.floor(mythic.length / 2)]!;
    expect(median).toBeGreaterThan(24 * 7);
    // And the whole roster stays an ordered ladder: every grade step costs more.
    const line = ['Mortal', 'Refined', 'Elite', 'Ascendant', 'Transcendent', 'Mythic'].map(
      (g) => ROSTER.find((u) => u.archetypeKey === '7|Path Avatar' && u.grade === g && u.path.startsWith('Orthodox'))!.trainHours,
    );
    for (let i = 1; i < line.length; i++) expect(line[i]!).toBeGreaterThan(line[i - 1]!);
  });
});

describe('the counter matrix', () => {
  it('covers 34 roles', () => {
    expect(ROLES.length).toBe(34);
  });

  it('never exceeds the sanctioned 2.2x strongest entry', () => {
    // CALIBRATION ANCHOR 5 (spec/07 §3.5). Nothing else in the game may
    // produce a larger single-source multiplier without deliberate review.
    let strongest = 0;
    for (const a of ROLES) for (const d of ROLES) strongest = Math.max(strongest, counterMultiplier(a, d));
    expect(strongest).toBeLessThanOrEqual(C.COUNTER_MAX);
    expect(strongest).toBeGreaterThan(1.5);
  });

  it('is never zero or negative — roleFactor divides by it', () => {
    for (const a of ROLES) for (const d of ROLES) expect(counterMultiplier(a, d)).toBeGreaterThan(0);
  });

  it('treats an unknown pairing as no special relationship', () => {
    expect(counterMultiplier('Nonexistent', 'Ranged')).toBe(1);
  });

  it('exposes the same numbers in both the indexed and named forms', () => {
    const named = counterMatrixByName();
    expect(named['Anti-Cavalry']?.['Shock Cavalry']).toBe(counterMultiplier('Anti-Cavalry', 'Shock Cavalry'));
    expect(counterMultiplier('Anti-Cavalry', 'Shock Cavalry')).toBeGreaterThan(1);
  });
});

describe('imported reference data', () => {
  it('carries the full building, holding, research and equipment catalogues', () => {
    expect(BUILDINGS.length).toBe(483);
    expect(HOLDINGS.length).toBe(12);
    expect(RESEARCH.length).toBe(21);
    expect(EQUIPMENT.length).toBe(135);
    expect(VETERANCY_TIERS.length).toBe(24);
  });

  it('records which balance revision it was generated from', () => {
    expect(BALANCE_REVISION).toMatch(/^[0-9a-f]{64}$/);
  });

  it('declares every constant’s provenance, and flags the assumed ones', () => {
    // Invariant §2.5: balance numbers come from the workbook. Where the spec
    // leaves one unstated, it is marked rather than silently invented.
    for (const name of Object.keys(CONSTANT_META)) {
      expect(CONSTANT_META[name]?.ref).toBeTruthy();
    }
    for (const name of ASSUMED_CONSTANTS) {
      expect(CONSTANT_META[name]?.provenance).toBe('assumed');
    }
    // Most constants must be traceable to the workbook or the specification.
    const assumedShare = ASSUMED_CONSTANTS.length / Object.keys(CONSTANT_META).length;
    expect(assumedShare).toBeLessThan(0.15);
  });
});

describe('determinism — the property every other guarantee rests on', () => {
  it('produces an identical stream for the same (worldId, eventId)', () => {
    const a = prng('world-1', 'event-7');
    const b = prng('world-1', 'event-7');
    const xs = Array.from({ length: 64 }, () => a());
    const ys = Array.from({ length: 64 }, () => b());
    expect(xs).toEqual(ys);
  });

  it('decorrelates different events and different worlds', () => {
    const a = prng('world-1', 'event-7')();
    const b = prng('world-1', 'event-8')();
    const c = prng('world-2', 'event-7')();
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('stays in [0, 1) and distributes evenly', () => {
    const r = prng('w', 'e');
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 100_000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)]!++;
    }
    for (const b of buckets) expect(b).toBeGreaterThan(9_000);
  });

  it('shuffles with a draw count that depends only on length, never on values', () => {
    // A draw count that varied with content would desynchronise a replay.
    const count = (items: unknown[]): number => {
      let n = 0;
      const base = prng('w', 'e');
      rngShuffle(() => {
        n++;
        return base();
      }, items);
      return n;
    };
    expect(count([1, 2, 3, 4, 5])).toBe(count(['a', 'b', 'c', 'd', 'e']));
  });

  it('round-trips a stored battle seed back into the same stream', () => {
    // This is what makes a battle re-runnable from its row alone.
    const seed = battleSeed('world-1', 'battle-42');
    const a = Array.from({ length: 16 }, rngFromSeed(seed));
    const b = Array.from({ length: 16 }, rngFromSeed(seed));
    expect(a).toEqual(b);
    expect(battleSeed('world-1', 'battle-43')).not.toBe(seed);
  });
});
