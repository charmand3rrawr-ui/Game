/**
 * import-workbook.ts — the balance pipeline (spec/07_balance_constants.md §1)
 *
 *   Ascendance_Master_Tables.xlsx
 *           │
 *           ├──▶ packages/shared/src/generated/constants.ts   (typed, frozen)
 *           ├──▶ packages/shared/src/generated/refdata.ts     (reference tables)
 *           └──▶ packages/server/migrations/0002_seed_ref.sql (seed data)
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *   Never hardcode a balance number. A magic number in game logic is a defect.
 *   Every constant emitted here carries a `source` recording exactly where it
 *   came from — a workbook cell, a specification section, or (rarely, and
 *   loudly) an assumption the balance owner still has to confirm.
 *
 * THE BUILD FAILS on: a missing sheet, a renamed column, a value outside its
 * declared range, or a violated calibration anchor (spec/07 §3). A silent
 * default here becomes a balance bug nobody can find.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workbook, ImportError, type Sheet, type Cell } from './workbook.js';
// The importer verifies the roster using the SAME generator the game runs, so
// "the workbook and the code agree" is a fact rather than a hope.
import { generateUnit } from '../../shared/src/units.js';
import { roundDecimal } from '../../shared/src/num.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const WORKBOOK = resolve(ROOT, 'data/Ascendance_Master_Tables.xlsx');
const OUT_CONSTANTS = resolve(ROOT, 'packages/shared/src/generated/constants.ts');
const OUT_REFDATA = resolve(ROOT, 'packages/shared/src/generated/refdata.ts');
const OUT_SEED = resolve(ROOT, 'packages/server/migrations/0002_seed_ref.sql');
const OUT_ASSUMPTIONS = resolve(ROOT, 'docs/ASSUMPTIONS.md');

// ============================================================================
// Constant provenance
// ============================================================================

type Provenance =
  | { kind: 'workbook'; ref: string }
  | { kind: 'spec'; ref: string }
  | { kind: 'derived'; ref: string }
  | { kind: 'assumed'; ref: string };

interface Emitted {
  name: string;
  value: number | number[] | string;
  provenance: Provenance;
  note: string;
}

class ConstantSet {
  readonly entries: Emitted[] = [];

  /** A number read straight out of a workbook cell. The preferred kind. */
  fromWorkbook(name: string, got: { value: number; ref: string }, note: string, range?: [number, number]): number {
    check(name, got.value, range);
    this.entries.push({ name, value: got.value, provenance: { kind: 'workbook', ref: got.ref }, note });
    return got.value;
  }

  /**
   * A number stated in the specification rather than the workbook. These are
   * structural constants (exponents, caps, clamps) that the spec fixes in prose
   * and §7's formula table. They are still not "hardcoded in game logic" —
   * they live here, once, with a citation.
   */
  fromSpec(name: string, value: number | number[], ref: string, note: string, range?: [number, number]): number {
    if (typeof value === 'number') check(name, value, range);
    this.entries.push({ name, value, provenance: { kind: 'spec', ref }, note });
    return value as number;
  }

  /** A number computed from other imported numbers, so it can never drift. */
  derived(name: string, value: number, ref: string, note: string): number {
    this.entries.push({ name, value, provenance: { kind: 'derived', ref }, note });
    return value;
  }

  /**
   * A number the specification requires but neither the workbook nor the spec
   * pins down. Emitted with an [ASSUMED] marker so the balance owner can
   * correct it (spec/00 §5) and surfaced in the importer's console output.
   */
  assumed(name: string, value: number, ref: string, note: string): number {
    this.entries.push({ name, value, provenance: { kind: 'assumed', ref }, note });
    return value;
  }

  list(kind: Provenance['kind']): Emitted[] {
    return this.entries.filter((e) => e.provenance.kind === kind);
  }
}

function check(name: string, value: number, range?: [number, number]): void {
  if (!Number.isFinite(value)) throw new ImportError(`${name} is not finite: ${value}`);
  if (range && (value < range[0] || value > range[1])) {
    throw new ImportError(`${name} = ${value} is outside its declared range [${range[0]}, ${range[1]}]`);
  }
}

// ============================================================================
// Reference-table shapes (mirrored by packages/shared/src/generated/refdata.ts)
// ============================================================================

interface RefBuilding {
  key: string;
  name: string;
  era: number;
  category: string;
  functionText: string;
  baseTimber: number;
  baseStone: number;
  baseSpecial: number;
  sizeClass: number;
  purpose?: string;
  mechanic?: string;
  synergies?: string;
  art?: string;
}
interface RefArchetype {
  key: string;
  era: number;
  name: string;
  role: string;
  atk: number;
  def: number;
  hp: number;
  speed: number;
  upkeep: number;
  baseTrainHours: number;
}
interface RefUnitGrade {
  grade: string; statMult: number; upkeepMult: number; trainMult: number; unlock: string;
  /** Minimum research discipline grade, parsed from the Unlock column. */
  requiresDisciplineGrade: number;
  /** Minimum Warfare proficiency rank, where the Unlock column names one. */
  requiresWarfareRank: number;
}
interface RefUnitPath { path: string; atkMod: number; defMod: number; hpMod: number; speedMod: number; identity: string }
interface RefVeterancyTier { tier: number; name: string; cumulativeLevels: number; totalStatBonus: number; tierUpCost: string; reputation: string }
interface RefGrade {
  grade: number; realmStage: string; minLevel: number; maxLevel: number; qiCost: string; tribulation: string;
  /** Parsed from the Tribulation column: what the trial actually does. */
  trial: RefTrial;
}

interface RefTrial {
  /** The trial's own name, e.g. "Lightning Tribulation". */
  name: string;
  /** No trial at all — the mortal realms are passed by effort alone. */
  none: boolean;
  /** Nearby players can see this one happening. */
  visible: boolean;
  /** And can interfere with it. This is the M9 acceptance test. */
  crashable: boolean;
  /** Failure suspends cultivation for this long, where the sheet says so. */
  stunMs: number;
  /** Difficulty is weighted by the player's reputation. */
  karmaWeighted: boolean;
}
interface RefHolding { key: string; name: string; era: string; layer: string; plotsAtFounding: number; maxPlots: number; adminCost: number; produces: string; notes: string }
interface RefResearch {
  key: string; name: string; era: number; branch: string; perLevel: string; prerequisite: string;
  /** The per-level effect as a fraction, parsed from "+0.3% ... / level". */
  perLevelPct: number;
}
interface RefEquipment { key: string; name: string; slot: string; tier: number; quality: string; bonusPct: number; costMult: number | null; source: string }
interface RefCelestial { name: string; a: string; b: string; c: string }
interface RefChassis { category: string; outputFormula: string; mechanics: string; scaling: string; vulnerability: string }

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const raw = await readFile(WORKBOOK);
  const hash = createHash('sha256').update(raw).digest('hex');
  const wb = await Workbook.load(WORKBOOK);

  console.log(`ascendance: importing ${WORKBOOK}`);
  console.log(`ascendance: workbook sha256 ${hash.slice(0, 16)}… (${wb.names().length} sheets)`);

  const C = new ConstantSet();

  // ------------------------------------------------------------------ grades
  const gradesSheet = wb.sheet('Grades_Realms');
  const grades = readGrades(gradesSheet);
  assertTribulationsParsed(grades);
  const MAX_GRADE = C.derived('MAX_GRADE', grades.length, 'Grades_Realms row count', 'The 42-grade spine.');
  const MAX_LEVEL = C.derived(
    'MAX_LEVEL',
    grades[grades.length - 1]!.maxLevel,
    'Grades_Realms!max level of the last grade',
    'Levels run 0..1337 for buildings, research, cultivation and veterancy alike.',
  );
  const LEVELS_PER_GRADE = C.derived(
    'LEVELS_PER_GRADE',
    grades[0]!.maxLevel - grades[0]!.minLevel + 1,
    'Grades_Realms!grade 1 span',
    'Every 32 levels is a grade boundary. Grades gate content; levels make you better.',
  );
  if (MAX_GRADE !== 42) throw new ImportError(`expected 42 grades, workbook has ${MAX_GRADE}`);
  if (MAX_LEVEL !== 1337) throw new ImportError(`expected max level 1337, workbook has ${MAX_LEVEL}`);
  if (LEVELS_PER_GRADE !== 32) throw new ImportError(`expected 32 levels per grade, workbook has ${LEVELS_PER_GRADE}`);

  // -------------------------------------------------------------- buildings
  const levels = wb.sheet('Building_Levels');
  const BUILD_TIME_K = C.fromWorkbook(
    'BUILD_TIME_K',
    levels.labelledBelow('Time constant K (h)', 8),
    'Calibrated so the sum of build time over all 1,338 levels is exactly 500 years.',
    [1e-6, 1e-2],
  );
  const BUILD_COST_EXP = C.fromSpec('BUILD_COST_EXP', 2.4, 'spec/07 §2 · Building cost', 'cost(L) = base * (L+1)^2.4 * 1.004^L', [1, 5]);
  const BUILD_COST_GEO = C.fromSpec('BUILD_COST_GEO', 1.004, 'spec/07 §2 · Building cost', 'The gentle exponential that makes the last levels prohibitive.', [1, 1.1]);
  const BUILD_TIME_EXP = C.fromSpec('BUILD_TIME_EXP', 1.9, 'spec/07 §2 · Build/research time', 'time(L) = K * (L+1)^1.9 * 1.003^L', [1, 5]);
  const BUILD_TIME_GEO = C.fromSpec('BUILD_TIME_GEO', 1.003, 'spec/07 §2 · Build/research time', '', [1, 1.1]);
  const OUTPUT_EXP = C.fromSpec('OUTPUT_EXP', 1.12, 'spec/07 §2 · Building output', 'Polynomial while cost is exponential — the reason a rational stopping point exists.', [0.5, 3]);

  // Verify the emitted curve against the workbook's own computed column, then
  // verify the 500-year calibration anchor (spec/07 §3.1).
  verifyBuildingCurves(levels, { BUILD_COST_EXP, BUILD_COST_GEO, BUILD_TIME_K, BUILD_TIME_EXP, BUILD_TIME_GEO, OUTPUT_EXP });
  const totalClimbHours = assertClimbAnchor(levels, { BUILD_TIME_K, BUILD_TIME_EXP, BUILD_TIME_GEO }, MAX_LEVEL);
  C.derived('FULL_CLIMB_HOURS', totalClimbHours, 'spec/07 §3.1 anchor', 'A full 0→1337 climb is exactly 500 years.');

  // ------------------------------------------------------------ cultivation
  const QI_BASE = C.fromSpec('QI_BASE', 100, 'spec/07 §2 · Qi breakthrough', 'cost(G) = 100 * G^3.2 * 1.15^G', [1, 1e6]);
  const QI_EXP = C.fromSpec('QI_EXP', 3.2, 'spec/07 §2 · Qi breakthrough', '', [1, 10]);
  const QI_GEO = C.fromSpec('QI_GEO', 1.15, 'spec/07 §2 · Qi breakthrough', '', [1, 2]);
  assertQiCurve(grades, { QI_BASE, QI_EXP, QI_GEO });

  // ------------------------------------------------------------------ units
  const arch = wb.sheet('Archetypes');
  const TRAIN_CONST = C.fromWorkbook(
    'TRAIN_CONST',
    arch.labelledBelow('Train const (h per upkeep pt)', 11),
    'Hours of training per point of base upkeep.',
    [0.01, 10],
  );
  const archetypes = readArchetypes(arch, TRAIN_CONST);
  const unitGrades = readUnitGrades(wb.sheet('Unit_Grades'));
  const unitPaths = readUnitPaths(wb.sheet('Unit_Paths'));
  assertRosterAnchor(archetypes, unitGrades, TRAIN_CONST);
  assertRosterMatchesMaster(wb.sheet('Units_Master'), archetypes, unitGrades, unitPaths);

  // -------------------------------------------------------------- veterancy
  const tiersSheet = wb.sheet('Veterancy_Tiers');
  const vetTiers = readVeterancyTiers(tiersSheet);
  const MAX_VET_TIER = C.derived('MAX_VET_TIER', vetTiers.length, 'Veterancy_Tiers row count', 'Copper → Eternal.');
  const LEVELS_PER_TIER = C.derived('LEVELS_PER_TIER', vetTiers[0]!.cumulativeLevels, 'Veterancy_Tiers!cumulative levels at tier 1', '');
  const VET_PER_LEVEL = C.fromSpec('VET_PER_LEVEL', 0.01, 'spec/07 §2 · Veterancy stat bonus', '+1% per level. Tiers themselves grant nothing.', [0, 0.1]);
  assertVeterancyLadder(vetTiers, { VET_PER_LEVEL, LEVELS_PER_TIER });

  const TIERUP_BASE = C.fromWorkbook('TIERUP_BASE', tiersSheet.labelled('Tier-2 base cost', 0, 1), 'Resource cost to promote into tier 2.', [1, 1e9]);
  const TIERUP_MULT = C.fromWorkbook('TIERUP_MULT', tiersSheet.labelled('Cost multiplier per tier', 2, 3), 'Deliberately NOT scaled by empire weight — this asymmetry is the Champion economy.', [1, 10]);
  assertTierUpCosts(vetTiers, { TIERUP_BASE, TIERUP_MULT });

  const xpSheet = wb.sheet('Veterancy_XP');
  const XP_BASE = C.fromWorkbook('XP_BASE', xpSheet.labelled('Base XP per level', 0, 1), 'required = 100 * (L+1)^0.21 * 1.30^(T-1) * empireWeightMult', [1, 1e6]);
  const XP_LEVEL_EXP = C.fromWorkbook('XP_LEVEL_EXP', xpSheet.labelled('Level exponent', 0, 1), 'The gentle requirement-side level slope.', [0, 2]);
  const XP_TIER_MULT = C.fromWorkbook('XP_TIER_MULT', xpSheet.labelled('Tier multiplier', 0, 1), 'The gentle requirement-side tier slope.', [1, 5]);
  const FATIGUE_LEVEL_EXP = C.fromWorkbook('FATIGUE_LEVEL_EXP', xpSheet.labelled('Level decay exponent', 3, 4), 'The earn-side half of the split curve.', [0, 2]);
  const FATIGUE_TIER_DIV = C.fromWorkbook('FATIGUE_TIER_DIV', xpSheet.labelled('Tier divisor', 3, 4), '', [1, 5]);
  const XP_STANDARD_BATTLE = C.fromWorkbook('XP_STANDARD_BATTLE', xpSheet.labelled('Base XP per battle', 3, 4), 'The reference "standard battle" used for pacing readouts only.', [1, 1e9]);

  const ewSheet = wb.sheet('Empire_Weight_Multiplier');
  const EW_KNEE = C.fromWorkbook('EW_KNEE', ewSheet.labelled('Knee W₀', 0, 1), 'multiplier = MIN(cap, 1 + (W / 100)^2.41)', [1, 1e6]);
  const EW_STEEPNESS = C.fromWorkbook('EW_STEEPNESS', ewSheet.labelled('Steepness k', 2, 3), '', [0.1, 10]);
  const EW_CAP = C.fromWorkbook('EW_CAP', ewSheet.labelled('Hard cap', 4, 5), 'The exact reciprocal of the 0.00001% earn-side floor it replaced.', [1, 1e12]);
  assertEmpireWeightCurve(ewSheet, { EW_KNEE, EW_STEEPNESS, EW_CAP });

  const TIER_PER_ERA = C.fromSpec('TIER_PER_ERA', 3.5, 'spec/04 §5 · era gating', 'max tier = ceil(3.5 * era). Keeps a theatre within a few tiers.', [1, 10]);

  // ------------------------------------------------------------ attribution
  const REL_MIN = C.fromSpec('REL_MIN', 0.05, 'spec/03 §7 · relativeFactor clamp', '', [0, 1]);
  const REL_MAX = C.fromSpec('REL_MAX', 4.0, 'spec/03 §7 · relativeFactor clamp', '', [1, 100]);
  const REL_EXP = C.fromSpec('REL_EXP', 0.5, 'spec/03 §7 · relativeFactor', 'The square root is deliberate; a linear ratio would discourage all normal warfare.', [0, 2]);
  C.fromSpec('REPETITION_LADDER', [1.0, 0.6, 0.35, 0.2, 0.1], 'spec/03 §7 · repetition', 'Diminishing returns against the same defender inside 24h.');
  const LOSER_XP_RATE = C.fromSpec('LOSER_XP_RATE', 0.6, 'spec/03 §7', 'The losing side still earns ~60%. Fighting a losing war must never be progression death.', [0, 1]);
  const BENEATH_NOTICE_RATIO = C.fromSpec('BENEATH_NOTICE_RATIO', 0.02, 'spec/03 §7 · hard zeroes', 'Victim UPV below 2% of killer UPV earns zero, not less.', [0, 1]);
  const NPC_TIER_CEILING = C.fromSpec('NPC_TIER_CEILING', 4, 'spec/03 §7 · hard zeroes', 'Barbarians cannot carry a formation past Steel.', [1, 24]);
  const ESCALATION_ERA_GAP = C.fromSpec('ESCALATION_ERA_GAP', 2, 'spec/03 §7 · hard zeroes', 'Punching two or more eras down earns nothing.', [1, 7]);
  const ABSORPTION_COEFF = C.fromSpec('ABSORPTION_COEFF', 0.5, 'spec/03 §7 · absorption XP', 'Without this the Guardian identity path is a trap.', [0, 5]);

  // ----------------------------------------------------------------- combat
  const JOINT_BONUS_CAP = C.fromSpec('JOINT_BONUS_CAP', 0.40, 'spec/07 §3.4 anchor', 'ONE +40% clamp over proficiency, equipment, commanders, cultivation and veterancy.', [0, 5]);
  const MORALE_MIN = C.fromSpec('MORALE_MIN', 0.5, 'spec/07 §2 · Morale', '', [0, 1]);
  const MORALE_MAX = C.fromSpec('MORALE_MAX', 1.5, 'spec/07 §2 · Morale', 'Smaller empires fight harder.', [1, 5]);
  const MORALE_EXP = C.assumed(
    'MORALE_EXP',
    0.25,
    'GDD Appendix A does not pin the exponent; spec/07 §2 gives only the clamp',
    'Shapes how fast morale moves between the 0.5 and 1.5 clamps as relative empire size changes. ' +
      '0.25 puts a 4x size disadvantage at ~1.41x morale, comfortably inside the clamp.',
  );
  const FORT_PER_GRADE = C.fromSpec('FORT_PER_GRADE', 0.05, 'spec/03 §5 · fortificationMult', '(1 + 0.05 * wallGrade)', [0, 1]);
  const COUNTER_MAX = C.fromSpec('COUNTER_MAX', 2.2, 'spec/07 §3.5 anchor', 'The strongest counter-matrix entry. Nothing may exceed it without review.', [1, 10]);
  const counter = readCounterMatrix(wb.sheet('Counter_Matrix'), COUNTER_MAX);

  // ------------------------------------------------- combat phase weighting
  // The six-phase resolver needs a handful of shape constants the specification
  // describes qualitatively. Each is marked so the balance owner can tune it
  // against the telemetry in spec/07 §5.
  const RANGED_PHASE_WEIGHT = C.assumed(
    'RANGED_PHASE_WEIGHT',
    0.35,
    'spec/03 §5 orders the phases but does not weight the ranged exchange against the main engagement',
    'The pre-contact exchange lands 35% of a full engagement, so bringing artillery matters ' +
      'without letting a siege train win unaccompanied.',
  );
  const WALL_GRADES_PER_SIEGE_SHARE = C.assumed(
    'WALL_GRADES_PER_SIEGE_SHARE',
    6,
    'spec/03 §5 says fortification damage is applied in the ranged phase without a rate',
    'A force that is entirely siege engines strips about six wall grades per assault, ' +
      'so walls are worn down over a campaign rather than in one battle.',
  );
  const AMBUSH_MAX_CHANCE = C.assumed(
    'AMBUSH_MAX_CHANCE',
    0.35,
    'spec/03 §5 phase 1 names intel, concealment and ambush chance without probabilities',
    'Ceiling on the defender\u2019s ambush chance. Capped so that scouting can always reduce the ' +
      'risk meaningfully and no terrain makes an attack a coin flip.',
  );
  const AMBUSH_PER_CONCEALMENT = C.assumed(
    'AMBUSH_PER_CONCEALMENT',
    0.5,
    'spec/03 §5 phase 1 names terrain concealment as an ambush input without a rate',
    'How much terrain concealment contributes to ambush chance. Fully concealed ground reaches ' +
      'the cap on its own, which is what makes terrain worth fighting for.',
  );
  const AMBUSH_PER_SCOUTING = C.assumed(
    'AMBUSH_PER_SCOUTING',
    0.4,
    'spec/03 §5 phase 1 names scouting quality as an ambush input without a rate',
    'How much attacker scouting suppresses ambush chance. Set below the concealment rate so ' +
      'scouting is the payoff for preparation without ever making terrain irrelevant.',
  );
  const AMBUSH_PENALTY = C.assumed(
    'AMBUSH_PENALTY',
    0.25,
    'spec/03 §5 phase 1 states that ambush happens, not what it costs',
    'An ambushed attacker fights at 75%. Large enough that failing to scout is a real mistake, ' +
      'small enough that it does not by itself decide a well-prepared assault.',
  );
  const AMBUSH_BONUS = C.assumed(
    'AMBUSH_BONUS',
    0.15,
    'spec/03 §5 phase 1 states that ambush happens, not what it grants',
    'An ambushing defender fights at 115%. Deliberately smaller than the attacker\u2019s penalty, ' +
      'so ambush is a disruption of the attack rather than a defensive multiplier to farm.',
  );
  const PURSUIT_PER_LOG_RATIO = C.assumed(
    'PURSUIT_PER_LOG_RATIO',
    0.25,
    'spec/03 §5 phase 4 calls for casualty amplification on the losing side without a rate',
    'Scales pursuit losses by the log of the power ratio, so a narrow win is not a massacre ' +
      'and a rout is.',
  );
  const PURSUIT_MAX = C.assumed(
    'PURSUIT_MAX',
    0.6,
    'spec/03 §5 phase 4 requires casualty amplification on the losing side without a ceiling',
    'Ceiling on pursuit losses. No single battle annihilates a force outright, so a beaten ' +
      'player always has a core to withdraw and rebuild around.',
  );
  const SCREEN_EXPOSURE = C.assumed(
    'SCREEN_EXPOSURE',
    1.6,
    'spec/03 §7 requires screens to absorb disproportionately but gives no exposure figure',
    'Screens take 60% more than their contribution share. This is what they are for, and it is ' +
      'what absorption XP pays them for.',
  );
  const MUNITIONS_PER_DAMAGE = C.assumed(
    'MUNITIONS_PER_DAMAGE',
    0.001,
    'spec/03 §5 phase 6 requires Era IV+ munitions drain without a rate',
    'Munitions consumed per point of damage delivered, so industrial depth decides long wars.',
  );

  // ----------------------------------------------------------- monetization
  const shardSheet = wb.sheet('Chrono_Shards');
  const SHARD_BASE = C.fromWorkbook('SHARD_BASE', shardSheet.labelled('Base ceiling', 0, 1), 'ceiling = 2.0 + 0.30*constructionRank + 0.50*era', [0, 100]);
  const SHARD_PER_RANK = C.fromWorkbook('SHARD_PER_RANK', shardSheet.labelled('Per Construction rank', 0, 1), '', [0, 10]);
  const SHARD_PER_ERA = C.fromWorkbook('SHARD_PER_ERA', shardSheet.labelled('Per era', 0, 1), '', [0, 10]);
  assertShardCeilingTable(shardSheet, { SHARD_BASE, SHARD_PER_RANK, SHARD_PER_ERA });
  const shardDenoms = readShardDenominations(shardSheet);
  const SHARD_SIEGE_LOCKOUT_MS = C.fromSpec(
    'SHARD_SIEGE_LOCKOUT_MS',
    4 * 3_600_000,
    'spec/04 §11 · prohibited targets',
    'No shard application within 4h of a hostile impact.',
    [0, 86_400_000],
  );
  const ENVY_PER_SCOPE = C.fromSpec('ENVY_PER_SCOPE', 0.10, 'spec/04 §11 · Heaven’s Envy', '-10% defensive strength per marked scope, stacking to -30%.', [0, 1]);
  const ENVY_MAX_SCOPES = C.fromSpec('ENVY_MAX_SCOPES', 3, 'spec/04 §11', 'Universe, quadrant, alliance.', [1, 10]);
  const ENVY_WINDOW_MS = C.fromSpec('ENVY_WINDOW_MS', 24 * 3_600_000, 'spec/04 §11', 'Rolling 24h measurement window.', [0, 7 * 86_400_000]);
  const TEMPORAL_DEBT_TIERS = C.fromSpec('TEMPORAL_DEBT_TIERS', 6, 'spec/04 §11 · guardrail 3', 'Karma tiers raising tribulation difficulty and suppressing Qi regen.', [1, 20]);
  const TEMPORAL_DEBT_DECAY_MS = C.fromSpec('TEMPORAL_DEBT_DECAY_MS', 30 * 86_400_000, 'spec/04 §11 · guardrail 3', 'One tier per 30 days of abstention.', [0, 365 * 86_400_000]);

  const GARRISON_HP_PER_WALL_GRADE = C.assumed(
    'GARRISON_HP_PER_WALL_GRADE',
    500,
    'spec/03 §5 adds flat garrison HP to the defence pool without a figure',
    'Flat hit points a wall grade contributes, so a fortified settlement is never a free kill ' +
      'even with no garrison present.',
  );
  const CARRY_PER_UNIT = C.assumed(
    'CARRY_PER_UNIT',
    50,
    'convoy capacity by era is described in spec/04 §2 without per-unit figures',
    'Resources one unit can carry home. Bounds plunder, which is what stops a raid being a wipeout.',
  );
  const HIDDEN_CELLAR = C.assumed(
    'HIDDEN_CELLAR',
    2_000,
    'spec/03 §5 names hidden-cellar protection without a figure',
    'Resources that can never be looted, so a beaten player always has something to rebuild on.',
  );
  const CAPTURED_LOYALTY = C.assumed(
    'CAPTURED_LOYALTY',
    15,
    'spec/04 §9 says a settlement flips "with low loyalty" without a number',
    'Loyalty a freshly captured settlement starts at. Low enough to invite counter-conquest, ' +
      'which is the point: taking ground is meant to be easier than holding it.',
  );
  const STARTING_MUNITIONS = C.assumed(
    'STARTING_MUNITIONS',
    1_000_000,
    'spec/03 §5 phase 6 requires a munitions pool without a starting size',
    'Munitions a force carries into an engagement before resupply.',
  );
  const ENVY_MIN_SPEND_FLOOR = C.assumed(
    'ENVY_MIN_SPEND_FLOOR',
    24,
    'spec/04 §11 sets the floor at "the median player\u2019s 30-day earned shard income", which is a live telemetry value',
    'Minimum purchased shard-hours to appear on a Heaven\u2019s Envy leaderboard, so a quiet scope ' +
      'returns fewer than ten names rather than marking a trivial spender. Replace with the live median at launch.',
  );

  // ------------------------------------------------- research and training
  const RESEARCH_ERA_PREREQ_GRADE = C.fromWorkbook(
    'RESEARCH_ERA_PREREQ_GRADE',
    { value: 12, ref: 'Research_Disciplines!Prerequisite "All Era N-1 disciplines at Grade 12+"' },
    'An era\u2019s disciplines require every previous-era discipline at this grade.',
    [1, 42],
  );
  const RESEARCH_COST_PER_LEVEL = C.assumed(
    'RESEARCH_COST_PER_LEVEL',
    120,
    'Research_Disciplines gives levels, grades and effects but no per-level resource cost',
    'Base resource cost of a research level, riding the same (L+1)^2.4 curve as buildings so the ' +
      'two progressions stay comparable. Research is player-level and global, but it is PAID from ' +
      'the settlement that hosts it, which keeps isolation intact.',
  );
  const TRAIN_COST_PER_UPKEEP = C.assumed(
    'TRAIN_COST_PER_UPKEEP',
    35,
    'Units_Master carries upkeep and training time but no resource cost per unit',
    'Resource cost to train one unit, per point of its upkeep. Upkeep already encodes era, ' +
      'archetype and grade, so cost stays correct automatically as the roster is rebalanced \u2014 ' +
      'the same reasoning that makes upkeep the base of Unit Power Value.',
  );
  const MILITARY_QUEUE_SLOTS = C.assumed(
    'MILITARY_QUEUE_SLOTS',
    2,
    'Category_Chassis!Military says military buildings grant unit queue slots without a number',
    'Training slots a settlement gets from its military buildings, separate from build slots so a ' +
      'settlement is not forced to choose between growing and defending itself.',
  );
  const TRAIN_BATCH_MAX = C.assumed(
    'TRAIN_BATCH_MAX',
    5_000,
    'no published batch limit on a training order',
    'Largest single training order, so one command cannot queue a year of production and make the ' +
      'attention dashboard useless.',
  );

  const TRAIN_SPEED_PER_GRADE = C.assumed(
    'TRAIN_SPEED_PER_GRADE',
    0.03,
    'Category_Chassis!Military says military buildings reduce train time, capped at -40%, without a rate',
    'Training time saved per grade of the best military building, so raising a Barracks is worth ' +
      'doing without letting one settlement out-produce a continent.',
  );
  const TRAIN_SPEED_CAP = C.fromWorkbook(
    'TRAIN_SPEED_CAP',
    { value: 0.4, ref: 'Category_Chassis!Military "-train time (capped -40%)"' },
    'Ceiling on training-time reduction from facilities.',
    [0, 1],
  );

  // ------------------------------------------------------------ cultivation
  const TRIBULATION_WINDOW_MS = C.assumed(
    'TRIBULATION_WINDOW_MS',
    4 * 3_600_000,
    'Cultivation!Breakthroughs calls tribulations "live events" without a duration',
    'How long a tribulation stands open between being declared and resolving. Long enough that a ' +
      'rival who sees a visible one has time to travel and interfere, which is the whole point of ' +
      'making them public.',
  );
  const TRIBULATION_BASE_SUCCESS = C.assumed(
    'TRIBULATION_BASE_SUCCESS',
    0.85,
    'Grades_Realms describes each trial but gives no pass rate',
    'Base chance of passing a tribulation before karma and interference. High, because the Qi cost ' +
      'is already the real gate and losing a breakthrough to a coin flip would be miserable.',
  );
  const TRIBULATION_PER_DEBT_TIER = C.assumed(
    'TRIBULATION_PER_DEBT_TIER',
    0.06,
    'spec/04 §11 guardrail 3 says Temporal Debt raises tribulation difficulty without a rate',
    'Pass chance lost per tier of Temporal Debt. This is where buying time is actually paid for: ' +
      'the cultivation game is the one thing money cannot accelerate.',
  );
  const TRIBULATION_PER_REPUTATION = C.assumed(
    'TRIBULATION_PER_REPUTATION',
    0.0015,
    'Cultivation!Karma says karmic weight modifies tribulation difficulty without a rate',
    'Pass chance gained per point of reputation on a karma-weighted trial, and lost per point of ' +
      'infamy. Betrayal stays allowed and stays priced.',
  );
  const TRIBULATION_CRASH_PENALTY = C.assumed(
    'TRIBULATION_CRASH_PENALTY',
    0.12,
    'Grades_Realms marks a trial "crashable" without saying what crashing it does',
    'Pass chance lost per rival who interferes with a visible tribulation. Enough that crashing one ' +
      'is worth the trip, not so much that one rival decides it.',
  );
  const TRIBULATION_FAILURE_QI_KEPT = C.assumed(
    'TRIBULATION_FAILURE_QI_KEPT',
    0.4,
    'Grades_Realms does not say what a failed breakthrough costs beyond the stun it names',
    'Fraction of the spent Qi returned on failure. A failed breakthrough hurts without erasing months ' +
      'of accumulation.',
  );
  const QI_PER_CULTIVATION_BUILDING = C.assumed(
    'QI_PER_CULTIVATION_BUILDING',
    4,
    'Cultivation!Qi names the sources (Spirit Groves, Qi Gathering Stones, Spirit Wells) without rates',
    'Qi per hour per level-scaled cultivation building, summed across every holding — cultivation is ' +
      'player-level progression, so its income is too.',
  );
  const QI_PER_SPIRIT_VEIN = C.assumed(
    'QI_PER_SPIRIT_VEIN',
    12,
    'Cultivation!Qi names Spirit Vein tiles as a source without a rate',
    'Qi per hour per Spirit Vein tile, which is what makes those tiles worth fighting over.',
  );
  const QI_IDLE_PER_HOUR = C.assumed(
    'QI_IDLE_PER_HOUR',
    2,
    'Cultivation!Qi lists idle meditation as a source without a rate',
    'Qi per hour from meditation alone, so a player with no cultivation buildings still advances, ' +
      'slowly, and the realm ladder is never completely shut to them.',
  );
  const CULTIVATION_AURA_PER_GRADE = C.assumed(
    'CULTIVATION_AURA_PER_GRADE',
    0.004,
    'Cultivation!Balance caps says realm bonuses fold into the joint cap without giving a per-grade rate',
    'Combat multiplier per cultivation grade, inside the +40% joint cap. Deliberately small: ' +
      'Cultivation!Balance caps is explicit that realms primarily gate content rather than grant power.',
  );

  // -------------------------------------------------------------- governors
  const GOVERNOR_TIME_MULT = C.fromSpec('GOVERNOR_TIME_MULT', 2.0, 'spec/04 §6 · the 2x rule', 'Anything a governor initiates takes twice as long. That field is the whole mechanic.', [1, 10]);
  const PLAYER_TIME_MULT = C.fromSpec('PLAYER_TIME_MULT', 1.0, 'spec/04 §6', '', [0.1, 2]);
  const CANCEL_REFUND_PCT = C.fromSpec('CANCEL_REFUND_PCT', 0.80, 'spec/05 §2 · DELETE /v1/queue/:itemId', 'Cancelling refunds 80% of resources.', [0, 1]);

  // ------------------------------------------------------------- settlement
  const SPEC_CAP_G30 = C.fromSpec('SPEC_CAP_G30', 3, 'spec/04 §1 · specialization caps', 'At most 3 buildings above grade 30. A hard constraint: reject the enqueue.', [0, 100]);
  const SPEC_CAP_G20 = C.fromSpec('SPEC_CAP_G20', 8, 'spec/04 §1 · specialization caps', 'At most 8 buildings above grade 20.', [0, 100]);
  const SPEC_CAP_G30_GRADE = C.fromSpec('SPEC_CAP_G30_GRADE', 30, 'spec/04 §1', '', [1, 42]);
  const SPEC_CAP_G20_GRADE = C.fromSpec('SPEC_CAP_G20_GRADE', 20, 'spec/04 §1', '', [1, 42]);
  const BROWNOUT_OUTPUT_MULT = C.fromSpec('BROWNOUT_OUTPUT_MULT', 0.5, 'spec/04 §1 · upkeep', 'Insolvency halves output.', [0, 1]);
  const BROWNOUT_GRACE_MS = C.fromSpec('BROWNOUT_GRACE_MS', 72 * 3_600_000, 'spec/04 §1 · upkeep', 'After 72h of Brownout a building sheds a level per day.', [0, 30 * 86_400_000]);
  const HERITAGE_CULTURE_PCT = C.fromSpec('HERITAGE_CULTURE_PCT', 0.02, 'spec/04 §1 · Heritage', 'Earlier-era buildings gain Culture equal to 2% of level. Nothing ever becomes obsolete.', [0, 1]);
  const LOYALTY_REGEN_PER_HOUR = C.fromSpec('LOYALTY_REGEN_PER_HOUR', 1, 'spec/04 §9', '', [0, 100]);
  const CAPTURE_GRADE_PENALTY = C.fromSpec('CAPTURE_GRADE_PENALTY', 3, 'spec/04 §9', 'Captured settlements keep buildings at -3 grades.', [0, 42]);
  const CONQUEST_LOYALTY_MIN = C.fromSpec('CONQUEST_LOYALTY_MIN', 20, 'spec/04 §9', 'Conquest-class units reduce loyalty 20-35 per successful attack.', [0, 100]);
  const CONQUEST_LOYALTY_MAX = C.fromSpec('CONQUEST_LOYALTY_MAX', 35, 'spec/04 §9', '', [0, 100]);

  const PLOTS_PER_HQ_GRADE = C.fromWorkbook(
    'PLOTS_PER_HQ_GRADE',
    { value: 2, ref: 'Category_Chassis!HQ/Governance "Scales with level by: +2 plots, +1 queue per 4 grades"' },
    'Plots: 24 at founding, +2 per HQ grade, capped by the holding type.',
    [0, 10],
  );
  const QUEUE_SLOT_PER_GRADES = C.fromWorkbook(
    'QUEUE_SLOT_PER_GRADES',
    { value: 4, ref: 'Category_Chassis!HQ/Governance "+1 queue per 4 grades"' },
    'Personal queue slots from the HQ. Their scarcity is the only brake on Seize (spec/04 §6).',
    [1, 42],
  );
  const CULTURE_PRESSURE_K = C.assumed(
    'CULTURE_PRESSURE_K',
    0.0004,
    'GDD §8.4 gives the shape ((cultureDelta)^2 * k, capped) but not k',
    'Calibrated so a 100-point culture lead flips an adjacent plot over roughly three weeks, ' +
      'matching spec/04 §3 ("flip adjacent low-culture plots over weeks").',
  );
  const CULTURE_PRESSURE_CAP = C.assumed(
    'CULTURE_PRESSURE_CAP',
    12,
    'GDD §8.4 states the cap exists but not its value',
    'Caps a runaway culture lead at roughly one plot flip per day.',
  );
  const ATTRITION_ESCALATION = C.assumed(
    'ATTRITION_ESCALATION',
    0.5,
    'spec/03 §4 says attrition escalates but does not give the rate',
    'Each further hour out of supply adds 50% of the base 3% rate, so a stranded army ' +
      'becomes a problem to solve rather than a leak to tolerate.',
  );
  const TEMPORAL_DEBT_HOURS_PER_TIER = C.assumed(
    'TEMPORAL_DEBT_HOURS_PER_TIER',
    168,
    'spec/04 §11 guardrail 3 defines six karma tiers but not the spend per tier',
    'One week of compressed time per karma tier, so reaching the top tier takes sustained buying.',
  );
  const STATECRAFT_PER_POINT = C.assumed(
    'STATECRAFT_PER_POINT',
    0.02,
    'spec/04 §9 says loyalty damage is "modified by Statecraft on both sides" without a rate',
    'Each net point of Statecraft advantage moves loyalty damage by 2%, clamped to +/-50%.',
  );

  const HQ_FACTOR_PER_GRADE = C.assumed(
    'HQ_FACTOR_PER_GRADE',
    0.05,
    'Category_Chassis!HQ/Governance describes HQ acceleration without a rate',
    'Each HQ grade compresses build time in its settlement by 5%, capped, so the HQ is worth ' +
      'raising without making one megacity strictly dominant.',
  );
  const HQ_FACTOR_CAP = C.assumed(
    'HQ_FACTOR_CAP',
    1.0,
    'no published cap on HQ acceleration',
    'Doubling at most. An uncapped factor would delete the specialization pressure plots exist to create.',
  );
  const GOVERNOR_QUEUE_SLOTS = C.fromWorkbook(
    'GOVERNOR_QUEUE_SLOTS',
    { value: 1, ref: 'Governors!"Runs in the governor\u2019s own parallel queue"' },
    'Governor slots are separate from and parallel to the personal slots from the HQ.',
    [1, 16],
  );
  const ADJACENCY_SYNERGY = C.assumed(
    'ADJACENCY_SYNERGY',
    0.15,
    'Specs_EraI gives per-building adjacency percentages in prose (e.g. Sawmill +15% next to Lumber Camp) but no column',
    'Default synergy bonus for an adjacent building named in a synergy chain, taken from the ' +
      'most common published value.',
  );
  const ADJACENCY_SAME_CATEGORY = C.assumed(
    'ADJACENCY_SAME_CATEGORY',
    0.03,
    'Building_Framework describes adjacency without a same-category rate',
    'A small bonus for clustering like with like, so district planning is rewarded but not dominant.',
  );
  const ADJACENCY_CAP = C.assumed(
    'ADJACENCY_CAP',
    0.5,
    'no published adjacency cap',
    'Caps a perfectly planned district at +50% so layout is a meaningful edge, not a substitute for levels.',
  );
  const BASE_STORAGE = C.assumed(
    'BASE_STORAGE',
    10_000,
    'per-building storage values are an open content task (spec §10)',
    'Starting stockpile capacity before any Logistics building, sized so a new village overflows ' +
      'within about a day of neglect and the attention dashboard has something to say.',
  );
  const STORAGE_PER_LOGISTICS = C.assumed(
    'STORAGE_PER_LOGISTICS',
    5_000,
    'per-building storage values are an open content task (spec §10)',
    'Capacity added per Logistics building, scaled by the standard output curve.',
  );
  const WORKERS_PER_LEVEL = C.assumed(
    'WORKERS_PER_LEVEL',
    0.5,
    'Building_Framework says buildings draw Workers from population without a rate',
    'Half a worker per level per plot, so understaffing is the normal state of a growing settlement.',
  );
  const UPKEEP_COIN_PER_LEVEL = C.assumed(
    'UPKEEP_COIN_PER_LEVEL',
    0.05,
    'spec/04 §1 states Era II+ Coin upkeep without a rate',
    'Coin per level per plot from Era II. Sized so a settlement of ordinary buildings pays its ' +
      'own way and an over-built one does not, which is what makes Brownout a real pressure.',
  );
  const UPKEEP_POWER_PER_LEVEL = C.assumed(
    'UPKEEP_POWER_PER_LEVEL',
    0.02,
    'spec/04 §1 states Era IV+ Electricity draw without a rate',
    'Electricity per level per plot from Era IV. Lower than the Coin rate because power is a ' +
      'second, narrower constraint layered on top rather than a replacement for it.',
  );

  // --------------------------------------------------------------- movement
  const ZOC_SPEED_MULT = C.fromSpec('ZOC_SPEED_MULT', 0.6, 'spec/03 §4 · zone of control', '0.6x speed inside a hostile fortification radius.', [0, 1]);
  const ATTRITION_PCT = C.fromSpec('ATTRITION_PCT', 0.03, 'spec/03 §4 · supply', '3% of strength per tick beyond supply range, escalating.', [0, 1]);
  const ATTRITION_INTERVAL_MS = C.fromSpec('ATTRITION_INTERVAL_MS', 3_600_000, 'spec/03 §4', 'One attrition tick per hour out of supply.', [1000, 86_400_000]);

  // -------------------------------------------------------------- equipment
  const equipSheet = wb.sheet('Equipment_Catalog');
  const EQUIP_TIER_MULT = C.fromSpec('EQUIP_TIER_MULT', 0.12, 'Equipment_Catalog!"Tier mult = 1 + 0.12x(tier-1)"', '', [0, 1]);
  const equipment = readEquipment(equipSheet);

  // ---------------------------------------------------------- reference sets
  const buildings = readBuildings(wb.sheet('Buildings_Master'), wb.sheet('Specs_EraI'));
  const holdings = readHoldings(wb.sheet('Holdings_Hierarchy'));
  const research = readResearch(wb.sheet('Research_Disciplines'));
  const celestial = readCelestial(wb.sheet('Celestial_Sites'));
  const chassis = readChassis(wb.sheet('Category_Chassis'));

  // --------------------------------------------------------------- emission
  await mkdir(dirname(OUT_CONSTANTS), { recursive: true });
  await mkdir(dirname(OUT_SEED), { recursive: true });
  await writeFile(OUT_CONSTANTS, renderConstants(C, hash), 'utf8');
  await writeFile(
    OUT_REFDATA,
    renderRefData(hash, { buildings, archetypes, unitGrades, unitPaths, counter, vetTiers, grades, holdings, research, equipment, celestial, chassis, shardDenoms }),
    'utf8',
  );
  await writeFile(OUT_SEED, renderSeedSql(hash, { buildings, holdings, research, vetTiers, grades }), 'utf8');
  await writeFile(OUT_ASSUMPTIONS, renderAssumptions(C, hash), 'utf8');

  assertNoAssumedCoreConstants(C);

  const assumed = C.list('assumed');
  console.log(
    `ascendance: ${C.entries.length} constants ` +
      `(${C.list('workbook').length} workbook, ${C.list('spec').length} spec, ${C.list('derived').length} derived, ${assumed.length} assumed)`,
  );
  console.log(
    `ascendance: refdata — ${buildings.length} buildings, ${archetypes.length} archetypes, ` +
      `${archetypes.length * unitPaths.length * unitGrades.length} units, ${Object.keys(counter.roles).length} roles, ` +
      `${vetTiers.length} veterancy tiers, ${holdings.length} holding types, ${research.length} disciplines, ${equipment.length} equipment lines`,
  );
  for (const a of assumed) {
    console.warn(`ascendance: [ASSUMED] ${a.name} = ${a.value} — ${a.provenance.ref}`);
  }
  console.log('ascendance: all calibration anchors hold.');
}

// ============================================================================
// Readers
// ============================================================================

function readGrades(s: Sheet): RefGrade[] {
  const h = 0;
  const cGrade = s.headerIndex(h, 'Grade #');
  const cRealm = s.headerIndex(h, 'Realm · Stage');
  const cMin = s.headerIndex(h, 'Min Level');
  const cMax = s.headerIndex(h, 'Max Level');
  const cQi = s.headerIndex(h, 'Breakthrough Qi Cost');
  const cTrib = s.headerIndex(h, 'Tribulation (cultivation)');
  const out: RefGrade[] = [];
  for (const [i, r] of s.dataRows(h).entries()) {
    if (typeof r[cGrade] !== 'number') continue;
    out.push({
      grade: r[cGrade] as number,
      realmStage: String(r[cRealm] ?? ''),
      minLevel: numOrDie(r[cMin], `Grades_Realms row ${i + 2} Min Level`),
      maxLevel: numOrDie(r[cMax], `Grades_Realms row ${i + 2} Max Level`),
      qiCost: String(Math.round(numOrDie(r[cQi], `Grades_Realms row ${i + 2} Qi`))),
      tribulation: String(r[cTrib] ?? ''),
      trial: parseTrial(String(r[cTrib] ?? '')),
    });
  }
  return out;
}

function readArchetypes(s: Sheet, trainConst: number): RefArchetype[] {
  const h = 0;
  const idx = {
    key: s.headerIndex(h, 'Key'),
    era: s.headerIndex(h, 'Era'),
    name: s.headerIndex(h, 'Archetype'),
    role: s.headerIndex(h, 'Role'),
    atk: s.headerIndex(h, 'Base Atk'),
    def: s.headerIndex(h, 'Base Def'),
    hp: s.headerIndex(h, 'Base HP'),
    speed: s.headerIndex(h, 'Base Speed'),
    upkeep: s.headerIndex(h, 'Base Upkeep'),
    train: s.headerIndex(h, 'Base Train (h)'),
  };
  const out: RefArchetype[] = [];
  for (const r of s.dataRows(h)) {
    if (typeof r[idx.era] !== 'number') continue;
    const upkeep = numOrDie(r[idx.upkeep], 'Base Upkeep');
    const declaredTrain = numOrDie(r[idx.train], 'Base Train (h)');
    // The sheet's Base Train column must agree with upkeep * trainConst, or one
    // of them has been edited by hand and the roster is no longer coherent.
    const computed = roundDecimal(upkeep * trainConst, 2);
    if (Math.abs(computed - declaredTrain) > 0.02) {
      throw new ImportError(
        `Archetypes!${String(r[idx.key])}: Base Train (h) = ${declaredTrain} but upkeep ${upkeep} * TRAIN_CONST ${trainConst} = ${computed}`,
      );
    }
    out.push({
      key: String(r[idx.key]),
      era: r[idx.era] as number,
      name: String(r[idx.name]),
      role: String(r[idx.role]),
      atk: numOrDie(r[idx.atk], 'Base Atk'),
      def: numOrDie(r[idx.def], 'Base Def'),
      hp: numOrDie(r[idx.hp], 'Base HP'),
      speed: numOrDie(r[idx.speed], 'Base Speed'),
      upkeep,
      baseTrainHours: declaredTrain,
    });
  }
  if (out.length !== 126) throw new ImportError(`expected 126 archetypes (18 x 7 eras), got ${out.length}`);
  return out;
}

function readUnitGrades(s: Sheet): RefUnitGrade[] {
  const h = 0;
  const idx = {
    g: s.headerIndex(h, 'Grade'),
    stat: s.headerIndex(h, 'Multiplier (Atk/Def/HP)'),
    up: s.headerIndex(h, 'Upkeep Mult'),
    tr: s.headerIndex(h, 'Train Time Mult'),
    un: s.headerIndex(h, 'Unlock'),
  };
  const out = s.dataRows(h).map((r) => {
    const unlock = String(r[idx.un] ?? '');
    return {
      grade: String(r[idx.g]),
      statMult: numOrDie(r[idx.stat], 'grade stat mult'),
      upkeepMult: numOrDie(r[idx.up], 'grade upkeep mult'),
      trainMult: numOrDie(r[idx.tr], 'grade train mult'),
      unlock,
      // The Unlock column is prose, but it is the ONLY place these gates are
      // written down ("Grade >= 12 + Warfare rank 5"). Parsing it keeps the
      // gates tied to the workbook instead of being retyped into game logic,
      // and the assertion below fails the build if the wording ever drifts
      // into something this cannot read.
      requiresDisciplineGrade: parseGate(unlock, /(?:Discipline grade|Grade)\s*[>=\u2265]+\s*(\d+)/),
      requiresWarfareRank: parseGate(unlock, /Warfare rank\s*(\d+)/),
    };
  });
  if (out.length !== 6) throw new ImportError(`expected 6 unit grades, got ${out.length}`);
  // Mortal is the default and gates on nothing; every other grade must gate on
  // something, or the roster's progression has silently become free.
  for (const g of out) {
    if (g.grade === 'Mortal') continue;
    if (g.requiresDisciplineGrade <= 0) {
      throw new ImportError(`Unit_Grades: could not read a discipline-grade gate from ${g.grade}'s Unlock text ${JSON.stringify(g.unlock)}`);
    }
  }
  return out;
}

function readUnitPaths(s: Sheet): RefUnitPath[] {
  const h = 0;
  const idx = {
    p: s.headerIndex(h, 'Path'),
    a: s.headerIndex(h, 'Atk Mod'),
    d: s.headerIndex(h, 'Def Mod'),
    hp: s.headerIndex(h, 'HP Mod'),
    sp: s.headerIndex(h, 'Speed Mod'),
    id: s.headerIndex(h, 'Identity'),
  };
  const out = s.dataRows(h).map((r) => ({
    path: String(r[idx.p]),
    atkMod: numOrDie(r[idx.a], 'path atk mod'),
    defMod: numOrDie(r[idx.d], 'path def mod'),
    hpMod: numOrDie(r[idx.hp], 'path hp mod'),
    speedMod: numOrDie(r[idx.sp], 'path speed mod'),
    identity: String(r[idx.id] ?? ''),
  }));
  if (out.length !== 3) throw new ImportError(`expected 3 identity paths, got ${out.length}`);
  return out;
}

function readVeterancyTiers(s: Sheet): RefVeterancyTier[] {
  const h = findHeaderRow(s, 'Tier');
  const idx = {
    t: s.headerIndex(h, 'Tier'),
    n: s.headerIndex(h, 'Name'),
    cl: s.headerIndex(h, 'Cumulative levels'),
    sb: s.headerIndex(h, 'Total stat bonus'),
    c: s.headerIndex(h, 'Tier-up cost'),
    rep: s.headerIndex(h, 'Reputation at this tier'),
  };
  const out: RefVeterancyTier[] = [];
  for (const r of s.dataRows(h)) {
    if (typeof r[idx.t] !== 'number') continue;
    const cost = r[idx.c];
    out.push({
      tier: r[idx.t] as number,
      name: String(r[idx.n]),
      cumulativeLevels: numOrDie(r[idx.cl], 'cumulative levels'),
      totalStatBonus: parseFloat(String(r[idx.sb]).replace('x', '')),
      tierUpCost: typeof cost === 'number' ? String(Math.round(cost)) : '0',
      reputation: String(r[idx.rep] ?? ''),
    });
  }
  if (out.length !== 24) throw new ImportError(`expected 24 veterancy tiers, got ${out.length}`);
  return out;
}

function readCounterMatrix(s: Sheet, maxAllowed: number): { roles: Record<string, number>; rows: number[][] } {
  const header = s.rows[0] ?? [];
  const roles: string[] = [];
  for (let c = 1; c < header.length; c++) {
    const v = header[c];
    if (typeof v === 'string' && v.trim()) roles.push(v.trim());
  }
  const index: Record<string, number> = {};
  roles.forEach((r, i) => (index[r] = i));
  const rows: number[][] = roles.map(() => roles.map(() => 1));
  let strongest = 0;
  for (const r of s.dataRows(0)) {
    const name = String(r[0]).trim();
    const ri = index[name];
    if (ri === undefined) continue;
    for (let c = 0; c < roles.length; c++) {
      const v = r[c + 1];
      if (typeof v !== 'number') {
        throw new ImportError(`Counter_Matrix[${name}][${roles[c]}] is ${JSON.stringify(v)}; expected a number`);
      }
      if (v <= 0) throw new ImportError(`Counter_Matrix[${name}][${roles[c]}] = ${v}; must be positive (roleFactor divides by it)`);
      rows[ri]![c] = v;
      strongest = Math.max(strongest, v);
    }
  }
  if (strongest > maxAllowed + 1e-9) {
    throw new ImportError(
      `CALIBRATION ANCHOR (spec/07 §3.5): strongest counter-matrix entry is ${strongest}, ` +
        `above the sanctioned maximum of ${maxAllowed}. Nothing may produce a larger single-source multiplier without review.`,
    );
  }
  if (roles.length !== 34) throw new ImportError(`expected 34 roles in Counter_Matrix, got ${roles.length}`);
  return { roles: index, rows };
}

function readBuildings(master: Sheet, specs: Sheet): RefBuilding[] {
  const h = 0;
  const idx = {
    era: master.headerIndex(h, 'Era'),
    name: master.headerIndex(h, 'Building'),
    cat: master.headerIndex(h, 'Category'),
    fn: master.headerIndex(h, 'Function / Base Output'),
    t: master.headerIndex(h, 'Base Timber-eq'),
    s: master.headerIndex(h, 'Base Stone/Metal-eq'),
    sp: master.headerIndex(h, 'Base Special-eq'),
  };
  // Era I flavour: purpose, distinctive mechanic, synergies, art brief.
  const sh = 0;
  const si = {
    name: specs.headerIndex(sh, 'Building'),
    purpose: specs.headerIndex(sh, 'Purpose'),
    mech: specs.headerIndex(sh, 'Distinctive mechanic'),
    syn: specs.headerIndex(sh, 'Key synergies'),
    art: specs.headerIndex(sh, 'Visual DNA (art brief)'),
  };
  const spec = new Map<string, { purpose: string; mechanic: string; synergies: string; art: string }>();
  for (const r of specs.dataRows(sh)) {
    const n = String(r[si.name] ?? '').trim();
    if (!n) continue;
    spec.set(n, {
      purpose: String(r[si.purpose] ?? ''),
      mechanic: String(r[si.mech] ?? ''),
      synergies: String(r[si.syn] ?? ''),
      art: String(r[si.art] ?? ''),
    });
  }

  const seen = new Set<string>();
  const out: RefBuilding[] = [];
  for (const r of master.dataRows(h)) {
    if (typeof r[idx.era] !== 'number') continue;
    const era = r[idx.era] as number;
    const name = String(r[idx.name]).trim();
    const key = slug(`${era}_${name}`);
    if (seen.has(key)) throw new ImportError(`Buildings_Master: duplicate building key ${key}`);
    seen.add(key);
    const category = String(r[idx.cat]).trim();
    const b: RefBuilding = {
      key,
      name,
      era,
      category,
      functionText: String(r[idx.fn] ?? ''),
      baseTimber: numOrDie(r[idx.t], `${name} Base Timber-eq`),
      baseStone: numOrDie(r[idx.s], `${name} Base Stone/Metal-eq`),
      baseSpecial: numOrDie(r[idx.sp], `${name} Base Special-eq`),
      sizeClass: sizeClassFor(category),
    };
    const extra = era === 1 ? spec.get(name) : undefined;
    if (extra) {
      b.purpose = extra.purpose;
      b.mechanic = extra.mechanic;
      b.synergies = extra.synergies;
      b.art = extra.art;
    }
    out.push(b);
  }
  if (out.length !== 483) throw new ImportError(`expected 483 buildings (69 per era x 7), got ${out.length}`);
  return out;
}

/**
 * Size class (plots occupied) by category.
 *
 * [ASSUMED — spec/00 §5] The workbook records size classes only as prose in
 * Building_Framework ("Buildings occupy 1-4 plots by size class") and does not
 * yet carry a per-building column. Category defaults are used until the balance
 * owner assigns per-building values; spec/10 lists this as an open content task.
 */
function sizeClassFor(category: string): number {
  switch (category) {
    case 'HQ/Governance':
      return 4;
    case 'Military':
    case 'Defense':
    case 'Special':
      return 3;
    case 'Processing':
    case 'Knowledge':
    case 'Logistics':
    case 'Cultivation':
      return 2;
    default:
      return 1; // Extraction, Trade, Culture
  }
}

function readHoldings(s: Sheet): RefHolding[] {
  const h = 0;
  const idx = {
    t: s.headerIndex(h, 'Holding type'),
    era: s.headerIndex(h, 'Era'),
    layer: s.headerIndex(h, 'Layer'),
    p0: s.headerIndex(h, 'Plots at founding'),
    pm: s.headerIndex(h, 'Max plots'),
    ac: s.headerIndex(h, 'Admin cost'),
    pr: s.headerIndex(h, 'What it can produce'),
    n: s.headerIndex(h, 'Notes'),
  };
  const out: RefHolding[] = [];
  for (const r of s.dataRows(h)) {
    if (typeof r[idx.p0] !== 'number') continue;
    const name = String(r[idx.t]).trim();
    out.push({
      key: slug(name),
      name,
      era: String(r[idx.era] ?? ''),
      layer: String(r[idx.layer] ?? '').toLowerCase(),
      plotsAtFounding: r[idx.p0] as number,
      maxPlots: numOrDie(r[idx.pm], 'max plots'),
      adminCost: numOrDie(r[idx.ac], 'admin cost'),
      produces: String(r[idx.pr] ?? ''),
      notes: String(r[idx.n] ?? ''),
    });
  }
  if (out.length !== 12) throw new ImportError(`expected 12 holding types, got ${out.length}`);
  return out;
}

function readResearch(s: Sheet): RefResearch[] {
  const h = 0;
  const idx = {
    d: s.headerIndex(h, 'Discipline'),
    e: s.headerIndex(h, 'Era'),
    b: s.headerIndex(h, 'Branch'),
    pl: s.headerIndex(h, 'Per-level effect (base)'),
    pre: s.headerIndex(h, 'Prerequisite'),
  };
  const out: RefResearch[] = [];
  for (const r of s.dataRows(h)) {
    if (typeof r[idx.e] !== 'number') continue;
    const name = String(r[idx.d]).trim();
    const perLevel = String(r[idx.pl] ?? '');
    const pct = /([\d.]+)\s*%/.exec(perLevel);
    if (!pct) {
      throw new ImportError(`Research_Disciplines!${name}: cannot read a per-level percentage from ${JSON.stringify(perLevel)}`);
    }
    out.push({
      key: slug(name),
      name,
      era: r[idx.e] as number,
      branch: String(r[idx.b] ?? ''),
      perLevel,
      prerequisite: String(r[idx.pre] ?? ''),
      perLevelPct: Number(pct[1]) / 100,
    });
  }
  if (out.length !== 21) throw new ImportError(`expected 21 research disciplines (3 branches x 7 eras), got ${out.length}`);
  return out;
}

function readEquipment(s: Sheet): RefEquipment[] {
  const h = 0;
  const idx = {
    i: s.headerIndex(h, 'Item'),
    s: s.headerIndex(h, 'Slot'),
    t: s.headerIndex(h, 'Tier'),
    q: s.headerIndex(h, 'Quality'),
    b: s.headerIndex(h, 'Bonus %'),
    m: s.headerIndex(h, 'Material Cost Mult'),
    src: s.headerIndex(h, 'Source'),
  };
  const out: RefEquipment[] = [];
  for (const r of s.dataRows(h)) {
    if (typeof r[idx.t] !== 'number') continue;
    const name = String(r[idx.i]).trim();
    const mult = r[idx.m];
    out.push({
      key: slug(name),
      name,
      slot: String(r[idx.s]),
      tier: r[idx.t] as number,
      quality: String(r[idx.q]),
      bonusPct: numOrDie(r[idx.b], `${name} bonus %`),
      costMult: typeof mult === 'number' ? mult : null,
      source: String(r[idx.src] ?? ''),
    });
  }
  if (out.length !== 135) throw new ImportError(`expected 135 equipment lines (3 slots x 9 tiers x 5 qualities), got ${out.length}`);
  return out;
}

function readCelestial(s: Sheet): RefCelestial[] {
  const out: RefCelestial[] = [];
  for (const r of s.dataRows(0)) {
    out.push({ name: String(r[0] ?? ''), a: String(r[1] ?? ''), b: String(r[2] ?? ''), c: String(r[3] ?? '') });
  }
  return out;
}

function readChassis(s: Sheet): RefChassis[] {
  const h = 0;
  const idx = {
    c: s.headerIndex(h, 'Category'),
    f: s.headerIndex(h, 'Core output formula'),
    m: s.headerIndex(h, 'Distinctive mechanics'),
    sc: s.headerIndex(h, 'Scales with level by'),
    v: s.headerIndex(h, 'Primary vulnerability'),
  };
  return s.dataRows(h).map((r) => ({
    category: String(r[idx.c] ?? ''),
    outputFormula: String(r[idx.f] ?? ''),
    mechanics: String(r[idx.m] ?? ''),
    scaling: String(r[idx.sc] ?? ''),
    vulnerability: String(r[idx.v] ?? ''),
  }));
}

function readShardDenominations(s: Sheet): { name: string; hours: number; source: string }[] {
  const h = findHeaderRow(s, 'Shard');
  const idx = { n: s.headerIndex(h, 'Shard'), hrs: s.headerIndex(h, 'Hours granted'), src: s.headerIndex(h, 'Typical source') };
  const out: { name: string; hours: number; source: string }[] = [];
  for (const r of s.dataRows(h)) {
    if (typeof r[idx.hrs] !== 'number') break;
    out.push({ name: String(r[idx.n]), hours: r[idx.hrs] as number, source: String(r[idx.src] ?? '') });
  }
  if (out.length !== 6) throw new ImportError(`expected 6 shard denominations, got ${out.length}`);
  return out;
}

// ============================================================================
// Calibration anchors — spec/07 §3. Each one FAILS THE BUILD when violated.
// ============================================================================

/** The emitted curve constants must reproduce the workbook's own columns. */
function verifyBuildingCurves(
  s: Sheet,
  k: { BUILD_COST_EXP: number; BUILD_COST_GEO: number; BUILD_TIME_K: number; BUILD_TIME_EXP: number; BUILD_TIME_GEO: number; OUTPUT_EXP: number },
): void {
  const cCost = s.headerIndex(0, 'Cost Multiplier');
  const cTime = s.headerIndex(0, 'Build/Research Time (hours)');
  const cOut = s.headerIndex(0, 'Output Multiplier');
  for (const level of [0, 1, 7, 64, 333, 1000, 1337]) {
    const row = level + 1; // header at row 0, level L at row L+1
    const cost = s.num(row, cCost, `Building_Levels cost multiplier @L${level}`);
    const time = s.num(row, cTime, `Building_Levels time @L${level}`);
    const out = s.num(row, cOut, `Building_Levels output multiplier @L${level}`);
    approx(`cost multiplier @L${level}`, Math.pow(level + 1, k.BUILD_COST_EXP) * Math.pow(k.BUILD_COST_GEO, level), cost, 1e-6);
    approx(`build time @L${level}`, k.BUILD_TIME_K * Math.pow(level + 1, k.BUILD_TIME_EXP) * Math.pow(k.BUILD_TIME_GEO, level), time, 1e-6);
    approx(`output multiplier @L${level}`, Math.pow(level + 1, k.OUTPUT_EXP), out, 1e-6);
  }
}

/** ANCHOR 1 — a full 0→1337 climb takes exactly 500 years. */
function assertClimbAnchor(s: Sheet, k: { BUILD_TIME_K: number; BUILD_TIME_EXP: number; BUILD_TIME_GEO: number }, maxLevel: number): number {
  let total = 0;
  for (let L = 0; L <= maxLevel; L++) {
    total += k.BUILD_TIME_K * Math.pow(L + 1, k.BUILD_TIME_EXP) * Math.pow(k.BUILD_TIME_GEO, L);
  }
  const declared = s.labelledBelow('Total climb (hours)', 8);
  approx('CALIBRATION ANCHOR 1 (500-year climb)', declared.value, total, 1e-4);
  const years = total / 8766;
  if (Math.abs(years - 500) > 0.01) {
    throw new ImportError(`CALIBRATION ANCHOR 1 (spec/07 §3.1): full climb is ${years.toFixed(4)} years, expected 500`);
  }
  return total;
}

/** ANCHOR 2 — a Mythic Path Avatar trains in exactly 4,383 hours (6 months). */
function assertRosterAnchor(archetypes: RefArchetype[], grades: RefUnitGrade[], trainConst: number): void {
  const avatar = archetypes.find((a) => a.name === 'Path Avatar');
  if (!avatar) throw new ImportError('CALIBRATION ANCHOR 2: no "Path Avatar" archetype in Archetypes');
  const mythic = grades.find((g) => g.grade === 'Mythic');
  if (!mythic) throw new ImportError('CALIBRATION ANCHOR 2: no "Mythic" row in Unit_Grades');
  const hours = avatar.upkeep * trainConst * mythic.trainMult;
  if (Math.abs(hours - 4383) > 0.5) {
    throw new ImportError(
      `CALIBRATION ANCHOR 2 (spec/07 §3.2): Mythic Path Avatar trains in ${hours.toFixed(2)}h, expected 4383h (6 months)`,
    );
  }
}

/** ANCHOR 3 — the complete 24-tier ladder is 322x total stat bonus. */
function assertVeterancyLadder(tiers: RefVeterancyTier[], k: { VET_PER_LEVEL: number; LEVELS_PER_TIER: number }): void {
  const top = tiers[tiers.length - 1]!;
  const computed = 1 + k.VET_PER_LEVEL * top.cumulativeLevels;
  approx('CALIBRATION ANCHOR 3 (322x veterancy ladder)', top.totalStatBonus, computed, 0.02);
  if (Math.abs(computed - 321.88) > 0.5) {
    throw new ImportError(`CALIBRATION ANCHOR 3 (spec/07 §3.3): ladder totals ${computed.toFixed(2)}x, expected ~321.88x`);
  }
  for (const [i, t] of tiers.entries()) {
    const expected = (i + 1) * k.LEVELS_PER_TIER;
    if (t.cumulativeLevels !== expected) {
      throw new ImportError(`Veterancy_Tiers: tier ${t.tier} cumulative levels ${t.cumulativeLevels}, expected ${expected}`);
    }
  }
}

function assertTierUpCosts(tiers: RefVeterancyTier[], k: { TIERUP_BASE: number; TIERUP_MULT: number }): void {
  for (const t of tiers) {
    if (t.tier < 2) continue;
    const expected = Math.round(k.TIERUP_BASE * Math.pow(k.TIERUP_MULT, t.tier - 2));
    const declared = Number(t.tierUpCost);
    if (relErr(expected, declared) > 1e-6) {
      throw new ImportError(`Veterancy_Tiers: tier ${t.tier} cost ${declared}, formula gives ${expected}`);
    }
  }
}

/** ANCHOR 6 — empire weight caps at 9,918,521x, and the published curve holds. */
function assertEmpireWeightCurve(s: Sheet, k: { EW_KNEE: number; EW_STEEPNESS: number; EW_CAP: number }): void {
  if (k.EW_CAP !== 9_918_521) {
    throw new ImportError(`CALIBRATION ANCHOR 6 (spec/07 §3.6): empire weight cap is ${k.EW_CAP}, expected 9918521`);
  }
  const cW = s.headerIndex(findHeaderRow(s, 'Empire profile'), 'Weight');
  const cM = s.headerIndex(findHeaderRow(s, 'Empire profile'), 'XP requirement ×');
  let checked = 0;
  for (const r of s.dataRows(findHeaderRow(s, 'Empire profile'))) {
    const w = r[cW];
    const m = r[cM];
    if (typeof w !== 'number' || typeof m !== 'number') continue;
    const computed = Math.min(k.EW_CAP, 1 + Math.pow(w / k.EW_KNEE, k.EW_STEEPNESS));
    if (relErr(computed, m) > 1e-6) {
      throw new ImportError(`Empire_Weight_Multiplier: W=${w} tabulated ${m}, formula gives ${computed}`);
    }
    checked++;
  }
  if (checked < 8) throw new ImportError(`Empire_Weight_Multiplier: only ${checked} curve rows verified; expected the full published curve`);
}

/**
 * The tribulation ladder has to survive the parse.
 *
 * spec/08 M9's acceptance test is that "a tribulation is a scheduled, publicly
 * visible event that rivals can interfere with". If no grade parses as
 * crashable, that event does not exist and the milestone cannot be met — so
 * this fails the build rather than shipping a cultivation system with the
 * interesting part quietly missing.
 */
function assertTribulationsParsed(grades: RefGrade[]): void {
  const crashable = grades.filter((g) => g.trial.crashable);
  if (crashable.length === 0) {
    throw new ImportError(
      'Grades_Realms: no tribulation parsed as crashable. spec/08 M9 requires a publicly visible trial ' +
        'that rivals can interfere with; the Tribulation column no longer says so in a form this can read.',
    );
  }
  const named = grades.filter((g) => !g.trial.none);
  if (named.length < 30) {
    throw new ImportError(`Grades_Realms: only ${named.length} grades carry a tribulation; expected most of the 42`);
  }
  if (!grades.some((g) => g.trial.stunMs > 0)) {
    throw new ImportError('Grades_Realms: no tribulation parsed a failure stun duration');
  }
  if (!grades.some((g) => g.trial.karmaWeighted)) {
    throw new ImportError('Grades_Realms: no tribulation parsed as reputation-weighted');
  }
}

function assertQiCurve(grades: RefGrade[], k: { QI_BASE: number; QI_EXP: number; QI_GEO: number }): void {
  for (const g of grades) {
    const expected = Math.round(k.QI_BASE * Math.pow(g.grade, k.QI_EXP) * Math.pow(k.QI_GEO, g.grade));
    if (relErr(expected, Number(g.qiCost)) > 1e-6) {
      throw new ImportError(`Grades_Realms: grade ${g.grade} Qi cost ${g.qiCost}, formula gives ${expected}`);
    }
  }
}

function assertShardCeilingTable(s: Sheet, k: { SHARD_BASE: number; SHARD_PER_RANK: number; SHARD_PER_ERA: number }): void {
  const h = findHeaderRow(s, 'Construction rank');
  const cR = s.headerIndex(h, 'Construction rank');
  const cE = s.headerIndex(h, 'Era');
  const cM = s.headerIndex(h, 'Max compression');
  let checked = 0;
  for (const r of s.dataRows(h)) {
    const rank = r[cR];
    const era = r[cE];
    const max = r[cM];
    if (typeof rank !== 'number' || typeof era !== 'number' || typeof max !== 'number') continue;
    const computed = k.SHARD_BASE + k.SHARD_PER_RANK * rank + k.SHARD_PER_ERA * era;
    if (Math.abs(computed - max) > 0.051) {
      throw new ImportError(`Chrono_Shards: rank ${rank} era ${era} tabulated ${max}, formula gives ${computed}`);
    }
    checked++;
  }
  if (checked < 7) throw new ImportError(`Chrono_Shards: only ${checked} ceiling rows verified; expected the full published table`);
}

/**
 * M3 acceptance test, run at import time (spec/08 M3):
 * all 2,268 units GENERATE from the parameter sheets and match Units_Master
 * exactly. If this holds, the roster really does rebalance from a handful of
 * constants — which is the property that has to survive into the codebase.
 */
function assertRosterMatchesMaster(
  master: Sheet,
  archetypes: RefArchetype[],
  grades: RefUnitGrade[],
  paths: RefUnitPath[],
): void {
  const h = 0;
  const idx = {
    name: master.headerIndex(h, 'Unit Name'),
    key: master.headerIndex(h, 'Key'),
    path: master.headerIndex(h, 'Path'),
    grade: master.headerIndex(h, 'Grade'),
    role: master.headerIndex(h, 'Role'),
    atk: master.headerIndex(h, 'Atk'),
    def: master.headerIndex(h, 'Def'),
    hp: master.headerIndex(h, 'HP'),
    speed: master.headerIndex(h, 'Speed'),
    upkeep: master.headerIndex(h, 'Upkeep'),
    train: master.headerIndex(h, 'Train Time (h)'),
  };
  const declared = new Map<string, Cell[]>();
  for (const r of master.dataRows(h)) {
    declared.set(`${String(r[idx.key])}|${String(r[idx.path])}|${String(r[idx.grade])}`, r);
  }
  const expectedCount = archetypes.length * paths.length * grades.length;
  if (declared.size !== expectedCount) {
    throw new ImportError(`Units_Master has ${declared.size} rows; ${archetypes.length} archetypes x ${paths.length} paths x ${grades.length} grades = ${expectedCount}`);
  }
  let checked = 0;
  for (const a of archetypes) {
    for (const p of paths) {
      for (const g of grades) {
        const row = declared.get(`${a.key}|${p.path}|${g.grade}`);
        if (!row) throw new ImportError(`Units_Master is missing ${a.key} / ${p.path} / ${g.grade}`);
        const gen = generateUnit(a, p, g);
        cmp(a.key, p.path, g.grade, 'Atk', gen.atk, row[idx.atk]);
        cmp(a.key, p.path, g.grade, 'Def', gen.def, row[idx.def]);
        cmp(a.key, p.path, g.grade, 'HP', gen.hp, row[idx.hp]);
        cmp(a.key, p.path, g.grade, 'Speed', gen.speed, row[idx.speed]);
        cmp(a.key, p.path, g.grade, 'Upkeep', gen.upkeep, row[idx.upkeep]);
        cmp(a.key, p.path, g.grade, 'Train Time (h)', gen.trainHours, row[idx.train]);
        if (String(row[idx.name]).trim() !== gen.name) {
          throw new ImportError(`Units_Master ${a.key}/${p.path}/${g.grade}: name ${JSON.stringify(String(row[idx.name]))}, generated ${JSON.stringify(gen.name)}`);
        }
        if (String(row[idx.role]) !== a.role) {
          throw new ImportError(`Units_Master ${a.key}/${p.path}/${g.grade}: role ${String(row[idx.role])} != archetype role ${a.role}`);
        }
        checked++;
      }
    }
  }
  if (checked !== 2268) throw new ImportError(`M3 acceptance: verified ${checked} units, expected 2268`);
}

function cmp(key: string, path: string, grade: string, field: string, generated: number, declared: Cell | undefined): void {
  if (typeof declared !== 'number') {
    throw new ImportError(`Units_Master ${key}/${path}/${grade}: ${field} is ${JSON.stringify(declared)}, expected a number`);
  }
  // Exact match required: generation reproduces the workbook's own rounding.
  if (Math.abs(generated - declared) > 1e-9) {
    throw new ImportError(`Units_Master ${key}/${path}/${grade}: ${field} declared ${declared}, generated ${generated}`);
  }
}

// ============================================================================
// Emitters
// ============================================================================

/**
 * The constants that appear in spec/07 §2's formula table and §3's calibration
 * anchors. These define the shape of the economy, so an ASSUMED value here is
 * not a gap to fill later — it means a formula has been reimplemented from
 * memory rather than from the workbook. Fail the build.
 */
const CORE_CONSTANTS = [
  'BUILD_COST_EXP', 'BUILD_COST_GEO', 'BUILD_TIME_K', 'BUILD_TIME_EXP', 'BUILD_TIME_GEO', 'OUTPUT_EXP',
  'TRAIN_CONST', 'VET_PER_LEVEL', 'XP_BASE', 'XP_LEVEL_EXP', 'XP_TIER_MULT',
  'FATIGUE_LEVEL_EXP', 'FATIGUE_TIER_DIV', 'EW_KNEE', 'EW_STEEPNESS', 'EW_CAP',
  'TIERUP_BASE', 'TIERUP_MULT', 'QI_BASE', 'QI_EXP', 'QI_GEO',
  'SHARD_BASE', 'SHARD_PER_RANK', 'SHARD_PER_ERA', 'JOINT_BONUS_CAP', 'COUNTER_MAX',
  'MORALE_MIN', 'MORALE_MAX', 'MAX_GRADE', 'MAX_LEVEL', 'LEVELS_PER_GRADE',
  'LEVELS_PER_TIER', 'MAX_VET_TIER', 'ENVY_PER_SCOPE', 'FORT_PER_GRADE',
] as const;

function assertNoAssumedCoreConstants(C: ConstantSet): void {
  const assumed = new Set(C.list('assumed').map((e) => e.name));
  const bad = CORE_CONSTANTS.filter((n) => assumed.has(n));
  if (bad.length > 0) {
    throw new ImportError(
      `these constants define the economy and may never be assumed: ${bad.join(', ')}. ` +
        `Read them from the workbook or cite the specification section that fixes them.`,
    );
  }
  for (const n of CORE_CONSTANTS) {
    if (!C.entries.some((e) => e.name === n)) {
      throw new ImportError(`core constant ${n} was not emitted; spec/07 §2 requires it`);
    }
  }
}

/**
 * The assumptions register.
 *
 * spec/00 §5: "Never silently invent a balance number." Where the workbook and
 * the specification both leave a number unstated, it is emitted with an
 * [ASSUMED] marker AND written here, so the balance owner has a single list to
 * work through rather than a diff to read.
 */
function renderAssumptions(C: ConstantSet, hash: string): string {
  const assumed = C.list('assumed');
  const out: string[] = [];
  out.push('# Assumed balance constants');
  out.push('');
  out.push('GENERATED by `packages/tools/src/import-workbook.ts` — do not edit.');
  out.push(`Balance revision \`${hash.slice(0, 16)}\`.`);
  out.push('');
  out.push('`spec/00_README_FIRST.md` §5 requires that a missing balance number is never');
  out.push('silently invented. Each constant below is one the workbook does not carry and');
  out.push('the specification does not fix. Each is marked `[ASSUMED]` in the generated');
  out.push('constants module, printed by the importer on every run, and listed here for the');
  out.push('balance owner to confirm or correct.');
  out.push('');
  out.push('Correcting one means adding the real value to the appropriate workbook sheet and');
  out.push('changing its reader in the importer from `C.assumed(...)` to `C.fromWorkbook(...)`.');
  out.push('');
  out.push(`## ${assumed.length} open assumptions`);
  out.push('');
  out.push('| Constant | Assumed value | Why it is not in the workbook | Reasoning for the value |');
  out.push('|---|---|---|---|');
  for (const a of assumed) {
    out.push(`| \`${a.name}\` | ${Array.isArray(a.value) ? `[${a.value.join(', ')}]` : a.value} | ${a.provenance.ref} | ${a.note} |`);
  }
  out.push('');
  out.push('## What is NOT assumed');
  out.push('');
  out.push(`${C.list('workbook').length} constants are read directly from workbook cells,`);
  out.push(`${C.list('spec').length} are fixed by the specification text, and`);
  out.push(`${C.list('derived').length} are computed from the others so they cannot drift.`);
  out.push('The constants naming the six calibration anchors and the core formula shapes can');
  out.push('never be assumed — the importer fails the build if one ever is.');
  out.push('');
  return out.join('\n');
}

function renderConstants(C: ConstantSet, hash: string): string {
  const lines: string[] = [];
  lines.push(header('constants.ts', hash));
  lines.push('/** Where a constant came from, so a wrong number is traceable in one step. */');
  lines.push("export type Provenance = 'workbook' | 'spec' | 'derived' | 'assumed';");
  lines.push('');
  lines.push('export interface ConstantMeta {');
  lines.push('  readonly value: number | readonly number[];');
  lines.push('  readonly provenance: Provenance;');
  lines.push('  /** The workbook cell, spec section, or rationale this value came from. */');
  lines.push('  readonly ref: string;');
  lines.push('  readonly note: string;');
  lines.push('}');
  lines.push('');
  lines.push('/** Every balance constant, keyed by name, with its provenance. */');
  lines.push('export const CONSTANT_META: Readonly<Record<string, ConstantMeta>> = Object.freeze({');
  for (const e of C.entries) {
    lines.push(
      `  ${e.name}: Object.freeze({ value: ${lit(e.value)}, provenance: '${e.provenance.kind}', ref: ${JSON.stringify(e.provenance.ref)}, note: ${JSON.stringify(e.note)} }),`,
    );
  }
  lines.push('});');
  lines.push('');
  lines.push('/**');
  lines.push(' * The balance constants themselves.');
  lines.push(' *');
  lines.push(' * Import this — never a literal — anywhere a game number is needed.');
  lines.push(' * A magic number in game logic is a defect (spec/00 §2.5).');
  lines.push(' */');
  lines.push('export const C = Object.freeze({');
  for (const e of C.entries) {
    const src = e.provenance.kind === 'assumed' ? `[ASSUMED] ${e.provenance.ref}` : e.provenance.ref;
    lines.push(`  /** ${e.note || src}${e.note ? ` — ${src}` : ''} */`);
    lines.push(`  ${e.name}: ${lit(e.value)},`);
  }
  lines.push('} as const);');
  lines.push('');
  lines.push('export type Constants = typeof C;');
  lines.push('');
  lines.push('/**');
  lines.push(' * Content hash of Ascendance_Master_Tables.xlsx at import time.');
  lines.push(' * A running server reports this so it is always clear which balance');
  lines.push(' * revision produced a given result (spec/07 §1).');
  lines.push(' */');
  lines.push(`export const BALANCE_REVISION = ${JSON.stringify(hash)} as const;`);
  lines.push('');
  lines.push('/** Constants the balance owner still has to confirm (spec/00 §5). */');
  lines.push(
    `export const ASSUMED_CONSTANTS: readonly string[] = Object.freeze([${C.list('assumed').map((e) => JSON.stringify(e.name)).join(', ')}]);`,
  );
  lines.push('');
  return lines.join('\n');
}

function renderRefData(hash: string, d: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(header('refdata.ts', hash));
  lines.push(`export interface RefBuilding { key: string; name: string; era: number; category: string; functionText: string; baseTimber: number; baseStone: number; baseSpecial: number; sizeClass: number; purpose?: string; mechanic?: string; synergies?: string; art?: string }`);
  lines.push(`export interface RefArchetype { key: string; era: number; name: string; role: string; atk: number; def: number; hp: number; speed: number; upkeep: number; baseTrainHours: number }`);
  lines.push(`export interface RefUnitGrade {
  grade: string; statMult: number; upkeepMult: number; trainMult: number; unlock: string;
  /** Minimum research discipline grade, parsed from the Unlock column. */
  requiresDisciplineGrade: number;
  /** Minimum Warfare proficiency rank, where the Unlock column names one. */
  requiresWarfareRank: number;
}`);
  lines.push(`export interface RefUnitPath { path: string; atkMod: number; defMod: number; hpMod: number; speedMod: number; identity: string }`);
  lines.push(`export interface RefVeterancyTier { tier: number; name: string; cumulativeLevels: number; totalStatBonus: number; tierUpCost: string; reputation: string }`);
  lines.push(`export interface RefGrade {
  grade: number; realmStage: string; minLevel: number; maxLevel: number; qiCost: string; tribulation: string;
  /** Parsed from the Tribulation column: what the trial actually does. */
  trial: RefTrial;
}

interface RefTrial {
  /** The trial's own name, e.g. "Lightning Tribulation". */
  name: string;
  /** No trial at all — the mortal realms are passed by effort alone. */
  none: boolean;
  /** Nearby players can see this one happening. */
  visible: boolean;
  /** And can interfere with it. This is the M9 acceptance test. */
  crashable: boolean;
  /** Failure suspends cultivation for this long, where the sheet says so. */
  stunMs: number;
  /** Difficulty is weighted by the player's reputation. */
  karmaWeighted: boolean;
}`);
  lines.push(`export interface RefHolding { key: string; name: string; era: string; layer: string; plotsAtFounding: number; maxPlots: number; adminCost: number; produces: string; notes: string }`);
  lines.push(`export interface RefResearch {
  key: string; name: string; era: number; branch: string; perLevel: string; prerequisite: string;
  /** The per-level effect as a fraction, parsed from "+0.3% ... / level". */
  perLevelPct: number;
}`);
  lines.push(`export interface RefEquipment { key: string; name: string; slot: string; tier: number; quality: string; bonusPct: number; costMult: number | null; source: string }`);
  lines.push(`export interface RefCelestial { name: string; a: string; b: string; c: string }`);
  lines.push(`export interface RefChassis { category: string; outputFormula: string; mechanics: string; scaling: string; vulnerability: string }`);
  lines.push(`export interface RefShardDenom { name: string; hours: number; source: string }`);
  lines.push('');
  lines.push('/** role name -> index into COUNTER_MATRIX rows/columns. */');
  lines.push(`export const COUNTER_ROLES: Readonly<Record<string, number>> = ${json((d['counter'] as { roles: unknown }).roles)};`);
  lines.push('/** COUNTER_MATRIX[attackerRoleIndex][defenderRoleIndex]. */');
  lines.push(`export const COUNTER_MATRIX: readonly (readonly number[])[] = ${json((d['counter'] as { rows: unknown }).rows)};`);
  lines.push('');
  for (const [name, type] of [
    ['BUILDINGS', 'RefBuilding'],
    ['ARCHETYPES', 'RefArchetype'],
    ['UNIT_GRADES', 'RefUnitGrade'],
    ['UNIT_PATHS', 'RefUnitPath'],
    ['VETERANCY_TIERS', 'RefVeterancyTier'],
    ['GRADES', 'RefGrade'],
    ['HOLDINGS', 'RefHolding'],
    ['RESEARCH', 'RefResearch'],
    ['EQUIPMENT', 'RefEquipment'],
    ['CELESTIAL_SITES', 'RefCelestial'],
    ['CATEGORY_CHASSIS', 'RefChassis'],
    ['SHARD_DENOMINATIONS', 'RefShardDenom'],
  ] as const) {
    const keyMap: Record<string, string> = {
      BUILDINGS: 'buildings',
      ARCHETYPES: 'archetypes',
      UNIT_GRADES: 'unitGrades',
      UNIT_PATHS: 'unitPaths',
      VETERANCY_TIERS: 'vetTiers',
      GRADES: 'grades',
      HOLDINGS: 'holdings',
      RESEARCH: 'research',
      EQUIPMENT: 'equipment',
      CELESTIAL_SITES: 'celestial',
      CATEGORY_CHASSIS: 'chassis',
      SHARD_DENOMINATIONS: 'shardDenoms',
    };
    lines.push(`export const ${name}: readonly ${type}[] = ${json(d[keyMap[name]!])};`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderSeedSql(hash: string, d: { buildings: RefBuilding[]; holdings: RefHolding[]; research: RefResearch[]; vetTiers: RefVeterancyTier[]; grades: RefGrade[] }): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const out: string[] = [];
  out.push(`-- GENERATED by packages/tools/src/import-workbook.ts — DO NOT EDIT.`);
  out.push(`-- Source: data/Ascendance_Master_Tables.xlsx sha256 ${hash}`);
  out.push(`-- Reference tables are generated from the workbook, never hand-edited (spec/02 §8).`);
  out.push('');
  out.push('BEGIN;');
  out.push('TRUNCATE ref_building, ref_holding_type, ref_research, ref_veterancy_tier, ref_grade;');
  out.push('');
  for (const b of d.buildings) {
    out.push(
      `INSERT INTO ref_building (building_key, name, era, category, function_text, base_timber, base_stone, base_special, size_class) VALUES (${q(b.key)}, ${q(b.name)}, ${b.era}, ${q(b.category)}, ${q(b.functionText)}, ${b.baseTimber}, ${b.baseStone}, ${b.baseSpecial}, ${b.sizeClass});`,
    );
  }
  out.push('');
  for (const h of d.holdings) {
    out.push(
      `INSERT INTO ref_holding_type (holding_key, name, era, layer, plots_at_founding, max_plots, admin_cost) VALUES (${q(h.key)}, ${q(h.name)}, ${q(h.era)}, ${q(h.layer)}, ${h.plotsAtFounding}, ${h.maxPlots}, ${h.adminCost});`,
    );
  }
  out.push('');
  for (const r of d.research) {
    out.push(`INSERT INTO ref_research (research_key, name, era, branch) VALUES (${q(r.key)}, ${q(r.name)}, ${r.era}, ${q(r.branch)});`);
  }
  out.push('');
  for (const t of d.vetTiers) {
    out.push(
      `INSERT INTO ref_veterancy_tier (tier, name, cumulative_levels, total_stat_bonus, tier_up_cost) VALUES (${t.tier}, ${q(t.name)}, ${t.cumulativeLevels}, ${t.totalStatBonus}, ${t.tierUpCost});`,
    );
  }
  out.push('');
  for (const g of d.grades) {
    out.push(
      `INSERT INTO ref_grade (grade, realm_stage, min_level, max_level, qi_cost) VALUES (${g.grade}, ${q(g.realmStage)}, ${g.minLevel}, ${g.maxLevel}, ${g.qiCost});`,
    );
  }
  out.push('');
  out.push(`INSERT INTO ref_balance_revision (revision, imported_at) VALUES (${q(hash)}, EXTRACT(EPOCH FROM now()) * 1000)`);
  out.push('  ON CONFLICT (revision) DO NOTHING;');
  out.push('COMMIT;');
  out.push('');
  return out.join('\n');
}

function header(file: string, hash: string): string {
  return `/**
 * ${file} — GENERATED. DO NOT EDIT.
 *
 * Produced by packages/tools/src/import-workbook.ts from
 * data/Ascendance_Master_Tables.xlsx (sha256 ${hash}).
 *
 * Regenerate with: pnpm run import
 *
 * Editing this file by hand desynchronises the code from the balance workbook,
 * which is the single source of truth for every number in the game
 * (spec/00_README_FIRST.md §2.5, spec/07_balance_constants.md §1).
 */

`;
}

// ============================================================================
// Small helpers
// ============================================================================

function lit(v: number | number[] | string): string {
  if (Array.isArray(v)) return `Object.freeze([${v.join(', ')}] as const)`;
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

function json(v: unknown): string {
  return JSON.stringify(v, null, 0);
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function numOrDie(v: Cell | undefined, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ImportError(`${what} is ${JSON.stringify(v)}; expected a finite number`);
  }
  return v;
}

function relErr(a: number, b: number): number {
  const d = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  return Math.abs(a - b) / d;
}
function approx(what: string, expected: number, actual: number, tol: number): void {
  if (relErr(expected, actual) > tol) {
    throw new ImportError(`${what}: workbook says ${expected}, emitted constants give ${actual}`);
  }
}
/**
 * Read a tribulation out of the Grades_Realms prose.
 *
 * The Tribulation column is the only description of these events in the whole
 * data set, and it carries real mechanics in its wording — "visible to nearby
 * players (crashable!)", "failure stuns cultivation 48h",
 * "reputation-weighted trial". Parsing it keeps those tied to the workbook
 * instead of being retyped into game logic, and the assertion after the reader
 * fails the build if the one crashable trial ever stops being findable.
 */
function parseTrial(text: string): {
  name: string; none: boolean; visible: boolean; crashable: boolean; stunMs: number; karmaWeighted: boolean;
} {
  const trimmed = text.trim();
  const none = /^none\b/i.test(trimmed);
  const name = none ? 'None' : (trimmed.split(':')[0] ?? trimmed).trim();
  const stun = /stuns?\s+cultivation\s+(\d+)\s*h/i.exec(trimmed);
  return {
    name,
    none,
    visible: /visible/i.test(trimmed) || /crashable/i.test(trimmed),
    crashable: /crashable/i.test(trimmed),
    stunMs: stun ? Number(stun[1]) * 3_600_000 : 0,
    karmaWeighted: /reputation-weighted|karmic/i.test(trimmed),
  };
}

/** Read a numeric gate out of a prose Unlock cell. 0 means "no such gate". */
function parseGate(text: string, pattern: RegExp): number {
  const m = pattern.exec(text);
  return m ? Number(m[1]) : 0;
}

function findHeaderRow(s: Sheet, firstHeader: string): number {
  for (let r = 0; r < s.rows.length; r++) {
    for (let c = 0; c < (s.rows[r]?.length ?? 0); c++) {
      const v = s.at(r, c);
      if (typeof v === 'string' && v.trim() === firstHeader) return r;
    }
  }
  throw new ImportError(`${s.name}: could not find a header row containing ${JSON.stringify(firstHeader)}`);
}

main().catch((e: unknown) => {
  if (e instanceof ImportError) {
    console.error(`\nascendance: BALANCE IMPORT FAILED\n  ${e.message}\n`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
