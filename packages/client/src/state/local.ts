/**
 * state/local.ts — the browser-hosted world
 *
 * GitHub Pages serves static files, so a deployed build has no gateway to talk
 * to. Rather than ship a cut-down demo, the page hosts an authoritative world
 * in-process using @ascendance/engine — the same engine the server runs,
 * unchanged, because the simulation is pure and the store is an interface
 * (DECISIONS.md D4).
 *
 * This does NOT weaken invariant §2.1. The World instance is still the sole
 * authority: the UI calls commands and reads what it is told, exactly as it
 * does over HTTP. What it cannot be is multiplayer — there is one process and
 * one player — so the page says so plainly rather than implying otherwise.
 */

import {
  World,
  seedWorld,
  CommandError,
  accrueProduction,
  buildingRef,
  buildingsForEra,
  hqFactorFor,
  hqLevel,
  plotsTotal,
  plotsUsed,
  productionRows,
  staffing,
  upgradeCost,
  type SeededWorld,
} from '@ascendance/engine';
import { BALANCE_REVISION, ASSUMED_CONSTANTS, BUILDINGS, C, GOVERNOR_SPECS, GOVERNOR_TIERS, HOLDINGS, RESEARCH, ROSTER, VETERANCY_TIERS, tryUnitDef } from '@ascendance/shared';
import type { Api, ApiProblem, MeResponse, SettlementDetail, MapResponse, FormationDto, MovementDto, QueueItemDto, Meta } from './api.js';
import { ApiError } from './api.js';

declare const __LOCAL_WORLD__: boolean;

export function isLocalMode(): boolean {
  if (typeof __LOCAL_WORLD__ !== 'undefined' && __LOCAL_WORLD__) return true;
  if (typeof window === 'undefined') return false;
  // An explicit ?local=1 lets anyone run the sandbox against a dev server too.
  return new URLSearchParams(window.location.search).get('local') === '1';
}

let seeded: SeededWorld | null = null;

/**
 * The local world starts two days in the past.
 *
 * Starting at "now" means every queue is empty and every timer reads zero,
 * which makes the Attention Dashboard — the screen that matters most — look
 * like an empty list on first load. Some history gives the world something to
 * have been doing.
 *
 * Two days rather than a week: a starting village's storage fills in about
 * three, and a dashboard where every row says the same thing teaches nothing.
 */
function ensureWorld(): SeededWorld {
  if (seeded) return seeded;
  const start = BigInt(Date.now()) - 2n * 24n * 3_600_000n;
  seeded = seedWorld({ worldId: 'sandbox', now: start, neighbours: 8 });
  seeded.world.advanceTo(BigInt(Date.now()));
  return seeded;
}

/** Advance the world to the wall clock. Called on a timer by the UI shell. */
function tick(): void {
  const { world } = ensureWorld();
  const now = BigInt(Date.now());
  if (now > world.now) world.advanceTo(now);
}

/** Convert an engine rejection into the same problem shape HTTP would send. */
function wrap<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    if (e instanceof CommandError) {
      const problem: ApiProblem = {
        type: `https://ascendance.game/problems/${e.problemType}`,
        title: e.problemType,
        status: 422,
        detail: e.message,
        meta: e.meta,
      };
      return Promise.reject(new ApiError(problem));
    }
    const message = e instanceof Error ? e.message : String(e);
    return Promise.reject(new ApiError({ type: 'about:blank', title: 'Error', status: 500, detail: message }));
  }
}

/** bigint -> string, recursively. The same rule as the wire format. */
function wire<T>(v: T): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(wire);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      out[k] = wire(val);
    }
    return out;
  }
  return v;
}

export const localApi: Api = {
  tick,

  meta(): Promise<Meta> {
    const { world } = ensureWorld();
    return Promise.resolve({
      balanceRevision: BALANCE_REVISION,
      assumedConstants: [...ASSUMED_CONSTANTS],
      serverTime: Date.now(),
      worldTime: world.now.toString(),
      counts: { buildings: BUILDINGS.length, units: ROSTER.length, holdings: HOLDINGS.length, veterancyTiers: VETERANCY_TIERS.length },
    });
  },

  me(): Promise<MeResponse> {
    const { world, playerId } = ensureWorld();
    return wrap(() => wire({
      player: world.player(playerId),
      empireWeight: world.empireWeight(playerId),
      settlements: world.settlementsOf(playerId).map((s) => ({
        id: s.id, name: s.name, holdingType: s.holdingType, layer: s.layer,
        coordX: s.coordX, coordY: s.coordY, loyalty: s.loyalty, population: s.population,
      })),
    }) as MeResponse);
  },

  attention(): Promise<{ items: import('@ascendance/shared').AttentionItem[]; serverTime: number }> {
    const { world, playerId } = ensureWorld();
    return wrap(() => wire({ items: world.attention(playerId), serverTime: Date.now() }) as {
      items: import('@ascendance/shared').AttentionItem[]; serverTime: number;
    });
  },

  settlement(id: string): Promise<SettlementDetail> {
    const { world, playerId } = ensureWorld();
    return wrap(() => {
      world.refresh(id);
      const view = world.view(id);
      if (view.settlement.ownerId !== playerId) {
        // What a scout would see. Building levels are hidden from enemies,
        // which is what rewards scouting (spec/04 §8).
        return wire({
          settlement: view.settlement,
          buildings: view.buildings.map((b) => ({ id: b.id, buildingKey: b.buildingKey, level: 0, damage: b.damage, staffedPct: 0, ref: buildingRef(b.buildingKey) })),
          queue: [], stockpiles: [], production: [],
          staffing: { demand: 0, supply: 0, ratio: 0 },
          plots: { used: 0, total: 0 }, hqLevel: 0, available: [],
          fogged: ['levels', 'stockpiles', 'queues', 'garrison'],
        }) as SettlementDetail;
      }
      const accrued = accrueProduction(view, world.now);
      const hq = hqLevel(view);
      return wire({
        settlement: view.settlement,
        buildings: view.buildings.map((b) => ({ ...b, ref: buildingRef(b.buildingKey) })),
        queue: view.queue,
        stockpiles: accrued.stockpiles,
        production: productionRows(view, world.now),
        staffing: staffing(view),
        plots: { used: plotsUsed(view), total: plotsTotal(view) },
        hqLevel: hq,
        available: buildingsForEra(world.player(playerId).era).map((r) => {
          const existing = view.buildings.find((b) => b.buildingKey === r.key);
          const cost = upgradeCost(r.key, existing?.level ?? 0, hqFactorFor(hq), 1, 1);
          return {
            key: r.key, name: r.name, category: r.category, era: r.era, sizeClass: r.sizeClass,
            functionText: r.functionText, purpose: r.purpose, mechanic: r.mechanic, synergies: r.synergies, art: r.art,
            currentLevel: existing?.level ?? 0,
            cost: cost.resources,
            timeMs: cost.totalTimeMs,
          };
        }),
      }) as SettlementDetail;
    });
  },

  map(): Promise<MapResponse> {
    const { world, playerId } = ensureWorld();
    return wrap(() => wire({
      settlements: world.store.read((tx) =>
        tx.settlements.all().map((s) => ({
          id: s.id, name: s.name, ownerId: s.ownerId, holdingType: s.holdingType,
          coordX: s.coordX, coordY: s.coordY, layer: s.layer,
          mine: s.ownerId === playerId, integrity: s.integrity,
        })),
      ),
      movements: world.store.read((tx) => tx.movements.all()),
    }) as MapResponse);
  },

  formations(): Promise<{ formations: FormationDto[] }> {
    const { world, playerId } = ensureWorld();
    return wrap(() => wire({
      formations: world.formationsOf(playerId).map((f) => {
        const d = tryUnitDef(f.unitKey);
        return {
          ...f,
          def: d ? { name: d.name, role: d.role, era: d.era, grade: d.grade, path: d.path, atk: d.atk, def: d.def, hp: d.hp, speed: d.speed, upkeep: d.upkeep } : null,
        };
      }),
    }) as { formations: FormationDto[] });
  },

  movements(): Promise<{ movements: MovementDto[]; serverTime: number }> {
    const { world, playerId } = ensureWorld();
    return wrap(() => wire({ movements: world.movementsOf(playerId), serverTime: Date.now() }) as {
      movements: MovementDto[]; serverTime: number;
    });
  },

  options(settlementId: string) {
    const { world, playerId } = ensureWorld();
    return wrap(() => wire(world.options(playerId, settlementId)) as import('./api.js').OptionsDto);
  },

  research() {
    const { world, playerId } = ensureWorld();
    return wrap(() => {
      const levels = world.researchLevelsOf(playerId);
      return wire({
        levels,
        effects: world.researchEffectsOf(playerId),
        disciplines: RESEARCH.map((r) => ({
          key: r.key, name: r.name, era: r.era, branch: r.branch,
          perLevel: r.perLevel, perLevelPct: r.perLevelPct, prerequisite: r.prerequisite,
          level: levels[r.key] ?? 0,
        })),
        inProgress: world.store.read((tx) =>
          tx.queue
            .where((q) => q.kind === 'research' && tx.settlements.get(q.settlementId)?.ownerId === playerId)
            .map((q) => ({ researchKey: q.targetKey, settlementId: q.settlementId, finishesAt: q.finishesAt })),
        ),
      }) as import('./api.js').ResearchDto;
    });
  },

  cultivation() {
    const { world, playerId } = ensureWorld();
    return wrap(() => wire({
      ...world.cultivation(playerId),
      visibleNearby: world.visibleTribulations(playerId),
    }) as import('./api.js').CultivationDto);
  },

  breakthrough(settlementId) {
    const { world, playerId } = ensureWorld();
    tick();
    return wrap(() => wire(world.beginBreakthrough(crypto.randomUUID(), playerId, settlementId)) as import('./api.js').TribulationDto);
  },

  interfere(tribulationId) {
    const { world, playerId } = ensureWorld();
    tick();
    return wrap(() => wire(world.interfere(crypto.randomUUID(), playerId, tribulationId)) as import('./api.js').TribulationDto);
  },

  battles(settlementId: string) {
    const { world } = ensureWorld();
    return wrap(() => wire({ battles: world.battlesAt(settlementId).slice(0, 25) }) as { battles: import('@ascendance/shared').Battle[] });
  },

  battle(id: string) {
    const { world } = ensureWorld();
    return wrap(() => {
      const b = world.battle(id);
      if (!b) throw new Error('no such battle');
      return wire(b) as import('@ascendance/shared').Battle;
    });
  },

  enqueue(settlementId, targetKey, slotKind) {
    const { world, playerId } = ensureWorld();
    tick();
    return wrap(() => wire(world.enqueue({
      commandId: crypto.randomUUID(), playerId, settlementId, kind: 'building', targetKey, slotKind,
    })) as QueueItemDto);
  },

  train(settlementId, targetKey, quantity, slotKind) {
    const { world, playerId } = ensureWorld();
    tick();
    return wrap(() => wire(world.enqueue({
      commandId: crypto.randomUUID(), playerId, settlementId, kind: 'training', targetKey, quantity, slotKind,
    })) as QueueItemDto);
  },

  startResearch(settlementId, targetKey, slotKind) {
    const { world, playerId } = ensureWorld();
    tick();
    return wrap(() => wire(world.enqueue({
      commandId: crypto.randomUUID(), playerId, settlementId, kind: 'research', targetKey, slotKind,
    })) as QueueItemDto);
  },

  cancel(itemId) {
    const { world, playerId } = ensureWorld();
    return wrap(() => world.cancelQueueItem(crypto.randomUUID(), playerId, itemId));
  },

  seize(itemId) {
    const { world, playerId } = ensureWorld();
    tick();
    return wrap(() => wire(world.seize(crypto.randomUUID(), playerId, itemId)) as QueueItemDto);
  },

  spendShards(itemId, shardHours) {
    const { world, playerId } = ensureWorld();
    tick();
    return wrap(() => wire(world.spendShards(crypto.randomUUID(), playerId, itemId, shardHours)) as QueueItemDto);
  },

  dispatch(args) {
    const { world, playerId } = ensureWorld();
    tick();
    return wrap(() => wire(world.dispatch({ commandId: crypto.randomUUID(), playerId, ...args })) as MovementDto);
  },

  tierUp(formationId, track) {
    const { world, playerId } = ensureWorld();
    return wrap(() => wire(world.tierUp(crypto.randomUUID(), playerId, formationId, track)) as FormationDto);
  },

  governors() {
    const { world, playerId } = ensureWorld();
    return wrap(() => {
      const mine = world.settlementsOf(playerId);
      const byId = new Map(mine.map((st) => [st.id, st.name]));
      return wire({
        commanderLevel: world.commanderLevelOf(playerId),
        tiers: GOVERNOR_TIERS,
        sheets: GOVERNOR_SPECS,
        settlements: mine.map((st) => ({ id: st.id, name: st.name, governorId: st.governorId })),
        governors: world.governorsOf(playerId).map((g) => ({
          ...g,
          areaNames: g.areaRef.settlementIds.map((id) => byId.get(id) ?? id),
        })),
      }) as import('./api.js').GovernorsDto;
    });
  },

  appointGovernor(args) {
    const { world, playerId } = ensureWorld();
    tick();
    return wrap(() => wire(world.appointGovernor({
      commandId: crypto.randomUUID(),
      playerId,
      commanderId: args.commanderId,
      tier: args.tier as 'bailiff' | 'planetary' | 'system' | 'sector',
      settlementIds: args.settlementIds,
      specs: args.specs,
      // Derived here exactly as the server derives it. The sandbox is not a
      // laxer world — it is the same engine with the same gates.
      commanderLevel: world.commanderLevelOf(playerId),
    })) as unknown as import('./api.js').GovernorDto);
  },

  updateGovernorSpecs(governorId, specs) {
    const { world, playerId } = ensureWorld();
    tick();
    return wrap(() => wire(
      world.updateGovernorSpecs(crypto.randomUUID(), playerId, governorId, specs),
    ) as unknown as import('./api.js').GovernorDto);
  },

  dismissGovernor(governorId) {
    const { world, playerId } = ensureWorld();
    tick();
    return wrap(() => world.dismissGovernor(crypto.randomUUID(), playerId, governorId));
  },

  auditGovernor(governorId) {
    const { world, playerId } = ensureWorld();
    return wrap(() => world.audit(crypto.randomUUID(), playerId, governorId));
  },

  alliance() {
    const { world, playerId } = ensureWorld();
    return wrap(() => {
      const held = world.allianceOf(playerId);
      return wire({
        alliance: held?.alliance ?? null,
        members: held?.members ?? [],
        maxMembers: C.ALLIANCE_MAX_MEMBERS,
        treaties: world.treatiesOf(playerId),
        known: world.knownPlayers(playerId),
        me: playerId,
        serverTime: Date.now(),
        napNoticeMs: C.NAP_NOTICE_MS,
        napBreakReputation: C.REPUTATION_NAP_BREAK,
        treatyBreakReputation: C.REPUTATION_TREATY_BREAK,
      }) as import('./api.js').AllianceDto;
    });
  },

  createAlliance(name, tag) {
    const { world, playerId } = ensureWorld();
    tick();
    return wrap(() => wire(world.createAlliance(crypto.randomUUID(), playerId, name, tag)) as NonNullable<import('./api.js').AllianceDto['alliance']>);
  },

  proposeTreaty(args) {
    const { world, playerId } = ensureWorld();
    tick();
    return wrap(() => wire(world.proposeTreaty({
      commandId: crypto.randomUUID(),
      playerId,
      counterpartyId: args.counterpartyId,
      kind: args.kind as 'nap' | 'trade' | 'defensive' | 'tribute' | 'border' | 'war' | 'armistice',
      terms: args.terms,
    })) as import('./api.js').TreatyDto);
  },

  acceptTreaty(treatyId) {
    const { world, playerId } = ensureWorld();
    tick();
    return wrap(() => wire(world.acceptTreaty(crypto.randomUUID(), playerId, treatyId)) as import('./api.js').TreatyDto);
  },

  breakTreaty(treatyId) {
    const { world, playerId } = ensureWorld();
    tick();
    return wrap(() => wire(world.breakTreaty(crypto.randomUUID(), playerId, treatyId)) as {
      treaty: import('./api.js').TreatyDto; reputationLost: number; effectiveAt: string;
    });
  },
};

/**
 * Drain the world's outbox.
 *
 * In the hosted build these are the WebSocket pushes; locally the shell polls
 * this on the same cadence, so the UI code that reacts to `attack.incoming` is
 * the same either way.
 */
export function drainLocalEvents(): { event: string; channel: string; data: unknown }[] {
  if (!seeded) return [];
  return seeded.world.drainOutbox();
}

/** Start over. The seed is fixed, so "new world" is reproducible. */
export function resetLocalWorld(): void {
  seeded = null;
}
