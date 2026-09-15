/**
 * xp.ts — Kill-attributed experience
 * ============================================================================
 *
 * PURPOSE
 *   Turns a resolved battle into XP awards per formation. Runs ASYNCHRONOUSLY
 *   after resolution so it never sits on the critical path of a battle a player
 *   is watching.
 *
 * WHY NOT FLAT XP PER BATTLE
 *   A universe resolving thousands of engagements daily cannot award a flat amount
 *   per battle. It would value a skirmish and a decisive siege equally, reward
 *   spamming trivial attacks, and sever progression from what a formation actually
 *   did. XP is therefore derived from kills, valued by what was killed and
 *   discounted by how easy the kill was.
 *
 * COST
 *   Attribution is per unit TYPE, not per soldier. A large battle produces roughly
 *   20-60 rows per side. A server resolving 10,000 battles a day writes on the
 *   order of a million rows — trivial next to the event log that already records
 *   every engagement.
 *
 * SPEC: spec/03_simulation_engine.md §7
 * WORKBOOK: sheets `XP_Attribution`, `XP_Worked_Example`
 */

import { C } from './generated/constants.js';
import { unitPowerValue, experienceFatigue, cumulativeLevels } from './formulas.js';

export type Track = 'atk' | 'def';

export interface CombatantSlice {
  formationId: string;
  unitKey: string;
  role: string;               // e.g. 'Line Infantry' — indexes the counter matrix
  count: number;
  baseUpkeep: number;
  tier: number;               // veterancy tier on the relevant track
  levelInTier: number;
  /** This unit type's share of its side's attack pool for the phase. 0..1 */
  contributionShare: number;
}

export interface PhaseLosses {
  /** unitKey -> number destroyed in this phase */
  byUnitKey: Record<string, number>;
}

export interface VictimProfile {
  unitKey: string;
  role: string;
  baseUpkeep: number;
  tier: number;
  levelInTier: number;
}

export interface AttributionRow {
  formationId: string;
  track: Track;
  killsCredited: Record<string, number>;
  rawValue: number;
  roleFactorAvg: number;
  relativeFactorAvg: number;
  fatigue: number;
  repetition: number;
  xpAwarded: bigint;
  /** Populated when a hard-zero rule fired, so the report can explain the zero. */
  zeroReason?: string;
}

/**
 * RoleFactor — the reward for fighting outside your specialty.
 *
 * factor = 1 / counterMatrix[killerRole][victimRole]
 *
 * Killing what you were built to kill teaches little; killing something that
 * counters you teaches a great deal. Pikemen slaughtering cavalry earn 0.56x.
 * Pikemen somehow killing crossbowmen earn 1.4x.
 *
 * This is one of the nicer emergent properties in the design: formations grow
 * fastest doing what they are bad at, which quietly pushes players toward harder,
 * more interesting engagements rather than safe ones.
 */
export function roleFactor(
  counterMatrix: Record<string, Record<string, number>>,
  killerRole: string,
  victimRole: string,
): number {
  const m = counterMatrix[killerRole]?.[victimRole] ?? 1;
  // Guard against a malformed matrix producing a divide-by-zero.
  return m <= 0 ? 1 : 1 / m;
}

/**
 * RelativeFactor — the primary anti-farming lever.
 *
 * factor = clamp((victimUPV / killerUPV) ^ 0.5, 0.05, 4.0)
 *
 * Killing something stronger than you teaches more; killing something far weaker
 * teaches almost nothing. A Ruby-tier formation killing Copper militia earns near
 * zero regardless of how many it kills.
 *
 * The square root is deliberate: a linear ratio would make killing anything
 * slightly weaker nearly worthless, which would discourage all normal warfare.
 */
export function relativeFactor(victimUPV: number, killerUPV: number): number {
  if (killerUPV <= 0) return C.REL_MAX;
  const raw = Math.pow(victimUPV / killerUPV, C.REL_EXP);
  return Math.max(C.REL_MIN, Math.min(C.REL_MAX, raw));
}

/**
 * Repetition decay against the same defender within 24 hours.
 * [1.0, 0.6, 0.35, 0.2, 0.1...] — stops a formation grinding one helpless
 * neighbour all day.
 */
export function repetitionFactor(engagementsAgainstTargetToday: number): number {
  const ladder = C.REPETITION_LADDER; // [1, 0.6, 0.35, 0.2, 0.1]
  const i = Math.max(0, Math.min(engagementsAgainstTargetToday, ladder.length - 1));
  return ladder[i] ?? ladder[ladder.length - 1] ?? 0;
}

/**
 * Hard-zero conditions. Evaluated BEFORE any XP is computed.
 *
 * These are absolute zeroes, not reductions. The distinction matters: a reduction
 * still rewards grinding at scale, whereas a zero ends the strategy entirely.
 */
export function hardZeroReason(ctx: {
  /**
   * The average UPV of the DEFENDING FORCE in this engagement, weighted by
   * headcount — not the UPV of one victim type.
   *
   * WHY THE FORCE AND NOT THE TYPE. The rule exists so that elite formations
   * gain nothing from slaughtering peasants (XP_Attribution: "a victim whose
   * UPV is below 2% of the killer's UPV awards zero XP"). Applied per victim
   * type it also zeroes the cheapest type inside a genuinely contested battle,
   * which is not what it is for — and it contradicts the specification's own
   * M5 acceptance test: in XP_Worked_Example the Ninth Musket's crossbowmen
   * sit at 1.87% of killer UPV, and excluding them yields 185 XP where
   * spec/08 M5 requires exactly 211.
   *
   * Evaluating the force average satisfies both. It is also the stronger
   * anti-farming rule: a player cannot dilute a peasant stack with a handful
   * of real units to make the peasants payable, because the average stays
   * beneath notice. See DECISIONS.md.
   */
  engagementVictimUPV: number;
  killerUPV: number;
  victimIsNpc: boolean;
  killerTier: number;
  eraGapBelow: number;        // how many eras below the killer the victim is
  targetIsLinkedAccount: boolean;
}): string | null {
  // "Beneath notice" — elite formations gain literally nothing from peasants.
  if (ctx.engagementVictimUPV < ctx.killerUPV * C.BENEATH_NOTICE_RATIO) return 'beneath-notice';

  // NPC ceiling — barbarians and pirates cannot carry a formation past Steel.
  // Beyond tier 4, only players and the endgame PvE factions count.
  if (ctx.victimIsNpc && ctx.killerTier >= C.NPC_TIER_CEILING) return 'npc-ceiling';

  // Escalation — punching two or more eras down is already unprofitable in
  // plunder and reputation; it earns no experience either.
  if (ctx.eraGapBelow >= C.ESCALATION_ERA_GAP) return 'escalation';

  // Self-dealing — same detection used by transfer caps and Heaven's Envy scopes.
  if (ctx.targetIsLinkedAccount) return 'linked-account';

  return null;
}

/**
 * Attribute XP for one unit type on one side of one battle.
 *
 * xp = Σ over victims [ UPV(victim) * roleFactor * relativeFactor ]
 *      * fatigue * repetition * (winner ? 1 : 0.6)
 *
 * The loser multiplier matches the Warfare proficiency rule: defeat still grants
 * roughly 60% of the winning rate on the same attribution, so an outmatched
 * player's army still develops. Fighting a losing war must never be progression
 * death, or players in that position simply quit.
 */
export function attributeKills(args: {
  killer: CombatantSlice;
  track: Track;
  phaseLosses: PhaseLosses;
  victimProfiles: Record<string, VictimProfile>;
  counterMatrix: Record<string, Record<string, number>>;
  engagementsAgainstTargetToday: number;
  won: boolean;
  victimIsNpc: boolean;
  eraGapBelow: number;
  targetIsLinkedAccount: boolean;
}): AttributionRow {
  const { killer, track, phaseLosses, victimProfiles, counterMatrix } = args;

  const killerUPV = unitPowerValue(
    killer.baseUpkeep,
    cumulativeLevels(killer.tier, killer.levelInTier),
  );

  // The hard zeroes are properties of the ENGAGEMENT, not of one victim type,
  // so they are evaluated once, before anything is awarded. A reduction still
  // rewards grinding at scale; a zero ends the strategy entirely.
  const engagementVictimUPV = averageVictimUPV(phaseLosses, victimProfiles);
  const zero = hardZeroReason({
    engagementVictimUPV,
    killerUPV,
    victimIsNpc: args.victimIsNpc,
    killerTier: killer.tier,
    eraGapBelow: args.eraGapBelow,
    targetIsLinkedAccount: args.targetIsLinkedAccount,
  });

  const killsCredited: Record<string, number> = {};
  let rawValue = 0;
  let roleSum = 0;
  let relSum = 0;
  let victimTypes = 0;

  for (const [victimKey, lost] of Object.entries(phaseLosses.byUnitKey)) {
    const v = victimProfiles[victimKey];
    if (!v || lost <= 0) continue;

    // Kills are attributed by CONTRIBUTION SHARE rather than tracked individually.
    // The resolver already computes these pools to decide the battle, so this
    // costs arithmetic rather than simulation.
    const credited = lost * killer.contributionShare;
    if (credited <= 0) continue;
    killsCredited[victimKey] = credited;
    if (zero) continue; // recorded for the report, but worth nothing

    const victimUPV = unitPowerValue(v.baseUpkeep, cumulativeLevels(v.tier, v.levelInTier));
    const rf = roleFactor(counterMatrix, killer.role, v.role);
    const xf = relativeFactor(victimUPV, killerUPV);

    rawValue += credited * victimUPV * rf * xf;
    roleSum += rf;
    relSum += xf;
    victimTypes++;
  }

  const fatigue = experienceFatigue(killer.tier, killer.levelInTier);
  const repetition = repetitionFactor(args.engagementsAgainstTargetToday);
  const sideMult = args.won ? 1 : C.LOSER_XP_RATE;

  const xp = BigInt(Math.max(0, Math.round(rawValue * fatigue * repetition * sideMult)));

  return {
    formationId: killer.formationId,
    track,
    killsCredited,
    rawValue,
    roleFactorAvg: victimTypes ? roleSum / victimTypes : 0,
    relativeFactorAvg: victimTypes ? relSum / victimTypes : 0,
    fatigue,
    repetition,
    xpAwarded: xp,
    zeroReason: xp === 0n ? (zero ?? 'no-credited-kills') : undefined,
  };
}

/**
 * Headcount-weighted average UPV of the force that died in this phase.
 *
 * This is what "beneath notice" is measured against. Weighting by headcount
 * rather than by type count means a thousand militia screened by ten elites
 * still reads as a militia engagement, which is the point.
 */
export function averageVictimUPV(
  phaseLosses: PhaseLosses,
  victimProfiles: Record<string, VictimProfile>,
): number {
  let total = 0;
  let count = 0;
  for (const [key, lost] of Object.entries(phaseLosses.byUnitKey)) {
    const v = victimProfiles[key];
    if (!v || lost <= 0) continue;
    total += lost * unitPowerValue(v.baseUpkeep, cumulativeLevels(v.tier, v.levelInTier));
    count += lost;
  }
  return count === 0 ? 0 : total / count;
}

/**
 * Absorption XP — the defence track's second component.
 *
 * absorption = 0.5 * (damageAbsorbed / totalDamageDelivered)
 *            * Σ(attacking force UPV) * fatigue
 *
 * WHY THIS EXISTS: screens get no kills. A Guardian shield wall or an Aegis
 * point-defence cruiser may kill nothing across an entire siege and still be the
 * reason the settlement held. Under pure kill attribution those archetypes could
 * never advance, and the Guardian identity path would be a trap that punished the
 * players who chose it. Soaking a Dreadnought bombardment teaches a screen a great
 * deal, and the system should say so.
 */
export function absorptionXp(args: {
  defender: CombatantSlice;
  damageAbsorbed: number;
  totalDamageDelivered: number;
  attackingForceUPV: number;
  won: boolean;
}): bigint {
  if (args.totalDamageDelivered <= 0) return 0n;
  const share = args.damageAbsorbed / args.totalDamageDelivered;
  const fatigue = experienceFatigue(args.defender.tier, args.defender.levelInTier);
  const sideMult = args.won ? 1 : C.LOSER_XP_RATE;
  const v = C.ABSORPTION_COEFF * share * args.attackingForceUPV * fatigue * sideMult;
  return BigInt(Math.max(0, Math.round(v)));
}

/**
 * Apply accrued XP to a formation, promoting levels as thresholds are crossed.
 *
 * NOTE ON TIERS: crossing level 1337 does NOT auto-promote. Promotion additionally
 * requires the resource cost paid from the formation's home settlement AND a
 * recorded qualifying deed. This function stops at the tier ceiling and reports
 * eligibility; the promotion itself is a separate, explicit player command.
 *
 * Era gating also applies: a formation cannot exceed ceil(3.5 * era).
 */
export function applyXp(args: {
  tier: number;
  levelInTier: number;
  currentXp: bigint;
  gained: bigint;
  empireWeightMultiplier: number;
  era: number;
  xpRequiredForLevel: (tier: number, level: number, ewm: number) => bigint;
  maxTierForEra: (era: number) => number;
}): { tier: number; levelInTier: number; xp: bigint; eligibleForPromotion: boolean } {
  let { tier, levelInTier } = args;
  let xp = args.currentXp + args.gained;
  const tierCap = args.maxTierForEra(args.era);

  // Loop rather than closed-form because the requirement changes every level and
  // the loop terminates quickly in practice (a single battle rarely grants more
  // than a handful of levels once fatigue is applied).
  for (;;) {
    if (levelInTier >= C.LEVELS_PER_TIER) break;       // needs an explicit promotion
    const need = args.xpRequiredForLevel(tier, levelInTier, args.empireWeightMultiplier);
    if (xp < need) break;
    xp -= need;
    levelInTier++;
  }

  const eligible = levelInTier >= C.LEVELS_PER_TIER && tier < tierCap;
  return { tier, levelInTier, xp, eligibleForPromotion: eligible };
}
