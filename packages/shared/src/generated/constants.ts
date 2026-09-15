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
  RANGED_PHASE_WEIGHT: Object.freeze({ value: 0.35, provenance: 'assumed', ref: "spec/03 §5 orders the phases but does not weight the ranged exchange against the main engagement", note: "The pre-contact exchange lands 35% of a full engagement, so bringing artillery matters without letting a siege train win unaccompanied." }),
  WALL_GRADES_PER_SIEGE_SHARE: Object.freeze({ value: 6, provenance: 'assumed', ref: "spec/03 §5 says fortification damage is applied in the ranged phase without a rate", note: "A force that is entirely siege engines strips about six wall grades per assault, so walls are worn down over a campaign rather than in one battle." }),
  AMBUSH_MAX_CHANCE: Object.freeze({ value: 0.35, provenance: 'assumed', ref: "spec/03 §5 phase 1 names intel, concealment and ambush chance without probabilities", note: "Ceiling on the defender’s ambush chance. Capped so that scouting can always reduce the risk meaningfully and no terrain makes an attack a coin flip." }),
  AMBUSH_PER_CONCEALMENT: Object.freeze({ value: 0.5, provenance: 'assumed', ref: "spec/03 §5 phase 1 names terrain concealment as an ambush input without a rate", note: "How much terrain concealment contributes to ambush chance. Fully concealed ground reaches the cap on its own, which is what makes terrain worth fighting for." }),
  AMBUSH_PER_SCOUTING: Object.freeze({ value: 0.4, provenance: 'assumed', ref: "spec/03 §5 phase 1 names scouting quality as an ambush input without a rate", note: "How much attacker scouting suppresses ambush chance. Set below the concealment rate so scouting is the payoff for preparation without ever making terrain irrelevant." }),
  AMBUSH_PENALTY: Object.freeze({ value: 0.25, provenance: 'assumed', ref: "spec/03 §5 phase 1 states that ambush happens, not what it costs", note: "An ambushed attacker fights at 75%. Large enough that failing to scout is a real mistake, small enough that it does not by itself decide a well-prepared assault." }),
  AMBUSH_BONUS: Object.freeze({ value: 0.15, provenance: 'assumed', ref: "spec/03 §5 phase 1 states that ambush happens, not what it grants", note: "An ambushing defender fights at 115%. Deliberately smaller than the attacker’s penalty, so ambush is a disruption of the attack rather than a defensive multiplier to farm." }),
  PURSUIT_PER_LOG_RATIO: Object.freeze({ value: 0.25, provenance: 'assumed', ref: "spec/03 §5 phase 4 calls for casualty amplification on the losing side without a rate", note: "Scales pursuit losses by the log of the power ratio, so a narrow win is not a massacre and a rout is." }),
  PURSUIT_MAX: Object.freeze({ value: 0.6, provenance: 'assumed', ref: "spec/03 §5 phase 4 requires casualty amplification on the losing side without a ceiling", note: "Ceiling on pursuit losses. No single battle annihilates a force outright, so a beaten player always has a core to withdraw and rebuild around." }),
  SCREEN_EXPOSURE: Object.freeze({ value: 1.6, provenance: 'assumed', ref: "spec/03 §7 requires screens to absorb disproportionately but gives no exposure figure", note: "Screens take 60% more than their contribution share. This is what they are for, and it is what absorption XP pays them for." }),
  MUNITIONS_PER_DAMAGE: Object.freeze({ value: 0.001, provenance: 'assumed', ref: "spec/03 §5 phase 6 requires Era IV+ munitions drain without a rate", note: "Munitions consumed per point of damage delivered, so industrial depth decides long wars." }),
  SHARD_BASE: Object.freeze({ value: 2, provenance: 'workbook', ref: "Chrono_Shards!R21C2", note: "ceiling = 2.0 + 0.30*constructionRank + 0.50*era" }),
  SHARD_PER_RANK: Object.freeze({ value: 0.3, provenance: 'workbook', ref: "Chrono_Shards!R22C2", note: "" }),
  SHARD_PER_ERA: Object.freeze({ value: 0.5, provenance: 'workbook', ref: "Chrono_Shards!R23C2", note: "" }),
  SHARD_SIEGE_LOCKOUT_MS: Object.freeze({ value: 14400000, provenance: 'spec', ref: "spec/04 §11 · prohibited targets", note: "No shard application within 4h of a hostile impact." }),
  ENVY_PER_SCOPE: Object.freeze({ value: 0.1, provenance: 'spec', ref: "spec/04 §11 · Heaven’s Envy", note: "-10% defensive strength per marked scope, stacking to -30%." }),
  ENVY_MAX_SCOPES: Object.freeze({ value: 3, provenance: 'spec', ref: "spec/04 §11", note: "Universe, quadrant, alliance." }),
  ENVY_WINDOW_MS: Object.freeze({ value: 86400000, provenance: 'spec', ref: "spec/04 §11", note: "Rolling 24h measurement window." }),
  TEMPORAL_DEBT_TIERS: Object.freeze({ value: 6, provenance: 'spec', ref: "spec/04 §11 · guardrail 3", note: "Karma tiers raising tribulation difficulty and suppressing Qi regen." }),
  TEMPORAL_DEBT_DECAY_MS: Object.freeze({ value: 2592000000, provenance: 'spec', ref: "spec/04 §11 · guardrail 3", note: "One tier per 30 days of abstention." }),
  GARRISON_HP_PER_WALL_GRADE: Object.freeze({ value: 500, provenance: 'assumed', ref: "spec/03 §5 adds flat garrison HP to the defence pool without a figure", note: "Flat hit points a wall grade contributes, so a fortified settlement is never a free kill even with no garrison present." }),
  CARRY_PER_UNIT: Object.freeze({ value: 50, provenance: 'assumed', ref: "convoy capacity by era is described in spec/04 §2 without per-unit figures", note: "Resources one unit can carry home. Bounds plunder, which is what stops a raid being a wipeout." }),
  HIDDEN_CELLAR: Object.freeze({ value: 2000, provenance: 'assumed', ref: "spec/03 §5 names hidden-cellar protection without a figure", note: "Resources that can never be looted, so a beaten player always has something to rebuild on." }),
  CAPTURED_LOYALTY: Object.freeze({ value: 15, provenance: 'assumed', ref: "spec/04 §9 says a settlement flips \"with low loyalty\" without a number", note: "Loyalty a freshly captured settlement starts at. Low enough to invite counter-conquest, which is the point: taking ground is meant to be easier than holding it." }),
  STARTING_MUNITIONS: Object.freeze({ value: 1000000, provenance: 'assumed', ref: "spec/03 §5 phase 6 requires a munitions pool without a starting size", note: "Munitions a force carries into an engagement before resupply." }),
  ENVY_MIN_SPEND_FLOOR: Object.freeze({ value: 24, provenance: 'assumed', ref: "spec/04 §11 sets the floor at \"the median player’s 30-day earned shard income\", which is a live telemetry value", note: "Minimum purchased shard-hours to appear on a Heaven’s Envy leaderboard, so a quiet scope returns fewer than ten names rather than marking a trivial spender. Replace with the live median at launch." }),
  RESEARCH_ERA_PREREQ_GRADE: Object.freeze({ value: 12, provenance: 'workbook', ref: "Research_Disciplines!Prerequisite \"All Era N-1 disciplines at Grade 12+\"", note: "An era’s disciplines require every previous-era discipline at this grade." }),
  RESEARCH_COST_PER_LEVEL: Object.freeze({ value: 120, provenance: 'assumed', ref: "Research_Disciplines gives levels, grades and effects but no per-level resource cost", note: "Base resource cost of a research level, riding the same (L+1)^2.4 curve as buildings so the two progressions stay comparable. Research is player-level and global, but it is PAID from the settlement that hosts it, which keeps isolation intact." }),
  TRAIN_COST_PER_UPKEEP: Object.freeze({ value: 35, provenance: 'assumed', ref: "Units_Master carries upkeep and training time but no resource cost per unit", note: "Resource cost to train one unit, per point of its upkeep. Upkeep already encodes era, archetype and grade, so cost stays correct automatically as the roster is rebalanced — the same reasoning that makes upkeep the base of Unit Power Value." }),
  MILITARY_QUEUE_SLOTS: Object.freeze({ value: 2, provenance: 'assumed', ref: "Category_Chassis!Military says military buildings grant unit queue slots without a number", note: "Training slots a settlement gets from its military buildings, separate from build slots so a settlement is not forced to choose between growing and defending itself." }),
  TRAIN_BATCH_MAX: Object.freeze({ value: 5000, provenance: 'assumed', ref: "no published batch limit on a training order", note: "Largest single training order, so one command cannot queue a year of production and make the attention dashboard useless." }),
  TRAIN_SPEED_PER_GRADE: Object.freeze({ value: 0.03, provenance: 'assumed', ref: "Category_Chassis!Military says military buildings reduce train time, capped at -40%, without a rate", note: "Training time saved per grade of the best military building, so raising a Barracks is worth doing without letting one settlement out-produce a continent." }),
  TRAIN_SPEED_CAP: Object.freeze({ value: 0.4, provenance: 'workbook', ref: "Category_Chassis!Military \"-train time (capped -40%)\"", note: "Ceiling on training-time reduction from facilities." }),
  TRIBULATION_WINDOW_MS: Object.freeze({ value: 14400000, provenance: 'assumed', ref: "Cultivation!Breakthroughs calls tribulations \"live events\" without a duration", note: "How long a tribulation stands open between being declared and resolving. Long enough that a rival who sees a visible one has time to travel and interfere, which is the whole point of making them public." }),
  TRIBULATION_BASE_SUCCESS: Object.freeze({ value: 0.85, provenance: 'assumed', ref: "Grades_Realms describes each trial but gives no pass rate", note: "Base chance of passing a tribulation before karma and interference. High, because the Qi cost is already the real gate and losing a breakthrough to a coin flip would be miserable." }),
  TRIBULATION_PER_DEBT_TIER: Object.freeze({ value: 0.06, provenance: 'assumed', ref: "spec/04 §11 guardrail 3 says Temporal Debt raises tribulation difficulty without a rate", note: "Pass chance lost per tier of Temporal Debt. This is where buying time is actually paid for: the cultivation game is the one thing money cannot accelerate." }),
  TRIBULATION_PER_REPUTATION: Object.freeze({ value: 0.0015, provenance: 'assumed', ref: "Cultivation!Karma says karmic weight modifies tribulation difficulty without a rate", note: "Pass chance gained per point of reputation on a karma-weighted trial, and lost per point of infamy. Betrayal stays allowed and stays priced." }),
  TRIBULATION_CRASH_PENALTY: Object.freeze({ value: 0.12, provenance: 'assumed', ref: "Grades_Realms marks a trial \"crashable\" without saying what crashing it does", note: "Pass chance lost per rival who interferes with a visible tribulation. Enough that crashing one is worth the trip, not so much that one rival decides it." }),
  TRIBULATION_FAILURE_QI_KEPT: Object.freeze({ value: 0.4, provenance: 'assumed', ref: "Grades_Realms does not say what a failed breakthrough costs beyond the stun it names", note: "Fraction of the spent Qi returned on failure. A failed breakthrough hurts without erasing months of accumulation." }),
  QI_PER_CULTIVATION_BUILDING: Object.freeze({ value: 4, provenance: 'assumed', ref: "Cultivation!Qi names the sources (Spirit Groves, Qi Gathering Stones, Spirit Wells) without rates", note: "Qi per hour per level-scaled cultivation building, summed across every holding — cultivation is player-level progression, so its income is too." }),
  QI_PER_SPIRIT_VEIN: Object.freeze({ value: 12, provenance: 'assumed', ref: "Cultivation!Qi names Spirit Vein tiles as a source without a rate", note: "Qi per hour per Spirit Vein tile, which is what makes those tiles worth fighting over." }),
  QI_IDLE_PER_HOUR: Object.freeze({ value: 2, provenance: 'assumed', ref: "Cultivation!Qi lists idle meditation as a source without a rate", note: "Qi per hour from meditation alone, so a player with no cultivation buildings still advances, slowly, and the realm ladder is never completely shut to them." }),
  CULTIVATION_AURA_PER_GRADE: Object.freeze({ value: 0.004, provenance: 'assumed', ref: "Cultivation!Balance caps says realm bonuses fold into the joint cap without giving a per-grade rate", note: "Combat multiplier per cultivation grade, inside the +40% joint cap. Deliberately small: Cultivation!Balance caps is explicit that realms primarily gate content rather than grant power." }),
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
  HQ_FACTOR_PER_GRADE: Object.freeze({ value: 0.05, provenance: 'assumed', ref: "Category_Chassis!HQ/Governance describes HQ acceleration without a rate", note: "Each HQ grade compresses build time in its settlement by 5%, capped, so the HQ is worth raising without making one megacity strictly dominant." }),
  HQ_FACTOR_CAP: Object.freeze({ value: 1, provenance: 'assumed', ref: "no published cap on HQ acceleration", note: "Doubling at most. An uncapped factor would delete the specialization pressure plots exist to create." }),
  GOVERNOR_QUEUE_SLOTS: Object.freeze({ value: 1, provenance: 'workbook', ref: "Governors!\"Runs in the governor’s own parallel queue\"", note: "Governor slots are separate from and parallel to the personal slots from the HQ." }),
  ADJACENCY_SYNERGY: Object.freeze({ value: 0.15, provenance: 'assumed', ref: "Specs_EraI gives per-building adjacency percentages in prose (e.g. Sawmill +15% next to Lumber Camp) but no column", note: "Default synergy bonus for an adjacent building named in a synergy chain, taken from the most common published value." }),
  ADJACENCY_SAME_CATEGORY: Object.freeze({ value: 0.03, provenance: 'assumed', ref: "Building_Framework describes adjacency without a same-category rate", note: "A small bonus for clustering like with like, so district planning is rewarded but not dominant." }),
  ADJACENCY_CAP: Object.freeze({ value: 0.5, provenance: 'assumed', ref: "no published adjacency cap", note: "Caps a perfectly planned district at +50% so layout is a meaningful edge, not a substitute for levels." }),
  BASE_STORAGE: Object.freeze({ value: 10000, provenance: 'assumed', ref: "per-building storage values are an open content task (spec §10)", note: "Starting stockpile capacity before any Logistics building, sized so a new village overflows within about a day of neglect and the attention dashboard has something to say." }),
  STORAGE_PER_LOGISTICS: Object.freeze({ value: 5000, provenance: 'assumed', ref: "per-building storage values are an open content task (spec §10)", note: "Capacity added per Logistics building, scaled by the standard output curve." }),
  WORKERS_PER_LEVEL: Object.freeze({ value: 0.5, provenance: 'assumed', ref: "Building_Framework says buildings draw Workers from population without a rate", note: "Half a worker per level per plot, so understaffing is the normal state of a growing settlement." }),
  UPKEEP_COIN_PER_LEVEL: Object.freeze({ value: 0.05, provenance: 'assumed', ref: "spec/04 §1 states Era II+ Coin upkeep without a rate", note: "Coin per level per plot from Era II. Sized so a settlement of ordinary buildings pays its own way and an over-built one does not, which is what makes Brownout a real pressure." }),
  UPKEEP_POWER_PER_LEVEL: Object.freeze({ value: 0.02, provenance: 'assumed', ref: "spec/04 §1 states Era IV+ Electricity draw without a rate", note: "Electricity per level per plot from Era IV. Lower than the Coin rate because power is a second, narrower constraint layered on top rather than a replacement for it." }),
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
  /** The pre-contact exchange lands 35% of a full engagement, so bringing artillery matters without letting a siege train win unaccompanied. — [ASSUMED] spec/03 §5 orders the phases but does not weight the ranged exchange against the main engagement */
  RANGED_PHASE_WEIGHT: 0.35,
  /** A force that is entirely siege engines strips about six wall grades per assault, so walls are worn down over a campaign rather than in one battle. — [ASSUMED] spec/03 §5 says fortification damage is applied in the ranged phase without a rate */
  WALL_GRADES_PER_SIEGE_SHARE: 6,
  /** Ceiling on the defender’s ambush chance. Capped so that scouting can always reduce the risk meaningfully and no terrain makes an attack a coin flip. — [ASSUMED] spec/03 §5 phase 1 names intel, concealment and ambush chance without probabilities */
  AMBUSH_MAX_CHANCE: 0.35,
  /** How much terrain concealment contributes to ambush chance. Fully concealed ground reaches the cap on its own, which is what makes terrain worth fighting for. — [ASSUMED] spec/03 §5 phase 1 names terrain concealment as an ambush input without a rate */
  AMBUSH_PER_CONCEALMENT: 0.5,
  /** How much attacker scouting suppresses ambush chance. Set below the concealment rate so scouting is the payoff for preparation without ever making terrain irrelevant. — [ASSUMED] spec/03 §5 phase 1 names scouting quality as an ambush input without a rate */
  AMBUSH_PER_SCOUTING: 0.4,
  /** An ambushed attacker fights at 75%. Large enough that failing to scout is a real mistake, small enough that it does not by itself decide a well-prepared assault. — [ASSUMED] spec/03 §5 phase 1 states that ambush happens, not what it costs */
  AMBUSH_PENALTY: 0.25,
  /** An ambushing defender fights at 115%. Deliberately smaller than the attacker’s penalty, so ambush is a disruption of the attack rather than a defensive multiplier to farm. — [ASSUMED] spec/03 §5 phase 1 states that ambush happens, not what it grants */
  AMBUSH_BONUS: 0.15,
  /** Scales pursuit losses by the log of the power ratio, so a narrow win is not a massacre and a rout is. — [ASSUMED] spec/03 §5 phase 4 calls for casualty amplification on the losing side without a rate */
  PURSUIT_PER_LOG_RATIO: 0.25,
  /** Ceiling on pursuit losses. No single battle annihilates a force outright, so a beaten player always has a core to withdraw and rebuild around. — [ASSUMED] spec/03 §5 phase 4 requires casualty amplification on the losing side without a ceiling */
  PURSUIT_MAX: 0.6,
  /** Screens take 60% more than their contribution share. This is what they are for, and it is what absorption XP pays them for. — [ASSUMED] spec/03 §7 requires screens to absorb disproportionately but gives no exposure figure */
  SCREEN_EXPOSURE: 1.6,
  /** Munitions consumed per point of damage delivered, so industrial depth decides long wars. — [ASSUMED] spec/03 §5 phase 6 requires Era IV+ munitions drain without a rate */
  MUNITIONS_PER_DAMAGE: 0.001,
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
  /** Flat hit points a wall grade contributes, so a fortified settlement is never a free kill even with no garrison present. — [ASSUMED] spec/03 §5 adds flat garrison HP to the defence pool without a figure */
  GARRISON_HP_PER_WALL_GRADE: 500,
  /** Resources one unit can carry home. Bounds plunder, which is what stops a raid being a wipeout. — [ASSUMED] convoy capacity by era is described in spec/04 §2 without per-unit figures */
  CARRY_PER_UNIT: 50,
  /** Resources that can never be looted, so a beaten player always has something to rebuild on. — [ASSUMED] spec/03 §5 names hidden-cellar protection without a figure */
  HIDDEN_CELLAR: 2000,
  /** Loyalty a freshly captured settlement starts at. Low enough to invite counter-conquest, which is the point: taking ground is meant to be easier than holding it. — [ASSUMED] spec/04 §9 says a settlement flips "with low loyalty" without a number */
  CAPTURED_LOYALTY: 15,
  /** Munitions a force carries into an engagement before resupply. — [ASSUMED] spec/03 §5 phase 6 requires a munitions pool without a starting size */
  STARTING_MUNITIONS: 1000000,
  /** Minimum purchased shard-hours to appear on a Heaven’s Envy leaderboard, so a quiet scope returns fewer than ten names rather than marking a trivial spender. Replace with the live median at launch. — [ASSUMED] spec/04 §11 sets the floor at "the median player’s 30-day earned shard income", which is a live telemetry value */
  ENVY_MIN_SPEND_FLOOR: 24,
  /** An era’s disciplines require every previous-era discipline at this grade. — Research_Disciplines!Prerequisite "All Era N-1 disciplines at Grade 12+" */
  RESEARCH_ERA_PREREQ_GRADE: 12,
  /** Base resource cost of a research level, riding the same (L+1)^2.4 curve as buildings so the two progressions stay comparable. Research is player-level and global, but it is PAID from the settlement that hosts it, which keeps isolation intact. — [ASSUMED] Research_Disciplines gives levels, grades and effects but no per-level resource cost */
  RESEARCH_COST_PER_LEVEL: 120,
  /** Resource cost to train one unit, per point of its upkeep. Upkeep already encodes era, archetype and grade, so cost stays correct automatically as the roster is rebalanced — the same reasoning that makes upkeep the base of Unit Power Value. — [ASSUMED] Units_Master carries upkeep and training time but no resource cost per unit */
  TRAIN_COST_PER_UPKEEP: 35,
  /** Training slots a settlement gets from its military buildings, separate from build slots so a settlement is not forced to choose between growing and defending itself. — [ASSUMED] Category_Chassis!Military says military buildings grant unit queue slots without a number */
  MILITARY_QUEUE_SLOTS: 2,
  /** Largest single training order, so one command cannot queue a year of production and make the attention dashboard useless. — [ASSUMED] no published batch limit on a training order */
  TRAIN_BATCH_MAX: 5000,
  /** Training time saved per grade of the best military building, so raising a Barracks is worth doing without letting one settlement out-produce a continent. — [ASSUMED] Category_Chassis!Military says military buildings reduce train time, capped at -40%, without a rate */
  TRAIN_SPEED_PER_GRADE: 0.03,
  /** Ceiling on training-time reduction from facilities. — Category_Chassis!Military "-train time (capped -40%)" */
  TRAIN_SPEED_CAP: 0.4,
  /** How long a tribulation stands open between being declared and resolving. Long enough that a rival who sees a visible one has time to travel and interfere, which is the whole point of making them public. — [ASSUMED] Cultivation!Breakthroughs calls tribulations "live events" without a duration */
  TRIBULATION_WINDOW_MS: 14400000,
  /** Base chance of passing a tribulation before karma and interference. High, because the Qi cost is already the real gate and losing a breakthrough to a coin flip would be miserable. — [ASSUMED] Grades_Realms describes each trial but gives no pass rate */
  TRIBULATION_BASE_SUCCESS: 0.85,
  /** Pass chance lost per tier of Temporal Debt. This is where buying time is actually paid for: the cultivation game is the one thing money cannot accelerate. — [ASSUMED] spec/04 §11 guardrail 3 says Temporal Debt raises tribulation difficulty without a rate */
  TRIBULATION_PER_DEBT_TIER: 0.06,
  /** Pass chance gained per point of reputation on a karma-weighted trial, and lost per point of infamy. Betrayal stays allowed and stays priced. — [ASSUMED] Cultivation!Karma says karmic weight modifies tribulation difficulty without a rate */
  TRIBULATION_PER_REPUTATION: 0.0015,
  /** Pass chance lost per rival who interferes with a visible tribulation. Enough that crashing one is worth the trip, not so much that one rival decides it. — [ASSUMED] Grades_Realms marks a trial "crashable" without saying what crashing it does */
  TRIBULATION_CRASH_PENALTY: 0.12,
  /** Fraction of the spent Qi returned on failure. A failed breakthrough hurts without erasing months of accumulation. — [ASSUMED] Grades_Realms does not say what a failed breakthrough costs beyond the stun it names */
  TRIBULATION_FAILURE_QI_KEPT: 0.4,
  /** Qi per hour per level-scaled cultivation building, summed across every holding — cultivation is player-level progression, so its income is too. — [ASSUMED] Cultivation!Qi names the sources (Spirit Groves, Qi Gathering Stones, Spirit Wells) without rates */
  QI_PER_CULTIVATION_BUILDING: 4,
  /** Qi per hour per Spirit Vein tile, which is what makes those tiles worth fighting over. — [ASSUMED] Cultivation!Qi names Spirit Vein tiles as a source without a rate */
  QI_PER_SPIRIT_VEIN: 12,
  /** Qi per hour from meditation alone, so a player with no cultivation buildings still advances, slowly, and the realm ladder is never completely shut to them. — [ASSUMED] Cultivation!Qi lists idle meditation as a source without a rate */
  QI_IDLE_PER_HOUR: 2,
  /** Combat multiplier per cultivation grade, inside the +40% joint cap. Deliberately small: Cultivation!Balance caps is explicit that realms primarily gate content rather than grant power. — [ASSUMED] Cultivation!Balance caps says realm bonuses fold into the joint cap without giving a per-grade rate */
  CULTIVATION_AURA_PER_GRADE: 0.004,
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
  /** Each HQ grade compresses build time in its settlement by 5%, capped, so the HQ is worth raising without making one megacity strictly dominant. — [ASSUMED] Category_Chassis!HQ/Governance describes HQ acceleration without a rate */
  HQ_FACTOR_PER_GRADE: 0.05,
  /** Doubling at most. An uncapped factor would delete the specialization pressure plots exist to create. — [ASSUMED] no published cap on HQ acceleration */
  HQ_FACTOR_CAP: 1,
  /** Governor slots are separate from and parallel to the personal slots from the HQ. — Governors!"Runs in the governor’s own parallel queue" */
  GOVERNOR_QUEUE_SLOTS: 1,
  /** Default synergy bonus for an adjacent building named in a synergy chain, taken from the most common published value. — [ASSUMED] Specs_EraI gives per-building adjacency percentages in prose (e.g. Sawmill +15% next to Lumber Camp) but no column */
  ADJACENCY_SYNERGY: 0.15,
  /** A small bonus for clustering like with like, so district planning is rewarded but not dominant. — [ASSUMED] Building_Framework describes adjacency without a same-category rate */
  ADJACENCY_SAME_CATEGORY: 0.03,
  /** Caps a perfectly planned district at +50% so layout is a meaningful edge, not a substitute for levels. — [ASSUMED] no published adjacency cap */
  ADJACENCY_CAP: 0.5,
  /** Starting stockpile capacity before any Logistics building, sized so a new village overflows within about a day of neglect and the attention dashboard has something to say. — [ASSUMED] per-building storage values are an open content task (spec §10) */
  BASE_STORAGE: 10000,
  /** Capacity added per Logistics building, scaled by the standard output curve. — [ASSUMED] per-building storage values are an open content task (spec §10) */
  STORAGE_PER_LOGISTICS: 5000,
  /** Half a worker per level per plot, so understaffing is the normal state of a growing settlement. — [ASSUMED] Building_Framework says buildings draw Workers from population without a rate */
  WORKERS_PER_LEVEL: 0.5,
  /** Coin per level per plot from Era II. Sized so a settlement of ordinary buildings pays its own way and an over-built one does not, which is what makes Brownout a real pressure. — [ASSUMED] spec/04 §1 states Era II+ Coin upkeep without a rate */
  UPKEEP_COIN_PER_LEVEL: 0.05,
  /** Electricity per level per plot from Era IV. Lower than the Coin rate because power is a second, narrower constraint layered on top rather than a replacement for it. — [ASSUMED] spec/04 §1 states Era IV+ Electricity draw without a rate */
  UPKEEP_POWER_PER_LEVEL: 0.02,
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
export const ASSUMED_CONSTANTS: readonly string[] = Object.freeze(["MORALE_EXP", "RANGED_PHASE_WEIGHT", "WALL_GRADES_PER_SIEGE_SHARE", "AMBUSH_MAX_CHANCE", "AMBUSH_PER_CONCEALMENT", "AMBUSH_PER_SCOUTING", "AMBUSH_PENALTY", "AMBUSH_BONUS", "PURSUIT_PER_LOG_RATIO", "PURSUIT_MAX", "SCREEN_EXPOSURE", "MUNITIONS_PER_DAMAGE", "GARRISON_HP_PER_WALL_GRADE", "CARRY_PER_UNIT", "HIDDEN_CELLAR", "CAPTURED_LOYALTY", "STARTING_MUNITIONS", "ENVY_MIN_SPEND_FLOOR", "RESEARCH_COST_PER_LEVEL", "TRAIN_COST_PER_UPKEEP", "MILITARY_QUEUE_SLOTS", "TRAIN_BATCH_MAX", "TRAIN_SPEED_PER_GRADE", "TRIBULATION_WINDOW_MS", "TRIBULATION_BASE_SUCCESS", "TRIBULATION_PER_DEBT_TIER", "TRIBULATION_PER_REPUTATION", "TRIBULATION_CRASH_PENALTY", "TRIBULATION_FAILURE_QI_KEPT", "QI_PER_CULTIVATION_BUILDING", "QI_PER_SPIRIT_VEIN", "QI_IDLE_PER_HOUR", "CULTIVATION_AURA_PER_GRADE", "CULTURE_PRESSURE_K", "CULTURE_PRESSURE_CAP", "ATTRITION_ESCALATION", "TEMPORAL_DEBT_HOURS_PER_TIER", "STATECRAFT_PER_POINT", "HQ_FACTOR_PER_GRADE", "HQ_FACTOR_CAP", "ADJACENCY_SYNERGY", "ADJACENCY_SAME_CATEGORY", "ADJACENCY_CAP", "BASE_STORAGE", "STORAGE_PER_LOGISTICS", "WORKERS_PER_LEVEL", "UPKEEP_COIN_PER_LEVEL", "UPKEEP_POWER_PER_LEVEL"]);
