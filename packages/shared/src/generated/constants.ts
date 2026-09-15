/**
 * constants.ts — GENERATED. DO NOT EDIT.
 *
 * Produced by packages/tools/src/import-workbook.ts from
 * data/Ascendance_Master_Tables.xlsx (sha256 910ad42c80c5a25e0bd3fc2647d71b985f8d7175f2bf88b6a6ced0769d55b2f4).
 *
 * Regenerate with: pnpm run import
 *
 * Editing this file by hand desynchronises the code from the balance workbook,
 * which is the single source of truth for every number in the game
 * (spec/00_README_FIRST.md §2.5, spec/07_balance_constants.md §1).
 */


/** Where a constant came from, so a wrong number is traceable in one step. */
export type Provenance = 'workbook' | 'spec' | 'derived' | 'assumed';

export interface ConstantMeta {
  readonly value: number | readonly number[];
  readonly provenance: Provenance;
  /** The workbook cell, spec section, or rationale this value came from. */
  readonly ref: string;
  readonly note: string;
}

/** Every balance constant, keyed by name, with its provenance. */
export const CONSTANT_META: Readonly<Record<string, ConstantMeta>> = Object.freeze({
  MAX_GRADE: Object.freeze({ value: 42, provenance: 'derived', ref: "Grades_Realms row count", note: "The 42-grade spine." }),
  MAX_LEVEL: Object.freeze({ value: 1337, provenance: 'derived', ref: "Grades_Realms!max level of the last grade", note: "Levels run 0..1337 for buildings, research, cultivation and veterancy alike." }),
  LEVELS_PER_GRADE: Object.freeze({ value: 32, provenance: 'derived', ref: "Grades_Realms!grade 1 span", note: "Every 32 levels is a grade boundary. Grades gate content; levels make you better." }),
  BUILD_TIME_K: Object.freeze({ value: 0.000431977487539977, provenance: 'workbook', ref: "Building_Levels!R2C9", note: "Calibrated so the sum of build time over all 1,338 levels is exactly 500 years." }),
  BUILD_COST_EXP: Object.freeze({ value: 2.4, provenance: 'spec', ref: "spec/07 §2 · Building cost", note: "cost(L) = base * (L+1)^2.4 * 1.004^L" }),
  BUILD_COST_GEO: Object.freeze({ value: 1.004, provenance: 'spec', ref: "spec/07 §2 · Building cost", note: "The gentle exponential that makes the last levels prohibitive." }),
  BUILD_TIME_EXP: Object.freeze({ value: 1.9, provenance: 'spec', ref: "spec/07 §2 · Build/research time", note: "time(L) = K * (L+1)^1.9 * 1.003^L" }),
  BUILD_TIME_GEO: Object.freeze({ value: 1.003, provenance: 'spec', ref: "spec/07 §2 · Build/research time", note: "" }),
  OUTPUT_EXP: Object.freeze({ value: 1.12, provenance: 'spec', ref: "spec/07 §2 · Building output", note: "Polynomial while cost is exponential — the reason a rational stopping point exists." }),
  FULL_CLIMB_HOURS: Object.freeze({ value: 4383000.000000001, provenance: 'derived', ref: "spec/07 §3.1 anchor", note: "A full 0→1337 climb is exactly 500 years." }),
  QI_BASE: Object.freeze({ value: 100, provenance: 'spec', ref: "spec/07 §2 · Qi breakthrough", note: "cost(G) = 100 * G^3.2 * 1.15^G" }),
  QI_EXP: Object.freeze({ value: 3.2, provenance: 'spec', ref: "spec/07 §2 · Qi breakthrough", note: "" }),
  QI_GEO: Object.freeze({ value: 1.15, provenance: 'spec', ref: "spec/07 §2 · Qi breakthrough", note: "" }),
  TRAIN_CONST: Object.freeze({ value: 0.405833333333333, provenance: 'workbook', ref: "Archetypes!R2C12", note: "Hours of training per point of base upkeep." }),
  MAX_VET_TIER: Object.freeze({ value: 24, provenance: 'derived', ref: "Veterancy_Tiers row count", note: "Copper → Eternal." }),
  LEVELS_PER_TIER: Object.freeze({ value: 1337, provenance: 'derived', ref: "Veterancy_Tiers!cumulative levels at tier 1", note: "" }),
  VET_PER_LEVEL: Object.freeze({ value: 0.01, provenance: 'spec', ref: "spec/07 §2 · Veterancy stat bonus", note: "+1% per level. Tiers themselves grant nothing." }),
  TIERUP_BASE: Object.freeze({ value: 50000, provenance: 'workbook', ref: "Veterancy_Tiers!R4C2", note: "Resource cost to promote into tier 2." }),
  TIERUP_MULT: Object.freeze({ value: 2.75, provenance: 'workbook', ref: "Veterancy_Tiers!R4C4", note: "Deliberately NOT scaled by empire weight — this asymmetry is the Champion economy." }),
  XP_BASE: Object.freeze({ value: 100, provenance: 'workbook', ref: "Veterancy_XP!R5C2", note: "required = 100 * (L+1)^0.21 * 1.30^(T-1) * empireWeightMult" }),
  XP_LEVEL_EXP: Object.freeze({ value: 0.21, provenance: 'workbook', ref: "Veterancy_XP!R6C2", note: "The gentle requirement-side level slope." }),
  XP_TIER_MULT: Object.freeze({ value: 1.3, provenance: 'workbook', ref: "Veterancy_XP!R7C2", note: "The gentle requirement-side tier slope." }),
  FATIGUE_LEVEL_EXP: Object.freeze({ value: 0.21, provenance: 'workbook', ref: "Veterancy_XP!R6C5", note: "The earn-side half of the split curve." }),
  FATIGUE_TIER_DIV: Object.freeze({ value: 1.25, provenance: 'workbook', ref: "Veterancy_XP!R7C5", note: "" }),
  XP_STANDARD_BATTLE: Object.freeze({ value: 1000, provenance: 'workbook', ref: "Veterancy_XP!R5C5", note: "The reference \"standard battle\" used for pacing readouts only." }),
  EW_KNEE: Object.freeze({ value: 100, provenance: 'workbook', ref: "Empire_Weight_Multiplier!R8C2", note: "multiplier = MIN(cap, 1 + (W / 100)^2.41)" }),
  EW_STEEPNESS: Object.freeze({ value: 2.41, provenance: 'workbook', ref: "Empire_Weight_Multiplier!R8C4", note: "" }),
  EW_CAP: Object.freeze({ value: 9918521, provenance: 'workbook', ref: "Empire_Weight_Multiplier!R8C6", note: "The exact reciprocal of the 0.00001% earn-side floor it replaced." }),
  TIER_PER_ERA: Object.freeze({ value: 3.5, provenance: 'spec', ref: "spec/04 §5 · era gating", note: "max tier = ceil(3.5 * era). Keeps a theatre within a few tiers." }),
  REL_MIN: Object.freeze({ value: 0.05, provenance: 'spec', ref: "spec/03 §7 · relativeFactor clamp", note: "" }),
  REL_MAX: Object.freeze({ value: 4, provenance: 'spec', ref: "spec/03 §7 · relativeFactor clamp", note: "" }),
  REL_EXP: Object.freeze({ value: 0.5, provenance: 'spec', ref: "spec/03 §7 · relativeFactor", note: "The square root is deliberate; a linear ratio would discourage all normal warfare." }),
  REPETITION_LADDER: Object.freeze({ value: Object.freeze([1, 0.6, 0.35, 0.2, 0.1] as const), provenance: 'spec', ref: "spec/03 §7 · repetition", note: "Diminishing returns against the same defender inside 24h." }),
  LOSER_XP_RATE: Object.freeze({ value: 0.6, provenance: 'spec', ref: "spec/03 §7", note: "The losing side still earns ~60%. Fighting a losing war must never be progression death." }),
  BENEATH_NOTICE_RATIO: Object.freeze({ value: 0.02, provenance: 'spec', ref: "spec/03 §7 · hard zeroes", note: "Victim UPV below 2% of killer UPV earns zero, not less." }),
  NPC_TIER_CEILING: Object.freeze({ value: 4, provenance: 'spec', ref: "spec/03 §7 · hard zeroes", note: "Barbarians cannot carry a formation past Steel." }),
  ESCALATION_ERA_GAP: Object.freeze({ value: 2, provenance: 'spec', ref: "spec/03 §7 · hard zeroes", note: "Punching two or more eras down earns nothing." }),
  ABSORPTION_COEFF: Object.freeze({ value: 0.5, provenance: 'spec', ref: "spec/03 §7 · absorption XP", note: "Without this the Guardian identity path is a trap." }),
  JOINT_BONUS_CAP: Object.freeze({ value: 0.4, provenance: 'spec', ref: "spec/07 §3.4 anchor", note: "ONE +40% clamp over proficiency, equipment, commanders, cultivation and veterancy." }),
  MORALE_MIN: Object.freeze({ value: 0.5, provenance: 'spec', ref: "spec/07 §2 · Morale", note: "" }),
  MORALE_MAX: Object.freeze({ value: 1.5, provenance: 'spec', ref: "spec/07 §2 · Morale", note: "Smaller empires fight harder." }),
  MORALE_EXP: Object.freeze({ value: 0.25, provenance: 'assumed', ref: "GDD Appendix A does not pin the exponent; spec/07 §2 gives only the clamp", note: "Shapes how fast morale moves between the 0.5 and 1.5 clamps as relative empire size changes. 0.25 puts a 4x size disadvantage at ~1.41x morale, comfortably inside the clamp." }),
  FORT_PER_GRADE: Object.freeze({ value: 0.05, provenance: 'spec', ref: "spec/03 §5 · fortificationMult", note: "(1 + 0.05 * wallGrade)" }),
  COUNTER_MAX: Object.freeze({ value: 2.2, provenance: 'spec', ref: "spec/07 §3.5 anchor", note: "The strongest counter-matrix entry. Nothing may exceed it without review." }),
  SHARD_BASE: Object.freeze({ value: 2, provenance: 'workbook', ref: "Chrono_Shards!R21C2", note: "ceiling = 2.0 + 0.30*constructionRank + 0.50*era" }),
  SHARD_PER_RANK: Object.freeze({ value: 0.3, provenance: 'workbook', ref: "Chrono_Shards!R22C2", note: "" }),
  SHARD_PER_ERA: Object.freeze({ value: 0.5, provenance: 'workbook', ref: "Chrono_Shards!R23C2", note: "" }),
  SHARD_SIEGE_LOCKOUT_MS: Object.freeze({ value: 14400000, provenance: 'spec', ref: "spec/04 §11 · prohibited targets", note: "No shard application within 4h of a hostile impact." }),
  ENVY_PER_SCOPE: Object.freeze({ value: 0.1, provenance: 'spec', ref: "spec/04 §11 · Heaven’s Envy", note: "-10% defensive strength per marked scope, stacking to -30%." }),
  ENVY_MAX_SCOPES: Object.freeze({ value: 3, provenance: 'spec', ref: "spec/04 §11", note: "Universe, quadrant, alliance." }),
  ENVY_WINDOW_MS: Object.freeze({ value: 86400000, provenance: 'spec', ref: "spec/04 §11", note: "Rolling 24h measurement window." }),
  TEMPORAL_DEBT_TIERS: Object.freeze({ value: 6, provenance: 'spec', ref: "spec/04 §11 · guardrail 3", note: "Karma tiers raising tribulation difficulty and suppressing Qi regen." }),
  TEMPORAL_DEBT_DECAY_MS: Object.freeze({ value: 2592000000, provenance: 'spec', ref: "spec/04 §11 · guardrail 3", note: "One tier per 30 days of abstention." }),
  GOVERNOR_TIME_MULT: Object.freeze({ value: 2, provenance: 'spec', ref: "spec/04 §6 · the 2x rule", note: "Anything a governor initiates takes twice as long. That field is the whole mechanic." }),
  PLAYER_TIME_MULT: Object.freeze({ value: 1, provenance: 'spec', ref: "spec/04 §6", note: "" }),
  CANCEL_REFUND_PCT: Object.freeze({ value: 0.8, provenance: 'spec', ref: "spec/05 §2 · DELETE /v1/queue/:itemId", note: "Cancelling refunds 80% of resources." }),
  SPEC_CAP_G30: Object.freeze({ value: 3, provenance: 'spec', ref: "spec/04 §1 · specialization caps", note: "At most 3 buildings above grade 30. A hard constraint: reject the enqueue." }),
  SPEC_CAP_G20: Object.freeze({ value: 8, provenance: 'spec', ref: "spec/04 §1 · specialization caps", note: "At most 8 buildings above grade 20." }),
  SPEC_CAP_G30_GRADE: Object.freeze({ value: 30, provenance: 'spec', ref: "spec/04 §1", note: "" }),
  SPEC_CAP_G20_GRADE: Object.freeze({ value: 20, provenance: 'spec', ref: "spec/04 §1", note: "" }),
  BROWNOUT_OUTPUT_MULT: Object.freeze({ value: 0.5, provenance: 'spec', ref: "spec/04 §1 · upkeep", note: "Insolvency halves output." }),
  BROWNOUT_GRACE_MS: Object.freeze({ value: 259200000, provenance: 'spec', ref: "spec/04 §1 · upkeep", note: "After 72h of Brownout a building sheds a level per day." }),
  HERITAGE_CULTURE_PCT: Object.freeze({ value: 0.02, provenance: 'spec', ref: "spec/04 §1 · Heritage", note: "Earlier-era buildings gain Culture equal to 2% of level. Nothing ever becomes obsolete." }),
  LOYALTY_REGEN_PER_HOUR: Object.freeze({ value: 1, provenance: 'spec', ref: "spec/04 §9", note: "" }),
  CAPTURE_GRADE_PENALTY: Object.freeze({ value: 3, provenance: 'spec', ref: "spec/04 §9", note: "Captured settlements keep buildings at -3 grades." }),
  CONQUEST_LOYALTY_MIN: Object.freeze({ value: 20, provenance: 'spec', ref: "spec/04 §9", note: "Conquest-class units reduce loyalty 20-35 per successful attack." }),
  CONQUEST_LOYALTY_MAX: Object.freeze({ value: 35, provenance: 'spec', ref: "spec/04 §9", note: "" }),
  PLOTS_PER_HQ_GRADE: Object.freeze({ value: 2, provenance: 'workbook', ref: "Category_Chassis!HQ/Governance \"Scales with level by: +2 plots, +1 queue per 4 grades\"", note: "Plots: 24 at founding, +2 per HQ grade, capped by the holding type." }),
  QUEUE_SLOT_PER_GRADES: Object.freeze({ value: 4, provenance: 'workbook', ref: "Category_Chassis!HQ/Governance \"+1 queue per 4 grades\"", note: "Personal queue slots from the HQ. Their scarcity is the only brake on Seize (spec/04 §6)." }),
  CULTURE_PRESSURE_K: Object.freeze({ value: 0.0004, provenance: 'assumed', ref: "GDD §8.4 gives the shape ((cultureDelta)^2 * k, capped) but not k", note: "Calibrated so a 100-point culture lead flips an adjacent plot over roughly three weeks, matching spec/04 §3 (\"flip adjacent low-culture plots over weeks\")." }),
  CULTURE_PRESSURE_CAP: Object.freeze({ value: 12, provenance: 'assumed', ref: "GDD §8.4 states the cap exists but not its value", note: "Caps a runaway culture lead at roughly one plot flip per day." }),
  ATTRITION_ESCALATION: Object.freeze({ value: 0.5, provenance: 'assumed', ref: "spec/03 §4 says attrition escalates but does not give the rate", note: "Each further hour out of supply adds 50% of the base 3% rate, so a stranded army becomes a problem to solve rather than a leak to tolerate." }),
  TEMPORAL_DEBT_HOURS_PER_TIER: Object.freeze({ value: 168, provenance: 'assumed', ref: "spec/04 §11 guardrail 3 defines six karma tiers but not the spend per tier", note: "One week of compressed time per karma tier, so reaching the top tier takes sustained buying." }),
  STATECRAFT_PER_POINT: Object.freeze({ value: 0.02, provenance: 'assumed', ref: "spec/04 §9 says loyalty damage is \"modified by Statecraft on both sides\" without a rate", note: "Each net point of Statecraft advantage moves loyalty damage by 2%, clamped to +/-50%." }),
  ZOC_SPEED_MULT: Object.freeze({ value: 0.6, provenance: 'spec', ref: "spec/03 §4 · zone of control", note: "0.6x speed inside a hostile fortification radius." }),
  ATTRITION_PCT: Object.freeze({ value: 0.03, provenance: 'spec', ref: "spec/03 §4 · supply", note: "3% of strength per tick beyond supply range, escalating." }),
  ATTRITION_INTERVAL_MS: Object.freeze({ value: 3600000, provenance: 'spec', ref: "spec/03 §4", note: "One attrition tick per hour out of supply." }),
  EQUIP_TIER_MULT: Object.freeze({ value: 0.12, provenance: 'spec', ref: "Equipment_Catalog!\"Tier mult = 1 + 0.12x(tier-1)\"", note: "" }),
});

/**
 * The balance constants themselves.
 *
 * Import this — never a literal — anywhere a game number is needed.
 * A magic number in game logic is a defect (spec/00 §2.5).
 */
export const C = Object.freeze({
  /** The 42-grade spine. — Grades_Realms row count */
  MAX_GRADE: 42,
  /** Levels run 0..1337 for buildings, research, cultivation and veterancy alike. — Grades_Realms!max level of the last grade */
  MAX_LEVEL: 1337,
  /** Every 32 levels is a grade boundary. Grades gate content; levels make you better. — Grades_Realms!grade 1 span */
  LEVELS_PER_GRADE: 32,
  /** Calibrated so the sum of build time over all 1,338 levels is exactly 500 years. — Building_Levels!R2C9 */
  BUILD_TIME_K: 0.000431977487539977,
  /** cost(L) = base * (L+1)^2.4 * 1.004^L — spec/07 §2 · Building cost */
  BUILD_COST_EXP: 2.4,
  /** The gentle exponential that makes the last levels prohibitive. — spec/07 §2 · Building cost */
  BUILD_COST_GEO: 1.004,
  /** time(L) = K * (L+1)^1.9 * 1.003^L — spec/07 §2 · Build/research time */
  BUILD_TIME_EXP: 1.9,
  /** spec/07 §2 · Build/research time */
  BUILD_TIME_GEO: 1.003,
  /** Polynomial while cost is exponential — the reason a rational stopping point exists. — spec/07 §2 · Building output */
  OUTPUT_EXP: 1.12,
  /** A full 0→1337 climb is exactly 500 years. — spec/07 §3.1 anchor */
  FULL_CLIMB_HOURS: 4383000.000000001,
  /** cost(G) = 100 * G^3.2 * 1.15^G — spec/07 §2 · Qi breakthrough */
  QI_BASE: 100,
  /** spec/07 §2 · Qi breakthrough */
  QI_EXP: 3.2,
  /** spec/07 §2 · Qi breakthrough */
  QI_GEO: 1.15,
  /** Hours of training per point of base upkeep. — Archetypes!R2C12 */
  TRAIN_CONST: 0.405833333333333,
  /** Copper → Eternal. — Veterancy_Tiers row count */
  MAX_VET_TIER: 24,
  /** Veterancy_Tiers!cumulative levels at tier 1 */
  LEVELS_PER_TIER: 1337,
  /** +1% per level. Tiers themselves grant nothing. — spec/07 §2 · Veterancy stat bonus */
  VET_PER_LEVEL: 0.01,
  /** Resource cost to promote into tier 2. — Veterancy_Tiers!R4C2 */
  TIERUP_BASE: 50000,
  /** Deliberately NOT scaled by empire weight — this asymmetry is the Champion economy. — Veterancy_Tiers!R4C4 */
  TIERUP_MULT: 2.75,
  /** required = 100 * (L+1)^0.21 * 1.30^(T-1) * empireWeightMult — Veterancy_XP!R5C2 */
  XP_BASE: 100,
  /** The gentle requirement-side level slope. — Veterancy_XP!R6C2 */
  XP_LEVEL_EXP: 0.21,
  /** The gentle requirement-side tier slope. — Veterancy_XP!R7C2 */
  XP_TIER_MULT: 1.3,
  /** The earn-side half of the split curve. — Veterancy_XP!R6C5 */
  FATIGUE_LEVEL_EXP: 0.21,
  /** Veterancy_XP!R7C5 */
  FATIGUE_TIER_DIV: 1.25,
  /** The reference "standard battle" used for pacing readouts only. — Veterancy_XP!R5C5 */
  XP_STANDARD_BATTLE: 1000,
  /** multiplier = MIN(cap, 1 + (W / 100)^2.41) — Empire_Weight_Multiplier!R8C2 */
  EW_KNEE: 100,
  /** Empire_Weight_Multiplier!R8C4 */
  EW_STEEPNESS: 2.41,
  /** The exact reciprocal of the 0.00001% earn-side floor it replaced. — Empire_Weight_Multiplier!R8C6 */
  EW_CAP: 9918521,
  /** max tier = ceil(3.5 * era). Keeps a theatre within a few tiers. — spec/04 §5 · era gating */
  TIER_PER_ERA: 3.5,
  /** spec/03 §7 · relativeFactor clamp */
  REL_MIN: 0.05,
  /** spec/03 §7 · relativeFactor clamp */
  REL_MAX: 4,
  /** The square root is deliberate; a linear ratio would discourage all normal warfare. — spec/03 §7 · relativeFactor */
  REL_EXP: 0.5,
  /** Diminishing returns against the same defender inside 24h. — spec/03 §7 · repetition */
  REPETITION_LADDER: Object.freeze([1, 0.6, 0.35, 0.2, 0.1] as const),
  /** The losing side still earns ~60%. Fighting a losing war must never be progression death. — spec/03 §7 */
  LOSER_XP_RATE: 0.6,
  /** Victim UPV below 2% of killer UPV earns zero, not less. — spec/03 §7 · hard zeroes */
  BENEATH_NOTICE_RATIO: 0.02,
  /** Barbarians cannot carry a formation past Steel. — spec/03 §7 · hard zeroes */
  NPC_TIER_CEILING: 4,
  /** Punching two or more eras down earns nothing. — spec/03 §7 · hard zeroes */
  ESCALATION_ERA_GAP: 2,
  /** Without this the Guardian identity path is a trap. — spec/03 §7 · absorption XP */
  ABSORPTION_COEFF: 0.5,
  /** ONE +40% clamp over proficiency, equipment, commanders, cultivation and veterancy. — spec/07 §3.4 anchor */
  JOINT_BONUS_CAP: 0.4,
  /** spec/07 §2 · Morale */
  MORALE_MIN: 0.5,
  /** Smaller empires fight harder. — spec/07 §2 · Morale */
  MORALE_MAX: 1.5,
  /** Shapes how fast morale moves between the 0.5 and 1.5 clamps as relative empire size changes. 0.25 puts a 4x size disadvantage at ~1.41x morale, comfortably inside the clamp. — [ASSUMED] GDD Appendix A does not pin the exponent; spec/07 §2 gives only the clamp */
  MORALE_EXP: 0.25,
  /** (1 + 0.05 * wallGrade) — spec/03 §5 · fortificationMult */
  FORT_PER_GRADE: 0.05,
  /** The strongest counter-matrix entry. Nothing may exceed it without review. — spec/07 §3.5 anchor */
  COUNTER_MAX: 2.2,
  /** ceiling = 2.0 + 0.30*constructionRank + 0.50*era — Chrono_Shards!R21C2 */
  SHARD_BASE: 2,
  /** Chrono_Shards!R22C2 */
  SHARD_PER_RANK: 0.3,
  /** Chrono_Shards!R23C2 */
  SHARD_PER_ERA: 0.5,
  /** No shard application within 4h of a hostile impact. — spec/04 §11 · prohibited targets */
  SHARD_SIEGE_LOCKOUT_MS: 14400000,
  /** -10% defensive strength per marked scope, stacking to -30%. — spec/04 §11 · Heaven’s Envy */
  ENVY_PER_SCOPE: 0.1,
  /** Universe, quadrant, alliance. — spec/04 §11 */
  ENVY_MAX_SCOPES: 3,
  /** Rolling 24h measurement window. — spec/04 §11 */
  ENVY_WINDOW_MS: 86400000,
  /** Karma tiers raising tribulation difficulty and suppressing Qi regen. — spec/04 §11 · guardrail 3 */
  TEMPORAL_DEBT_TIERS: 6,
  /** One tier per 30 days of abstention. — spec/04 §11 · guardrail 3 */
  TEMPORAL_DEBT_DECAY_MS: 2592000000,
  /** Anything a governor initiates takes twice as long. That field is the whole mechanic. — spec/04 §6 · the 2x rule */
  GOVERNOR_TIME_MULT: 2,
  /** spec/04 §6 */
  PLAYER_TIME_MULT: 1,
  /** Cancelling refunds 80% of resources. — spec/05 §2 · DELETE /v1/queue/:itemId */
  CANCEL_REFUND_PCT: 0.8,
  /** At most 3 buildings above grade 30. A hard constraint: reject the enqueue. — spec/04 §1 · specialization caps */
  SPEC_CAP_G30: 3,
  /** At most 8 buildings above grade 20. — spec/04 §1 · specialization caps */
  SPEC_CAP_G20: 8,
  /** spec/04 §1 */
  SPEC_CAP_G30_GRADE: 30,
  /** spec/04 §1 */
  SPEC_CAP_G20_GRADE: 20,
  /** Insolvency halves output. — spec/04 §1 · upkeep */
  BROWNOUT_OUTPUT_MULT: 0.5,
  /** After 72h of Brownout a building sheds a level per day. — spec/04 §1 · upkeep */
  BROWNOUT_GRACE_MS: 259200000,
  /** Earlier-era buildings gain Culture equal to 2% of level. Nothing ever becomes obsolete. — spec/04 §1 · Heritage */
  HERITAGE_CULTURE_PCT: 0.02,
  /** spec/04 §9 */
  LOYALTY_REGEN_PER_HOUR: 1,
  /** Captured settlements keep buildings at -3 grades. — spec/04 §9 */
  CAPTURE_GRADE_PENALTY: 3,
  /** Conquest-class units reduce loyalty 20-35 per successful attack. — spec/04 §9 */
  CONQUEST_LOYALTY_MIN: 20,
  /** spec/04 §9 */
  CONQUEST_LOYALTY_MAX: 35,
  /** Plots: 24 at founding, +2 per HQ grade, capped by the holding type. — Category_Chassis!HQ/Governance "Scales with level by: +2 plots, +1 queue per 4 grades" */
  PLOTS_PER_HQ_GRADE: 2,
  /** Personal queue slots from the HQ. Their scarcity is the only brake on Seize (spec/04 §6). — Category_Chassis!HQ/Governance "+1 queue per 4 grades" */
  QUEUE_SLOT_PER_GRADES: 4,
  /** Calibrated so a 100-point culture lead flips an adjacent plot over roughly three weeks, matching spec/04 §3 ("flip adjacent low-culture plots over weeks"). — [ASSUMED] GDD §8.4 gives the shape ((cultureDelta)^2 * k, capped) but not k */
  CULTURE_PRESSURE_K: 0.0004,
  /** Caps a runaway culture lead at roughly one plot flip per day. — [ASSUMED] GDD §8.4 states the cap exists but not its value */
  CULTURE_PRESSURE_CAP: 12,
  /** Each further hour out of supply adds 50% of the base 3% rate, so a stranded army becomes a problem to solve rather than a leak to tolerate. — [ASSUMED] spec/03 §4 says attrition escalates but does not give the rate */
  ATTRITION_ESCALATION: 0.5,
  /** One week of compressed time per karma tier, so reaching the top tier takes sustained buying. — [ASSUMED] spec/04 §11 guardrail 3 defines six karma tiers but not the spend per tier */
  TEMPORAL_DEBT_HOURS_PER_TIER: 168,
  /** Each net point of Statecraft advantage moves loyalty damage by 2%, clamped to +/-50%. — [ASSUMED] spec/04 §9 says loyalty damage is "modified by Statecraft on both sides" without a rate */
  STATECRAFT_PER_POINT: 0.02,
  /** 0.6x speed inside a hostile fortification radius. — spec/03 §4 · zone of control */
  ZOC_SPEED_MULT: 0.6,
  /** 3% of strength per tick beyond supply range, escalating. — spec/03 §4 · supply */
  ATTRITION_PCT: 0.03,
  /** One attrition tick per hour out of supply. — spec/03 §4 */
  ATTRITION_INTERVAL_MS: 3600000,
  /** Equipment_Catalog!"Tier mult = 1 + 0.12x(tier-1)" */
  EQUIP_TIER_MULT: 0.12,
} as const);

export type Constants = typeof C;

/**
 * Content hash of Ascendance_Master_Tables.xlsx at import time.
 * A running server reports this so it is always clear which balance
 * revision produced a given result (spec/07 §1).
 */
export const BALANCE_REVISION = "910ad42c80c5a25e0bd3fc2647d71b985f8d7175f2bf88b6a6ced0769d55b2f4" as const;

/** Constants the balance owner still has to confirm (spec/00 §5). */
export const ASSUMED_CONSTANTS: readonly string[] = Object.freeze(["MORALE_EXP", "CULTURE_PRESSURE_K", "CULTURE_PRESSURE_CAP", "ATTRITION_ESCALATION", "TEMPORAL_DEBT_HOURS_PER_TIER", "STATECRAFT_PER_POINT"]);
