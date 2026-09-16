/**
 * sim/governor.ts — automation priced in time, never in efficiency
 *
 * THE ENTIRE SYSTEM IS ONE NUMBER (spec/04 §6):
 *
 *   > Anything a governor initiates takes twice as long.
 *
 * No output tax, no efficiency loss, no cap on holdings, no administrative
 * overload penalty. The only limit on the size of an empire is the player's own
 * attention, and governors are the relief valve.
 *
 * GOVERNORS HAVE NO JUDGEMENT. That is the design, not a limitation. The
 * Governor_Specs sheet records what each spec sheet does when written badly,
 * and every one of those failure modes is implemented here as a real outcome:
 *
 *   Build Order              stalls on the first unaffordable entry
 *   Training Standing Order  trains nothing, or drains the settlement
 *   Research Mandate         idles
 *   Resource Policy          warehouses overflow and the surplus is lost
 *   Defence Posture          defaults to Turtle
 *   Escalation Rules         the player learns from the battle report
 *
 * A stalled governor is not a bug. It is the game telling a player their spec
 * was vague — so the stall has to SURFACE, on the attention dashboard, with the
 * reason attached.
 */

import {
  C,
  GOVERNOR_SPECS,
  GOVERNOR_TIERS,
  type Governor,
  type GovernorSpecs,
  type GovernorTier,
  type ProblemType,
  type RefGovernorSpec,
  type RefGovernorTier,
  type Settlement,
  type Uuid,
} from '@ascendance/shared';
import type { SettlementView, Validation } from './settlement.js';
import { buildingRef, validateAffordable, validateBuildingEnqueue } from './settlement.js';

const TIER_BY_KEY = new Map<string, RefGovernorTier>(GOVERNOR_TIERS.map((t) => [t.key, t]));

export function governorTier(key: string): RefGovernorTier {
  const t = TIER_BY_KEY.get(key);
  if (!t) throw new Error(`unknown governor tier ${key}`);
  return t;
}

/** The six spec sheets, with what each does when left vague. */
export function specSheets(): readonly RefGovernorSpec[] {
  return GOVERNOR_SPECS;
}

function reject(type: ProblemType, detail: string, meta?: Record<string, unknown>): Validation {
  return { ok: false, type, detail, meta };
}

// ============================================================================
// Appointment
// ============================================================================

export interface AppointContext {
  tier: GovernorTier;
  /** The commander being appointed. Each tier demands a minimum level. */
  commanderLevel: number;
  /** Settlements the area would cover. */
  settlements: Settlement[];
  /** Disciplines already mandated to another governor of this player. */
  mandatedDisciplines: Set<string>;
  specs: GovernorSpecs;
}

export function validateAppointment(ctx: AppointContext): Validation {
  const tier = TIER_BY_KEY.get(ctx.tier);
  if (!tier) return reject('not-found', `no such governor tier: ${ctx.tier}`);

  if (ctx.commanderLevel < tier.commanderLevel) {
    return reject(
      'validation',
      `a ${tier.name} needs a commander of level ${tier.commanderLevel}; this one is ${ctx.commanderLevel}`,
      { required: tier.commanderLevel, have: ctx.commanderLevel, tier: tier.key },
    );
  }

  if (ctx.settlements.length === 0) {
    return reject('validation', `a ${tier.name} governs ${tier.area.toLowerCase()}, and you hold nothing in it`);
  }

  // "Only one governor may hold any given discipline" (Governor_Specs). Two
  // governors advancing the same global level would be paying twice for one
  // thing.
  for (const key of ctx.specs.researchMandate) {
    if (ctx.mandatedDisciplines.has(key)) {
      return reject('validation', `another governor already holds the mandate for ${key}`, { discipline: key });
    }
  }
  if (ctx.specs.researchMandate.length > 1) {
    return reject('validation', 'a governor may be granted authority over exactly one research discipline', {
      given: ctx.specs.researchMandate.length,
    });
  }

  return { ok: true };
}

// ============================================================================
// What a governor does next
// ============================================================================

export type Intent =
  | { kind: 'build'; settlementId: Uuid; buildingKey: string; toLevel: number }
  | { kind: 'train'; settlementId: Uuid; unitKey: string; quantity: number }
  | { kind: 'research'; settlementId: Uuid; researchKey: string }
  | { kind: 'haul'; settlementId: Uuid; targetId: Uuid; cargo: Record<string, bigint> }
  | { kind: 'stall'; settlementId: Uuid; sheet: string; reason: string };

export interface GovernorContext {
  governor: Governor;
  view: SettlementView;
  /** Units already present, so a standing order knows what it is short of. */
  garrison: Map<string, number>;
  /** The player's current level in each mandated discipline. */
  researchLevels: Readonly<Record<string, number>>;
  /** True while this governor is dead: the area stops initiating anything. */
  assassinated: boolean;
  /**
   * What the next level of a building would cost here.
   *
   * Injected rather than imported so this module stays free of the cost curves
   * and remains a pure decision function over explicit inputs.
   */
  costOf?: (buildingKey: string, view: SettlementView) => Record<string, bigint>;
}

/**
 * Decide the single next thing this governor initiates in this settlement.
 *
 * ONE thing, deliberately. A governor works down its build order and stalls on
 * the first entry it cannot start — it never reorders, never improvises, and
 * never skips ahead to something it CAN afford. spec/04 §6 is explicit that a
 * build order ignoring a resource shortfall stalls the queue rather than
 * skipping ahead, and that the stall must surface on the attention dashboard.
 *
 * Returning the stall as a value rather than as `null` is what makes that
 * possible: the caller gets the reason, not just the absence of an action.
 */
export function nextIntent(ctx: GovernorContext): Intent | null {
  const { governor, view } = ctx;
  const settlementId = view.settlement.id;

  // A dead governor's entire area stalls. Running jobs continue; nothing new
  // is initiated until a replacement travels there (Governors sheet).
  if (ctx.assassinated) {
    return { kind: 'stall', settlementId, sheet: 'Appointment', reason: 'the governor is dead; nothing new will start until a replacement arrives' };
  }

  // The governor's own parallel queue is one deep. It does not race itself.
  if (view.queue.some((q) => q.slotKind === 'governor')) return null;

  // 1. BUILD ORDER — in sequence, no reordering, no improvising.
  const build = nextBuild(ctx);
  if (build) return build;

  // 2. TRAINING STANDING ORDER — replace losses up to the target count.
  const train = nextTraining(ctx);
  if (train) return train;

  // 3. RESEARCH MANDATE — one discipline, to a target grade.
  const research = nextResearch(ctx);
  if (research) return research;

  // 4. RESOURCE POLICY — haul the surplus above the floors somewhere useful.
  const haul = nextHaul(ctx);
  if (haul) return haul;

  return null;
}

function nextBuild(ctx: GovernorContext): Intent | null {
  const { governor, view } = ctx;
  const settlementId = view.settlement.id;

  for (const step of governor.specs.buildOrder) {
    const existing = view.buildings.find((b) => b.buildingKey === step.buildingKey);
    const level = existing?.level ?? 0;
    if (level >= step.toLevel) continue; // this entry is satisfied; move on

    // The first UNSATISFIED entry is the only one considered. If it cannot
    // start, the governor stalls here rather than looking further down the
    // list — that literalism is the mechanic.
    const check = validateBuildingEnqueue(view, step.buildingKey, 'governor');
    if (!check.ok) {
      return {
        kind: 'stall', settlementId, sheet: 'Build Order',
        reason: `${buildingName(step.buildingKey)} to ${step.toLevel}: ${check.detail}`,
      };
    }
    // Affordability is checked HERE too, not left to the enqueue to refuse.
    // "Stalls on the first unaffordable entry" is a named behaviour of the
    // Build Order sheet, and a stall the player sees attributed to their spec
    // teaches something a caught exception does not.
    if (ctx.costOf) {
      const afford = validateAffordable(view, ctx.costOf(step.buildingKey, view));
      if (!afford.ok) {
        return {
          kind: 'stall', settlementId, sheet: 'Build Order',
          reason: `${buildingName(step.buildingKey)} to ${step.toLevel}: ${afford.detail}`,
        };
      }
    }
    return { kind: 'build', settlementId, buildingKey: step.buildingKey, toLevel: step.toLevel };
  }
  return null;
}

function nextTraining(ctx: GovernorContext): Intent | null {
  const { governor, view } = ctx;
  const settlementId = view.settlement.id;

  for (const order of governor.specs.trainingStandingOrder) {
    const have = ctx.garrison.get(order.unitKey) ?? 0;
    if (have >= order.maintainCount) continue;
    const short = order.maintainCount - have;
    // "Trains nothing, or drains the settlement on an unbounded order" is the
    // published failure mode. The batch cap is what stops the second half.
    return {
      kind: 'train', settlementId, unitKey: order.unitKey,
      quantity: Math.min(short, C.TRAIN_BATCH_MAX),
    };
  }
  return null;
}

function nextResearch(ctx: GovernorContext): Intent | null {
  const { governor, view } = ctx;
  const settlementId = view.settlement.id;

  for (const key of governor.specs.researchMandate) {
    // A mandate needs somewhere to do the work. "Idles" is the published
    // failure, and it is worth naming rather than silently doing nothing.
    if (!view.buildings.some((b) => buildingRef(b.buildingKey).category === 'Knowledge')) {
      return {
        kind: 'stall', settlementId, sheet: 'Research Mandate',
        reason: `mandated to advance ${key}, but this settlement has no Knowledge building`,
      };
    }
    return { kind: 'research', settlementId, researchKey: key };
  }
  return null;
}

/**
 * Haul the surplus above the stockpile floors to the nominated destination.
 *
 * Without a policy, "warehouses overflow and the surplus is lost permanently"
 * — which is exactly what happens, because nothing here fires.
 */
function nextHaul(ctx: GovernorContext): Intent | null {
  const { governor, view } = ctx;
  const policy = governor.specs.resourcePolicy;
  if (!policy.haulSurplusTo || policy.haulSurplusTo === view.settlement.id) return null;

  const cargo: Record<string, bigint> = {};
  for (const sp of view.stockpiles) {
    // The floor is expressed in days of local consumption; with no consumption
    // model yet, it is read as an absolute reserve.
    const floor = BigInt(Math.max(0, Math.round(policy.keepDays))) * BigInt(C.HAUL_FLOOR_PER_DAY);
    if (sp.amount <= floor) continue;
    const surplus = sp.amount - floor;
    // Only worth a convoy if there is enough to justify one. A trickle of
    // haulers is how a player ends up with a hundred interceptable convoys.
    if (surplus < BigInt(C.HAUL_MIN_CARGO)) continue;
    cargo[sp.resourceKey] = surplus;
  }
  if (Object.keys(cargo).length === 0) return null;

  return { kind: 'haul', settlementId: view.settlement.id, targetId: policy.haulSurplusTo, cargo };
}

function buildingName(key: string): string {
  try {
    return buildingRef(key).name;
  } catch {
    return key;
  }
}

// ============================================================================
// Defence posture and escalation
// ============================================================================

export type Posture = GovernorSpecs['defencePosture'];

export interface PostureEffect {
  /** Whether the garrison sallies out to meet an attacker. */
  counterAttacks: boolean;
  /** Defensive multiplier from digging in. */
  defenceMod: number;
  note: string;
}

/**
 * How a posture changes an engagement in the governor's area.
 *
 * "Defaults to Turtle, which loses winnable fights and wins unwinnable ones
 * slowly" is the published failure mode of leaving this blank — so Turtle is
 * genuinely strong defensively and genuinely passive, rather than being a
 * neutral default dressed up as a choice.
 */
export function postureEffect(posture: Posture): PostureEffect {
  switch (posture) {
    case 'fortify':
      return {
        counterAttacks: false,
        defenceMod: 1 + C.POSTURE_FORTIFY_BONUS,
        note: 'Turtle: the garrison holds the walls and never leaves them.',
      };
    case 'mobile':
      return {
        counterAttacks: true,
        defenceMod: 1 - C.POSTURE_SALLY_PENALTY,
        note: 'Sally: the garrison meets attackers in the field, giving up the walls to do it.',
      };
    case 'garrison':
    default:
      return {
        counterAttacks: false,
        defenceMod: 1,
        note: 'Hold: the garrison defends, and counter-attacks only locally.',
      };
  }
}

export interface EscalationCheck {
  alert: boolean;
  pauseQueue: boolean;
  reason?: string;
}

/**
 * Whether the governor should stop acting and wake the player.
 *
 * The published failure of leaving this vague is that "the player learns about
 * a lost province from the battle report". Escalation is the difference between
 * automation and abdication.
 */
export function checkEscalation(
  specs: GovernorSpecs,
  ctx: { incomingForce: number; loyalty: number },
): EscalationCheck {
  const rules = specs.escalationRules;
  if (rules.alertOnIncoming && ctx.incomingForce > 0) {
    return {
      alert: true,
      pauseQueue: true,
      reason: `${ctx.incomingForce} hostile units inbound; the governor has stopped initiating`,
    };
  }
  if (ctx.loyalty < rules.alertBelowLoyalty) {
    return {
      alert: true,
      pauseQueue: false,
      reason: `loyalty has fallen to ${ctx.loyalty}, below your threshold of ${rules.alertBelowLoyalty}`,
    };
  }
  return { alert: false, pauseQueue: false };
}

// ============================================================================
// Subversion
// ============================================================================

/**
 * A turned governor follows corrupted specs SILENTLY.
 *
 * "An enemy Spymaster may turn a governor rather than kill them. A turned
 * governor follows corrupted specs" — and only an audit reveals it. That is
 * why `subvertedBy` is never exposed on a normal read: a subversion a player
 * can see on their governor screen is not a subversion, it is a status effect.
 */
export function corruptSpecs(specs: GovernorSpecs): GovernorSpecs {
  return {
    ...specs,
    // Quietly reversed priorities: the things that matter go last.
    buildOrder: [...specs.buildOrder].reverse(),
    // The garrison stops being replaced.
    trainingStandingOrder: specs.trainingStandingOrder.map((o) => ({ ...o, maintainCount: 0 })),
    // And the alarm is switched off, which is the part that actually costs a
    // province.
    escalationRules: { alertOnIncoming: false, alertBelowLoyalty: 0 },
  };
}

export interface Audit {
  subverted: boolean;
  by?: Uuid;
  findings: string[];
}

/** An audit is the only thing that reveals a turned governor. */
export function auditGovernor(governor: Governor, asWritten: GovernorSpecs): Audit {
  if (!governor.subvertedBy) {
    return { subverted: false, findings: ['The governor is executing your specs as written.'] };
  }
  const findings: string[] = [];
  const running = governor.specs;
  if (JSON.stringify(running.buildOrder) !== JSON.stringify(asWritten.buildOrder)) {
    findings.push('The build order being executed is not the one you wrote.');
  }
  if (running.trainingStandingOrder.some((o) => o.maintainCount === 0)) {
    findings.push('Standing training orders have been zeroed; losses are not being replaced.');
  }
  if (!running.escalationRules.alertOnIncoming) {
    findings.push('Escalation alerts have been switched off. You would not have been told.');
  }
  return { subverted: true, by: governor.subvertedBy, findings };
}
