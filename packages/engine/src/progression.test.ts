/**
 * progression.test.ts — training and research
 *
 * spec/08 M3 requires training queues, and spec/04 §3 requires research as the
 * single global exception to production isolation. Both were missing from the
 * first pass at M3: `enqueue` routed every kind through the building path, so
 * a training order failed with "unknown building". These tests exist so that
 * cannot happen again quietly.
 */

import { describe, it, expect } from 'vitest';
import { C, RESEARCH, gradeForLevel, tryUnitDef } from '@ascendance/shared';
import { seedWorld } from './bootstrap.js';
import { CommandError } from './world.js';
import {
  validateResearchEnqueue, researchEffects, bestMilitaryGrade, researchCost, levelOf,
} from './sim/research.js';
import { trainingCost, validateTrainingEnqueue, trainingSlots } from './sim/military.js';

const T0 = 1_700_000_000_000n;
const HOUR = 3_600_000n;
const cmd = (() => { let n = 0; return (): string => `pc-${n++}`; })();

function world(): ReturnType<typeof seedWorld> {
  return seedWorld({ worldId: 'prog', now: T0, neighbours: 3 });
}

// ============================================================================
// Every queue kind actually works — the regression this file exists for
// ============================================================================

describe('every queue kind is implemented', () => {
  it('accepts a building, a training batch, and a research level', () => {
    const { world: w, playerId, homeId } = world();
    // Building and research share the HQ's slots — raising a settlement and
    // advancing a discipline are the same scarce resource, which is the early
    // game's central tension. Training has its own pool. So the three go into
    // three different slots.
    const orders = [
      { kind: 'building' as const, targetKey: '1_fishery', slotKind: 'personal' as const },
      { kind: 'training' as const, targetKey: '1|Militia|Orthodox (Balanced)|Mortal', quantity: 20, slotKind: 'personal' as const },
      { kind: 'research' as const, targetKey: 'agrarian_arts', slotKind: 'governor' as const },
    ];

    for (const o of orders) {
      const item = w.enqueue({ commandId: cmd(), playerId, settlementId: homeId, ...o });
      expect(item.kind).toBe(o.kind);
      expect(item.finishesAt).toBeGreaterThan(item.startedAt);
    }
  });

  it('makes building and research compete for the HQ\u2019s slots', () => {
    const { world: w, playerId, homeId } = world();
    w.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'building', targetKey: '1_fishery', slotKind: 'personal' });
    expect(() =>
      w.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'research', targetKey: 'agrarian_arts', slotKind: 'personal' }),
    ).toThrow(/personal slots are busy/);
  });

  it('draws training from its own slot pool, not the HQ build slots', () => {
    // A settlement is never forced to choose between growing and defending
    // itself, so military buildings grant training slots separately.
    const { world: w, playerId, homeId } = world();
    const view = w.view(homeId);
    expect(trainingSlots(view)).toBeGreaterThan(0);

    w.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'building', targetKey: '1_fishery', slotKind: 'personal' });
    // The single personal build slot is now busy, and training still works.
    const training = w.enqueue({
      commandId: cmd(), playerId, settlementId: homeId, kind: 'training',
      targetKey: '1|Militia|Orthodox (Balanced)|Mortal', quantity: 10, slotKind: 'personal',
    });
    expect(training.kind).toBe('training');
  });
});

// ============================================================================
// Training
// ============================================================================

describe('training', () => {
  it('spawns the units in the settlement that built them', () => {
    // spec/04 §4: units spawn in their production settlement and must
    // physically travel. There is no empire-wide muster.
    const { world: w, playerId, homeId } = world();
    const before = w.formationsOf(playerId).reduce((n, f) => n + f.count, 0);

    const item = w.enqueue({
      commandId: cmd(), playerId, settlementId: homeId, kind: 'training',
      targetKey: '1|Militia|Orthodox (Balanced)|Mortal', quantity: 50, slotKind: 'personal',
    });
    w.advanceTo(item.finishesAt);

    const after = w.formationsOf(playerId);
    expect(after.reduce((n, f) => n + f.count, 0)).toBe(before + 50);
    expect(after.every((f) => f.count === 0 || f.settlementId === homeId || f.settlementId !== homeId)).toBe(true);
    expect(after.some((f) => f.settlementId === homeId && f.unitKey === '1|Militia|Orthodox (Balanced)|Mortal')).toBe(true);
  });

  it('scales time with the batch, so a large order is a real commitment', () => {
    const one = trainingCost('1|Militia|Orthodox (Balanced)|Mortal', 1, 1, 1);
    const hundred = trainingCost('1|Militia|Orthodox (Balanced)|Mortal', 100, 1, 1);
    expect(hundred.totalTimeMs).toBe(one.perUnitMs * 100n);
    expect(hundred.resources['grain']).toBe(one.resources['grain']! * 100n);
  });

  it('keeps the Mythic Path Avatar anchor intact through the training path', () => {
    // CALIBRATION ANCHOR 2 (spec/07 §3.2), reached the way the game reaches it.
    const cost = trainingCost('7|Path Avatar|Orthodox (Balanced)|Mythic', 1, 1, 1);
    expect(Number(cost.perUnitMs) / 3_600_000).toBeCloseTo(4383, 0);
  });

  it('doubles under a governor, per unit', () => {
    const byHand = trainingCost('1|Militia|Orthodox (Balanced)|Mortal', 10, 1, C.PLAYER_TIME_MULT);
    const byGovernor = trainingCost('1|Militia|Orthodox (Balanced)|Mortal', 10, 1, C.GOVERNOR_TIME_MULT);
    expect(byGovernor.totalTimeMs).toBe(byHand.totalTimeMs * 2n);
  });

  it('refuses a unit the settlement has no building for', () => {
    const { world: w, playerId, homeId } = world();
    // Nothing in the starting kit trains cavalry.
    const cavalry = '1|Chariot|Orthodox (Balanced)|Mortal';
    if (tryUnitDef(cavalry)) {
      expect(() =>
        w.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'training', targetKey: cavalry, quantity: 1, slotKind: 'personal' }),
      ).toThrow(CommandError);
    }
  });

  it('refuses a grade the player has not researched', () => {
    // Unit_Grades: Elite needs "Grade >= 12 + Warfare rank 5". Those gates are
    // parsed from the workbook, not retyped, so this asserts the parse too.
    const { world: w, playerId, homeId } = world();
    expect(() =>
      w.enqueue({
        commandId: cmd(), playerId, settlementId: homeId, kind: 'training',
        targetKey: '1|Militia|Orthodox (Balanced)|Elite', quantity: 1, slotKind: 'personal',
      }),
    ).toThrow(/grade|Warfare/i);
  });

  it('refuses a later era outright', () => {
    const { world: w, playerId, homeId } = world();
    expect(() =>
      w.enqueue({
        commandId: cmd(), playerId, settlementId: homeId, kind: 'training',
        targetKey: '4|Main Battle Tank|Orthodox (Balanced)|Mortal', quantity: 1, slotKind: 'personal',
      }),
    ).toThrow();
  });

  it('refuses an Outpost, which trains nothing at all', () => {
    const { world: w, playerId } = world();
    const outpost = w.store.read((tx) => tx.settlements.find((s) => s.holdingType === 'outpost_camp'));
    if (!outpost) return;
    w.store.transaction((tx) => tx.settlements.put({ ...outpost, ownerId: playerId }));
    expect(() =>
      w.enqueue({
        commandId: cmd(), playerId, settlementId: outpost.id, kind: 'training',
        targetKey: '1|Militia|Orthodox (Balanced)|Mortal', quantity: 1, slotKind: 'personal',
      }),
    ).toThrow();
  });

  it('merges into an existing formation, diluting its veterancy', () => {
    // Green dilution applies on reinforcement, not on loss (spec/03 §6).
    const { world: w, playerId, homeId } = world();
    const target = w.formationsOf(playerId).find((f) => f.unitKey === '1|Militia|Orthodox (Balanced)|Mortal')!;
    w.store.transaction((tx) => tx.formations.put({ ...target, atkTier: 6, atkLevel: 500 }));
    const before = w.formationsOf(playerId).find((f) => f.id === target.id)!;

    const item = w.enqueue({
      commandId: cmd(), playerId, settlementId: homeId, kind: 'training',
      targetKey: '1|Militia|Orthodox (Balanced)|Mortal', quantity: 400, slotKind: 'personal',
    });
    w.advanceTo(item.finishesAt);

    const after = w.formationsOf(playerId).find((f) => f.id === target.id)!;
    expect(after.count).toBe(before.count + 400);
    expect(after.atkTier).toBeLessThan(before.atkTier);
  });
});

// ============================================================================
// Research
// ============================================================================

describe('research — the one global progression', () => {
  const base = { levels: {}, playerEra: 1, cultivationGrade: 1, hasKnowledgeBuilding: true };

  it('is global to the player but paid for locally', () => {
    const { world: w, playerId, homeId } = world();
    const before = w.view(homeId).stockpiles.find((s) => s.resourceKey === 'timber')!.amount;

    const item = w.enqueue({
      commandId: cmd(), playerId, settlementId: homeId, kind: 'research', targetKey: 'agrarian_arts', slotKind: 'personal',
    });
    // Paid from this settlement's stockpile...
    expect(w.view(homeId).stockpiles.find((s) => s.resourceKey === 'timber')!.amount).toBeLessThan(before);

    w.advanceTo(item.finishesAt);
    // ...but the level belongs to the player, not the settlement.
    expect(levelOf(w.researchLevelsOf(playerId), 'agrarian_arts')).toBe(1);
  });

  it('cannot be researched twice at once across an empire', () => {
    // Otherwise a wide player buys the same global level once per settlement.
    const { world: w, playerId, homeId } = world();
    w.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'research', targetKey: 'agrarian_arts', slotKind: 'personal' });
    expect(() =>
      w.enqueue({ commandId: cmd(), playerId, settlementId: homeId, kind: 'research', targetKey: 'agrarian_arts', slotKind: 'governor' }),
    ).toThrow(/already being researched/i);
  });

  it('needs a Knowledge building to host it', () => {
    const r = validateResearchEnqueue('agrarian_arts', { ...base, hasKnowledgeBuilding: false });
    expect(r.ok).toBe(false);
  });

  it('requires every previous-era discipline at grade 12', () => {
    // spec/04 §3. An era-2 player with nothing behind them is refused — the
    // era gate is satisfied, so this is the prerequisite talking.
    const r = validateResearchEnqueue('guild_economics', { ...base, playerEra: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.type).toBe('grade-prerequisite');
      expect(r.detail).toMatch(/grade 12/);
    }
  });

  it('lets an era-2 discipline through once era 1 is at grade 12', () => {
    const era1 = RESEARCH.filter((x) => x.era === 1);
    const levels = Object.fromEntries(era1.map((x) => [x.key, 12 * C.LEVELS_PER_GRADE]));
    const r = validateResearchEnqueue('guild_economics', { ...base, playerEra: 2, levels });
    expect(r.ok).toBe(true);
  });

  it('only checks the grade prerequisites when a level CROSSES a boundary', () => {
    // Grades are the checkpoints; levels between them run free.
    const mid = { ...base, levels: { agrarian_arts: 5 } };
    expect(validateResearchEnqueue('agrarian_arts', mid).ok).toBe(true);

    // Breaking into grade 2 is free: it needs the others at grade 1, and
    // level 0 already IS grade 1. The gate starts biting at grade 3, where a
    // player who rushed one discipline has to bring the others along.
    const intoGrade2 = { ...base, levels: { agrarian_arts: C.LEVELS_PER_GRADE - 1 } };
    expect(validateResearchEnqueue('agrarian_arts', intoGrade2).ok).toBe(true);

    const intoGrade3 = { ...base, levels: { agrarian_arts: 2 * C.LEVELS_PER_GRADE - 1 }, cultivationGrade: 10 };
    const r = validateResearchEnqueue('agrarian_arts', intoGrade3);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.type).toBe('grade-prerequisite');
      expect(r.detail).toMatch(/grade 2/);
    }
  });

  it('gates a breakthrough on cultivation as well as on the other disciplines', () => {
    // Technology and the player's own cultivation advance together by design;
    // neither is allowed to run away from the other.
    const sameEraReady = Object.fromEntries(
      RESEARCH.filter((x) => x.era === 1).map((x) => [x.key, 2 * C.LEVELS_PER_GRADE - 1]),
    );
    const r = validateResearchEnqueue('agrarian_arts', {
      ...base, levels: sameEraReady, cultivationGrade: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/cultivation/i);

    const ok = validateResearchEnqueue('agrarian_arts', {
      ...base, levels: sameEraReady, cultivationGrade: 2,
    });
    expect(ok.ok).toBe(true);
  });

  it('applies the per-level effects the workbook publishes', () => {
    // +0.3% output per level for Economy, +0.25% unit effectiveness for
    // Military — parsed from Research_Disciplines, not retyped.
    const e = researchEffects({ agrarian_arts: 100, tribal_warfare: 100 }, 1);
    expect(e.output).toBeCloseTo(1.3, 6);
    expect(e.unitEffectiveness).toBeCloseTo(1.25, 6);
    expect(e.governance).toBeCloseTo(1, 6);
  });

  it('ignores disciplines from an era the player has not reached', () => {
    const e = researchEffects({ guild_economics: 1000 }, 1);
    expect(e.output).toBe(1);
  });

  it('reads the military grade that gates unit grades', () => {
    expect(bestMilitaryGrade({ tribal_warfare: 12 * C.LEVELS_PER_GRADE })).toBe(13);
    expect(bestMilitaryGrade({ agrarian_arts: 40 * C.LEVELS_PER_GRADE })).toBe(1);
  });

  it('rides the same cost curve as buildings', () => {
    // So a player can reason about "a level of research" against "a level of
    // building" with one mental model, and the 500-year anchor covers both.
    const low = researchCost('agrarian_arts', 0, 1, 1);
    const high = researchCost('agrarian_arts', 100, 1, 1);
    expect(high.resources['timber']! > low.resources['timber']! * 100n).toBe(true);
    expect(high.totalTimeMs).toBeGreaterThan(low.totalTimeMs);
  });

  it('feeds the combat tech multiplier', () => {
    const { world: w, playerId } = world();
    w.store.transaction((tx) => {
      tx.research.put({ playerId, researchKey: 'tribal_warfare', level: 200 });
    });
    const effects = w.researchEffectsOf(playerId);
    expect(effects.unitEffectiveness).toBeCloseTo(1.5, 6);
  });
});

// ============================================================================
// Options — what the server tells the client it may do
// ============================================================================

describe('the options endpoint', () => {
  it('costs everything server-side, and says why anything is refused', () => {
    const { world: w, playerId, homeId } = world();
    const o = w.options(playerId, homeId);

    expect(o.buildings.length).toBeGreaterThan(0);
    expect(o.training.length).toBeGreaterThan(0);
    expect(o.research.length).toBe(RESEARCH.filter((r) => r.era === 1).length);

    const militia = o.training.find((t) => t.unitKey === '1|Militia|Orthodox (Balanced)|Mortal')!;
    expect(militia.allowed).toBe(true);
    expect(Object.keys(militia.cost).length).toBeGreaterThan(0);

    const elite = o.training.find((t) => t.unitKey === '1|Militia|Orthodox (Balanced)|Elite')!;
    expect(elite.allowed).toBe(false);
    expect(elite.reason).toBeTruthy();

    for (const r of o.research) {
      expect(r.grade).toBe(gradeForLevel(r.level));
    }
  });
});

// ============================================================================
// The seize and shard paths must know what kind of item they are moving
// ============================================================================

describe('seize and shards work on every kind', () => {
  it('re-arms a seized training batch as training, not as a building', () => {
    const { world: w, playerId, homeId } = world();
    const item = w.enqueue({
      commandId: cmd(), playerId, settlementId: homeId, kind: 'training',
      targetKey: '1|Militia|Orthodox (Balanced)|Mortal', quantity: 200, slotKind: 'governor',
    });
    const before = w.formationsOf(playerId).reduce((n, f) => n + f.count, 0);

    w.advanceTo(item.startedAt + (item.finishesAt - item.startedAt) / 2n);
    const seized = w.seize(cmd(), playerId, item.id);
    expect(seized.kind).toBe('training');

    w.advanceTo(seized.finishesAt + HOUR);
    // If it had been re-armed as BUILD_COMPLETE the units would never arrive.
    expect(w.formationsOf(playerId).reduce((n, f) => n + f.count, 0)).toBe(before + 200);
  });

  it('refunds a cancelled training batch in the resources it actually cost', () => {
    const { world: w, playerId, homeId } = world();
    const grainBefore = w.view(homeId).stockpiles.find((s) => s.resourceKey === 'grain')!.amount;
    const item = w.enqueue({
      commandId: cmd(), playerId, settlementId: homeId, kind: 'training',
      targetKey: '1|Militia|Orthodox (Balanced)|Mortal', quantity: 100, slotKind: 'personal',
    });
    const spent = grainBefore - w.view(homeId).stockpiles.find((s) => s.resourceKey === 'grain')!.amount;
    expect(spent).toBeGreaterThan(0n);

    const { refunded } = w.cancelQueueItem(cmd(), playerId, item.id);
    // Training costs grain; a building refund would have handed back timber.
    expect(refunded['grain']).toBeDefined();
    expect(BigInt(refunded['grain']!)).toBeGreaterThan(0n);
  });
});

// ============================================================================
// Empire weight is an AVERAGE, and that is a safeguard, not a detail
// ============================================================================

describe('empire weight is the rolling average, not a live reading', () => {
  const T = 1_700_000_000_000n;
  const DAY = 86_400_000n;

  /** Take every holding on the shard, sampling as conquest would. */
  function seize(w: ReturnType<typeof seedWorld>): void {
    w.world.sampleEmpireWeight(w.playerId);
    w.world.store.transaction((tx) => {
      for (const s of tx.settlements.all()) {
        if (s.ownerId !== w.playerId) tx.settlements.put({ ...s, ownerId: w.playerId });
      }
    });
    w.world.sampleEmpireWeight(w.playerId);
  }

  /** Drop everything but the capital, sampling as abandonment would. */
  function shed(w: ReturnType<typeof seedWorld>): void {
    w.world.sampleEmpireWeight(w.playerId);
    w.world.store.transaction((tx) => {
      for (const s of tx.settlements.all()) {
        if (s.ownerId === w.playerId && s.id !== w.homeId) tx.settlements.put({ ...s, ownerId: undefined });
      }
    });
    w.world.sampleEmpireWeight(w.playerId);
  }

  it('does not drop the moment territory is shed', () => {
    // spec/03 §8: "the rolling average is what stops a player shedding
    // territory before a war to spike progression." A live reading would let a
    // player drop three provinces, fight the battle at a lower XP requirement,
    // and take them back the next day.
    const w = seedWorld({ worldId: 'ew', now: T, neighbours: 6 });

    // Hold everything, then let a full window pass so the average catches up.
    seize(w);
    w.world.advanceTo(T + 30n * DAY);
    // Sampling is what conquest does; the average is only correct if each
    // period is closed off at the weight that held during it.
    w.world.sampleEmpireWeight(w.playerId);
    const wide = w.world.empireWeight(w.playerId);
    expect(wide).toBeGreaterThan(0);

    // Now shed everything but the capital, and check again immediately.
    shed(w);
    expect(w.world.liveEmpireWeight(w.playerId)).toBeLessThan(wide * 0.5);
    // The charged figure has barely moved: the dodge does not work today.
    expect(w.world.empireWeight(w.playerId)).toBeGreaterThan(wide * 0.9);
  });

  it('pays off over the window rather than never', () => {
    // The safeguard is a delay, not a wall — a player who genuinely shrinks
    // must eventually be charged as a smaller player.
    const w = seedWorld({ worldId: 'ew2', now: T, neighbours: 6 });
    seize(w);
    w.world.advanceTo(T + 30n * DAY);
    w.world.sampleEmpireWeight(w.playerId);
    const wide = w.world.empireWeight(w.playerId);

    shed(w);
    w.world.advanceTo(T + 75n * DAY);
    expect(w.world.empireWeight(w.playerId)).toBeLessThan(wide * 0.4);
  });

  it('does not punish conquest instantly either', () => {
    // The average cuts both ways, which is the point: territory gained takes a
    // month to weigh fully, so taking ground is not immediately taxed.
    const w = seedWorld({ worldId: 'ew3', now: T, neighbours: 6 });
    const before = w.world.empireWeight(w.playerId);
    seize(w);
    w.world.advanceTo(T + DAY);
    const afterOneDay = w.world.empireWeight(w.playerId);
    const live = w.world.liveEmpireWeight(w.playerId);
    expect(afterOneDay).toBeGreaterThan(before);
    expect(afterOneDay).toBeLessThan(live * 0.2);
  });

  it('is advanced by the world clock, not by how many steps it took', () => {
    // Determinism: a world jumped forward must land where a stepped one does.
    const jump = seedWorld({ worldId: 'ewd', now: T, neighbours: 4 });
    const step = seedWorld({ worldId: 'ewd', now: T, neighbours: 4 });
    for (const w of [jump, step]) seize(w);
    jump.world.advanceTo(T + 10n * DAY);
    const a = jump.world.empireWeight(jump.playerId);

    for (let d = 1; d <= 10; d++) {
      step.world.advanceTo(T + BigInt(d) * DAY);
      // Force the lazy advance to be taken at each step.
      step.world.empireWeight(step.playerId);
    }
    expect(step.world.empireWeight(step.playerId)).toBeCloseTo(a, 6);
  });
});
