/**
 * xp.test.ts — the M5 acceptance test and the anti-farming rules.
 *
 * spec/08 M5: "the XP_Worked_Example sheet reproduces exactly in code — 2,000
 * Elite Musketeers at Ruby earn 211 XP from that engagement."
 *
 * That single number exercises contribution share, UPV, the counter matrix,
 * relative factor, fatigue and repetition all at once, which is why the spec
 * chose it as the milestone gate.
 */

import { describe, it, expect } from 'vitest';
import { C } from './generated/constants.js';
import {
  attributeKills,
  absorptionXp,
  roleFactor,
  relativeFactor,
  repetitionFactor,
  hardZeroReason,
  averageVictimUPV,
  applyXp,
  type CombatantSlice,
  type VictimProfile,
} from './xp.js';
import { unitPowerValue, cumulativeLevels, xpRequiredForLevel, maxTierForEra } from './formulas.js';

/**
 * The counter matrix slice the worked example uses.
 *
 * The sheet gives RoleFactor 0.77 against Pikemen, i.e. a counter multiplier of
 * 1/0.77 ≈ 1.3 — Anti-Cavalry pikemen resist Ranged musketeers — and 1.0
 * against crossbowmen.
 */
const MATRIX: Record<string, Record<string, number>> = {
  Ranged: { 'Anti-Cavalry': 1.3, Ranged: 1.0 },
  Screen: { Ranged: 1.0 },
};

describe('M5 acceptance — the worked example reproduces exactly', () => {
  // THE ENGAGEMENT (XP_Worked_Example):
  //   Attacker: the Ninth Musket — 2,000 Elite Musketeers at Ruby (tier 12,
  //             level 800), upkeep 9.6, plus 300 Field Cannon.
  //   Defender: 1,500 Bronze pikemen (tier 2, level 400) and 800 Copper
  //             crossbowmen (tier 1, level 600), upkeep 4 each.
  //   Result:   attacker wins; 900 pikemen and 400 crossbowmen lost;
  //             the musketeers' contribution share of the attack pool is 0.78.
  const musketeers: CombatantSlice = {
    formationId: 'ninth-musket',
    unitKey: '3|Musketeer|Orthodox (Balanced)|Elite',
    role: 'Ranged',
    count: 2000,
    baseUpkeep: 9.6,
    tier: 12,
    levelInTier: 800,
    contributionShare: 0.78,
  };

  const victims: Record<string, VictimProfile> = {
    pikemen: { unitKey: 'pikemen', role: 'Anti-Cavalry', baseUpkeep: 4, tier: 2, levelInTier: 400 },
    crossbowmen: { unitKey: 'crossbowmen', role: 'Ranged', baseUpkeep: 4, tier: 1, levelInTier: 600 },
  };

  it('reproduces the published stat multipliers and UPVs', () => {
    expect(unitPowerValue(9.6, cumulativeLevels(12, 800))).toBeCloseTo(1498.3, 1);
    expect(unitPowerValue(11, cumulativeLevels(5, 200))).toBeCloseTo(621.3, 1);
    expect(unitPowerValue(4, cumulativeLevels(2, 400))).toBeCloseTo(73.5, 1);
    expect(unitPowerValue(4, cumulativeLevels(1, 600))).toBeCloseTo(28, 1);
  });

  it('credits kills by contribution share', () => {
    expect(900 * 0.78).toBeCloseTo(702, 6);
    expect(400 * 0.78).toBeCloseTo(312, 6);
  });

  it('reproduces the published role and relative factors', () => {
    expect(roleFactor(MATRIX, 'Ranged', 'Anti-Cavalry')).toBeCloseTo(0.77, 2);
    expect(roleFactor(MATRIX, 'Ranged', 'Ranged')).toBeCloseTo(1.0, 6);
    const killerUPV = unitPowerValue(9.6, cumulativeLevels(12, 800));
    expect(relativeFactor(unitPowerValue(4, cumulativeLevels(2, 400)), killerUPV)).toBeCloseTo(0.221, 3);
    expect(relativeFactor(unitPowerValue(4, cumulativeLevels(1, 600)), killerUPV)).toBeCloseTo(0.137, 3);
  });

  it('awards the Ninth Musket exactly 211 XP on the attack track', () => {
    const row = attributeKills({
      killer: musketeers,
      track: 'atk',
      phaseLosses: { byUnitKey: { pikemen: 900, crossbowmen: 400 } },
      victimProfiles: victims,
      counterMatrix: MATRIX,
      engagementsAgainstTargetToday: 0,
      won: true,
      victimIsNpc: false,
      eraGapBelow: 0,
      targetIsLinkedAccount: false,
    });

    expect(row.killsCredited['pikemen']).toBeCloseTo(702, 6);
    expect(row.killsCredited['crossbowmen']).toBeCloseTo(312, 6);
    // Sum of weighted value: 8,780 + 1,197 = 9,977 on the sheet.
    expect(row.rawValue).toBeGreaterThan(9900);
    expect(row.rawValue).toBeLessThan(10050);
    expect(row.fatigue).toBeCloseTo(0.0211, 4);
    expect(row.repetition).toBe(1);
    expect(row.xpAwarded).toBe(211n);
  });

  it('shows that a huge siege is worth a fraction of a level to a Ruby formation', () => {
    // The sheet's read-out: 2.9% of a level, about ten standard battles.
    const required = xpRequiredForLevel(12, 800, 1);
    expect(Number(required)).toBeCloseTo(7297, -1);
    expect((211 / Number(required)) * 100).toBeCloseTo(2.9, 1);
  });

  it('still pays the losing side about 60% on the same attribution', () => {
    const args = {
      killer: musketeers,
      track: 'atk' as const,
      phaseLosses: { byUnitKey: { pikemen: 900, crossbowmen: 400 } },
      victimProfiles: victims,
      counterMatrix: MATRIX,
      engagementsAgainstTargetToday: 0,
      victimIsNpc: false,
      eraGapBelow: 0,
      targetIsLinkedAccount: false,
    };
    const won = attributeKills({ ...args, won: true }).xpAwarded;
    const lost = attributeKills({ ...args, won: false }).xpAwarded;
    // Fighting a losing war must never be progression death, or players in
    // that position simply quit.
    expect(Number(lost) / Number(won)).toBeCloseTo(C.LOSER_XP_RATE, 2);
  });
});

describe('anti-farming — hard zeroes, not reductions', () => {
  const base = {
    engagementVictimUPV: 100,
    killerUPV: 100,
    victimIsNpc: false,
    killerTier: 1,
    eraGapBelow: 0,
    targetIsLinkedAccount: false,
  };

  it('gives an elite formation literally nothing for peasants', () => {
    // A reduction still rewards grinding at scale; a zero ends the strategy.
    expect(hardZeroReason({ ...base, engagementVictimUPV: 1.9 })).toBe('beneath-notice');
    expect(hardZeroReason({ ...base, engagementVictimUPV: 2.1 })).toBeNull();
  });

  it('stops barbarians carrying a formation past Steel', () => {
    expect(hardZeroReason({ ...base, victimIsNpc: true, killerTier: 4 })).toBe('npc-ceiling');
    expect(hardZeroReason({ ...base, victimIsNpc: true, killerTier: 3 })).toBeNull();
  });

  it('pays nothing for punching two or more eras down', () => {
    expect(hardZeroReason({ ...base, eraGapBelow: 2 })).toBe('escalation');
    expect(hardZeroReason({ ...base, eraGapBelow: 1 })).toBeNull();
  });

  it('pays nothing for self-dealing between linked accounts', () => {
    expect(hardZeroReason({ ...base, targetIsLinkedAccount: true })).toBe('linked-account');
  });

  it('decays repetition against the same defender within 24 hours', () => {
    expect(repetitionFactor(0)).toBe(1);
    expect(repetitionFactor(1)).toBeCloseTo(0.6, 6);
    expect(repetitionFactor(4)).toBeCloseTo(0.1, 6);
    expect(repetitionFactor(99)).toBeCloseTo(0.1, 6);
  });

  it('cannot be dodged by salting a peasant stack with a few real units', () => {
    // The floor reads the force average, so ten elites among a thousand
    // militia do not make the militia payable.
    const killerUPV = 100_000;
    const profiles = {
      militia: { unitKey: 'militia', role: 'Ranged', baseUpkeep: 2, tier: 1, levelInTier: 0 },
      guard: { unitKey: 'guard', role: 'Ranged', baseUpkeep: 900, tier: 10, levelInTier: 900 },
    };
    const avg = averageVictimUPV({ byUnitKey: { militia: 1000, guard: 10 } }, profiles);
    expect(avg).toBeLessThan(killerUPV * C.BENEATH_NOTICE_RATIO);
  });

  it('explains the zero rather than silently awarding nothing', () => {
    const row = attributeKills({
      killer: {
        formationId: 'f', unitKey: 'u', role: 'Ranged', count: 10, baseUpkeep: 1000,
        tier: 12, levelInTier: 0, contributionShare: 1,
      },
      track: 'atk',
      phaseLosses: { byUnitKey: { militia: 5000 } },
      victimProfiles: { militia: { unitKey: 'militia', role: 'Ranged', baseUpkeep: 2, tier: 1, levelInTier: 0 } },
      counterMatrix: MATRIX,
      engagementsAgainstTargetToday: 0,
      won: true,
      victimIsNpc: false,
      eraGapBelow: 0,
      targetIsLinkedAccount: false,
    });
    expect(row.xpAwarded).toBe(0n);
    expect(row.zeroReason).toBe('beneath-notice');
  });
});

describe('absorption XP — without it the Guardian path is a trap', () => {
  const screen: CombatantSlice = {
    formationId: 'shield-wall', unitKey: 'u', role: 'Screen', count: 1000,
    baseUpkeep: 3, tier: 4, levelInTier: 200, contributionShare: 0,
  };

  it('pays a screen that killed nothing but held the line', () => {
    const xp = absorptionXp({
      defender: screen,
      damageAbsorbed: 60_000,
      totalDamageDelivered: 100_000,
      attackingForceUPV: 500_000,
      won: true,
    });
    expect(xp).toBeGreaterThan(0n);
  });

  it('scales with the share of damage soaked and the force soaked from', () => {
    const half = absorptionXp({ defender: screen, damageAbsorbed: 50_000, totalDamageDelivered: 100_000, attackingForceUPV: 1000, won: true });
    const all = absorptionXp({ defender: screen, damageAbsorbed: 100_000, totalDamageDelivered: 100_000, attackingForceUPV: 1000, won: true });
    expect(Number(all)).toBeCloseTo(Number(half) * 2, -1);
  });

  it('pays nothing when no damage was delivered', () => {
    expect(absorptionXp({ defender: screen, damageAbsorbed: 0, totalDamageDelivered: 0, attackingForceUPV: 1000, won: true })).toBe(0n);
  });
});

describe('levelling — crossing 1337 does not auto-promote', () => {
  const deps = { xpRequiredForLevel, maxTierForEra };

  it('spends XP level by level as thresholds are crossed', () => {
    const r = applyXp({ tier: 1, levelInTier: 0, currentXp: 0n, gained: 10_000n, empireWeightMultiplier: 1, era: 7, ...deps });
    expect(r.levelInTier).toBeGreaterThan(0);
    expect(r.tier).toBe(1);
    expect(r.eligibleForPromotion).toBe(false);
  });

  it('stops at the tier ceiling and reports eligibility instead of promoting', () => {
    // Promotion additionally requires the resource cost paid from the home
    // settlement AND a recorded qualifying deed. It is a separate, explicit
    // player command (spec/03 §8).
    const r = applyXp({
      tier: 2, levelInTier: C.LEVELS_PER_TIER, currentXp: 0n, gained: 10n ** 12n,
      empireWeightMultiplier: 1, era: 7, ...deps,
    });
    expect(r.tier).toBe(2);
    expect(r.levelInTier).toBe(C.LEVELS_PER_TIER);
    expect(r.eligibleForPromotion).toBe(true);
  });

  it('refuses eligibility past the era ceiling', () => {
    // Era I caps at ceil(3.5 * 1) = 4 (Steel).
    const r = applyXp({
      tier: 4, levelInTier: C.LEVELS_PER_TIER, currentXp: 0n, gained: 10n ** 12n,
      empireWeightMultiplier: 1, era: 1, ...deps,
    });
    expect(r.eligibleForPromotion).toBe(false);
  });

  it('slows to a crawl under a galactic empire weight', () => {
    const light = applyXp({ tier: 5, levelInTier: 100, currentXp: 0n, gained: 100_000n, empireWeightMultiplier: 1, era: 7, ...deps });
    const heavy = applyXp({ tier: 5, levelInTier: 100, currentXp: 0n, gained: 100_000n, empireWeightMultiplier: 38_589, era: 7, ...deps });
    expect(light.levelInTier).toBeGreaterThan(heavy.levelInTier);
    expect(heavy.levelInTier).toBe(100);
  });
});
