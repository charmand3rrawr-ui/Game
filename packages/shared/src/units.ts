/**
 * units.ts — combinatorial roster generation
 *
 * THE POINT OF THIS FILE
 *   There are 2,268 unit definitions. They are NOT 2,268 hand-maintained rows:
 *   they are 126 archetypes x 3 identity paths x 6 grades, generated from the
 *   parameter sheets. The whole roster rebalances from a handful of constants,
 *   and spec/04 §4 requires that property to survive into the codebase — so the
 *   game generates the roster at load rather than storing it.
 *
 *   The importer runs the SAME function against Units_Master and fails the build
 *   if a single stat disagrees (spec/08 M3 acceptance test). That is what keeps
 *   the workbook and the running game honest about each other.
 *
 * SPEC: spec/04_game_systems.md §4 · WORKBOOK: Archetypes, Unit_Paths, Unit_Grades, Units_Master
 */

import { roundDecimal, roundDecimalProduct } from './num.js';

export interface ArchetypeParams {
  key: string;
  era: number;
  name: string;
  role: string;
  atk: number;
  def: number;
  hp: number;
  speed: number;
  upkeep: number;
  /** As published in Archetypes!Base Train (h) — one decimal, and the roster
   *  is generated from THAT value, not from the unrounded product. */
  baseTrainHours: number;
}

export interface PathParams {
  path: string;
  atkMod: number;
  defMod: number;
  hpMod: number;
  speedMod: number;
  identity: string;
}

export interface GradeParams {
  grade: string;
  statMult: number;
  upkeepMult: number;
  trainMult: number;
  unlock: string;
}

export interface UnitDef {
  /** Stable identity: `{archetypeKey}|{path}|{grade}`. */
  unitKey: string;
  name: string;
  era: number;
  archetype: string;
  archetypeKey: string;
  path: string;
  grade: string;
  role: string;
  atk: number;
  def: number;
  hp: number;
  speed: number;
  upkeep: number;
  trainHours: number;
}

/** `Elite Asura Militia` — the naming convention Units_Master publishes. */
export function unitName(archetype: string, path: string, grade: string): string {
  const gradePrefix = grade === 'Mortal' ? '' : `${grade} `;
  const pathPrefix = path.startsWith('Orthodox') ? '' : `${path.split(' ')[0]} `;
  return `${gradePrefix}${pathPrefix}${archetype}`;
}

export function unitKeyOf(archetypeKey: string, path: string, grade: string): string {
  return `${archetypeKey}|${path}|${grade}`;
}

/**
 * Generate one unit definition.
 *
 * ROUNDING MATTERS HERE. Units_Master publishes Atk/Def/Speed/Upkeep/Train to
 * one decimal and HP as a whole number, and it derives training time from the
 * ALREADY-ROUNDED `Base Train (h)` column. Reproducing the workbook means
 * reproducing its rounding, not just its algebra.
 */
export function generateUnit(a: ArchetypeParams, p: PathParams, g: GradeParams): UnitDef {
  return {
    unitKey: unitKeyOf(a.key, p.path, g.grade),
    name: unitName(a.name, p.path, g.grade),
    era: a.era,
    archetype: a.name,
    archetypeKey: a.key,
    path: p.path,
    grade: g.grade,
    role: a.role,
    // ROUNDING MODEL, established by comparing all 13,608 published values in
    // Units_Master and failing until zero disagreed. The workbook is not
    // uniform, so neither is this:
    //
    //   Atk/Def/Speed/Upkeep/Train — multiply the published decimals EXACTLY,
    //     then round half away from zero. Doing this in binary publishes
    //     4.06 * 2.5 as 10.1 where the sheet says 10.2, because 10.15 * 10 is
    //     101.49999999999999.
    //
    //   HP — multiply as BINARY floats, then round that result in decimal. The
    //     sheet publishes 50 * 1.15 as 57 (the binary product sits just below
    //     57.5) and 50 * 1.35 as 68 (just above 67.5). Exact-decimal arithmetic
    //     would make both ties and get 27 of the 2,268 units wrong.
    //
    // Neither rule is a preference. Each is what the source data does, and the
    // importer fails the build if a single stat ever stops matching.
    atk: roundDecimalProduct([a.atk, g.statMult, p.atkMod], 1),
    def: roundDecimalProduct([a.def, g.statMult, p.defMod], 1),
    hp: roundDecimal(a.hp * g.statMult * p.hpMod, 0),
    speed: roundDecimalProduct([a.speed, p.speedMod], 1),
    upkeep: roundDecimalProduct([a.upkeep, g.upkeepMult], 1),
    // Training time derives from the ALREADY-ROUNDED published Base Train (h),
    // not from upkeep * TRAIN_CONST. Using the unrounded product shifts Elite
    // units by a tenth of an hour and fails the roster check.
    trainHours: roundDecimalProduct([a.baseTrainHours, g.trainMult], 1),
  };
}

/** The full cross product, in a stable order. */
export function generateRoster(
  archetypes: readonly ArchetypeParams[],
  paths: readonly PathParams[],
  grades: readonly GradeParams[],
): UnitDef[] {
  const out: UnitDef[] = [];
  for (const a of archetypes) {
    for (const p of paths) {
      for (const g of grades) {
        out.push(generateUnit(a, p, g));
      }
    }
  }
  return out;
}
