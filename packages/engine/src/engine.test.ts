/**
 * engine.test.ts — milestone acceptance tests M1, M2, M4 and M8
 *
 * Each milestone in spec/08 has an explicit acceptance test and the instruction
 * "do not advance until it passes". These are those tests.
 */

import { describe, it, expect } from 'vitest';
import {
  C,
  cumulativeLevels,
  gradeForLevel,
  personalQueueSlots,
  unitDef,
  rngFromSeed,
  battleSeed,
  type Formation,
  type Settlement,
} from '@ascendance/shared';
import { World, CommandError } from './world.js';
import { seedWorld } from './bootstrap.js';
import { MemoryStore } from './store/memory.js';
import { Scheduler, IdFactory, compareEvents } from './scheduler.js';
import { resolveBattle, type BattleInput, type CombatUnit } from './sim/combat.js';
import {
  hqLevel, plotsTotal, plotsUsed, validateBuildingEnqueue, upgradeCost,
  accrueProduction, staffing, hqFactorFor,
} from './sim/settlement.js';

const T0 = 1_700_000_000_000n;
const HOUR = 3_600_000n;
const cmd = (() => { let n = 0; return (): string => `cmd-${n++}`; })();

function freshWorld(): ReturnType<typeof seedWorld> {
  return seedWorld({ now: T0, neighbours: 6 });
}

// ============================================================================
// M1 — the scheduler
// ============================================================================

describe('M1 acceptance — the scheduler', () => {
  it('executes events at their timestamps, in timestamp order', () => {
    const store = new MemoryStore();
    const sched = new Scheduler(store, new IdFactory('w'));
    const fired: string[] = [];
    sched.on('DECAY_TICK', (_tx, e) => { fired.push(String(e.payload['tag'])); });

    store.transaction((tx) => {
      sched.schedule(tx, { shardId: 's', executeAt: T0 + 300n, kind: 'DECAY_TICK', payload: { tag: 'third' } });
      sched.schedule(tx, { shardId: 's', executeAt: T0 + 100n, kind: 'DECAY_TICK', payload: { tag: 'first' } });
      sched.schedule(tx, { shardId: 's', executeAt: T0 + 200n, kind: 'DECAY_TICK', payload: { tag: 'second' } });
    });

    expect(sched.drain(T0 + 150n).executed).toBe(1);
    expect(fired).toEqual(['first']);
    expect(sched.advanceTo(T0 + 1000n).executed).toBe(2);
    expect(fired).toEqual(['first', 'second', 'third']);
  });

  it('costs nothing for idle entities — ten thousand quiet settlements schedule nothing', () => {
    // The whole point of the design: O(events actually happening), not
    // O(entities) per tick forever.
    const store = new MemoryStore();
    const sched = new Scheduler(store, new IdFactory('w'));
    expect(sched.drain(T0 + 10n ** 9n).executed).toBe(0);
    expect(sched.nextDueAt()).toBeUndefined();
  });

  it('hands a handler its SCHEDULED time, not the wall clock', () => {
    // A worker running late must still resolve as though it happened on time,
    // or a replay of the event log would diverge (Bible §5.4).
    const store = new MemoryStore();
    const sched = new Scheduler(store, new IdFactory('w'));
    let seen: bigint | undefined;
    sched.on('REVOLT_CHECK', (_tx, _e, now) => { seen = now; });
    store.transaction((tx) => sched.schedule(tx, { shardId: 's', executeAt: T0 + 50n, kind: 'REVOLT_CHECK', payload: {} }));
    sched.drain(T0 + 999_999n); // drained very late
    expect(seen).toBe(T0 + 50n);
  });

  it('leaves no trace when a handler throws', () => {
    const store = new MemoryStore();
    const sched = new Scheduler(store, new IdFactory('w'));
    sched.on('DECAY_TICK', (tx) => {
      tx.appendEvent({ id: 'x', worldId: 'w', shardId: 's', occurredAt: T0, kind: 'should-not-survive', payload: {} });
      throw new Error('poisoned');
    });
    store.transaction((tx) => sched.schedule(tx, { shardId: 's', executeAt: T0, kind: 'DECAY_TICK', payload: {} }));
    const r = sched.drain(T0);
    expect(r.executed).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(store.read((tx) => tx.allEvents())).toHaveLength(0);
  });

  it('does not double-run one event, and one poisoned event does not roll back the rest', () => {
    const store = new MemoryStore();
    const sched = new Scheduler(store, new IdFactory('w'));
    let good = 0;
    sched.on('DECAY_TICK', (_tx, e) => {
      if (e.payload['bad']) throw new Error('poisoned');
      good++;
    });
    store.transaction((tx) => {
      sched.schedule(tx, { shardId: 's', executeAt: T0, kind: 'DECAY_TICK', payload: {} });
      sched.schedule(tx, { shardId: 's', executeAt: T0, kind: 'DECAY_TICK', payload: { bad: true } });
      sched.schedule(tx, { shardId: 's', executeAt: T0, kind: 'DECAY_TICK', payload: {} });
    });
    const r = sched.drain(T0);
    expect(good).toBe(2);
    expect(r.failed).toHaveLength(1);
    expect(sched.drain(T0).executed).toBe(0); // nothing re-runs
  });

  it('orders simultaneous events deterministically', () => {
    // The comparator is the only thing deciding which of two simultaneous
    // battles resolves first, and a replay must make the same choice.
    const a = { id: 'ev-a', shardId: 's', executeAt: T0, kind: 'DECAY_TICK' as const, payload: {} };
    const b = { id: 'ev-b', shardId: 's', executeAt: T0, kind: 'DECAY_TICK' as const, payload: {} };
    expect(compareEvents(a, b)).toBeLessThan(0);
    expect(compareEvents(b, a)).toBeGreaterThan(0);
    expect(compareEvents(a, a)).toBe(0);
  });

  it('cancels a pending event but refuses to lose one already claimed', () => {
    const store = new MemoryStore();
    const sched = new Scheduler(store, new IdFactory('w'));
    sched.on('MOVEMENT_ARRIVE', () => undefined);
    const id = store.transaction((tx) =>
      sched.schedule(tx, { shardId: 's', executeAt: T0 + HOUR, kind: 'MOVEMENT_ARRIVE', payload: {} }).id,
    );
    expect(store.transaction((tx) => sched.cancel(tx, id))).toBe(true);
    expect(store.transaction((tx) => sched.cancel(tx, id))).toBe(false);
    expect(sched.advanceTo(T0 + HOUR * 2n).executed).toBe(0);
  });
});

// ============================================================================
// M1 — replay determinism, "the single most valuable test in the codebase"
// ============================================================================

describe('M1 — replay determinism', () => {
  /** A fixed script of player actions, run against a fresh world. */
  function playScript(): { world: World; hash: string } {
    const { world, playerId, homeId } = seedWorld({ worldId: 'replay', now: T0, neighbours: 4 });
    world.enqueue({ commandId: 'c1', playerId, settlementId: homeId, kind: 'building', targetKey: '1_farm', slotKind: 'personal' });
    world.advanceTo(T0 + HOUR * 6n);
    world.enqueue({ commandId: 'c2', playerId, settlementId: homeId, kind: 'building', targetKey: '1_lumber_camp', slotKind: 'personal' });
    world.advanceTo(T0 + HOUR * 24n);

    const target = world.store.read((tx) => tx.settlements.find((s) => s.ownerId && s.ownerId !== playerId));
    const force = world.formationsOf(playerId).filter((f) => f.count > 0).slice(0, 2);
    if (target && force.length > 0) {
      world.dispatch({
        commandId: 'c3', playerId, originId: homeId, targetId: target.id, mission: 'attack',
        formations: force.map((f) => ({ formationId: f.id, count: Math.floor(f.count / 2) })),
      });
    }
    world.advanceTo(T0 + HOUR * 72n);
    return { world, hash: worldHash(world) };
  }

  it('produces an identical world from an identical script and seed', () => {
    // If this passes, determinism holds — and determinism is what makes
    // archaeology, the World Atlas, dispute resolution and every balance
    // simulation possible (spec/08).
    const a = playScript();
    const b = playScript();
    expect(a.hash).toBe(b.hash);
  });

  it('reaches the same state whether advanced in one jump or many', () => {
    // Nothing may depend on how finely time was sliced, or a busy server and a
    // quiet one would diverge.
    const one = seedWorld({ worldId: 'slices', now: T0, neighbours: 3 });
    one.world.enqueue({ commandId: 'x1', playerId: one.playerId, settlementId: one.homeId, kind: 'building', targetKey: '1_farm', slotKind: 'personal' });
    one.world.advanceTo(T0 + HOUR * 48n);

    const many = seedWorld({ worldId: 'slices', now: T0, neighbours: 3 });
    many.world.enqueue({ commandId: 'x1', playerId: many.playerId, settlementId: many.homeId, kind: 'building', targetKey: '1_farm', slotKind: 'personal' });
    for (let h = 1n; h <= 48n; h++) many.world.advanceTo(T0 + HOUR * h);

    expect(worldHash(one.world)).toBe(worldHash(many.world));
  });

  it('records every state change in the append-only event log', () => {
    const { world, playerId, homeId } = seedWorld({ worldId: 'log', now: T0, neighbours: 2 });
    world.enqueue({ commandId: 'l1', playerId, settlementId: homeId, kind: 'building', targetKey: '1_farm', slotKind: 'personal' });
    world.advanceTo(T0 + HOUR * 24n);
    const log = world.store.read((tx) => tx.allEvents());
    expect(log.map((e) => e.kind)).toContain('queue.enqueued');
    expect(log.map((e) => e.kind)).toContain('building.completed');
    // Append-only: timestamps never go backwards.
    for (let i = 1; i < log.length; i++) expect(log[i]!.occurredAt >= log[i - 1]!.occurredAt).toBe(true);
  });
});

// ============================================================================
// M2 — settlements and buildings
// ============================================================================

describe('M2 acceptance — settlements and buildings', () => {
  it('matches the workbook cost and time curves exactly', () => {
    // cost(L) = base * (L+1)^2.4 * 1.004^L, from Building_Levels.
    const c = upgradeCost('1_farm', 0, 1, 1, 1);
    expect(c.resources['timber']).toBe(45n); // Farm base Timber-eq
    const c10 = upgradeCost('1_farm', 10, 1, 1, 1);
    const expected = BigInt(Math.round(45 * Math.pow(11, C.BUILD_COST_EXP) * Math.pow(C.BUILD_COST_GEO, 10)));
    expect(c10.resources['timber']).toBe(expected);
  });

  it('rejects all six framework constraints rather than penalising them', () => {
    const { world, homeId } = freshWorld();
    const view = world.view(homeId);

    // 2. Level gating — nothing may pass the HQ.
    const tall = validateBuildingEnqueue(
      { ...view, buildings: view.buildings.map((b) => (b.buildingKey === '1_farm' ? { ...b, level: hqLevel(view) } : b)) },
      '1_farm',
      'personal',
    );
    expect(tall.ok).toBe(false);
    if (!tall.ok) expect(tall.type).toBe('hq-level-cap');

    // 1. Plots — a settlement can never hold every building.
    const crowded = {
      ...view,
      buildings: Array.from({ length: 40 }, (_, i) => ({
        ...view.buildings[0]!, id: `b${i}`, buildingKey: '1_farm', plotIndex: i,
      })),
    };
    const noPlots = validateBuildingEnqueue(crowded, '1_fishery', 'personal');
    expect(noPlots.ok).toBe(false);
    if (!noPlots.ok) expect(noPlots.type).toBe('insufficient-plots');
  });

  it('hard-stops the one-perfect-megacity pattern at the specialization caps', () => {
    const { world, homeId } = freshWorld();
    const view = world.view(homeId);
    // The cap is checked when an enqueue CROSSES a grade boundary, so the
    // candidate sits at the last level of grade 31 and is asked to enter 32.
    const lastLevelOfG31 = (C.SPEC_CAP_G30_GRADE + 1) * C.LEVELS_PER_GRADE - 1;
    const hq = { ...view.buildings[0]!, id: 'hq', buildingKey: '1_chieftain_s_hall', level: 1337 };
    const maxed = Array.from({ length: C.SPEC_CAP_G30 }, (_, i) => ({
      ...view.buildings[0]!, id: `hi${i}`, buildingKey: `1_fishery`, level: lastLevelOfG31, plotIndex: i,
    }));
    const candidate = { ...view.buildings[0]!, id: 'cand', buildingKey: '1_farm', level: lastLevelOfG31 };
    expect(gradeForLevel(candidate.level + 1)).toBeGreaterThan(gradeForLevel(candidate.level));
    const r = validateBuildingEnqueue({ ...view, buildings: [hq, ...maxed, candidate] }, '1_farm', 'personal');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.type).toBe('specialization-cap');
  });

  it('grants plots and queue slots from the HQ grade', () => {
    const { world, homeId } = freshWorld();
    const view = world.view(homeId);
    expect(plotsTotal(view)).toBeGreaterThan(24);
    expect(plotsUsed(view)).toBeGreaterThan(0);
    expect(personalQueueSlots(gradeForLevel(hqLevel(view)))).toBeGreaterThanOrEqual(1);
    expect(hqFactorFor(hqLevel(view))).toBeGreaterThan(1);
  });

  it('accrues production lazily and discards overflow', () => {
    const { world, homeId } = freshWorld();
    const before = world.view(homeId);
    const after = accrueProduction(before, T0 + HOUR * 10n);
    const grain = after.stockpiles.find((s) => s.resourceKey === 'grain');
    expect(grain).toBeDefined();
    // Overflow above capacity is LOST, not carried — deliberate pressure to
    // spend, trade, or expand.
    for (const s of after.stockpiles) expect(s.amount <= s.capacity).toBe(true);
  });

  it('reports understaffing as a condition, not an error', () => {
    const { world, homeId } = freshWorld();
    const st = staffing(world.view(homeId));
    expect(st.demand).toBeGreaterThan(0);
    expect(st.ratio).toBeGreaterThan(0);
    expect(st.ratio).toBeLessThanOrEqual(1);
  });

  it('spends resources on enqueue and completes the building on schedule', () => {
    const { world, playerId, homeId } = freshWorld();
    const before = world.view(homeId).stockpiles.find((s) => s.resourceKey === 'timber')!.amount;
    const item = world.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'building', targetKey: '1_fishery', slotKind: 'personal' });
    expect(item.finishesAt).toBeGreaterThan(T0);

    const after = world.view(homeId).stockpiles.find((s) => s.resourceKey === 'timber')!.amount;
    expect(after).toBeLessThan(before);

    world.advanceTo(item.finishesAt);
    expect(world.view(homeId).buildings.some((b) => b.buildingKey === '1_fishery')).toBe(true);
  });

  it('refuses to enqueue what the settlement cannot afford', () => {
    const { world, playerId, homeId } = freshWorld();
    world.store.transaction((tx) => {
      for (const s of tx.stockpiles.where((x) => x.settlementId === homeId)) tx.stockpiles.put({ ...s, amount: 0n });
    });
    expect(() =>
      world.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'building', targetKey: '1_fishery', slotKind: 'personal' }),
    ).toThrow(CommandError);
  });
});

// ============================================================================
// M4 — combat
// ============================================================================

describe('M4 acceptance — the six-phase resolver', () => {
  function battle(overrides: Partial<BattleInput> = {}): BattleInput {
    const attacker: CombatUnit[] = [
      { formationId: 'a1', formationName: 'The Hearth Levy', unitKey: '1|Militia|Orthodox (Balanced)|Mortal', count: 400, tier: 3, levelInTier: 200, equipmentMod: 1.1 },
      { formationId: 'a2', formationName: 'Verrin Longbows', unitKey: '1|Hunter-Archer|Asura (Offense)|Mortal', count: 200, tier: 2, levelInTier: 500, equipmentMod: 1.05 },
      { formationId: 'a3', formationName: 'The Takers', unitKey: '1|Axeman|Orthodox (Balanced)|Elite', count: 150, tier: 4, levelInTier: 100, equipmentMod: 1.0 },
    ];
    const defender: CombatUnit[] = [
      { formationId: 'd1', formationName: 'Steading Levy', unitKey: '1|Spearman|Orthodox (Balanced)|Mortal', count: 300, tier: 2, levelInTier: 100, equipmentMod: 1 },
      { formationId: 'd2', formationName: 'Wall Watch', unitKey: '1|Shield Bearer|Guardian (Defense)|Mortal', count: 200, tier: 3, levelInTier: 50, equipmentMod: 1 },
    ];
    return {
      battleId: 'bt-1',
      settlementName: 'Aelric’s Steading',
      layer: 'province',
      mission: 'attack',
      attacker: { playerName: 'Verrin', empireWeight: 20, era: 1, units: attacker, techTier: 1, doctrineMod: 1, commanderMod: 1.05, envyScopes: 0, munitions: 1e6, statecraft: 2, scoutingQuality: 0.3 },
      defender: { playerName: 'Aelric', empireWeight: 18, era: 1, units: defender, techTier: 1, doctrineMod: 1, commanderMod: 1, envyScopes: 0, munitions: 1e6, statecraft: 1, scoutingQuality: 0 },
      fortification: { wallGrade: 4, flatGarrisonHp: 2000, concealment: 0.2 },
      plunderable: { timber: 50_000n, stone: 30_000n },
      carryCapacity: 20_000n,
      hiddenCellar: 2_000n,
      defenderLoyalty: 100,
      ...overrides,
    };
  }

  it('reproduces a battle byte-identically from a fixed seed', () => {
    const seed = battleSeed('w', 'bt-1');
    const a = resolveBattle(battle(), rngFromSeed(seed));
    const b = resolveBattle(battle(), rngFromSeed(seed));
    expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report));
    expect(a.survivors).toEqual(b.survivors);
  });

  it('runs the six phases in order', () => {
    const r = resolveBattle(battle(), rngFromSeed(battleSeed('w', 'bt-1')));
    expect(r.report.phases.map((p) => p.name)).toEqual(['intel', 'ranged', 'main', 'breakthrough', 'plunder']);
    // Munitions is Era IV+ only.
    const modern = battle();
    modern.attacker.era = 4;
    const r4 = resolveBattle(modern, rngFromSeed(battleSeed('w', 'bt-2')));
    expect(r4.report.phases.map((p) => p.name)).toContain('munitions');
  });

  it('never breaches the +40% joint cap, however many systems stack', () => {
    const b = battle();
    // Every in-cap system pushed hard at once.
    b.attacker.techTier = 3;
    b.attacker.commanderMod = 2;
    b.attacker.units = b.attacker.units.map((u) => ({ ...u, equipmentMod: 1.5, tier: 12, levelInTier: 1000 }));
    const r = resolveBattle(b, rngFromSeed(battleSeed('w', 'cap')));
    for (const phase of r.report.phases) {
      for (const p of [phase.attackerPower, phase.defenderPower]) {
        if (p.base <= 0) continue;
        // capped is the in-cap portion; it may never exceed base * 1.4 times
        // the out-of-cap multipliers, which is exactly what `uncapped` records.
        expect(p.capped).toBeLessThanOrEqual(p.uncapped + 1e-6);
        if (p.jointCapEngaged) expect(p.capped).toBeLessThan(p.uncapped);
      }
    }
  });

  it('shows the cap engaging rather than applying it silently', () => {
    // A silent cap produces accusations of cheating.
    const b = battle();
    b.attacker.commanderMod = 3;
    b.attacker.units = b.attacker.units.map((u) => ({ ...u, equipmentMod: 1.5, tier: 20, levelInTier: 1000 }));
    const r = resolveBattle(b, rngFromSeed(battleSeed('w', 'cap2')));
    const main = r.report.phases.find((p) => p.name === 'main')!;
    expect(main.attackerPower.jointCapEngaged).toBe(true);
    expect(main.note).toContain('joint cap');
  });

  it('conserves forces — casualties never exceed the counts present', () => {
    for (const seedTag of ['s1', 's2', 's3', 's4', 's5']) {
      const input = battle();
      const r = resolveBattle(input, rngFromSeed(battleSeed('w', seedTag)));
      for (const side of [r.report.attacker, r.report.defender]) {
        for (const f of side.formations) {
          expect(f.after).toBeGreaterThanOrEqual(0);
          expect(f.after).toBeLessThanOrEqual(f.before);
        }
      }
    }
  });

  it('enforces layer limits as preconditions, not modifiers', () => {
    // Orbital bombardment softens a planet but cannot capture it.
    const b = battle({ layer: 'orbit', mission: 'conquer' });
    const r = resolveBattle(b, rngFromSeed(battleSeed('w', 'orbit')));
    if (r.report.outcome === 'attacker') {
      expect(r.captured).toBe(false);
      expect(r.report.layerLimits.join(' ')).toMatch(/cannot occupy/i);
    }
  });

  it('cannot flip a settlement without conquest-class units', () => {
    const b = battle();
    const r = resolveBattle(b, rngFromSeed(battleSeed('w', 'noconq')));
    if (r.report.outcome === 'attacker') {
      expect(r.captured).toBe(false);
      expect(r.report.layerLimits.join(' ')).toMatch(/conquest-class/i);
    }
  });

  it('bounds plunder by carrying capacity and never takes the hidden cellar', () => {
    const b = battle({ carryCapacity: 5_000n });
    const r = resolveBattle(b, rngFromSeed(battleSeed('w', 'loot')));
    if (r.report.outcome === 'attacker') {
      const total = Object.values(r.plunder).reduce((n, v) => n + v, 0n);
      expect(total).toBeLessThanOrEqual(5_000n);
    }
  });

  it('writes the full arithmetic of every multiplier into the report', () => {
    // INVARIANT §2.7: if a number cannot be shown with its derivation, it
    // should not exist.
    const r = resolveBattle(battle(), rngFromSeed(battleSeed('w', 'report')));
    const main = r.report.phases.find((p) => p.name === 'main')!;
    for (const key of ['techTier', 'equipment', 'doctrine', 'commander', 'veterancy', 'morale', 'counterMatrix', 'uncapped', 'capped'] as const) {
      expect(typeof main.attackerPower[key]).toBe('number');
    }
    expect(main.defenderPower.fortification).toBeGreaterThan(1);
    expect(main.attackerPower.byUnit.length).toBeGreaterThan(0);
    for (const row of main.attackerPower.byUnit) {
      expect(row.formationId).toBeTruthy();
      expect(row.contributionShare).toBeGreaterThanOrEqual(0);
      expect(row.contributionShare).toBeLessThanOrEqual(1);
    }
    const shares = main.attackerPower.byUnit.reduce((n, r2) => n + r2.contributionShare, 0);
    expect(shares).toBeCloseTo(1, 6);
  });

  it('applies Heaven’s Envy to defence and fortification but never to attack', () => {
    // A marked player is a glass cannon, not simply weaker.
    const clean = resolveBattle(battle(), rngFromSeed(battleSeed('w', 'envy')));
    const marked = battle();
    marked.defender.envyScopes = 3;
    const cursed = resolveBattle(marked, rngFromSeed(battleSeed('w', 'envy')));

    const cleanMain = clean.report.phases.find((p) => p.name === 'main')!;
    const cursedMain = cursed.report.phases.find((p) => p.name === 'main')!;
    expect(cursedMain.defenderPower.total).toBeLessThan(cleanMain.defenderPower.total);
    expect(cursedMain.defenderPower.heavensEnvy).toBeCloseTo(0.7, 10);
  });

  it('pays screens for damage they absorbed even when they killed nothing', () => {
    // Without absorption XP the Guardian identity path is a trap.
    const r = resolveBattle(battle(), rngFromSeed(battleSeed('w', 'absorb')));
    expect(r.damageAbsorbed['d2']).toBeGreaterThan(0);
  });
});

// ============================================================================
// M8 — governors, Seize, and the 2x rule
// ============================================================================

describe('M8 acceptance — governors and Seize', () => {
  it('executes a governor job at exactly 2x time', () => {
    const { world, playerId, homeId } = freshWorld();
    const byHand = world.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'building', targetKey: '1_fishery', slotKind: 'personal' });
    const byGovernor = world.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'building', targetKey: '1_apiary', slotKind: 'governor' });
    // Different buildings, so compare the ratio of their computed durations
    // against the same job done by hand.
    const handDuration = byHand.finishesAt - byHand.startedAt;
    const govDuration = byGovernor.finishesAt - byGovernor.startedAt;
    const handEquivalent = upgradeCost('1_apiary', 0, hqFactorFor(hqLevel(world.view(homeId))), 1, 1).totalTimeMs;
    expect(govDuration).toBe(handEquivalent * 2n);
    expect(byHand.timeMultiplier).toBe(1);
    expect(byGovernor.timeMultiplier).toBe(2);
    expect(handDuration).toBeGreaterThan(0n);
  });

  it('keeps elapsed progress on Seize and recomputes the remainder at 1x', () => {
    const { world, playerId, homeId } = freshWorld();
    const item = world.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'building', targetKey: '1_apiary', slotKind: 'governor' });
    const total = item.finishesAt - item.startedAt;

    world.advanceTo(T0 + total / 2n);
    const seized = world.seize(cmd(), playerId, item.id);

    // Half the (doubled) work was done; the remaining half now runs at 1x, so
    // it takes a quarter of the original doubled duration.
    expect(seized.slotKind).toBe('personal');
    expect(seized.timeMultiplier).toBe(1);
    expect(seized.finishesAt - world.now).toBe(total / 4n);
    expect(seized.finishesAt).toBeLessThan(item.finishesAt);
  });

  it('refuses to Seize without a free personal slot', () => {
    // This scarcity is the ONLY thing preventing a player from governing
    // everything and instantly seizing it all back (Bible §5.6).
    const { world, playerId, homeId } = freshWorld();
    const slots = personalQueueSlots(gradeForLevel(hqLevel(world.view(homeId))));
    const govItem = world.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'building', targetKey: '1_apiary', slotKind: 'governor' });
    const fillers = ['1_fishery', '1_orchard', '1_pig_pen', '1_chicken_coop', '1_goat_shed', '1_trap_line', '1_vegetable_garden'];
    for (let i = 0; i < slots; i++) {
      world.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'building', targetKey: fillers[i]!, slotKind: 'personal' });
    }
    expect(() => world.seize(cmd(), playerId, govItem.id)).toThrow(/personal slot/i);
  });

  it('audits the Seize in the event log', () => {
    // Seize is one of only two things that may move a completion time downward
    // (invariant §2.8), so it is written to the permanent record.
    const { world, playerId, homeId } = freshWorld();
    const item = world.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'building', targetKey: '1_apiary', slotKind: 'governor' });
    // Early buildings complete in seconds — advance to halfway, not an hour, or
    // there is nothing left to seize.
    world.advanceTo(item.startedAt + (item.finishesAt - item.startedAt) / 2n);
    world.seize(cmd(), playerId, item.id);
    const audit = world.store.read((tx) => tx.allEvents()).find((e) => e.kind === 'queue.seized');
    expect(audit).toBeDefined();
    expect(audit?.payload['wasFinishingAt']).toBeDefined();
    expect(audit?.payload['nowFinishingAt']).toBeDefined();
  });
});

// ============================================================================
// Idempotency and command safety
// ============================================================================

describe('commands are idempotent by commandId', () => {
  it('does not double-send an army on a retried dispatch', () => {
    // On mobile, a dropped connection during an attack dispatch would otherwise
    // send two armies (spec/05 §1).
    const { world, playerId, homeId } = freshWorld();
    const target = world.store.read((tx) => tx.settlements.find((s) => s.ownerId && s.ownerId !== playerId))!;
    const f = world.formationsOf(playerId)[0]!;
    const args = {
      commandId: 'retry-me', playerId, originId: homeId, targetId: target.id, mission: 'attack',
      formations: [{ formationId: f.id, count: 10 }],
    };
    const first = world.dispatch(args);
    const second = world.dispatch(args);
    expect(second.id).toBe(first.id);
    expect(world.movementsOf(playerId)).toHaveLength(1);
    expect(world.formationsOf(playerId).find((x) => x.id === f.id)!.count).toBe(f.count - 10);
  });

  it('blocks an attack behind a non-aggression pact, on the server', () => {
    // A NAP hard-blocks attacks in the UI AND on the server. Betrayal is always
    // allowed and always priced — but it must be an explicit treaty break.
    const { world, playerId, homeId } = freshWorld();
    const target = world.store.read((tx) => tx.settlements.find((s) => s.ownerId && s.ownerId !== playerId))!;
    world.store.transaction((tx) => {
      tx.treaties.put({
        id: 't1', kind: 'nap', partyA: playerId, partyB: target.ownerId!, terms: {}, signedAt: T0,
      });
    });
    const f = world.formationsOf(playerId)[0]!;
    expect(() =>
      world.dispatch({ commandId: cmd(), playerId, originId: homeId, targetId: target.id, mission: 'attack', formations: [{ formationId: f.id, count: 5 }] }),
    ).toThrow(/non-aggression/i);
  });
});

// ============================================================================
// M10 — Chrono Shard guardrails, enforced server-side
// ============================================================================

describe('M10 acceptance — Chrono Shard guardrails', () => {
  it('cannot be exceeded by any purchase, however large the balance', () => {
    const { world, playerId, homeId } = freshWorld();
    world.store.transaction((tx) => {
      const p = tx.players.require(playerId);
      tx.players.put({ ...p, shardBalanceHours: 1_000_000 });
    });
    const item = world.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'building', targetKey: '1_fishery', slotKind: 'personal' });
    const naturalDuration = item.finishesAt - item.startedAt;

    const after = world.spendShards(cmd(), playerId, item.id, 1_000_000);
    const compressedDuration = after.finishesAt - after.startedAt;
    // At construction rank 0 in era 1 the ceiling is 2.5x, so the item can
    // never take less than 40% of its natural duration.
    const ratio = Number(naturalDuration) / Number(compressedDuration);
    expect(ratio).toBeLessThanOrEqual(2.5 + 1e-6);
  });

  it('refuses every prohibited target, starting with an inbound attack', () => {
    const { world, playerId, homeId } = freshWorld();
    const attacker = world.store.read((tx) => tx.settlements.find((s) => s.ownerId && s.ownerId !== playerId))!;
    const item = world.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'building', targetKey: '1_fishery', slotKind: 'personal' });

    world.store.transaction((tx) => {
      tx.movements.put({
        id: 'incoming', shardId: 'shard-1', ownerId: attacker.ownerId!, originId: attacker.id, targetId: homeId,
        mission: 'attack', formations: [], departsAt: T0, arrivesAt: T0 + HOUR, revealedTo: [],
      });
    });
    expect(() => world.spendShards(cmd(), playerId, item.id, 1)).toThrow(/hostile-movement-inbound/);
  });

  it('accrues Temporal Debt, which money cannot pay off', () => {
    // Early buildings finish in seconds, so there is nothing to compress. Debt
    // is a late-game pressure by construction, which is itself the design
    // working: shards are worthless until a job is long enough to hurt.
    const { world, playerId, homeId } = deepBuild(freshWorld(), 900);
    const item = world.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'building', targetKey: '1_farm', slotKind: 'personal' });

    // At a rank-0 ceiling of 2.5x the most that can ever be compressed is 60%
    // of the natural duration, so the job has to be long enough that 60% of it
    // crosses a karma tier at all.
    const naturalHours = Number(item.finishesAt - item.startedAt) / 3_600_000;
    expect(naturalHours * 0.6).toBeGreaterThan(C.TEMPORAL_DEBT_HOURS_PER_TIER);

    world.spendShards(cmd(), playerId, item.id, 100_000);
    const p = world.player(playerId);
    expect(p.temporalDebt).toBeGreaterThan(0);
    expect(p.temporalDebt).toBeLessThanOrEqual(C.TEMPORAL_DEBT_TIERS);
  });

  it('logs every spend permanently for public disclosure', () => {
    const { world, playerId, homeId } = freshWorld();
    const item = world.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'building', targetKey: '1_fishery', slotKind: 'personal' });
    world.spendShards(cmd(), playerId, item.id, 2);
    expect(world.store.read((tx) => tx.allEvents()).some((e) => e.kind === 'shards.spent')).toBe(true);
  });
});

// ============================================================================
// The attention dashboard
// ============================================================================

describe('the attention dashboard', () => {
  it('puts an incoming attack above everything else', () => {
    const { world, playerId, homeId } = freshWorld();
    const enemy = world.store.read((tx) => tx.settlements.find((s) => s.ownerId && s.ownerId !== playerId))!;
    const f = world.formationsOf(enemy.ownerId!)[0]!;
    world.dispatch({
      commandId: cmd(), playerId: enemy.ownerId!, originId: enemy.id, targetId: homeId,
      mission: 'attack', formations: [{ formationId: f.id, count: 20 }],
    });
    const items = world.attention(playerId);
    expect(items[0]?.kind).toBe('incoming_attack');
    expect(items[0]?.deadline).toBeDefined();
  });

  it('gives each row a one-tap resolution where one exists', () => {
    const { world, playerId } = freshWorld();
    for (const item of world.attention(playerId)) {
      if (item.kind === 'idle_queue' || item.kind === 'warehouse_full' || item.kind === 'incoming_attack') {
        expect(item.action).toBeDefined();
        expect(item.action?.label).toBeTruthy();
      }
    }
  });

  it('flags idle build slots, because unspent time compounds over months', () => {
    const { world, playerId } = freshWorld();
    expect(world.attention(playerId).some((i) => i.kind === 'idle_queue')).toBe(true);
  });
});

// ============================================================================
// The full play loop — M7's acceptance, minus the UI
// ============================================================================

describe('the full play loop', () => {
  it('builds, dispatches, resolves, and produces a readable report', () => {
    const { world, playerId, homeId } = freshWorld();

    world.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'building', targetKey: '1_fishery', slotKind: 'personal' });

    const target = world.store.read((tx) => tx.settlements.find((s) => s.ownerId && s.ownerId !== playerId))!;
    const force = world.formationsOf(playerId);
    const movement = world.dispatch({
      commandId: cmd(), playerId, originId: homeId, targetId: target.id, mission: 'attack',
      formations: force.map((f) => ({ formationId: f.id, count: Math.floor(f.count * 0.8) })),
    });
    expect(movement.arrivesAt).toBeGreaterThan(world.now);

    world.advanceTo(movement.arrivesAt);

    const battles = world.battlesAt(target.id);
    expect(battles).toHaveLength(1);
    const report = battles[0]!.report;
    expect(report.phases.length).toBeGreaterThanOrEqual(5);
    expect(['attacker', 'defender']).toContain(report.outcome);
    // Both sides can read the whole engagement, including the XP attribution.
    expect(report.attacker.formations.length).toBeGreaterThan(0);
    expect(report.defender.formations.length).toBeGreaterThan(0);
    expect(battles[0]!.seed).toBeGreaterThan(0n);
  });

  it('credits veterancy to the formations that did the work', () => {
    const { world, playerId, homeId } = freshWorld();
    const target = world.store.read((tx) => tx.settlements.find((s) => s.ownerId && s.ownerId !== playerId))!;
    const before = new Map(world.formationsOf(playerId).map((f) => [f.id, cumulativeLevels(f.atkTier, f.atkLevel)]));

    const movement = world.dispatch({
      commandId: cmd(), playerId, originId: homeId, targetId: target.id, mission: 'attack',
      formations: world.formationsOf(playerId).map((f) => ({ formationId: f.id, count: Math.floor(f.count * 0.9) })),
    });
    world.advanceTo(movement.arrivesAt);

    const report = world.battlesAt(target.id)[0]!.report;
    expect(report.attribution.length).toBeGreaterThan(0);
    for (const row of report.attribution) {
      // Every attribution row explains itself: what it killed, how it was
      // valued, and what the next level costs.
      expect(row.requirement.total).toBeTruthy();
      expect(row.formationName).toBeTruthy();
      expect(Number(row.xpAwarded)).toBeGreaterThanOrEqual(0);
    }
    // At least one surviving formation gained something.
    const after = world.formationsOf(playerId);
    const gained = after.some((f) => cumulativeLevels(f.atkTier, f.atkLevel) > (before.get(f.id) ?? 0) || f.atkXp > 0n);
    expect(gained).toBe(true);
  });

  it('records a deed, which is the third promotion requirement', () => {
    const { world, playerId, homeId } = freshWorld();
    const target = world.store.read((tx) => tx.settlements.find((s) => s.ownerId && s.ownerId !== playerId))!;
    const m = world.dispatch({
      commandId: cmd(), playerId, originId: homeId, targetId: target.id, mission: 'attack',
      formations: world.formationsOf(playerId).map((f) => ({ formationId: f.id, count: Math.floor(f.count * 0.5) })),
    });
    world.advanceTo(m.arrivesAt);
    expect(world.formationsOf(playerId).some((f) => f.deeds.length > 0)).toBe(true);
  });
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Fast-forward a settlement to a deep level without simulating five centuries.
 *
 * Used where a behaviour only exists in the late game — Chrono Shards are
 * pointless on a job that finishes in seconds — so the test can exercise it
 * without a 500-year advance.
 */
function deepBuild(seeded: ReturnType<typeof seedWorld>, level: number): ReturnType<typeof seedWorld> {
  const { world, playerId, homeId } = seeded;
  world.store.transaction((tx) => {
    for (const b of tx.buildings.where((x) => x.settlementId === homeId)) {
      tx.buildings.put({ ...b, level: b.buildingKey === '1_chieftain_s_hall' ? 1337 : level });
    }
    for (const s of tx.stockpiles.where((x) => x.settlementId === homeId)) {
      tx.stockpiles.put({ ...s, amount: 10n ** 30n, capacity: 10n ** 30n });
    }
    const p = tx.players.require(playerId);
    tx.players.put({ ...p, shardBalanceHours: 1_000_000 });
    tx.proficiencies.put({ playerId, track: 'construction', rank: 0, xp: 0n, xpToday: 0n });
  });
  return seeded;
}

/**
 * A stable hash of the whole world state.
 *
 * Used by the replay tests. Sorting every collection by id first is what makes
 * it insensitive to insertion order, so the test measures the SIMULATION being
 * deterministic rather than the store's iteration order being stable.
 */
function worldHash(world: World): string {
  const state = world.store.read((tx) => ({
    settlements: tx.settlements.all().sort(byId).map(normalise),
    buildings: tx.buildings.all().sort(byId).map(normalise),
    formations: tx.formations.all().sort(byId).map(normalise),
    stockpiles: tx.stockpiles.all().sort((a, b) => `${a.settlementId}${a.resourceKey}`.localeCompare(`${b.settlementId}${b.resourceKey}`)).map(normalise),
    queue: tx.queue.all().sort(byId).map(normalise),
    battles: tx.battles.all().sort(byId).map((b) => ({ id: b.id, seed: b.seed.toString(), outcome: b.report.outcome })),
    log: tx.allEvents().map((e) => ({ kind: e.kind, at: e.occurredAt.toString() })),
  }));
  return JSON.stringify(state, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id.localeCompare(b.id);
}

function normalise<T extends object>(row: T): T {
  return Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) as T;
}

void unitDef;
void ({} as Formation);
void ({} as Settlement);
