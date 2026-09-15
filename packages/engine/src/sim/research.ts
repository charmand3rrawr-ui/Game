/**
 * sim/research.ts — the one global progression
 *
 * Research is PLAYER-LEVEL AND GLOBAL — the single exception to production
 * isolation (invariant §2.4, spec/04 §3). Without it a wide empire would be
 * unplayable: nobody is going to research the same discipline in four hundred
 * settlements.
 *
 * But it is still PAID locally. A research item is queued at a settlement, from
 * that settlement's stockpile, in that settlement's queue slot. The level it
 * produces is global; the cost is not. That split is what keeps isolation
 * intact while making a wide empire playable.
 *
 * Grade boundaries carry the weight (spec/04 §3): fork choices, unit-grade
 * gates, edicts. Levels make you incrementally better; grades change what you
 * are, and they are what the prerequisites below are written in terms of.
 */

import {
  C,
  RESEARCH,
  buildingCost,
  buildTimeMs,
  gradeForLevel,
  type Millis,
  type ProblemType,
  type RefResearch,
} from '@ascendance/shared';
import type { Validation } from './settlement.js';

const BY_KEY = new Map<string, RefResearch>(RESEARCH.map((r) => [r.key, r]));

export function researchRef(key: string): RefResearch {
  const r = BY_KEY.get(key);
  if (!r) throw new Error(`unknown research discipline ${key}`);
  return r;
}

export function disciplinesForEra(era: number): RefResearch[] {
  return RESEARCH.filter((r) => r.era <= era);
}

/** `disciplineKey -> level`, the player's whole research state. */
export type ResearchLevels = Readonly<Record<string, number>>;

export function levelOf(levels: ResearchLevels, key: string): number {
  return levels[key] ?? 0;
}

export function gradeOf(levels: ResearchLevels, key: string): number {
  return gradeForLevel(levelOf(levels, key));
}

/**
 * The highest grade reached in any MILITARY discipline.
 *
 * This is what gates unit grades: `Unit_Grades` says Elite needs "Grade >= 12 +
 * Warfare rank 5", and the grade it means is a research grade. Reading the
 * best military discipline rather than a specific one means a player who went
 * deep on their own era's warfare tree is not punished for skipping an older
 * one.
 */
export function bestMilitaryGrade(levels: ResearchLevels): number {
  let best = 0;
  for (const r of RESEARCH) {
    if (r.branch !== 'Military') continue;
    best = Math.max(best, gradeOf(levels, r.key));
  }
  return best;
}

export function bestGradeInAnyDiscipline(levels: ResearchLevels): number {
  let best = 0;
  for (const r of RESEARCH) best = Math.max(best, gradeOf(levels, r.key));
  return best;
}

// ============================================================================
// Cost
// ============================================================================

export interface ResearchCost {
  resources: Record<string, bigint>;
  totalTimeMs: Millis;
}

/**
 * Cost and time to raise a discipline by one level.
 *
 * Deliberately the SAME curve as buildings — `(L+1)^2.4 * 1.004^L` for cost and
 * `K * (L+1)^1.9 * 1.003^L` for time — so the two progressions stay
 * comparable and a player can reason about "a level of research" against "a
 * level of building" without a second mental model. It also means the
 * 500-year calibration anchor covers research as well, which is what spec/07
 * §3.1 assumes when it says "a full 0→1337 building OR RESEARCH climb".
 */
export function researchCost(
  key: string,
  fromLevel: number,
  knowledgeFactor: number,
  timeMultiplier: number,
): ResearchCost {
  const ref = researchRef(key);
  // Branch decides which resource class the work draws on: an Economy
  // discipline is paperwork and surveys, a Military one is drills and steel.
  const base = BigInt(C.RESEARCH_COST_PER_LEVEL);
  return {
    resources:
      ref.branch === 'Military'
        ? { stone: buildingCost(base, fromLevel), special: buildingCost(base, fromLevel) }
        : { timber: buildingCost(base, fromLevel), special: buildingCost(base, fromLevel) },
    totalTimeMs: buildTimeMs(fromLevel, knowledgeFactor, 1, timeMultiplier),
  };
}

/** Knowledge buildings compress research time, as an HQ compresses building. */
export function knowledgeFactorFor(bestKnowledgeLevel: number): number {
  return 1 + Math.min(C.HQ_FACTOR_CAP, gradeForLevel(bestKnowledgeLevel) * C.HQ_FACTOR_PER_GRADE);
}

// ============================================================================
// Prerequisites
// ============================================================================

export interface ResearchContext {
  levels: ResearchLevels;
  playerEra: number;
  cultivationGrade: number;
  /** Whether the settlement hosting the work has a Knowledge building at all. */
  hasKnowledgeBuilding: boolean;
}

function reject(type: ProblemType, detail: string, meta?: Record<string, unknown>): Validation {
  return { ok: false, type, detail, meta };
}

/**
 * Whether a discipline may be raised one level.
 *
 * spec/04 §3 states three prerequisites, and all three are enforced here:
 *
 *   1. An era's disciplines require ALL previous-era disciplines at grade 12+.
 *   2. Grade G requires all SAME-ERA disciplines at G−1.
 *   3. Grade G requires cultivation realm ≥ G−1.
 *
 * Rules 2 and 3 only bite when the next level CROSSES a grade boundary, which
 * is the whole point of grades: they are the checkpoints, and levels between
 * them are free-running.
 */
export function validateResearchEnqueue(key: string, ctx: ResearchContext): Validation {
  const ref = BY_KEY.get(key);
  if (!ref) return reject('not-found', `no such discipline: ${key}`);

  if (!ctx.hasKnowledgeBuilding) {
    return reject('validation', 'research needs a Knowledge building in this settlement');
  }

  if (ref.era > ctx.playerEra) {
    return reject('era-gate', `${ref.name} belongs to era ${ref.era}; you are in era ${ctx.playerEra}`, {
      requiredEra: ref.era, era: ctx.playerEra,
    });
  }

  const current = levelOf(ctx.levels, key);
  if (current >= C.MAX_LEVEL) {
    return reject('validation', `${ref.name} is already at the level cap of ${C.MAX_LEVEL}`);
  }

  // 1. Previous-era disciplines, all of them, at grade 12+.
  if (ref.era > 1) {
    const behind = RESEARCH.filter(
      (r) => r.era === ref.era - 1 && gradeOf(ctx.levels, r.key) < C.RESEARCH_ERA_PREREQ_GRADE,
    );
    if (behind.length > 0) {
      return reject(
        'grade-prerequisite',
        `${ref.name} requires every era ${ref.era - 1} discipline at grade ${C.RESEARCH_ERA_PREREQ_GRADE}: ` +
          `${behind.map((r) => `${r.name} is at ${gradeOf(ctx.levels, r.key)}`).join(', ')}`,
        { requiredGrade: C.RESEARCH_ERA_PREREQ_GRADE, behind: behind.map((r) => r.key) },
      );
    }
  }

  const nextGrade = gradeForLevel(current + 1);
  const crossesBoundary = nextGrade > gradeForLevel(current);
  if (!crossesBoundary) return { ok: true };

  // 2. Same-era disciplines at G-1.
  const lagging = RESEARCH.filter(
    (r) => r.era === ref.era && r.key !== key && gradeOf(ctx.levels, r.key) < nextGrade - 1,
  );
  if (lagging.length > 0) {
    return reject(
      'grade-prerequisite',
      `breaking into grade ${nextGrade} requires every era ${ref.era} discipline at grade ${nextGrade - 1}: ` +
        `${lagging.map((r) => `${r.name} is at ${gradeOf(ctx.levels, r.key)}`).join(', ')}`,
      { nextGrade, lagging: lagging.map((r) => r.key) },
    );
  }

  // 3. Cultivation realm at G-1. Technology and the player's own cultivation
  //    advance together by design — neither runs away from the other.
  if (ctx.cultivationGrade < nextGrade - 1) {
    return reject(
      'grade-prerequisite',
      `breaking into grade ${nextGrade} requires cultivation grade ${nextGrade - 1}; you are at ${ctx.cultivationGrade}`,
      { nextGrade, cultivationGrade: ctx.cultivationGrade },
    );
  }

  return { ok: true };
}

// ============================================================================
// Effects
// ============================================================================

export interface ResearchEffects {
  /** Multiplier on economic output, from Economy disciplines. */
  output: number;
  /** Multiplier on unit effectiveness, from Military disciplines. */
  unitEffectiveness: number;
  /** Multiplier on governance metrics, from Statecraft disciplines. */
  governance: number;
}

/**
 * Aggregate every discipline's per-level effect.
 *
 * The percentages come from the workbook (`+0.3% output / level`,
 * `+0.25% era unit effectiveness / level`), parsed at import time rather than
 * retyped here.
 *
 * Only disciplines of the player's CURRENT era or earlier contribute, because
 * the effect is written "in era systems" — the point of Heritage is that old
 * work keeps paying, not that future work pays early.
 */
export function researchEffects(levels: ResearchLevels, era: number): ResearchEffects {
  const out: ResearchEffects = { output: 1, unitEffectiveness: 1, governance: 1 };
  for (const r of RESEARCH) {
    if (r.era > era) continue;
    const gain = levelOf(levels, r.key) * r.perLevelPct;
    if (gain <= 0) continue;
    if (r.branch === 'Economy') out.output += gain;
    else if (r.branch === 'Military') out.unitEffectiveness += gain;
    else out.governance += gain;
  }
  return out;
}

/**
 * The tech multiplier a battle sees.
 *
 * Folded into the joint +40% cap along with equipment, commanders, cultivation
 * and veterancy — research does not get to sit outside it just because it took
 * a long time (spec/07 §3.4).
 */
export function techTier(levels: ResearchLevels, era: number): number {
  return researchEffects(levels, era).unitEffectiveness;
}
