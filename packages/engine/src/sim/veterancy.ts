/**
 * sim/veterancy.ts — turning a resolved battle into experience
 *
 * Runs AFTER resolution and off the critical path (spec/03 §7): the player
 * watching a battle should not wait on attribution arithmetic. The resolver
 * already computed the contribution pools it needs, so this costs arithmetic
 * rather than simulation.
 *
 * TWO COMPONENTS, because screens get no kills:
 *   - Kill XP, credited by contribution share, valued by what was killed.
 *   - Absorption XP on the defence track. Without it, Guardian-path and screen
 *     archetypes could never advance and the whole identity path would be a
 *     trap that punished the players who chose it (Bible §5.5).
 */

import {
  C,
  absorptionXp,
  attributeKills,
  applyXp,
  counterMatrixByName,
  cumulativeLevels,
  diluteVeterancy,
  empireWeightMultiplier,
  maxTierForEra,
  tierUpCost,
  unitDef,
  unitPowerValue,
  xpRequiredForLevel,
  type AttributionSummary,
  type Formation,
  type VeterancyTrack,
  type VictimProfile,
  type CombatantSlice,
} from '@ascendance/shared';
import type { BattleResult, SideInput } from './combat.js';

export interface AttributionContext {
  /** Engagements this attacker has already had against this defender today. */
  engagementsToday: Map<string, number>;
  attackerEmpireWeight: number;
  defenderEmpireWeight: number;
  attackerEra: number;
  defenderEra: number;
  defenderIsNpc: boolean;
  attackerIsNpc: boolean;
  /** Same detection that feeds transfer caps and Heaven's Envy scopes. */
  linkedAccounts: boolean;
}

export interface XpAward {
  formationId: string;
  track: VeterancyTrack;
  xp: bigint;
  summary: AttributionSummary;
}

/**
 * Attribute experience for both sides of a resolved battle.
 *
 * The LOSING side still earns about 60% on the same attribution. Fighting a
 * losing war must never be progression death, or players in that position
 * simply quit.
 */
export function attributeBattle(
  input: { attacker: SideInput; defender: SideInput },
  result: BattleResult,
  formations: Map<string, Formation>,
  ctx: AttributionContext,
): XpAward[] {
  const matrix = counterMatrixByName();
  const awards: XpAward[] = [];

  const attackerWon = result.report.outcome === 'attacker';
  const attackerVictims = victimProfiles(input.defender);
  const defenderVictims = victimProfiles(input.attacker);

  // --- attack track: the attacking force's kills ---------------------------
  for (const u of input.attacker.units) {
    const f = formations.get(u.formationId);
    if (!f) continue;
    let totalXp = 0n;
    let merged: AttributionSummary | null = null;

    for (const [i, phaseLosses] of result.defenderLossesByPhase.entries()) {
      if (Object.keys(phaseLosses).length === 0) continue;
      const share = result.attackerSharesByPhase[i]?.[u.formationId] ?? 0;
      if (share <= 0) continue;
      const row = attributeKills({
        killer: sliceOf(u, share),
        track: 'atk',
        phaseLosses: { byUnitKey: phaseLosses },
        victimProfiles: attackerVictims,
        counterMatrix: matrix,
        engagementsAgainstTargetToday: ctx.engagementsToday.get(u.formationId) ?? 0,
        won: attackerWon,
        victimIsNpc: ctx.defenderIsNpc,
        eraGapBelow: Math.max(0, ctx.attackerEra - ctx.defenderEra),
        targetIsLinkedAccount: ctx.linkedAccounts,
      });
      totalXp += row.xpAwarded;
      merged = mergeSummary(merged, row, f, 'atk', ctx.attackerEmpireWeight, 0n);
    }

    if (merged) awards.push({ formationId: u.formationId, track: 'atk', xp: totalXp, summary: { ...merged, xpAwarded: totalXp.toString() } });
  }

  // --- defence track: kills PLUS absorption --------------------------------
  const attackingForceUPV = forceUPV(input.attacker);
  for (const u of input.defender.units) {
    const f = formations.get(u.formationId);
    if (!f) continue;
    const slice = sliceOf(u, 0);
    let totalXp = 0n;
    let merged: AttributionSummary | null = null;

    for (const [i, phaseLosses] of result.attackerLossesByPhase.entries()) {
      if (Object.keys(phaseLosses).length === 0) continue;
      const share = result.defenderSharesByPhase[i]?.[u.formationId] ?? 0;
      if (share <= 0) continue;
      const row = attributeKills({
        killer: sliceOf(u, share),
        track: 'def',
        phaseLosses: { byUnitKey: phaseLosses },
        victimProfiles: defenderVictims,
        counterMatrix: matrix,
        engagementsAgainstTargetToday: 0,
        won: !attackerWon,
        victimIsNpc: ctx.attackerIsNpc,
        eraGapBelow: Math.max(0, ctx.defenderEra - ctx.attackerEra),
        targetIsLinkedAccount: ctx.linkedAccounts,
      });
      totalXp += row.xpAwarded;
      merged = mergeSummary(merged, row, f, 'def', ctx.defenderEmpireWeight, 0n);
    }

    // Soaking a Dreadnought bombardment teaches a screen a great deal, and the
    // system should say so.
    const absorbed = result.damageAbsorbed[u.formationId] ?? 0;
    const absorption = absorptionXp({
      defender: slice,
      damageAbsorbed: absorbed,
      totalDamageDelivered: result.damageDelivered.attacker,
      attackingForceUPV,
      won: !attackerWon,
    });
    totalXp += absorption;

    if (!merged && absorption > 0n) {
      merged = blankSummary(f, 'def', ctx.defenderEmpireWeight, slice);
    }
    if (merged) {
      awards.push({
        formationId: u.formationId,
        track: 'def',
        xp: totalXp,
        summary: { ...merged, absorptionXp: absorption.toString(), xpAwarded: totalXp.toString() },
      });
    }
  }

  return awards;
}

function sliceOf(
  u: { formationId: string; unitKey: string; count: number; tier: number; levelInTier: number },
  contributionShare: number,
): CombatantSlice {
  const def = unitDef(u.unitKey);
  return {
    formationId: u.formationId,
    unitKey: u.unitKey,
    role: def.role,
    count: u.count,
    baseUpkeep: def.upkeep,
    tier: u.tier,
    levelInTier: u.levelInTier,
    // Taken from the resolver's own pools, per phase. This is what makes
    // attribution proportional to what a formation actually did rather than to
    // who happened to be present.
    contributionShare,
  };
}

function victimProfiles(side: SideInput): Record<string, VictimProfile> {
  const out: Record<string, VictimProfile> = {};
  for (const u of side.units) {
    const def = unitDef(u.unitKey);
    out[u.unitKey] = {
      unitKey: u.unitKey,
      role: def.role,
      baseUpkeep: def.upkeep,
      tier: u.tier,
      levelInTier: u.levelInTier,
    };
  }
  return out;
}

function forceUPV(side: SideInput): number {
  let total = 0;
  for (const u of side.units) {
    const def = unitDef(u.unitKey);
    total += u.count * unitPowerValue(def.upkeep, cumulativeLevels(u.tier, u.levelInTier));
  }
  return total;
}

function mergeSummary(
  prev: AttributionSummary | null,
  row: ReturnType<typeof attributeKills>,
  f: Formation,
  track: VeterancyTrack,
  empireWeight: number,
  absorption: bigint,
): AttributionSummary {
  const kills = { ...(prev?.killsCredited ?? {}) };
  for (const [k, v] of Object.entries(row.killsCredited)) kills[k] = (kills[k] ?? 0) + v;
  return {
    formationId: f.id,
    formationName: f.name,
    track,
    killsCredited: kills,
    rawValue: (prev?.rawValue ?? 0) + row.rawValue,
    roleFactorAvg: row.roleFactorAvg,
    relativeFactorAvg: row.relativeFactorAvg,
    fatigue: row.fatigue,
    repetition: row.repetition,
    absorptionXp: absorption.toString(),
    xpAwarded: row.xpAwarded.toString(),
    zeroReason: row.zeroReason,
    requirement: requirementBreakdown(track === 'atk' ? f.atkTier : f.defTier, track === 'atk' ? f.atkLevel : f.defLevel, empireWeight),
  };
}

function blankSummary(f: Formation, track: VeterancyTrack, empireWeight: number, slice: CombatantSlice): AttributionSummary {
  return {
    formationId: f.id,
    formationName: f.name,
    track,
    killsCredited: {},
    rawValue: 0,
    roleFactorAvg: 0,
    relativeFactorAvg: 0,
    fatigue: 1 / (Math.pow(slice.levelInTier + 1, C.FATIGUE_LEVEL_EXP) * Math.pow(C.FATIGUE_TIER_DIV, slice.tier - 1)),
    repetition: 1,
    absorptionXp: '0',
    xpAwarded: '0',
    requirement: requirementBreakdown(track === 'atk' ? f.atkTier : f.defTier, track === 'atk' ? f.atkLevel : f.defLevel, empireWeight),
  };
}

/**
 * The requirement stack, broken into its four factors.
 *
 * Shown to the player alongside the award, because "you earned 211 and need
 * 7,297" is only meaningful if they can also see WHY it is 7,297 — and in
 * particular how much of it is their own empire's weight.
 */
export function requirementBreakdown(tier: number, level: number, empireWeight: number): {
  base: number; levelFactor: number; tierFactor: number; empireWeightMultiplier: number; total: string;
} {
  const ewm = empireWeightMultiplier(empireWeight);
  return {
    base: C.XP_BASE,
    levelFactor: Math.pow(level + 1, C.XP_LEVEL_EXP),
    tierFactor: Math.pow(C.XP_TIER_MULT, tier - 1),
    empireWeightMultiplier: ewm,
    total: xpRequiredForLevel(tier, level, ewm).toString(),
  };
}

/**
 * Apply an award to a formation, levelling as thresholds are crossed.
 *
 * Crossing level 1337 does NOT auto-promote. Promotion additionally requires
 * the resource cost paid from the formation's home settlement AND a recorded
 * qualifying deed — it is a separate, explicit player command (spec/03 §8).
 */
export function applyAward(f: Formation, track: VeterancyTrack, gained: bigint, empireWeight: number, era: number): Formation {
  const ewm = empireWeightMultiplier(empireWeight);
  const r = applyXp({
    tier: track === 'atk' ? f.atkTier : f.defTier,
    levelInTier: track === 'atk' ? f.atkLevel : f.defLevel,
    currentXp: track === 'atk' ? f.atkXp : f.defXp,
    gained,
    empireWeightMultiplier: ewm,
    era,
    xpRequiredForLevel,
    maxTierForEra,
  });
  return track === 'atk'
    ? { ...f, atkTier: r.tier, atkLevel: r.levelInTier, atkXp: r.xp }
    : { ...f, defTier: r.tier, defLevel: r.levelInTier, defXp: r.xp };
}

export interface PromotionCheck {
  eligible: boolean;
  reason?: string;
  cost: bigint;
}

/**
 * Whether a formation may promote into its next tier.
 *
 * All three conditions, per spec/03 §8. The resource cost is deliberately NOT
 * multiplied by empire weight — that asymmetry is what produces the Champion
 * economy, where large empires bankroll small allies' promotions. Do not "fix"
 * it (spec/04 §5).
 */
export function checkPromotion(f: Formation, track: VeterancyTrack, era: number, homeStockpile: bigint): PromotionCheck {
  const tier = track === 'atk' ? f.atkTier : f.defTier;
  const level = track === 'atk' ? f.atkLevel : f.defLevel;
  const cost = tierUpCost(tier + 1);

  if (level < C.LEVELS_PER_TIER) {
    return { eligible: false, reason: `level ${level} of ${C.LEVELS_PER_TIER}`, cost };
  }
  if (tier >= maxTierForEra(era)) {
    return { eligible: false, reason: `era ${era} caps veterancy at tier ${maxTierForEra(era)}`, cost };
  }
  if (f.deeds.length === 0) {
    return { eligible: false, reason: 'no qualifying deed on record', cost };
  }
  if (homeStockpile < cost) {
    return { eligible: false, reason: `home settlement holds ${homeStockpile} of ${cost}`, cost };
  }
  return { eligible: true, cost };
}

/**
 * Reinforce a formation, diluting its veterancy by headcount.
 *
 * GREEN DILUTION APPLIES ON REINFORCEMENT, NOT ON LOSS (spec/03 §6). Survivors
 * of a massacre carry their veterancy forward intact; it is the fresh recruits
 * who dilute it. And the resources spent on prior promotions are simply gone —
 * which is what makes reinforcing an elite formation a real decision rather
 * than an obvious one.
 */
export function reinforce(f: Formation, addedCount: number, freshCumulativeLevels = 0): Formation {
  if (addedCount <= 0) return f;
  const atk = diluteVeterancy(cumulativeLevels(f.atkTier, f.atkLevel), f.count, freshCumulativeLevels, addedCount);
  const def = diluteVeterancy(cumulativeLevels(f.defTier, f.defLevel), f.count, freshCumulativeLevels, addedCount);
  return {
    ...f,
    count: f.count + addedCount,
    ...splitCumulative(atk, 'atk'),
    ...splitCumulative(def, 'def'),
    // Diluted XP progress toward the next level is lost with the rest.
    atkXp: 0n,
    defXp: 0n,
  };
}

function splitCumulative(cumulative: number, track: VeterancyTrack): Partial<Formation> {
  const total = Math.max(0, Math.floor(cumulative));
  const tier = Math.min(C.MAX_VET_TIER, Math.floor(total / C.LEVELS_PER_TIER) + 1);
  const level = total % C.LEVELS_PER_TIER;
  return track === 'atk' ? { atkTier: tier, atkLevel: level } : { defTier: tier, defLevel: level };
}
