/**
 * sim/military.ts — training units
 *
 * spec/04 §4: "Units spawn in their production settlement and must physically
 * travel." There is no empire-wide muster and no instant reinforcement. An army
 * exists where it was built, and getting it somewhere else is a movement that
 * can be seen and intercepted.
 *
 * WHAT GATES A UNIT (all enforced here, at enqueue):
 *   - the holding type: an Outpost trains nothing at all;
 *   - a military building of the right kind, present in this settlement;
 *   - the era: you cannot train what you have not reached;
 *   - the unit's GRADE, against research and Warfare proficiency — the gates
 *     parsed from `Unit_Grades`, not retyped here;
 *   - a free training slot, which military buildings grant separately from the
 *     HQ's build slots.
 */

import {
  C,
  HOLDINGS,
  ROSTER,
  UNIT_GRADES,
  tryUnitDef,
  countWhere,
  trainTimeMs,
  gradeForLevel,
  type Building,
  type Millis,
  type ProblemType,
  type QueueItem,
  type RefUnitGrade,
  type UnitDef,
} from '@ascendance/shared';
import { buildingRef, type SettlementView, type Validation } from './settlement.js';
import { bestMilitaryGrade, type ResearchLevels } from './research.js';

const GRADE_BY_NAME = new Map<string, RefUnitGrade>(UNIT_GRADES.map((g) => [g.grade, g]));

/**
 * Which military building unlocks which role.
 *
 * [ASSUMED — spec/00 §5] `Category_Chassis` says Military buildings "gate unit
 * archetypes" but the workbook carries no building→archetype mapping; spec §10
 * lists per-building detail as an open content task. These pairings follow the
 * Era I building names, and a role with no entry falls back to the generic
 * training buildings so the roster is never unreachable.
 */
const ROLE_BUILDINGS: Record<string, string[]> = {
  'Line Infantry': ['barracks', 'training_yard'],
  'Anti-Cavalry': ['barracks', 'training_yard'],
  'Shock Infantry': ['barracks', 'sparring_circle'],
  'Elite Shock': ['training_yard', 'sparring_circle'],
  Ranged: ['archery_range', 'bowyer', 'fletcher'],
  Skirmisher: ['archery_range', 'kennels'],
  Screen: ['shield_wright', 'barracks'],
  Recon: ['scout_post', 'kennels', 'rally_point'],
  Logistics: ['rally_point', 'tool_shed'],
};

const GENERIC_TRAINING = ['barracks', 'training_yard'];

/** Military buildings present here, by their era-stripped key. */
function militaryBuildings(view: SettlementView): Set<string> {
  const out = new Set<string>();
  for (const b of view.buildings) {
    const ref = buildingRef(b.buildingKey);
    if (ref.category !== 'Military') continue;
    // Keys are `{era}_{name}`; the same building recurs across eras, and a
    // Barracks is a Barracks whichever era built it (Heritage, spec/04 §1).
    out.add(b.buildingKey.replace(/^\d+_/, ''));
  }
  return out;
}

export function trainingSlots(view: SettlementView): number {
  const count = countWhere(view.buildings, (b) => buildingRef(b.buildingKey).category === 'Military');
  return count === 0 ? 0 : C.MILITARY_QUEUE_SLOTS;
}

export function trainingQueue(view: SettlementView): QueueItem[] {
  return view.queue.filter((q) => q.kind === 'training');
}

// ============================================================================
// Cost
// ============================================================================

export interface TrainingCost {
  resources: Record<string, bigint>;
  totalTimeMs: Millis;
  perUnitMs: Millis;
}

/**
 * Cost and time to train a batch.
 *
 * Time is PER UNIT and multiplied by the batch, which is what makes a Mythic
 * Path Avatar six months of a settlement's attention rather than six months of
 * wall clock shared across a thousand of them. It is also why the governor
 * multiplier applies per unit (Governors sheet: "Applies per unit, so a Mythic
 * Path Avatar or a large batch becomes a serious commitment").
 */
export function trainingCost(
  unitKey: string,
  quantity: number,
  facilitySpeedMod: number,
  timeMultiplier: number,
): TrainingCost {
  const def = unitDefOrThrow(unitKey);
  const grade = GRADE_BY_NAME.get(def.grade);
  if (!grade) throw new Error(`unknown unit grade ${def.grade}`);

  const archetypeUpkeep = def.upkeep / grade.upkeepMult;
  const perUnitMs = trainTimeMs(archetypeUpkeep, grade.trainMult, facilitySpeedMod, timeMultiplier);

  // Upkeep already encodes era, archetype and grade, so cost derived from it
  // stays correct automatically as the roster is rebalanced — the same
  // reasoning that makes upkeep the base of Unit Power Value.
  const perUnit = BigInt(Math.max(1, Math.round(def.upkeep * C.TRAIN_COST_PER_UPKEEP)));
  const batch = BigInt(quantity);

  return {
    resources: {
      // Soldiers eat, carry metal, and need something made specially.
      grain: perUnit * batch,
      stone: (perUnit * batch) / 2n,
      special: (perUnit * batch) / 4n,
    },
    perUnitMs,
    totalTimeMs: perUnitMs * batch,
  };
}

function unitDefOrThrow(unitKey: string): UnitDef {
  const def = tryUnitDef(unitKey);
  if (!def) throw new Error(`unknown unit ${unitKey}`);
  return def;
}

/** Military buildings compress training time, as an HQ compresses building. */
export function facilitySpeedFor(view: SettlementView): number {
  const best = Math.max(
    0,
    ...view.buildings.filter((b) => buildingRef(b.buildingKey).category === 'Military').map((b) => b.level),
    0,
  );
  // Capped at -40%, per Category_Chassis!Military ("-train time (capped -40%)").
  return 1 - Math.min(C.TRAIN_SPEED_CAP, gradeForLevel(best) * C.TRAIN_SPEED_PER_GRADE);
}

// ============================================================================
// Validation
// ============================================================================

export interface TrainingContext {
  view: SettlementView;
  playerEra: number;
  research: ResearchLevels;
  warfareRank: number;
  cultivationGrade: number;
}

function reject(type: ProblemType, detail: string, meta?: Record<string, unknown>): Validation {
  return { ok: false, type, detail, meta };
}

export function validateTrainingEnqueue(ctx: TrainingContext, unitKey: string, quantity: number): Validation {
  const def = tryUnitDef(unitKey);
  if (!def) return reject('not-found', `no such unit: ${unitKey}`);

  if (quantity < 1 || quantity > C.TRAIN_BATCH_MAX) {
    return reject('validation', `a training order is 1 to ${C.TRAIN_BATCH_MAX} units`, { max: C.TRAIN_BATCH_MAX });
  }

  // An Outpost is extraction only and trains nothing (Holdings_Hierarchy).
  const holding = HOLDINGS.find((h) => h.key === ctx.view.settlement.holdingType);
  if (holding && /no unit training/i.test(holding.produces)) {
    return reject('validation', `a ${holding.name} cannot train units`, { holdingType: holding.key });
  }

  if (def.era > ctx.playerEra) {
    return reject('era-gate', `${def.name} belongs to era ${def.era}; you are in era ${ctx.playerEra}`, {
      requiredEra: def.era, era: ctx.playerEra,
    });
  }

  // The grade gates, read from Unit_Grades rather than retyped.
  const grade = GRADE_BY_NAME.get(def.grade);
  if (grade) {
    const have = bestMilitaryGrade(ctx.research);
    if (grade.requiresDisciplineGrade > 0 && have < grade.requiresDisciplineGrade) {
      return reject(
        'grade-prerequisite',
        `${def.grade} units need a military discipline at grade ${grade.requiresDisciplineGrade}; your best is ${have}`,
        { required: grade.requiresDisciplineGrade, have, unlock: grade.unlock },
      );
    }
    if (grade.requiresWarfareRank > 0 && ctx.warfareRank < grade.requiresWarfareRank) {
      return reject(
        'grade-prerequisite',
        `${def.grade} units need Warfare rank ${grade.requiresWarfareRank}; you are rank ${ctx.warfareRank}`,
        { required: grade.requiresWarfareRank, have: ctx.warfareRank, unlock: grade.unlock },
      );
    }
  }

  // A building that can actually train this role.
  const present = militaryBuildings(ctx.view);
  if (present.size === 0) {
    return reject('validation', 'this settlement has no military building');
  }
  const wanted = ROLE_BUILDINGS[def.role] ?? GENERIC_TRAINING;
  if (!wanted.some((w) => present.has(w))) {
    return reject(
      'validation',
      `${def.role} units need one of: ${wanted.map((w) => w.replace(/_/g, ' ')).join(', ')}`,
      { role: def.role, needs: wanted, present: [...present] },
    );
  }

  // A free training slot. These are separate from the HQ's build slots, so a
  // settlement is never forced to choose between growing and defending itself.
  const slots = trainingSlots(ctx.view);
  const used = trainingQueue(ctx.view).length;
  if (used >= slots) {
    return reject('no-free-queue-slot', `all ${slots} training slots are busy`, { used, available: slots });
  }

  return { ok: true };
}

/** Everything this settlement could train right now, with its reason if not. */
/**
 * The roster up to an era, cached.
 *
 * Six eras, one fixed answer each, and this sits in front of the 2,268-unit
 * roster on every settlement screen open — so the filter ran in full each time
 * to produce a list that had not changed since the process started. Frozen, so
 * the shared copy cannot be mutated by a caller.
 */
const ROSTER_BY_ERA = new Map<number, readonly UnitDef[]>();

function unitsUpToEra(era: number): readonly UnitDef[] {
  const hit = ROSTER_BY_ERA.get(era);
  if (hit) return hit;
  const list = Object.freeze(ROSTER.filter((u) => u.era <= era));
  ROSTER_BY_ERA.set(era, list);
  return list;
}

export function trainableHere(ctx: TrainingContext): {
  unit: UnitDef; allowed: boolean; reason?: string; cost: TrainingCost;
}[] {
  const speed = facilitySpeedFor(ctx.view);
  return unitsUpToEra(ctx.playerEra).map((unit) => {
    const check = validateTrainingEnqueue(ctx, unit.unitKey, 1);
    return {
      unit,
      allowed: check.ok,
      reason: check.ok ? undefined : check.detail,
      cost: trainingCost(unit.unitKey, 1, speed, C.PLAYER_TIME_MULT),
    };
  });
}

/**
 * The name a newly trained batch gets.
 *
 * Formations are what players name and grow attached to (spec/02 §4), so a
 * batch that joins an existing formation of the same unit type does exactly
 * that — and dilutes its veterancy, which is the point. A new one gets a
 * placeholder the player will rename.
 */
export function defaultFormationName(def: UnitDef, existingCount: number): string {
  return existingCount === 0 ? `${def.name} Company` : `${def.name} Company ${existingCount + 1}`;
}

export { militaryBuildings };
export type { Building };
