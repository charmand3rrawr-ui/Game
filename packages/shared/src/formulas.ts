/**
 * formulas.ts — Ascendance core game mathematics
 * ============================================================================
 *
 * PURPOSE
 *   Every number the game derives rather than stores comes from this file.
 *   These functions are the single source of truth for game math and are imported
 *   by BOTH the server resolver and the client-side battle simulator, which is the
 *   whole reason the project is in one language: the simulator a player uses to
 *   plan an attack runs literally the same code that will resolve it.
 *
 * INVARIANTS (see spec/00_README_FIRST.md §2)
 *   - Pure. No I/O, no clock reads, no globals, no Math.random().
 *   - Deterministic. Same inputs always produce the same output on every platform.
 *   - No magic numbers. Every constant is imported from generated/constants.ts,
 *     which is produced from Ascendance_Master_Tables.xlsx at build time.
 *
 * WHY bigint
 *   Resource costs reach 2.3e14, XP requirements reach 1.88e12, and veterancy raw
 *   ratings are larger still. IEEE-754 loses integer precision above 9.007e15, so
 *   anything that is *stored* is a bigint. Multipliers and intermediate combat math
 *   stay as numbers because precision there is irrelevant and speed is not.
 */

import { C } from './generated/constants.js'; // frozen, generated from the workbook
import { clamp } from './num.js';

// ============================================================================
// SECTION 1 — BUILDINGS
// ============================================================================

/**
 * Resource cost to raise a building from `level` to `level + 1`.
 *
 * cost(L) = base * (L+1)^2.4 * 1.004^L
 *
 * The polynomial term does most of the work in the early and middle game; the
 * gentle exponential term (1.004) is what makes the last few hundred levels
 * genuinely prohibitive without making the early game feel exponential.
 *
 * Source: workbook sheet `Building_Levels`. Calibrated jointly with buildTimeMs
 * so that a full 0 -> 1337 climb is a 500-year project.
 */
export function buildingCost(baseCost: bigint, level: number): bigint {
  const mult = Math.pow(level + 1, C.BUILD_COST_EXP) * Math.pow(C.BUILD_COST_GEO, level);
  // Round once, at the end, to avoid accumulating float error into a stored value.
  return BigInt(Math.round(Number(baseCost) * mult));
}

/**
 * Wall-clock milliseconds to raise a building from `level` to `level + 1`.
 *
 * time(L) = K * (L+1)^1.9 * 1.003^L     where K ≈ 0.000432 hours
 *
 * CALIBRATION ANCHOR (spec/07 §3.1): K is solved so that the sum of this function
 * over all 1,338 levels equals exactly 4,383,000 hours — 500 years. Changing K,
 * the exponent, or the geometric term breaks that anchor and is a design decision
 * requiring sign-off, not a tweak.
 *
 * `hqFactor` and `speedMods` are bounded accelerations (HQ level, doctrines,
 * cultivation auras, Tools component). They compress the curve; they never flatten
 * it, and none of them are purchasable.
 *
 * `governorMultiplier` is 1.0 for player-initiated work and 2.0 for governor-initiated.
 * That single number is the entire governor system (spec/04 §6).
 */
export function buildTimeMs(
  level: number,
  hqFactor: number,
  speedMods: number,
  governorMultiplier: number,
): bigint {
  const hours =
    C.BUILD_TIME_K *
    Math.pow(level + 1, C.BUILD_TIME_EXP) *
    Math.pow(C.BUILD_TIME_GEO, level);
  const adjusted = (hours / hqFactor) * speedMods * governorMultiplier;
  return BigInt(Math.round(adjusted * 3_600_000));
}

/**
 * Production output multiplier at a given level.
 *
 * output(L) = (L+1)^1.12
 *
 * Deliberately POLYNOMIAL while cost and time are near-exponential. That asymmetry
 * is what creates the central strategic question of the building game: there is
 * always a rational stopping point for any given building, and it differs per
 * settlement. Without it, players would simply max everything in priority order.
 */
export function outputMultiplier(level: number): number {
  return Math.pow(level + 1, C.OUTPUT_EXP);
}

/**
 * Effective production per millisecond for one building.
 *
 * Staffing scales output LINEARLY — a mine at 50% staffing produces exactly half.
 * This is what gives population real strategic weight and makes sieges, plagues,
 * and fresh conquests economically meaningful rather than cosmetic.
 */
export function productionRatePerMs(
  baseRatePerHour: number,
  level: number,
  tileRichness: number,
  staffedPct: number,
  adjacencyBonus: number,
): number {
  const perHour =
    baseRatePerHour *
    outputMultiplier(level) *
    tileRichness *
    (staffedPct / 100) *
    (1 + adjacencyBonus);
  return perHour / 3_600_000;
}

/**
 * Lazy accrual. Production is NEVER a tick — see spec/03 §3.
 *
 * Storing `lastAccruedAt` and computing on read is the difference between a server
 * that handles ten thousand settlements and one that handles ten million. Idle
 * settlements must cost exactly zero CPU.
 *
 * Overflow above capacity is DISCARDED, not carried. That loss is a deliberate
 * design pressure pushing players to spend, trade, or expand.
 */
export function accrue(
  current: bigint,
  capacity: bigint,
  ratePerMs: number,
  lastAccruedAt: bigint,
  now: bigint,
): { amount: bigint; overflowed: boolean } {
  const elapsed = Number(now - lastAccruedAt);
  if (elapsed <= 0) return { amount: current, overflowed: false };
  const gained = BigInt(Math.floor(ratePerMs * elapsed));
  const raw = current + gained;
  if (raw > capacity) return { amount: capacity, overflowed: true };
  return { amount: raw, overflowed: false };
}

// ============================================================================
// SECTION 2 — GRADES (shared by buildings, research, and cultivation)
// ============================================================================

/**
 * The 42-grade spine. Every 32 levels is a grade boundary.
 *
 * Grades — not raw levels — gate CONTENT: unit grade tiers, doctrine forks,
 * equipment tiers, edicts, era systems. Levels make you incrementally better;
 * grades change what you are. Buildings, research disciplines and the player's
 * cultivation realm all ride this same ladder, which is why a player can say
 * "my Powder Doctrine broke through to Golden Core" and communicate three facts
 * at once.
 *
 * Grade 42 spans levels 1312-1337 (42 * 32 = 1344, truncated to the 1337 cap).
 */
export function gradeForLevel(level: number): number {
  return Math.min(C.MAX_GRADE, Math.floor(level / C.LEVELS_PER_GRADE) + 1);
}

/** Qi cost to break through into grade G. Curve: 100 * G^3.2 * 1.15^G */
export function qiBreakthroughCost(grade: number): bigint {
  return BigInt(
    Math.round(C.QI_BASE * Math.pow(grade, C.QI_EXP) * Math.pow(C.QI_GEO, grade)),
  );
}

// ============================================================================
// SECTION 3 — UNITS AND TRAINING
// ============================================================================

/**
 * Training time for one unit.
 *
 * CALIBRATION ANCHOR (spec/07 §3.2): the constant is solved so a Mythic-grade
 * Path Avatar (upkeep 900, grade multiplier 12) trains in exactly 4,383 hours —
 * six months. The whole training economy hangs off that anchor.
 *
 * The consequence is intentional and important: high-grade units are strategic
 * capital, not consumables. Losing a Mythic Titan costs a dynasty seven weeks of
 * production. That is what makes capital-ship engagements fearful, makes escort
 * doctrine matter, and makes shipyard raids worth planning.
 */
export function trainTimeMs(
  baseUpkeep: number,
  gradeTrainMultiplier: number,
  facilitySpeedMod: number,
  governorMultiplier: number,
): bigint {
  const hours =
    baseUpkeep * C.TRAIN_CONST * gradeTrainMultiplier * facilitySpeedMod * governorMultiplier;
  return BigInt(Math.round(hours * 3_600_000));
}

/**
 * Unit Power Value — the universal measure of "what a unit is worth".
 *
 * UPV = upkeep * veterancy stat multiplier
 *
 * Using upkeep as the base is not laziness: upkeep already encodes era, archetype
 * and grade, so UPV stays correct automatically as the roster is rebalanced. It is
 * consumed by XP attribution (spec/03 §7) so that killing a Mythic Dreadnought is
 * worth thousands of times killing a militiaman with no separate table to maintain.
 */
export function unitPowerValue(baseUpkeep: number, cumulativeVeterancyLevels: number): number {
  return baseUpkeep * veterancyStatMultiplier(cumulativeVeterancyLevels);
}

// ============================================================================
// SECTION 4 — VETERANCY
// ============================================================================

/**
 * Total stat bonus from veterancy.
 *
 * Tiers grant NOTHING. They gate further levelling and cost resources. All combat
 * benefit comes from levels, at +1% each, accumulating across every tier.
 *
 * Maximum is therefore 24 tiers * 1337 levels * 1% = 322x. That deliberately sits
 * in the same order of magnitude as the era spread (~150x), which is what keeps
 * the counter matrix, terrain, timing and force size relevant. An earlier draft
 * multiplied stats 5x per tier, producing a 1.7e17 ladder that would have deleted
 * every other system in the game.
 */
export function veterancyStatMultiplier(cumulativeLevels: number): number {
  return 1 + C.VET_PER_LEVEL * cumulativeLevels;
}

export function cumulativeLevels(tier: number, levelInTier: number): number {
  return (tier - 1) * C.LEVELS_PER_TIER + levelInTier;
}

/**
 * XP required for the next level — the full stack.
 *
 * required = 100 * (L+1)^0.21 * 1.30^(T-1) * empireWeightMultiplier
 *
 * WHY THIS SHAPE: difficulty is the PRODUCT of this gentle requirement curve and
 * the gentle earn-side decay in experienceFatigue() below. Two shallow slopes give
 * the same pacing as one brutal exponential while keeping every displayed number
 * readable — the largest requirement in the game is about 1.88e12, where a
 * per-level doubling curve would have reached 10^402 and been unstorable.
 */
export function xpRequiredForLevel(
  tier: number,
  levelInTier: number,
  empireWeightMultiplier: number,
): bigint {
  const v =
    C.XP_BASE *
    Math.pow(levelInTier + 1, C.XP_LEVEL_EXP) *
    Math.pow(C.XP_TIER_MULT, tier - 1) *
    empireWeightMultiplier;
  return BigInt(Math.round(v));
}

/**
 * Experience Fatigue — the earn-side half of the split curve.
 *
 * fatigue = 1 / ((L+1)^0.21 * 1.25^(T-1))
 *
 * A veteran formation learns less from each fight because there is less left to
 * learn. Diegetically true, and mechanically it means an elite formation cannot be
 * grown on easy fights — combined with relativeFactor() below, farming weak targets
 * stops advancing a legendary unit entirely.
 */
export function experienceFatigue(tier: number, levelInTier: number): number {
  return 1 / (Math.pow(levelInTier + 1, C.FATIGUE_LEVEL_EXP) * Math.pow(C.FATIGUE_TIER_DIV, tier - 1));
}

/**
 * Empire Weight multiplier on XP REQUIRED.
 *
 * multiplier = MIN(9_918_521, 1 + (W / 100)^2.41)
 *
 * W is the rolling 30-day average of the summed admin costs of all OWNED holdings.
 * Vassalized holdings are not owned and contribute nothing — which is why
 * vassalizing rather than annexing keeps an empire's armies capable of learning,
 * the strongest incentive alignment in the design.
 *
 * The rolling average (not a live reading) is what stops a player shedding
 * territory before a war to spike progression: it takes a month to pay off.
 *
 * WHY THE SOFT KNEE: a naive power law reaching the same cap would burden a normal
 * 25-village player with a 200x requirement, ending veterancy for anyone who
 * expanded at all. This curve leaves small and mid-sized players nearly untouched
 * and falls away sharply only once a player is a genuine regional power.
 *
 * RISK TO MONITOR (spec/07 §5): this penalises expansion, which is the core loop.
 * If median empire weight or conquests-per-week flattens after launch, the knee
 * constant is wrong and must move.
 */
/**
 * Advance a player's rolling empire weight toward its live value.
 *
 * `empireWeightMultiplier` takes a 30-DAY AVERAGE, and that is not a detail:
 * `spec/03 §8` says in as many words that "the rolling average is what stops a
 * player shedding territory before a war to spike progression". Feed it a live
 * reading instead and the safeguard is gone — drop three provinces, fight the
 * battle at a lower requirement, take them back tomorrow.
 *
 * Rather than keep thirty days of samples, this converges the stored average on
 * the weight the player ACTUALLY HELD over the elapsed period, in proportion to
 * how much of the window that period covers. A full window arrives exactly; a
 * single day moves a thirtieth of the way.
 *
 * `heldWeight` is the live figure as at the START of the period, not now — and
 * that distinction is the whole safeguard. Live weight is piecewise-constant
 * between ownership changes, so the value that held for the last stretch is the
 * one that stretch should be averaged at. Passing the CURRENT figure instead
 * makes the average collapse onto it the moment a month has passed since the
 * last sample, which hands the dodge straight back: shed the provinces, read a
 * low average immediately, fight cheap.
 *
 * The property this buys cuts both ways, which is the point. Territory shed
 * before a war costs a month to pay off, and territory gained takes a month to
 * weigh fully — so conquest is not instantly taxed either.
 *
 * Pure and time-driven, so it is correct whether a world is advanced in one
 * jump or a thousand — no tick, and nothing to miss if a worker was down.
 */
export function blendEmpireWeight(
  previousAvg: number, heldWeight: number, elapsedMs: number, windowMs: number,
): number {
  if (!(elapsedMs > 0) || !(windowMs > 0)) return previousAvg;
  // Never past the held figure: an overshoot would invent weight nobody had.
  const share = Math.min(1, elapsedMs / windowMs);
  return previousAvg + (heldWeight - previousAvg) * share;
}

export function empireWeightMultiplier(weight30dAvg: number): number {
  return Math.min(C.EW_CAP, 1 + Math.pow(weight30dAvg / C.EW_KNEE, C.EW_STEEPNESS));
}

/** Resource cost to promote into `tier`. Deliberately NOT scaled by empire weight. */
export function tierUpCost(tier: number): bigint {
  if (tier < 2) return 0n;
  return BigInt(Math.round(C.TIERUP_BASE * Math.pow(C.TIERUP_MULT, tier - 2)));
}

/**
 * Green dilution — the most important balancing rule in the veterancy system.
 *
 * Reinforcing a formation lowers its veterancy proportionally by headcount, and
 * the resources spent on prior promotions are simply gone. A Tier 12 formation of
 * 100 merged with 900 recruits lands near Tier 1.
 *
 * NOTE: this MUST be computed on the cumulative-level scale, not the tier scale.
 * Averaging tiers directly produces wrong results because tiers are not linear in
 * accumulated experience.
 */
export function diluteVeterancy(
  existingCumulativeLevels: number,
  existingCount: number,
  freshCumulativeLevels: number,
  freshCount: number,
): number {
  const total = existingCount + freshCount;
  if (total === 0) return 0;
  return (existingCumulativeLevels * existingCount + freshCumulativeLevels * freshCount) / total;
}

/** Max veterancy tier for an era. Keeps opponents in a theatre within a few tiers. */
export function maxTierForEra(era: number): number {
  return Math.min(C.MAX_VET_TIER, Math.ceil(era * C.TIER_PER_ERA));
}

// ============================================================================
// SECTION 5 — COMBAT
// ============================================================================

/**
 * The joint non-doctrine bonus cap.
 *
 * Proficiency, equipment, commanders, cultivation and veterancy all fold into ONE
 * clamp of +40% on any stat. Without a joint cap, five individually reasonable
 * systems multiply into an unreasonable one — which is exactly how these games
 * usually break.
 *
 * Log both the uncapped and capped values into the battle report so a player can
 * see the cap engage. Silent caps produce accusations of cheating.
 */
export function applyJointCap(base: number, combinedMultiplier: number): {
  value: number;
  capped: boolean;
  uncapped: number;
} {
  const uncapped = base * combinedMultiplier;
  const ceiling = base * (1 + C.JOINT_BONUS_CAP);
  return uncapped > ceiling
    ? { value: ceiling, capped: true, uncapped }
    : { value: uncapped, capped: false, uncapped };
}

/**
 * Morale by relative empire size. clamp(0.5, 1.5).
 *
 * Smaller attackers fight harder. This is the classic anti-farming lever inherited
 * from the genre: it makes a large empire's casual raid on a small neighbour
 * expensive, without forbidding it.
 */
export function morale(attackerWeight: number, defenderWeight: number): number {
  if (defenderWeight <= 0) return 1;
  const ratio = attackerWeight / defenderWeight;
  return Math.max(C.MORALE_MIN, Math.min(C.MORALE_MAX, Math.pow(ratio, -C.MORALE_EXP)));
}

/** Fortification defence multiplier. (1 + 0.05 * wallGrade) */
export function fortificationMultiplier(wallGrade: number): number {
  return 1 + C.FORT_PER_GRADE * wallGrade;
}

/**
 * Heaven's Envy debuff — the public mark on the heaviest daily shard buyers.
 *
 * Three scopes (universe / quadrant / alliance top 10) each apply -10% defensive
 * strength for 24 hours, stacking to -30%. Applies to unit defence pools AND
 * fortification multipliers; deliberately does NOT touch attack values, which makes
 * marked players glass cannons rather than simply weaker.
 *
 * KNOWN LOOPHOLE, documented deliberately: a player who buys purely to fuel
 * offensives is not penalised. If beta telemetry shows buy-to-blitz behaviour, the
 * fix is a smaller offensive component (-5% per scope), not a larger defensive one.
 */
export function heavensEnvyDebuff(scopesMarked: number): number {
  return 1 - Math.min(scopesMarked, 3) * C.ENVY_PER_SCOPE;
}

// ============================================================================
// SECTION 6 — CHRONO SHARDS
// ============================================================================

/**
 * Maximum time compression a player may apply, from EARNED progression only.
 *
 * ceiling = 2.0 + 0.30 * constructionRank + 0.50 * era
 *
 * THE GOVERNING PRINCIPLE OF THE ENTIRE MONETIZATION MODEL: money buys you up to
 * your earned ceiling, never past it. A whale with a vault of shards and rank-0
 * Construction compresses at 2.5x like everybody else, and their surplus shards are
 * simply unspendable that day.
 */
export function shardCeiling(constructionRank: number, era: number): number {
  return C.SHARD_BASE + C.SHARD_PER_RANK * constructionRank + C.SHARD_PER_ERA * era;
}

/**
 * Whether shards may be applied to a queue item at all.
 *
 * Every one of these is a hard prohibition, enforced server-side, regardless of
 * whether the shards were earned or purchased. The through-line: shards accelerate
 * an empire's development but can never be deployed as a battlefield trump card.
 * The moments the game is actually about stay on real time.
 */
export function shardsPermitted(ctx: {
  hostileInboundMs: number | null; // ms until impact, null if none
  atWarAsBelligerent: boolean;
  itemKind: string;
  isAscensionProject: boolean;
  isEpochVictoryProject: boolean;
  isMegastructure: boolean;
  isCultivationBreakthrough: boolean;
  isFortificationRepairUnderSiege: boolean;
  targetEraGap: number; // how many eras below the player the target is
}): { allowed: boolean; reason?: string } {
  if (ctx.hostileInboundMs !== null && ctx.hostileInboundMs < C.SHARD_SIEGE_LOCKOUT_MS)
    return { allowed: false, reason: 'hostile-movement-inbound' };
  if (ctx.atWarAsBelligerent && ctx.itemKind === 'training')
    return { allowed: false, reason: 'wartime-training' };
  if (ctx.isAscensionProject) return { allowed: false, reason: 'ascension-project' };
  if (ctx.isEpochVictoryProject) return { allowed: false, reason: 'epoch-victory-project' };
  if (ctx.isMegastructure) return { allowed: false, reason: 'megastructure' };
  if (ctx.isCultivationBreakthrough) return { allowed: false, reason: 'cultivation' };
  if (ctx.isFortificationRepairUnderSiege) return { allowed: false, reason: 'under-siege' };
  if (ctx.targetEraGap >= 2) return { allowed: false, reason: 'escalation-rules' };
  return { allowed: true };
}

// ============================================================================
// SECTION 7 — GRADES, HOLDINGS AND SETTLEMENT CONSTRAINTS
// ============================================================================

/**
 * Plots available to a settlement.
 *
 * Plot scarcity is the PRIMARY driver of specialization (spec/04 §1). A
 * settlement can never hold every building, and that has to be enforced rather
 * than merely discouraged — so this is a hard number the enqueue path checks,
 * not a soft penalty.
 */
export function plotsAvailable(plotsAtFounding: number, maxPlots: number, hqGrade: number): number {
  return Math.min(maxPlots, plotsAtFounding + C.PLOTS_PER_HQ_GRADE * hqGrade);
}

/**
 * Personal queue slots granted by the HQ.
 *
 * This number is the only thing preventing a player from governing everything
 * and instantly seizing it all back — Seize requires a free PERSONAL slot
 * (spec/04 §6, and the Implementation Bible §5.6 flags it as one of the six
 * things most likely to be got wrong). Governor slots are separate and parallel.
 */
export function personalQueueSlots(hqGrade: number): number {
  return 1 + Math.floor(hqGrade / C.QUEUE_SLOT_PER_GRADES);
}

/**
 * Administrative upkeep of an empire: `k * N^1.35` over owned holdings.
 *
 * Feeds Empire Weight, whose 30-day rolling average multiplies veterancy XP
 * requirements. Vassalized holdings are NOT owned and contribute nothing —
 * which is why vassalizing rather than annexing keeps an empire's armies able
 * to learn, the strongest incentive alignment in the design (spec/07 §2).
 */
export function adminUpkeep(holdingAdminCosts: readonly number[]): number {
  let sum = 0;
  for (const c of holdingAdminCosts) sum += c;
  return sum;
}

/**
 * Culture border pressure: `(cultureDelta)^2 * k`, capped.
 *
 * High-culture settlements flip adjacent low-culture plots over WEEKS, not
 * minutes — soft power has to be slow or it becomes a weapon (spec/04 §3).
 */
export function culturePressure(cultureDelta: number): number {
  if (cultureDelta <= 0) return 0;
  return Math.min(C.CULTURE_PRESSURE_CAP, cultureDelta * cultureDelta * C.CULTURE_PRESSURE_K);
}

// ============================================================================
// SECTION 8 — MOVEMENT
// ============================================================================

/**
 * Travel time for a movement.
 *
 * NEVER round the resulting timestamp. Coordinated multi-wave attacks landing
 * seconds apart are a core skill in this genre; they work here because arrival
 * is a precisely timestamped scheduled event rather than a polling artefact
 * (spec/03 §4).
 */
export function travelTimeMs(
  distance: number,
  slowestUnitSpeed: number,
  layerModifier: number,
  roadModifier: number,
  inZoneOfControl: boolean,
): bigint {
  const speed = slowestUnitSpeed * layerModifier * roadModifier * (inZoneOfControl ? C.ZOC_SPEED_MULT : 1);
  if (speed <= 0) throw new RangeError('movement speed must be positive');
  // Speeds are expressed per hour of game time; distance is in map units.
  return BigInt(Math.round((distance / speed) * 3_600_000));
}

/** Euclidean distance between two map points. */
export function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Attrition beyond supply range: 3% of strength per tick, ESCALATING.
 *
 * This is the mechanic that punishes overextension. It escalates so that
 * ignoring it compounds — a stranded army should become a problem the player
 * has to solve, not a slow leak they can tolerate indefinitely.
 */
export function attritionFraction(ticksOutOfSupply: number): number {
  return Math.min(1, C.ATTRITION_PCT * (1 + ticksOutOfSupply * C.ATTRITION_ESCALATION));
}

// ============================================================================
// SECTION 9 — QUEUE TIME AND CHRONO SHARDS
// ============================================================================

/**
 * Time compression from spending Chrono Shards on a queue item.
 *
 * THE GOVERNING PRINCIPLE OF THE ENTIRE MONETIZATION MODEL (spec/04 §11): a
 * player may never compress elapsed time by more than their EARNED ceiling. A
 * whale with a vault of shards and rank-0 Construction compresses at 2.5x like
 * everybody else, and their surplus shards are simply unspendable that day.
 *
 * Returns the new completion timestamp and the shard-hours actually consumed,
 * which may be fewer than offered. Nothing here can ever move a completion
 * earlier than `now` plus the remaining time divided by the ceiling.
 */
export function applyShards(args: {
  now: bigint;
  startedAt: bigint;
  finishesAt: bigint;
  shardHoursOffered: number;
  constructionRank: number;
  era: number;
  alreadyCompressedMs: bigint;
}): { finishesAt: bigint; shardHoursSpent: number; compressedMs: bigint; ceilingReached: boolean } {
  const remaining = args.finishesAt - args.now;
  if (remaining <= 0n) {
    return { finishesAt: args.finishesAt, shardHoursSpent: 0, compressedMs: 0n, ceilingReached: false };
  }

  const totalDuration = args.finishesAt - args.startedAt;
  const ceiling = shardCeiling(args.constructionRank, args.era);
  // The ceiling is a compression RATIO over the whole item: at 2.5x, the item
  // may never take less than 1/2.5 of its natural duration in wall-clock time.
  const minimumDuration = BigInt(Math.ceil(Number(totalDuration) / ceiling));
  const maximumCompression = totalDuration - minimumDuration - args.alreadyCompressedMs;
  if (maximumCompression <= 0n) {
    return { finishesAt: args.finishesAt, shardHoursSpent: 0, compressedMs: 0n, ceilingReached: true };
  }

  const offeredMs = BigInt(Math.round(args.shardHoursOffered * 3_600_000));
  const applied = [offeredMs, maximumCompression, remaining].reduce((a, b) => (a < b ? a : b));
  const spentHours = Number(applied) / 3_600_000;

  return {
    finishesAt: args.finishesAt - applied,
    shardHoursSpent: spentHours,
    compressedMs: applied,
    ceilingReached: applied < offeredMs,
  };
}

/**
 * Temporal Debt tier after a spend. Six tiers of karma (spec/04 §11 guardrail 3).
 *
 * Raises tribulation difficulty and suppresses Qi regeneration. Decays one tier
 * per 30 days of abstention — so the cost of buying time is paid in the
 * cultivation game, which money cannot touch.
 */
export function temporalDebtAfterSpend(current: number, shardHoursSpent: number): number {
  const gained = Math.floor(shardHoursSpent / C.TEMPORAL_DEBT_HOURS_PER_TIER);
  return Math.min(C.TEMPORAL_DEBT_TIERS, current + gained);
}

export function temporalDebtAfterAbstention(current: number, msSinceLastSpend: bigint): number {
  const decayed = Number(msSinceLastSpend / BigInt(C.TEMPORAL_DEBT_DECAY_MS));
  return Math.max(0, current - decayed);
}

// ============================================================================
// SECTION 10 — CONQUEST
// ============================================================================

/**
 * Loyalty damage from a successful conquest-class attack.
 *
 * Statecraft on BOTH sides modifies it, so conquest is a contest of
 * administration as well as arms. At zero loyalty the settlement flips WITH LOW
 * LOYALTY, which invites counter-conquest — taking ground is deliberately
 * easier than holding it (spec/04 §9).
 */
export function loyaltyDamage(
  rng: () => number,
  attackerStatecraft: number,
  defenderStatecraft: number,
): number {
  const span = C.CONQUEST_LOYALTY_MAX - C.CONQUEST_LOYALTY_MIN;
  const base = C.CONQUEST_LOYALTY_MIN + rng() * span;
  const contest = clamp(1 + (attackerStatecraft - defenderStatecraft) * C.STATECRAFT_PER_POINT, 0.5, 1.5);
  return Math.round(base * contest);
}

/** Captured settlements keep their buildings at -3 grades (spec/04 §9). */
export function capturedBuildingLevel(level: number): number {
  const drop = C.CAPTURE_GRADE_PENALTY * C.LEVELS_PER_GRADE;
  return Math.max(0, level - drop);
}
