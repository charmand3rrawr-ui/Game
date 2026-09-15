/**
 * roster.ts — the generated unit roster, bound to the imported balance data
 *
 * The roster is built once at module load from the parameter sheets, not stored
 * as 2,268 rows (spec/04 §4). Lookups are by `unitKey` = `{archetypeKey}|{path}|{grade}`.
 */

import { ARCHETYPES, UNIT_GRADES, UNIT_PATHS, COUNTER_ROLES, COUNTER_MATRIX } from './generated/refdata.js';
import { generateRoster, type UnitDef } from './units.js';

/** All 2,268 unit definitions, in a stable order. */
export const ROSTER: readonly UnitDef[] = Object.freeze(generateRoster(ARCHETYPES, UNIT_PATHS, UNIT_GRADES));

const BY_KEY = new Map<string, UnitDef>(ROSTER.map((u) => [u.unitKey, u]));

export function unitDef(unitKey: string): UnitDef {
  const u = BY_KEY.get(unitKey);
  if (!u) throw new Error(`unknown unit ${unitKey}`);
  return u;
}

export function tryUnitDef(unitKey: string): UnitDef | undefined {
  return BY_KEY.get(unitKey);
}

export function unitsForEra(era: number): UnitDef[] {
  return ROSTER.filter((u) => u.era === era);
}

/**
 * Counter-matrix lookup: how much damage `attackerRole` does to `defenderRole`.
 *
 * An unknown role pairing returns 1 rather than throwing. A missing entry means
 * "no special relationship", and a hard failure here would take down a battle
 * resolution over a data gap that has no gameplay consequence.
 */
export function counterMultiplier(attackerRole: string, defenderRole: string): number {
  const a = COUNTER_ROLES[attackerRole];
  const d = COUNTER_ROLES[defenderRole];
  if (a === undefined || d === undefined) return 1;
  return COUNTER_MATRIX[a]?.[d] ?? 1;
}

/**
 * The counter matrix as the nested record shape `xp.ts` expects.
 *
 * Built lazily and cached: the XP attributor wants random access by role NAME,
 * while the resolver wants the dense indexed form for speed.
 */
let nested: Record<string, Record<string, number>> | null = null;

export function counterMatrixByName(): Record<string, Record<string, number>> {
  if (nested) return nested;
  const out: Record<string, Record<string, number>> = {};
  for (const [attacker, ai] of Object.entries(COUNTER_ROLES)) {
    const row: Record<string, number> = {};
    for (const [defender, di] of Object.entries(COUNTER_ROLES)) {
      row[defender] = COUNTER_MATRIX[ai]?.[di] ?? 1;
    }
    out[attacker] = row;
  }
  nested = out;
  return out;
}

export const ROLES: readonly string[] = Object.freeze(Object.keys(COUNTER_ROLES));
