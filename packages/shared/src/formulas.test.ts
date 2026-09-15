/**
 * formulas.test.ts — the calibration anchors, asserted in code.
 *
 * spec/07 §3 lists six fixed points the whole economy was tuned around. The
 * importer asserts them against the workbook; these assert them against the
 * running code, so a refactor cannot quietly move one.
 */

import { describe, it, expect } from 'vitest';
import { C } from './generated/constants.js';
import {
  buildingCost,
  buildTimeMs,
  outputMultiplier,
  accrue,
  gradeForLevel,
  qiBreakthroughCost,
  trainTimeMs,
  veterancyStatMultiplier,
  cumulativeLevels,
  xpRequiredForLevel,
  experienceFatigue,
  empireWeightMultiplier,
  tierUpCost,
  diluteVeterancy,
  maxTierForEra,
  applyJointCap,
  morale,
  fortificationMultiplier,
  heavensEnvyDebuff,
  shardCeiling,
  shardsPermitted,
  applyShards,
  travelTimeMs,
  capturedBuildingLevel,
  personalQueueSlots,
  plotsAvailable,
} from './formulas.js';

describe('calibration anchor 1 — a full 0→1337 climb takes exactly 500 years', () => {
  it('sums build time across every level to 4,383,000 hours', () => {
    let totalMs = 0n;
    for (let L = 0; L <= C.MAX_LEVEL; L++) totalMs += buildTimeMs(L, 1, 1, 1);
    const years = Number(totalMs) / 3_600_000 / 8766;
    expect(years).toBeCloseTo(500, 2);
  });

  it('keeps cost near-exponential while output stays polynomial', () => {
    // This asymmetry is what creates a rational stopping point per building.
    // Without it players would simply max everything in priority order.
    const costRatio = Number(buildingCost(100n, 600)) / Number(buildingCost(100n, 300));
    const outputRatio = outputMultiplier(600) / outputMultiplier(300);
    expect(costRatio).toBeGreaterThan(outputRatio * 4);
  });
});

describe('calibration anchor 2 — a Mythic Path Avatar trains in exactly 4,383 hours', () => {
  it('trains in six months', () => {
    // Path Avatar base upkeep 900, Mythic grade train multiplier 12.
    const ms = trainTimeMs(900, 12, 1, 1);
    expect(Number(ms) / 3_600_000).toBeCloseTo(4383, 0);
  });

  it('doubles under a governor, and nothing else changes', () => {
    // The entire governor system is this one number (spec/04 §6).
    expect(trainTimeMs(900, 12, 1, 2)).toBe(trainTimeMs(900, 12, 1, 1) * 2n);
  });
});

describe('calibration anchor 3 — the 24-tier veterancy ladder is 322x', () => {
  it('tops out at 321.88x', () => {
    const top = cumulativeLevels(C.MAX_VET_TIER, C.LEVELS_PER_TIER);
    expect(veterancyStatMultiplier(top)).toBeCloseTo(321.88, 2);
  });

  it('grants nothing for a tier by itself — only levels carry stats', () => {
    const endOfTier3 = cumulativeLevels(3, C.LEVELS_PER_TIER);
    const startOfTier4 = cumulativeLevels(4, 0);
    expect(veterancyStatMultiplier(endOfTier3)).toBe(veterancyStatMultiplier(startOfTier4));
  });
});

describe('calibration anchor 4 — the joint non-doctrine bonus cap is +40%', () => {
  it('clamps five reasonable systems into one reasonable one', () => {
    // Proficiency, equipment, commander, cultivation and veterancy, each a
    // modest 12%, multiply to +76% uncapped.
    const combined = 1.12 ** 5;
    const r = applyJointCap(1000, combined);
    expect(r.capped).toBe(true);
    expect(r.value).toBeCloseTo(1400, 6);
    // Both values are reported, so the player can SEE the cap engage. A silent
    // cap produces accusations of cheating.
    expect(r.uncapped).toBeGreaterThan(r.value);
  });

  it('leaves a modest stack alone', () => {
    const r = applyJointCap(1000, 1.2);
    expect(r.capped).toBe(false);
    expect(r.value).toBeCloseTo(1200, 6);
  });
});

describe('calibration anchor 6 — empire weight caps at 9,918,521x', () => {
  it('leaves new and mid-sized players essentially untouched', () => {
    expect(empireWeightMultiplier(2)).toBeCloseTo(1.0001, 3); // one village
    expect(empireWeightMultiplier(20)).toBeLessThan(1.05); // ten villages
    expect(empireWeightMultiplier(70)).toBeLessThan(1.5); // a normal mid-game empire
  });

  it('bites at the knee and hard-caps at the top', () => {
    expect(empireWeightMultiplier(400)).toBeCloseTo(29.2465, 3);
    expect(empireWeightMultiplier(80_000)).toBeCloseTo(9_918_521, 0);
    expect(empireWeightMultiplier(1e9)).toBe(C.EW_CAP);
  });

  it('does NOT scale tier-up cost — this asymmetry is the Champion economy', () => {
    // Small players can learn but not pay; galactic powers can pay but not
    // learn. Large empires therefore bankroll small allies' promotions. This
    // is an intended emergent consequence, not a bug (spec/04 §5).
    expect(tierUpCost(12)).toBe(1_236_792_784n);
    expect(tierUpCost(2)).toBe(50_000n);
    expect(tierUpCost(1)).toBe(0n);
  });
});

describe('green dilution — the most important rule in the veterancy system', () => {
  it('lands a Tier 12 hundred merged with 900 recruits near Tier 1', () => {
    const veteran = cumulativeLevels(12, 0); // 11 full tiers of levels
    const diluted = diluteVeterancy(veteran, 100, 0, 900);
    // 14707 * 0.1 = 1470.7 cumulative levels, i.e. just past tier 1.
    expect(Math.floor(diluted / C.LEVELS_PER_TIER) + 1).toBe(2);
    expect(diluted).toBeLessThan(cumulativeLevels(3, 0));
  });

  it('is computed on the cumulative-level scale, not the tier scale', () => {
    // Tiers are not linear in accumulated experience, so averaging them gives a
    // different — and wrong — answer. A Tier 12 formation at level 800 merged
    // 50/50 with green troops:
    const veteran = cumulativeLevels(12, 800);
    const diluted = diluteVeterancy(veteran, 500, 0, 500);
    const realTier = diluted / C.LEVELS_PER_TIER + 1;
    const naiveTierAverage = (12 + 1) / 2;
    expect(realTier).toBeCloseTo(6.8, 1);
    expect(Math.abs(realTier - naiveTierAverage)).toBeGreaterThan(0.2);
  });

  it('is exactly linear in cumulative levels — the property tier averaging lacks', () => {
    const a = cumulativeLevels(9, 431);
    const b = cumulativeLevels(3, 17);
    expect(diluteVeterancy(a, 137, b, 863)).toBeCloseTo((a * 137 + b * 863) / 1000, 9);
  });

  it('is a no-op when nothing is added', () => {
    expect(diluteVeterancy(5000, 100, 0, 0)).toBe(5000);
  });
});

describe('the split curve — two gentle slopes, not one brutal exponential', () => {
  it('keeps the largest requirement readable', () => {
    // A per-level doubling curve would reach 10^402 and be unstorable. The
    // largest requirement here is about 1.88e12 (spec/07 §2).
    const hardest = xpRequiredForLevel(C.MAX_VET_TIER, C.LEVELS_PER_TIER, 1);
    expect(hardest).toBeLessThan(10_000_000n);
    const withWeight = xpRequiredForLevel(C.MAX_VET_TIER, C.LEVELS_PER_TIER, C.EW_CAP);
    expect(Number(withWeight)).toBeLessThan(1e13);
  });

  it('pairs a rising requirement with a falling earn rate', () => {
    const reqLow = Number(xpRequiredForLevel(1, 0, 1));
    const reqHigh = Number(xpRequiredForLevel(12, 1000, 1));
    expect(reqHigh / reqLow).toBeGreaterThan(20);
    expect(experienceFatigue(12, 1000)).toBeLessThan(experienceFatigue(1, 0) / 20);
  });
});

describe('production accrual is lazy and overflow is discarded', () => {
  it('computes on read rather than on a tick', () => {
    const r = accrue(0n, 1000n, 1 / 1000, 0n, 500_000n); // 1 per second
    expect(r.amount).toBe(500n);
    expect(r.overflowed).toBe(false);
  });

  it('DISCARDS overflow above capacity rather than carrying it', () => {
    // That loss is deliberate design pressure to spend, trade, or expand.
    const r = accrue(900n, 1000n, 1, 0n, 1000n);
    expect(r.amount).toBe(1000n);
    expect(r.overflowed).toBe(true);
  });

  it('never goes backwards when now is behind lastAccruedAt', () => {
    expect(accrue(500n, 1000n, 1, 1000n, 0n).amount).toBe(500n);
  });
});

describe('morale — smaller empires fight harder', () => {
  it('stays inside the 0.5 .. 1.5 clamp at any size ratio', () => {
    for (const [a, d] of [[1, 1000], [1000, 1], [50, 50], [1e9, 1]] as const) {
      const m = morale(a, d);
      expect(m).toBeGreaterThanOrEqual(C.MORALE_MIN);
      expect(m).toBeLessThanOrEqual(C.MORALE_MAX);
    }
  });

  it('favours the smaller side', () => {
    expect(morale(10, 100)).toBeGreaterThan(morale(100, 10));
  });
});

describe('Heaven’s Envy — the mark of stolen time', () => {
  it('stacks to exactly -30% and no further', () => {
    expect(heavensEnvyDebuff(0)).toBe(1);
    expect(heavensEnvyDebuff(1)).toBeCloseTo(0.9, 10);
    expect(heavensEnvyDebuff(3)).toBeCloseTo(0.7, 10);
    expect(heavensEnvyDebuff(9)).toBeCloseTo(0.7, 10);
  });
});

describe('Chrono Shards — money buys you up to your earned ceiling, never past it', () => {
  it('matches the published ceiling table', () => {
    expect(shardCeiling(0, 1)).toBeCloseTo(2.5, 6); // new player, first week
    expect(shardCeiling(5, 3)).toBeCloseTo(5.0, 6); // competent kingdom
    expect(shardCeiling(10, 7)).toBeCloseTo(8.5, 6); // the hard ceiling
  });

  it('refuses every prohibited target', () => {
    const base = {
      hostileInboundMs: null,
      atWarAsBelligerent: false,
      itemKind: 'building',
      isAscensionProject: false,
      isEpochVictoryProject: false,
      isMegastructure: false,
      isCultivationBreakthrough: false,
      isFortificationRepairUnderSiege: false,
      targetEraGap: 0,
    };
    expect(shardsPermitted(base).allowed).toBe(true);
    expect(shardsPermitted({ ...base, hostileInboundMs: 3_600_000 }).reason).toBe('hostile-movement-inbound');
    expect(shardsPermitted({ ...base, atWarAsBelligerent: true, itemKind: 'training' }).reason).toBe('wartime-training');
    expect(shardsPermitted({ ...base, isAscensionProject: true }).reason).toBe('ascension-project');
    expect(shardsPermitted({ ...base, isEpochVictoryProject: true }).reason).toBe('epoch-victory-project');
    expect(shardsPermitted({ ...base, isMegastructure: true }).reason).toBe('megastructure');
    expect(shardsPermitted({ ...base, isCultivationBreakthrough: true }).reason).toBe('cultivation');
    expect(shardsPermitted({ ...base, isFortificationRepairUnderSiege: true }).reason).toBe('under-siege');
    expect(shardsPermitted({ ...base, targetEraGap: 2 }).reason).toBe('escalation-rules');
  });

  it('cannot be exceeded by any purchase, however large', () => {
    // A whale offering a thousand shard-hours at rank 0 gets the same
    // compression as everybody else; the surplus is simply unspendable.
    const totalMs = 10n * 3_600_000n; // a ten-hour item
    const r = applyShards({
      now: 0n,
      startedAt: 0n,
      finishesAt: totalMs,
      shardHoursOffered: 1000,
      constructionRank: 0,
      era: 1,
      alreadyCompressedMs: 0n,
    });
    // ceiling 2.5x => the item can never take less than 4 hours.
    expect(Number(r.finishesAt) / 3_600_000).toBeCloseTo(4, 6);
    expect(r.ceilingReached).toBe(true);
    expect(r.shardHoursSpent).toBeCloseTo(6, 6);
  });

  it('respects compression already spent, so the ceiling cannot be lapped', () => {
    const totalMs = 10n * 3_600_000n;
    const already = 6n * 3_600_000n;
    const r = applyShards({
      now: 0n,
      startedAt: 0n,
      finishesAt: totalMs - already,
      shardHoursOffered: 100,
      constructionRank: 0,
      era: 1,
      alreadyCompressedMs: already,
    });
    expect(r.shardHoursSpent).toBe(0);
    expect(r.ceilingReached).toBe(true);
  });
});

describe('structural rules', () => {
  it('puts every 32 levels on a grade boundary, capped at 42', () => {
    expect(gradeForLevel(0)).toBe(1);
    expect(gradeForLevel(31)).toBe(1);
    expect(gradeForLevel(32)).toBe(2);
    expect(gradeForLevel(1337)).toBe(42);
  });

  it('matches the published Qi breakthrough costs', () => {
    expect(qiBreakthroughCost(1)).toBe(115n);
    expect(qiBreakthroughCost(2)).toBe(1215n);
    expect(qiBreakthroughCost(3)).toBe(5115n);
  });

  it('gates veterancy tier by era so a theatre stays within a few tiers', () => {
    expect(maxTierForEra(1)).toBe(4);
    expect(maxTierForEra(7)).toBe(C.MAX_VET_TIER);
  });

  it('raises fortification by 5% per wall grade', () => {
    expect(fortificationMultiplier(0)).toBe(1);
    expect(fortificationMultiplier(20)).toBeCloseTo(2, 10);
  });

  it('drops captured buildings by exactly three grades', () => {
    expect(capturedBuildingLevel(500)).toBe(500 - 3 * C.LEVELS_PER_GRADE);
    expect(capturedBuildingLevel(10)).toBe(0);
  });

  it('grants personal queue slots and plots from the HQ grade', () => {
    expect(personalQueueSlots(0)).toBe(1);
    expect(personalQueueSlots(8)).toBe(3);
    expect(plotsAvailable(24, 110, 0)).toBe(24);
    expect(plotsAvailable(24, 110, 10)).toBe(44);
    expect(plotsAvailable(24, 110, 1000)).toBe(110);
  });

  it('slows movement inside a hostile zone of control', () => {
    const free = travelTimeMs(100, 20, 1, 1, false);
    const contested = travelTimeMs(100, 20, 1, 1, true);
    expect(Number(contested) / Number(free)).toBeCloseTo(1 / C.ZOC_SPEED_MULT, 6);
  });

  it('never rounds an arrival timestamp away from its computed value', () => {
    // Coordinated multi-wave attacks landing seconds apart are a core skill;
    // they only work because arrival is exact.
    const a = travelTimeMs(1000.5, 17.3, 1, 1, false);
    const b = travelTimeMs(1000.6, 17.3, 1, 1, false);
    expect(a).not.toBe(b);
  });
});
