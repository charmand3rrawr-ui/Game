/**
 * sim/cultivation.ts — the player's own advancement
 *
 * The avatar cultivates through the SAME 42 grades that structure buildings and
 * research, named as 14 realms × 3 stages (spec/04 §10). That shared ladder is
 * why a player can say "my Powder Doctrine broke through to Golden Core" and
 * communicate three facts at once.
 *
 * TWO THINGS MAKE THIS DIFFERENT FROM EVERY OTHER PROGRESSION
 *
 *   1. It cannot be bought. Chrono Shards are prohibited from cultivation
 *      breakthroughs outright (spec/04 §11), and Temporal Debt — the karma
 *      accrued by spending them — makes tribulations HARDER. The cultivation
 *      game is where buying time is actually paid for.
 *
 *   2. A breakthrough is not a purchase, it is an EVENT. Qi is spent, a
 *      tribulation opens, and several of them are publicly visible and can be
 *      crashed by rivals. spec/08 M9's acceptance test is exactly that.
 *
 * Realms primarily GATE CONTENT rather than grant power: Cultivation!Balance
 * caps is explicit that cultivation bonuses fold into the joint +40% cap with
 * everything else, and the per-grade aura here is deliberately small.
 */

import {
  C,
  GRADES,
  qiBreakthroughCost,
  type Millis,
  type ProblemType,
  type RefGrade,
  type Rng,
} from '@ascendance/shared';
import type { Validation } from './settlement.js';
import { buildingRef, type SettlementView } from './settlement.js';

const BY_GRADE = new Map<number, RefGrade>(GRADES.map((g) => [g.grade, g]));

export function gradeRef(grade: number): RefGrade {
  const g = BY_GRADE.get(grade);
  if (!g) throw new Error(`no such cultivation grade ${grade}`);
  return g;
}

/** "Golden Core · Perfected" — what a player actually calls their realm. */
export function realmName(grade: number): string {
  return BY_GRADE.get(grade)?.realmStage ?? `Grade ${grade}`;
}

// ============================================================================
// Qi
// ============================================================================

export interface QiSources {
  buildings: number;
  spiritVeins: number;
  meditation: number;
  perHour: number;
}

/**
 * Qi income, summed across every holding.
 *
 * Cultivation is player-level progression, so its income is too — this is the
 * same exception to isolation that research enjoys (invariant §2.4). Spirit
 * Vein tiles pay far more than buildings, which is what makes those tiles worth
 * fighting over rather than merely nice.
 */
export function qiPerHour(views: readonly SettlementView[]): QiSources {
  let buildings = 0;
  let spiritVeins = 0;
  for (const view of views) {
    for (const b of view.buildings) {
      if (buildingRef(b.buildingKey).category !== 'Cultivation') continue;
      // Level-scaled, but linearly: a Qi well is a well, not a compounding
      // engine. The realm ladder is meant to be paced by time, not by stacking.
      buildings += C.QI_PER_CULTIVATION_BUILDING * (1 + b.level / C.LEVELS_PER_GRADE);
    }
    spiritVeins += view.settlement.terrain.spiritVeins * C.QI_PER_SPIRIT_VEIN;
  }
  // Idle meditation, so a player with no cultivation buildings still advances.
  // Slowly — but the ladder is never completely shut to them.
  const meditation = C.QI_IDLE_PER_HOUR;
  return { buildings, spiritVeins, meditation, perHour: buildings + spiritVeins + meditation };
}

/**
 * Qi accrued since it was last banked.
 *
 * Lazy, exactly like resource production: nothing ticks, and a player who has
 * not logged in for a month costs nothing while they are away (spec/03 §3).
 *
 * Temporal Debt SUPPRESSES this. Spending Chrono Shards buys build time and
 * costs cultivation time, which is the trade the monetization model is built
 * on (spec/04 §11 guardrail 3).
 */
export function accrueQi(
  current: bigint,
  perHour: number,
  temporalDebt: number,
  lastAccruedAt: Millis,
  now: Millis,
): bigint {
  const elapsedMs = Number(now - lastAccruedAt);
  if (elapsedMs <= 0) return current;
  const suppression = Math.max(0, 1 - temporalDebt * C.TRIBULATION_PER_DEBT_TIER);
  const gained = (perHour * suppression * elapsedMs) / 3_600_000;
  return current + BigInt(Math.floor(Math.max(0, gained)));
}

// ============================================================================
// Breakthrough
// ============================================================================

export interface BreakthroughContext {
  grade: number;
  qi: bigint;
  temporalDebt: number;
  reputation: number;
  /** Set while a failed trial's stun is still in force. */
  stunnedUntil?: Millis;
  now: Millis;
  /** A tribulation already open for this player. */
  tribulationOpen: boolean;
}

function reject(type: ProblemType, detail: string, meta?: Record<string, unknown>): Validation {
  return { ok: false, type, detail, meta };
}

export function validateBreakthrough(ctx: BreakthroughContext): Validation {
  const next = ctx.grade + 1;
  if (next > C.MAX_GRADE) {
    return reject('validation', `${realmName(ctx.grade)} is the final realm`);
  }
  if (ctx.tribulationOpen) {
    return reject('validation', 'a tribulation is already under way');
  }
  if (ctx.stunnedUntil !== undefined && ctx.stunnedUntil > ctx.now) {
    return reject('validation', 'cultivation is suspended after a failed trial', {
      until: ctx.stunnedUntil.toString(),
    });
  }
  const cost = qiBreakthroughCost(next);
  if (ctx.qi < cost) {
    return reject('insufficient-resources', `breaking into ${realmName(next)} needs ${cost} Qi; you hold ${ctx.qi}`, {
      short: { qi: (cost - ctx.qi).toString() }, required: cost.toString(),
    });
  }
  return { ok: true };
}

export interface TribulationOdds {
  base: number;
  karma: number;
  debt: number;
  interference: number;
  /** The final clamped chance, and every term that produced it. */
  chance: number;
  trial: RefGrade['trial'];
}

/**
 * The odds of passing, with every term shown.
 *
 * Same principle as a battle report (invariant §2.7): if a number decides
 * something that matters, the player gets to see how it was assembled. A
 * breakthrough that fails for reasons nobody can inspect is the kind of thing
 * that makes players believe the game cheats.
 */
export function tribulationOdds(args: {
  grade: number;
  temporalDebt: number;
  reputation: number;
  interferers: number;
}): TribulationOdds {
  const trial = gradeRef(args.grade).trial;

  // A karma-weighted trial reads reputation in both directions: a benefactor
  // finds it easier, an oathbreaker finds it brutal.
  const karma = trial.karmaWeighted ? args.reputation * C.TRIBULATION_PER_REPUTATION : 0;
  const debt = -args.temporalDebt * C.TRIBULATION_PER_DEBT_TIER;
  // Only a crashable trial can be interfered with at all.
  const interference = trial.crashable ? -args.interferers * C.TRIBULATION_CRASH_PENALTY : 0;

  const raw = C.TRIBULATION_BASE_SUCCESS + karma + debt + interference;
  return {
    base: C.TRIBULATION_BASE_SUCCESS,
    karma,
    debt,
    interference,
    // Never certain and never hopeless: a rival can always make it worse, and
    // can never make it impossible.
    chance: Math.max(0.05, Math.min(0.99, raw)),
    trial,
  };
}

export interface TribulationResult {
  passed: boolean;
  roll: number;
  odds: TribulationOdds;
  newGrade: number;
  qiRefunded: bigint;
  stunnedUntil?: Millis;
  narrative: string;
}

/**
 * Resolve a tribulation.
 *
 * PURE, and given its randomness from a seeded generator keyed on the event
 * (spec/03 §2) — a tribulation replays identically, like everything else.
 */
export function resolveTribulation(args: {
  grade: number;
  qiSpent: bigint;
  temporalDebt: number;
  reputation: number;
  interferers: number;
  now: Millis;
  rng: Rng;
}): TribulationResult {
  const odds = tribulationOdds(args);
  const roll = args.rng();
  const passed = roll < odds.chance;
  const next = args.grade + 1;

  if (passed) {
    return {
      passed: true,
      roll,
      odds,
      newGrade: next,
      qiRefunded: 0n,
      narrative:
        odds.trial.none
          ? `${realmName(next)} reached through mortal effort alone.`
          : `${odds.trial.name} endured. ${realmName(next)} reached.`,
    };
  }

  // Failure costs most of the Qi and, where the sheet says so, suspends
  // cultivation entirely for a time.
  const refunded = (args.qiSpent * BigInt(Math.round(C.TRIBULATION_FAILURE_QI_KEPT * 100))) / 100n;
  const stun = odds.trial.stunMs > 0 ? args.now + BigInt(odds.trial.stunMs) : undefined;
  return {
    passed: false,
    roll,
    odds,
    newGrade: args.grade,
    qiRefunded: refunded,
    stunnedUntil: stun,
    narrative:
      `${odds.trial.name} overcame you.` +
      (args.interferers > 0 ? ` ${args.interferers} rival${args.interferers === 1 ? '' : 's'} saw to it.` : '') +
      (stun ? ' Cultivation is suspended while you recover.' : ''),
  };
}

// ============================================================================
// Effects
// ============================================================================

/**
 * The combat aura a realm grants.
 *
 * Folded into the joint +40% cap with proficiency, equipment, commanders and
 * veterancy. Deliberately small per grade: Cultivation!Balance caps is explicit
 * that realms primarily gate content, and a cultivation track that out-scaled
 * the army would make the strategy game a side quest.
 */
export function cultivationAura(grade: number): number {
  return 1 + grade * C.CULTIVATION_AURA_PER_GRADE;
}

/**
 * Whether a realm unlocks a unit grade.
 *
 * `Unit_Grades` gates Ascendant on "cultivation realm Sovereign". Realm names
 * come from the workbook, so this matches on the realm rather than on a grade
 * number that would drift if the ladder were ever re-cut.
 */
export function realmAtLeast(grade: number, realm: string): boolean {
  const index = GRADES.findIndex((g) => g.realmStage.toLowerCase().startsWith(realm.toLowerCase()));
  return index >= 0 && grade >= GRADES[index]!.grade;
}

/** Every grade with its trial, for the Codex and the cultivation screen. */
export function realmLadder(): RefGrade[] {
  return [...GRADES];
}
