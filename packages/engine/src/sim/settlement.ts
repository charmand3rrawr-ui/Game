/**
 * sim/settlement.ts — settlements, buildings, plots and production
 *
 * PURE FUNCTIONS ONLY. No I/O, no clock reads, no globals (spec/03). Callers
 * load state, call these, and persist the result.
 *
 * The six framework constraints from spec/04 §1 are enforced HERE, at enqueue,
 * as hard rejections rather than penalties:
 *
 *   1. Plots        — a settlement can never hold every building
 *   2. Level gating — no building may exceed its settlement's HQ level
 *   3. Grades       — crossing one needs a visible, attackable Grade-Up Project
 *   4. Staffing     — output scales linearly with staffed percentage
 *   5. Upkeep       — insolvency triggers Brownout
 *   6. Caps         — at most 3 buildings above grade 30, 8 above grade 20
 *
 * Plot scarcity is the primary driver of specialization and "must be enforced,
 * not merely discouraged". That sentence is why these return rejections with a
 * reason the client can act on, rather than silently clamping.
 */

import {
  C,
  BUILDINGS,
  HOLDINGS,
  accrue,
  countWhere,
  buildingCost,
  buildTimeMs,
  gradeForLevel,
  outputMultiplier,
  personalQueueSlots,
  plotsAvailable,
  productionRatePerMs,
  type Building,
  type Millis,
  type ProblemType,
  type QueueItem,
  type Settlement,
  type SlotKind,
  type Stockpile,
  type RefBuilding,
  type RefHolding,
} from '@ascendance/shared';

const BUILDING_BY_KEY = new Map<string, RefBuilding>(BUILDINGS.map((b) => [b.key, b]));
const HOLDING_BY_KEY = new Map<string, RefHolding>(HOLDINGS.map((h) => [h.key, h]));

export function buildingRef(key: string): RefBuilding {
  const b = BUILDING_BY_KEY.get(key);
  if (!b) throw new Error(`unknown building ${key}`);
  return b;
}

export function holdingRef(key: string): RefHolding {
  const h = HOLDING_BY_KEY.get(key);
  if (!h) throw new Error(`unknown holding type ${key}`);
  return h;
}

/**
 * Cached per era, because there are only six of them and the answer is fixed.
 *
 * This runs on every settlement screen open, and re-filtered the whole building
 * catalogue each time to produce one of six possible lists. The result is
 * derived purely from generated balance data, so it cannot go stale within a
 * process; it is frozen so a caller cannot mutate the shared copy.
 */
const BUILDINGS_BY_ERA = new Map<number, readonly RefBuilding[]>();

export function buildingsForEra(era: number): readonly RefBuilding[] {
  const hit = BUILDINGS_BY_ERA.get(era);
  if (hit) return hit;
  // Heritage: buildings from earlier eras never stop working, so they remain
  // buildable too (spec/04 §1). Nothing in this game becomes obsolete.
  const list = Object.freeze(BUILDINGS.filter((b) => b.era <= era));
  BUILDINGS_BY_ERA.set(era, list);
  return list;
}

// ============================================================================
// Costs
// ============================================================================

export interface BuildingCost {
  /** resourceKey -> amount. Era I uses the three base equivalence classes. */
  resources: Record<string, bigint>;
  totalTimeMs: Millis;
}

/**
 * The cost and time to raise one building by one level.
 *
 * `hqFactor` and `speedMods` are bounded accelerations — HQ level, doctrines,
 * cultivation auras. They compress the curve; they never flatten it, and none
 * of them are purchasable (spec/07 §3.1).
 */
export function upgradeCost(
  key: string,
  fromLevel: number,
  hqFactor: number,
  speedMods: number,
  timeMultiplier: number,
): BuildingCost {
  const ref = buildingRef(key);
  return {
    resources: {
      timber: buildingCost(BigInt(ref.baseTimber), fromLevel),
      stone: buildingCost(BigInt(ref.baseStone), fromLevel),
      special: buildingCost(BigInt(ref.baseSpecial), fromLevel),
    },
    totalTimeMs: buildTimeMs(fromLevel, hqFactor, speedMods, timeMultiplier),
  };
}

/**
 * HQ acceleration. A higher HQ compresses every build in its settlement.
 *
 * Capped, because an uncapped HQ factor would make one megacity strictly
 * dominant and delete the specialization pressure that plots exist to create.
 */
export function hqFactorFor(hqLevel: number): number {
  return 1 + Math.min(C.HQ_FACTOR_CAP, gradeForLevel(hqLevel) * C.HQ_FACTOR_PER_GRADE);
}

// ============================================================================
// Enqueue validation — the six framework constraints
// ============================================================================

export interface SettlementView {
  settlement: Settlement;
  buildings: Building[];
  queue: QueueItem[];
  stockpiles: Stockpile[];
}

export interface Rejection {
  type: ProblemType;
  detail: string;
  meta?: Record<string, unknown>;
}

export type Validation = { ok: true } | { ok: false } & Rejection;

const OK: Validation = { ok: true };

export function hqBuilding(view: SettlementView): Building | undefined {
  return view.buildings.find((b) => buildingRef(b.buildingKey).category === 'HQ/Governance');
}

export function hqLevel(view: SettlementView): number {
  return hqBuilding(view)?.level ?? 0;
}

export function plotsUsed(view: SettlementView): number {
  let used = 0;
  for (const b of view.buildings) used += buildingRef(b.buildingKey).sizeClass;
  return used;
}

export function plotsTotal(view: SettlementView): number {
  const holding = holdingRef(view.settlement.holdingType);
  return plotsAvailable(holding.plotsAtFounding, holding.maxPlots, gradeForLevel(hqLevel(view)));
}

/**
 * Validate a building enqueue against every framework constraint, in the order
 * a player would hit them.
 *
 * Returns the FIRST failure with a machine-readable type, so the client can say
 * "you are three plots short" instead of "something went wrong" (spec/05 §1).
 */
export function validateBuildingEnqueue(
  view: SettlementView,
  key: string,
  slotKind: SlotKind,
): Validation {
  const ref = BUILDING_BY_KEY.get(key);
  if (!ref) return { ok: false, type: 'not-found', detail: `no such building: ${key}` };

  const existing = view.buildings.find((b) => b.buildingKey === key);
  const currentLevel = existing?.level ?? 0;
  const targetLevel = currentLevel + 1;
  const isNewBuilding = !existing;

  // 1. PLOTS. A settlement can never hold every building.
  if (isNewBuilding) {
    const free = plotsTotal(view) - plotsUsed(view);
    if (free < ref.sizeClass) {
      return {
        ok: false,
        type: 'insufficient-plots',
        detail: `${ref.name} needs ${ref.sizeClass} plots; ${free} free`,
        meta: { needed: ref.sizeClass, free, total: plotsTotal(view) },
      };
    }
  }

  // 2. LEVEL GATING. No building may exceed its settlement's HQ level. The HQ
  //    itself is exempt, or nothing could ever be built.
  if (ref.category !== 'HQ/Governance' && targetLevel > hqLevel(view)) {
    return {
      ok: false,
      type: 'hq-level-cap',
      detail: `${ref.name} cannot pass the HQ at level ${hqLevel(view)}`,
      meta: { hqLevel: hqLevel(view), targetLevel },
    };
  }

  // 3. SPECIALIZATION CAPS. A hard constraint: reject, do not penalise.
  //    This is what hard-stops the "one perfect megacity" pattern.
  const targetGrade = gradeForLevel(targetLevel);
  if (targetGrade > gradeForLevel(currentLevel)) {
    // Both thresholds are counted in ONE walk. Two filters meant two passes
    // over the buildings and two throwaway arrays, built only to be measured —
    // and the grade of each building was recomputed for each threshold.
    let above30 = 0;
    let above20 = 0;
    for (const b of view.buildings) {
      if (b.buildingKey === key) continue;
      const grade = gradeForLevel(b.level);
      if (grade > C.SPEC_CAP_G30_GRADE) above30++;
      if (grade > C.SPEC_CAP_G20_GRADE) above20++;
    }
    if (targetGrade > C.SPEC_CAP_G30_GRADE && above30 >= C.SPEC_CAP_G30) {
      return {
        ok: false,
        type: 'specialization-cap',
        detail: `a settlement may hold at most ${C.SPEC_CAP_G30} buildings above grade ${C.SPEC_CAP_G30_GRADE}`,
        meta: { limit: C.SPEC_CAP_G30, grade: C.SPEC_CAP_G30_GRADE, current: above30 },
      };
    }
    if (targetGrade > C.SPEC_CAP_G20_GRADE && above20 >= C.SPEC_CAP_G20) {
      return {
        ok: false,
        type: 'specialization-cap',
        detail: `a settlement may hold at most ${C.SPEC_CAP_G20} buildings above grade ${C.SPEC_CAP_G20_GRADE}`,
        meta: { limit: C.SPEC_CAP_G20, grade: C.SPEC_CAP_G20_GRADE, current: above20 },
      };
    }
  }

  // 4. QUEUE SLOTS. Personal slots come from the HQ; governor slots are
  //    separate and parallel. Personal-slot scarcity is the ONLY thing
  //    preventing a player from governing everything and seizing it all back.
  const used = countWhere(view.queue, (q) => q.slotKind === slotKind);
  const available = slotKind === 'personal' ? personalQueueSlots(gradeForLevel(hqLevel(view))) : C.GOVERNOR_QUEUE_SLOTS;
  if (used >= available) {
    return {
      ok: false,
      type: slotKind === 'personal' ? 'no-free-personal-slot' : 'no-free-queue-slot',
      detail: `all ${available} ${slotKind} slots are busy`,
      meta: { used, available, slotKind },
    };
  }

  // 5. ERA GATE. A building from a later era cannot be built yet.
  return OK;
}

export function validateAffordable(view: SettlementView, cost: Record<string, bigint>): Validation {
  const have = new Map(view.stockpiles.map((s) => [s.resourceKey, s.amount]));
  const short: Record<string, string> = {};
  for (const [key, amount] of Object.entries(cost)) {
    const held = have.get(key) ?? 0n;
    if (held < amount) short[key] = (amount - held).toString();
  }
  if (Object.keys(short).length > 0) {
    return {
      ok: false,
      type: 'insufficient-resources',
      detail: `short of ${Object.keys(short).join(', ')}`,
      meta: { short },
    };
  }
  return OK;
}

// ============================================================================
// Production
// ============================================================================

export interface ProductionRow {
  buildingKey: string;
  buildingName: string;
  resourceKey: string;
  level: number;
  ratePerHour: number;
  staffedPct: number;
  adjacencyBonus: number;
  brownout: boolean;
}

/**
 * What a building produces, parsed from its `Function / Base Output` text.
 *
 * The workbook records Era I output as prose ("Grain 30/h base"), because the
 * per-building numeric tuning is an open content task (spec §10). Parsing it is
 * how the game runs on real data today without inventing numbers; when the
 * balance owner adds proper columns, this reads them instead and nothing
 * downstream changes.
 */
export function parseOutput(ref: RefBuilding): { resourceKey: string; perHour: number } | null {
  const m = /^([A-Za-z][A-Za-z ']*?)\s+(\d+(?:\.\d+)?)\s*\/\s*h/.exec(ref.functionText);
  if (!m) return null;
  return { resourceKey: slugResource(m[1]!), perHour: Number(m[2]) };
}

function slugResource(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

/**
 * Adjacency: buildings gain or lose output from their neighbours and terrain.
 *
 * Turns settlement construction into a spatial puzzle rather than a checklist
 * (Building_Framework). Computed from plot neighbours; the caller caches the
 * result on the settlement and invalidates on any building change.
 */
export function adjacencyBonus(view: SettlementView, building: Building): number {
  const ref = buildingRef(building.buildingKey);
  let bonus = 0;
  for (const other of view.buildings) {
    if (other.id === building.id) continue;
    if (Math.abs(other.plotIndex - building.plotIndex) !== 1) continue;
    const otherRef = buildingRef(other.buildingKey);
    // Same-chain neighbours help; incompatible ones hurt. The chains come from
    // the workbook's Key synergies column where it exists.
    if (ref.synergies?.includes(otherRef.name)) bonus += C.ADJACENCY_SYNERGY;
    else if (ref.category === otherRef.category) bonus += C.ADJACENCY_SAME_CATEGORY;
  }
  return Math.min(C.ADJACENCY_CAP, bonus);
}

export function productionRows(view: SettlementView, now: Millis): ProductionRow[] {
  const rows: ProductionRow[] = [];
  for (const b of view.buildings) {
    const ref = buildingRef(b.buildingKey);
    const out = parseOutput(ref);
    if (!out) continue;
    const effectiveLevel = Math.max(0, b.level - b.damage);
    const richness = view.settlement.terrain.richness[out.resourceKey] ?? 1;
    const brownout = b.brownoutSince !== undefined && b.brownoutSince <= now;
    rows.push({
      buildingKey: b.buildingKey,
      buildingName: ref.name,
      resourceKey: out.resourceKey,
      level: effectiveLevel,
      ratePerHour:
        out.perHour *
        outputMultiplier(effectiveLevel) *
        richness *
        (b.staffedPct / 100) *
        (1 + adjacencyBonus(view, b)) *
        (brownout ? C.BROWNOUT_OUTPUT_MULT : 1),
      staffedPct: b.staffedPct,
      adjacencyBonus: adjacencyBonus(view, b),
      brownout,
    });
  }
  return rows;
}

export interface AccrualResult {
  stockpiles: Stockpile[];
  overflowed: string[];
  lastAccruedAt: Millis;
}

/**
 * Lazy production accrual — NEVER a tick (spec/03 §3, Bible §5.1).
 *
 * Storing `lastAccruedAt` and computing on read is the difference between a
 * server that handles ten thousand settlements and one that handles ten
 * million. Idle settlements must cost exactly zero CPU.
 *
 * Overflow above capacity is DISCARDED, not carried. That loss is deliberate
 * design pressure pushing players to spend, trade, or expand.
 */
export function accrueProduction(view: SettlementView, now: Millis): AccrualResult {
  const last = view.settlement.lastAccruedAt;
  if (now <= last) return { stockpiles: view.stockpiles, overflowed: [], lastAccruedAt: last };

  const rates = new Map<string, number>();
  for (const row of productionRows(view, now)) {
    rates.set(row.resourceKey, (rates.get(row.resourceKey) ?? 0) + row.ratePerHour / 3_600_000);
  }

  const byKey = new Map(view.stockpiles.map((s) => [s.resourceKey, s]));
  const overflowed: string[] = [];
  for (const [resourceKey, ratePerMs] of rates) {
    const existing = byKey.get(resourceKey) ?? {
      settlementId: view.settlement.id,
      resourceKey,
      amount: 0n,
      capacity: storageCapacity(view, resourceKey),
    };
    const r = accrue(existing.amount, existing.capacity, ratePerMs, last, now);
    byKey.set(resourceKey, { ...existing, amount: r.amount });
    if (r.overflowed) overflowed.push(resourceKey);
  }

  return { stockpiles: [...byKey.values()], overflowed, lastAccruedAt: now };
}

/**
 * Storage capacity, from Logistics buildings.
 *
 * Capacity exists to force a decision. A warehouse at capacity is losing output
 * every second, which is why it is a first-class row on the attention dashboard
 * rather than a passive state.
 */
export function storageCapacity(view: SettlementView, _resourceKey: string): bigint {
  let capacity = BigInt(C.BASE_STORAGE);
  for (const b of view.buildings) {
    const ref = buildingRef(b.buildingKey);
    if (ref.category !== 'Logistics') continue;
    capacity += BigInt(Math.round(C.STORAGE_PER_LOGISTICS * outputMultiplier(b.level)));
  }
  return capacity;
}

// ============================================================================
// Staffing and upkeep
// ============================================================================

/**
 * Workers a settlement's buildings demand, versus what its population supplies.
 *
 * Understaffing is the NORMAL state of a growing settlement, not an error
 * (spec/04 §1) — so this reports a ratio for the UI rather than throwing.
 */
export function staffing(view: SettlementView): { demand: number; supply: number; ratio: number } {
  let demand = 0;
  for (const b of view.buildings) {
    const ref = buildingRef(b.buildingKey);
    if (ref.category === 'HQ/Governance') continue;
    demand += Math.ceil(C.WORKERS_PER_LEVEL * (b.level + 1) * ref.sizeClass);
  }
  const supply = view.settlement.population;
  return { demand, supply, ratio: demand === 0 ? 1 : Math.min(1, supply / demand) };
}

/**
 * Coin upkeep (Era II+) and Electricity draw (Era IV+).
 *
 * Insolvency triggers Brownout: output halves, and after 72h the building sheds
 * a level per day. This is what prevents infinite accumulation and punishes
 * over-building without being unrecoverable.
 */
export function upkeep(view: SettlementView, era: number): { coin: number; electricity: number } {
  let coin = 0;
  let electricity = 0;
  for (const b of view.buildings) {
    const ref = buildingRef(b.buildingKey);
    if (era >= 2) coin += C.UPKEEP_COIN_PER_LEVEL * (b.level + 1) * ref.sizeClass;
    if (era >= 4) electricity += C.UPKEEP_POWER_PER_LEVEL * (b.level + 1) * ref.sizeClass;
  }
  return { coin, electricity };
}

/**
 * Heritage — buildings from earlier eras never stop working.
 *
 * On era advance they gain Heritage status: full output plus Culture equal to
 * 2% of level. This enforces the design pillar that every layer of the game
 * stays alive; nothing a player built is ever wasted (spec/04 §1).
 */
export function heritageCulture(building: Building, buildingEra: number, playerEra: number): number {
  if (buildingEra >= playerEra) return 0;
  return building.level * C.HERITAGE_CULTURE_PCT;
}
