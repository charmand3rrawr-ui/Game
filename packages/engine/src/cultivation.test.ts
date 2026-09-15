/**
 * cultivation.test.ts — M9 acceptance
 *
 * spec/08 M9: "a tribulation is a scheduled, publicly visible event that rivals
 * can interfere with."
 *
 * That sentence is the whole milestone. A cultivation system where breaking
 * through is a button that spends a currency would pass a casual reading and
 * miss the point entirely: the interesting part is the window of exposed time
 * between declaring a breakthrough and surviving it.
 */

import { describe, it, expect } from 'vitest';
import { C, GRADES, qiBreakthroughCost, rngFromSeed, battleSeed } from '@ascendance/shared';
import { seedWorld } from './bootstrap.js';
import { CommandError } from './world.js';
import {
  accrueQi, cultivationAura, gradeRef, qiPerHour, realmAtLeast, realmName,
  resolveTribulation, tribulationOdds, validateBreakthrough,
} from './sim/cultivation.js';

const T0 = 1_700_000_000_000n;
const HOUR = 3_600_000n;
const cmd = (() => { let n = 0; return (): string => `cv-${n++}`; })();

function world(): ReturnType<typeof seedWorld> {
  return seedWorld({ worldId: 'cult', now: T0, neighbours: 4 });
}

/** Put a player in a position to break through, without waiting months. */
function readyToBreakThrough(w: ReturnType<typeof seedWorld>, grade: number): void {
  w.world.store.transaction((tx) => {
    const p = tx.players.require(w.playerId);
    tx.players.put({
      ...p,
      cultivationGrade: grade,
      qi: qiBreakthroughCost(grade + 1) * 2n,
      lastQiAccruedAt: w.world.now,
    });
  });
}

// ============================================================================
// M9 acceptance — the crashable tribulation
// ============================================================================

describe('M9 acceptance — a tribulation is a scheduled, public, crashable event', () => {
  it('has at least one crashable trial, read from the workbook', () => {
    // Grades_Realms marks the Lightning Tribulation "visible to nearby players
    // (crashable!)". The importer fails the build if that stops parsing, so
    // this asserts the property survived into the shipped data.
    const crashable = GRADES.filter((g) => g.trial.crashable);
    expect(crashable.length).toBeGreaterThan(0);
    expect(crashable[0]!.trial.name).toBeTruthy();
    expect(crashable.every((g) => g.trial.visible)).toBe(true);
  });

  it('opens a scheduled window rather than resolving immediately', () => {
    const w = world();
    const crashableGrade = GRADES.find((g) => g.trial.crashable)!.grade;
    readyToBreakThrough(w, crashableGrade);

    const t = w.world.beginBreakthrough(cmd(), w.playerId, w.homeId);
    expect(t.resolvesAt).toBeGreaterThan(w.world.now);
    expect(t.crashable).toBe(true);
    // The grade has NOT changed yet. It is not a purchase.
    expect(w.world.player(w.playerId).cultivationGrade).toBe(crashableGrade);
  });

  it('is visible to rivals, who can then interfere with it', () => {
    const w = world();
    const crashableGrade = GRADES.find((g) => g.trial.crashable)!.grade;
    readyToBreakThrough(w, crashableGrade);
    const t = w.world.beginBreakthrough(cmd(), w.playerId, w.homeId);

    const rival = w.world.store.read((tx) =>
      tx.players.find((p) => p.id !== w.playerId),
    )!;

    // The rival can see it...
    const visible = w.world.visibleTribulations(rival.id);
    expect(visible.map((x) => x.id)).toContain(t.id);

    // ...and crash it.
    const crashed = w.world.interfere(cmd(), rival.id, t.id);
    expect(crashed.interferers).toContain(rival.id);
  });

  it('lowers the odds for every rival who comes, but never to zero', () => {
    const grade = GRADES.find((g) => g.trial.crashable)!.grade;
    const alone = tribulationOdds({ grade, temporalDebt: 0, reputation: 0, interferers: 0 });
    const crowded = tribulationOdds({ grade, temporalDebt: 0, reputation: 0, interferers: 3 });
    const mobbed = tribulationOdds({ grade, temporalDebt: 0, reputation: 0, interferers: 50 });

    expect(crowded.chance).toBeLessThan(alone.chance);
    expect(crowded.interference).toBeLessThan(0);
    // A breakthrough can always be earned through a crowd. A rival can make it
    // worse; no number of them can make it impossible.
    expect(mobbed.chance).toBeGreaterThan(0);
  });

  it('refuses to let a trial that is not crashable be crashed', () => {
    const w = world();
    const privateGrade = GRADES.find((g) => !g.trial.crashable && !g.trial.none)!.grade;
    readyToBreakThrough(w, privateGrade);
    const t = w.world.beginBreakthrough(cmd(), w.playerId, w.homeId);
    const rival = w.world.store.read((tx) => tx.players.find((p) => p.id !== w.playerId))!;

    expect(() => w.world.interfere(cmd(), rival.id, t.id)).toThrow(CommandError);
  });

  it('refuses to let a player crash their own trial, or crash twice', () => {
    const w = world();
    const grade = GRADES.find((g) => g.trial.crashable)!.grade;
    readyToBreakThrough(w, grade);
    const t = w.world.beginBreakthrough(cmd(), w.playerId, w.homeId);
    const rival = w.world.store.read((tx) => tx.players.find((p) => p.id !== w.playerId))!;

    expect(() => w.world.interfere(cmd(), w.playerId, t.id)).toThrow(/your own/i);
    w.world.interfere(cmd(), rival.id, t.id);
    expect(() => w.world.interfere(cmd(), rival.id, t.id)).toThrow(/already interfering/i);
  });

  it('resolves when the window closes, and records why', () => {
    const w = world();
    const grade = GRADES.find((g) => g.trial.crashable)!.grade;
    readyToBreakThrough(w, grade);
    const t = w.world.beginBreakthrough(cmd(), w.playerId, w.homeId);

    w.world.advanceTo(t.resolvesAt);

    const log = w.world.store.read((tx) => tx.allEvents());
    const resolved = log.find((e) => e.kind === 'tribulation.passed' || e.kind === 'tribulation.failed');
    expect(resolved).toBeDefined();
    // The odds and the roll are both on the record: a breakthrough lost to a
    // crowd should be inspectable, not arbitrary.
    expect(resolved?.payload['chance']).toBeDefined();
    expect(resolved?.payload['roll']).toBeDefined();
    expect(resolved?.payload['narrative']).toBeTruthy();
    expect(w.world.store.read((tx) => tx.tribulations.count())).toBe(0);
  });

  it('announces a visible trial to the shard, and a private one to nobody', () => {
    const w = world();
    const visibleGrade = GRADES.find((g) => g.trial.visible)!.grade;
    readyToBreakThrough(w, visibleGrade);
    w.world.beginBreakthrough(cmd(), w.playerId, w.homeId);
    expect(w.world.drainOutbox().some((m) => m.event === 'tribulation.opened')).toBe(true);

    const w2 = world();
    const privateGrade = GRADES.find((g) => !g.trial.visible && !g.trial.none)?.grade;
    if (privateGrade !== undefined) {
      readyToBreakThrough(w2, privateGrade);
      w2.world.beginBreakthrough(cmd(), w2.playerId, w2.homeId);
      expect(w2.world.drainOutbox().some((m) => m.event === 'tribulation.opened')).toBe(false);
    }
  });
});

// ============================================================================
// Qi
// ============================================================================

describe('Qi', () => {
  it('accrues lazily, like every other income in the game', () => {
    const banked = accrueQi(0n, 100, 0, T0, T0 + HOUR * 10n);
    expect(banked).toBe(1000n);
    // Never runs backwards if the clock is read out of order.
    expect(accrueQi(500n, 100, 0, T0 + HOUR, T0)).toBe(500n);
  });

  it('is SUPPRESSED by Temporal Debt — this is what buying time costs', () => {
    // spec/04 §11 guardrail 3. The cultivation game is the one thing Chrono
    // Shards cannot accelerate, and spending them actively slows it.
    const clean = accrueQi(0n, 100, 0, T0, T0 + HOUR * 10n);
    const indebted = accrueQi(0n, 100, 5, T0, T0 + HOUR * 10n);
    expect(indebted).toBeLessThan(clean);
  });

  it('pays far more for a Spirit Vein tile than for a building', () => {
    const w = world();
    const views = w.world.settlementsOf(w.playerId).map((s) => w.world.view(s.id));
    const income = qiPerHour(views);
    expect(income.perHour).toBeGreaterThan(0);
    expect(income.spiritVeins).toBeGreaterThan(0);
    expect(income.meditation).toBe(C.QI_IDLE_PER_HOUR);
  });

  it('still advances a player with nothing at all, through meditation', () => {
    // The realm ladder is never completely shut to someone who built no
    // cultivation buildings and holds no veins.
    expect(qiPerHour([]).perHour).toBe(C.QI_IDLE_PER_HOUR);
  });
});

// ============================================================================
// Breakthrough rules
// ============================================================================

describe('breaking through', () => {
  const base = { grade: 5, qi: 10n ** 12n, temporalDebt: 0, reputation: 0, now: T0, tribulationOpen: false };

  it('matches the published Qi costs', () => {
    for (const g of GRADES.slice(0, 12)) {
      expect(qiBreakthroughCost(g.grade).toString()).toBe(g.qiCost);
    }
  });

  it('refuses without the Qi, and says how short', () => {
    const r = validateBreakthrough({ ...base, qi: 0n });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.type).toBe('insufficient-resources');
      expect((r.meta?.['short'] as Record<string, string>)['qi']).toBeTruthy();
    }
  });

  it('refuses a second tribulation while one is open', () => {
    const r = validateBreakthrough({ ...base, tribulationOpen: true });
    expect(r.ok).toBe(false);
  });

  it('refuses while cultivation is suspended after a failure', () => {
    // Grades_Realms: the Heart Demon "stuns cultivation 48h" on failure. That
    // duration is parsed from the sheet, not retyped.
    const r = validateBreakthrough({ ...base, stunnedUntil: T0 + HOUR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/suspended/i);
  });

  it('spends the Qi at declaration, not at resolution', () => {
    // The Qi is gone the moment you commit. Backing out is not an option, and
    // that is what makes the exposed window mean something.
    const w = world();
    readyToBreakThrough(w, 5);
    const before = w.world.cultivation(w.playerId).qi;
    w.world.beginBreakthrough(cmd(), w.playerId, w.homeId);
    expect(w.world.cultivation(w.playerId).qi).toBeLessThan(before);
  });

  it('raises the grade on success and returns part of the Qi on failure', () => {
    const passed = resolveTribulation({
      grade: 5, qiSpent: 1000n, temporalDebt: 0, reputation: 0, interferers: 0,
      now: T0, rng: () => 0,
    });
    expect(passed.passed).toBe(true);
    expect(passed.newGrade).toBe(6);
    expect(passed.qiRefunded).toBe(0n);

    const failed = resolveTribulation({
      grade: 5, qiSpent: 1000n, temporalDebt: 0, reputation: 0, interferers: 0,
      now: T0, rng: () => 0.999,
    });
    expect(failed.passed).toBe(false);
    expect(failed.newGrade).toBe(5);
    expect(failed.qiRefunded).toBeGreaterThan(0n);
    expect(failed.qiRefunded).toBeLessThan(1000n);
  });

  it('suspends cultivation after failing a trial that says it does', () => {
    const stunGrade = GRADES.find((g) => g.trial.stunMs > 0)!.grade;
    const r = resolveTribulation({
      grade: stunGrade, qiSpent: 100n, temporalDebt: 0, reputation: 0, interferers: 0,
      now: T0, rng: () => 0.999,
    });
    expect(r.stunnedUntil).toBe(T0 + BigInt(gradeRef(stunGrade).trial.stunMs));
  });

  it('weights a karmic trial by reputation, in both directions', () => {
    const karmic = GRADES.find((g) => g.trial.karmaWeighted)!.grade;
    const saint = tribulationOdds({ grade: karmic, temporalDebt: 0, reputation: 100, interferers: 0 });
    const oathbreaker = tribulationOdds({ grade: karmic, temporalDebt: 0, reputation: -100, interferers: 0 });
    expect(saint.chance).toBeGreaterThan(oathbreaker.chance);
    expect(saint.karma).toBeGreaterThan(0);
    expect(oathbreaker.karma).toBeLessThan(0);
  });

  it('ignores reputation on a trial that is not karmic', () => {
    const plain = GRADES.find((g) => !g.trial.karmaWeighted && !g.trial.none)!.grade;
    const a = tribulationOdds({ grade: plain, temporalDebt: 0, reputation: 500, interferers: 0 });
    expect(a.karma).toBe(0);
  });

  it('makes a shard-buyer’s breakthroughs harder', () => {
    const clean = tribulationOdds({ grade: 5, temporalDebt: 0, reputation: 0, interferers: 0 });
    const indebted = tribulationOdds({ grade: 5, temporalDebt: 5, reputation: 0, interferers: 0 });
    expect(indebted.chance).toBeLessThan(clean.chance);
    expect(indebted.debt).toBeLessThan(0);
  });

  it('is replayable from its seed, like everything else', () => {
    const args = {
      grade: 5, qiSpent: 100n, temporalDebt: 1, reputation: 10, interferers: 2, now: T0,
    };
    const a = resolveTribulation({ ...args, rng: rngFromSeed(battleSeed('w', 'trial-1')) });
    const b = resolveTribulation({ ...args, rng: rngFromSeed(battleSeed('w', 'trial-1')) });
    expect(a.roll).toBe(b.roll);
    expect(a.passed).toBe(b.passed);
  });
});

// ============================================================================
// Realms gate content; they barely grant power
// ============================================================================

describe('realms gate content rather than granting power', () => {
  it('keeps the combat aura small, inside the joint cap', () => {
    // Cultivation!Balance caps is explicit: realms primarily gate content, and
    // all cultivation bonuses fold into the +40% joint clamp.
    const top = cultivationAura(C.MAX_GRADE);
    expect(top).toBeLessThan(1 + C.JOINT_BONUS_CAP);
    expect(top).toBeGreaterThan(1);
  });

  it('names realms the way players do', () => {
    expect(realmName(1)).toMatch(/Mortal Vessel/);
    expect(realmName(C.MAX_GRADE)).toBeTruthy();
    // Unit_Grades gates Ascendant units on "cultivation realm Sovereign".
    expect(realmAtLeast(C.MAX_GRADE, 'Mortal Vessel')).toBe(true);
    expect(realmAtLeast(1, 'Transcendent Dao')).toBe(false);
  });

  it('feeds the combat multiplier through the same path research does', () => {
    const w = world();
    w.world.store.transaction((tx) => {
      const p = tx.players.require(w.playerId);
      tx.players.put({ ...p, cultivationGrade: 30 });
    });
    expect(w.world.cultivation(w.playerId).aura).toBeCloseTo(cultivationAura(30), 10);
  });
});
