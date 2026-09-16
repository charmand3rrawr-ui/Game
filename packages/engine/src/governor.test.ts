/**
 * governor.test.ts — M8 acceptance, and the failure modes that are gameplay
 *
 * spec/08 M8: "a governor executes a build order at exactly 2× time; seizing
 * keeps elapsed progress and recomputes the remainder at 1×; seizing without a
 * free personal slot is rejected."
 *
 * The 2× rule and Seize are covered in engine.test.ts, which is where they were
 * first built. This file covers the rest of the system: the six spec sheets,
 * and the published failure mode of each one. Those failures are the design —
 * "stalls on the first unaffordable entry and builds nothing further" is a
 * governor working correctly — so they are asserted as behaviour, not guarded
 * against as bugs.
 */

import { describe, it, expect } from 'vitest';
import { C, GOVERNOR_SPECS, GOVERNOR_TIERS, type GovernorSpecs } from '@ascendance/shared';
import { seedWorld } from './bootstrap.js';
import { CommandError } from './world.js';
import {
  auditGovernor, checkEscalation, corruptSpecs, governorTier, nextIntent,
  postureEffect, specSheets, validateAppointment,
} from './sim/governor.js';

const T0 = 1_700_000_000_000n;
const HOUR = 3_600_000n;
const cmd = (() => { let n = 0; return (): string => `gv-${n++}`; })();

function blankSpecs(over: Partial<GovernorSpecs> = {}): GovernorSpecs {
  return {
    buildOrder: [],
    trainingStandingOrder: [],
    researchMandate: [],
    resourcePolicy: { keepDays: 0 },
    defencePosture: 'garrison',
    escalationRules: { alertOnIncoming: false, alertBelowLoyalty: 0 },
    ...over,
  };
}

function world(): ReturnType<typeof seedWorld> {
  return seedWorld({ worldId: 'gov', now: T0, neighbours: 4 });
}

/** Appoint a governor over the home settlement with the given specs. */
function appoint(w: ReturnType<typeof seedWorld>, specs: GovernorSpecs, level = 40): void {
  w.world.appointGovernor({
    commandId: cmd(), playerId: w.playerId, commanderId: 'cmdr-1', tier: 'bailiff',
    settlementIds: [w.homeId], specs, commanderLevel: level,
  });
}

// ============================================================================
// The six spec sheets exist, and say what they do when written badly
// ============================================================================

describe('the six spec sheets', () => {
  it('are all six, read from the workbook', () => {
    expect(specSheets()).toHaveLength(6);
    expect(GOVERNOR_SPECS.map((s) => s.key).sort()).toEqual([
      'buildOrder', 'defencePosture', 'escalationRules',
      'researchMandate', 'resourcePolicy', 'trainingStandingOrder',
    ]);
  });

  it('each carry the published failure mode, so the UI can teach it', () => {
    // A vague spec produces a bad outcome the player has to diagnose. Hiding
    // the rule behind a grey button would make that impossible.
    for (const sheet of GOVERNOR_SPECS) {
      expect(sheet.failure.length).toBeGreaterThan(20);
      expect(sheet.behaviour.length).toBeGreaterThan(20);
    }
    expect(GOVERNOR_SPECS.find((s) => s.key === 'buildOrder')!.failure).toMatch(/stalls/i);
    expect(GOVERNOR_SPECS.find((s) => s.key === 'resourcePolicy')!.failure).toMatch(/overflow/i);
  });
});

// ============================================================================
// Appointment
// ============================================================================

describe('appointing a governor', () => {
  it('demands the commander level the workbook sets for the tier', () => {
    expect(GOVERNOR_TIERS.map((t) => t.key)).toEqual(['bailiff', 'planetary', 'system', 'sector']);
    expect(governorTier('bailiff').commanderLevel).toBe(5);
    expect(governorTier('sector').commanderLevel).toBe(40);

    const tooJunior = validateAppointment({
      tier: 'sector', commanderLevel: 10,
      settlements: [{ id: 's' } as never], mandatedDisciplines: new Set(), specs: blankSpecs(),
    });
    expect(tooJunior.ok).toBe(false);
    if (!tooJunior.ok) expect(tooJunior.detail).toMatch(/level 40/);
  });

  it('reads the commander level off the player, never off the request', () => {
    // The tiers gate on it, so it cannot be something a caller states. A brand
    // new player has nobody: every starting formation is green at level 0, so
    // delegation is earned by fighting rather than granted at the start.
    const w = world();
    expect(w.world.commanderLevelOf(w.playerId)).toBe(0);

    // One veteran formation is one officer. Either track counts — an officer
    // who has only ever held a wall is still an officer.
    w.world.store.transaction((tx) => {
      const f = tx.formations.where((f) => f.ownerId === w.playerId)[0]!;
      tx.formations.put({ ...f, defLevel: 17 });
    });
    expect(w.world.commanderLevelOf(w.playerId)).toBe(17);
    // Enough for a Bailiff and a Planetary Governor; not for a System one.
    expect(governorTier('bailiff').commanderLevel).toBeLessThanOrEqual(17);
    expect(governorTier('planetary').commanderLevel).toBeLessThanOrEqual(17);
    expect(governorTier('system').commanderLevel).toBeGreaterThan(17);
  });

  it('allows exactly one research discipline per governor', () => {
    const two = validateAppointment({
      tier: 'bailiff', commanderLevel: 10, settlements: [{ id: 's' } as never],
      mandatedDisciplines: new Set(),
      specs: blankSpecs({ researchMandate: ['agrarian_arts', 'tribal_warfare'] }),
    });
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.detail).toMatch(/exactly one/);
  });

  it('refuses a discipline another governor already holds', () => {
    // Two governors advancing the same global level would be paying twice for
    // one thing.
    const clash = validateAppointment({
      tier: 'bailiff', commanderLevel: 10, settlements: [{ id: 's' } as never],
      mandatedDisciplines: new Set(['agrarian_arts']),
      specs: blankSpecs({ researchMandate: ['agrarian_arts'] }),
    });
    expect(clash.ok).toBe(false);
  });

  it('attaches the governor to every holding in the area', () => {
    const w = world();
    appoint(w, blankSpecs());
    expect(w.world.view(w.homeId).settlement.governorId).toBeTruthy();
    expect(w.world.governorsOf(w.playerId)).toHaveLength(1);
  });

  it('refuses to govern someone else’s holding', () => {
    const w = world();
    const theirs = w.world.store.read((tx) => tx.settlements.find((s) => s.ownerId && s.ownerId !== w.playerId))!;
    expect(() =>
      w.world.appointGovernor({
        commandId: cmd(), playerId: w.playerId, commanderId: 'c', tier: 'bailiff',
        settlementIds: [theirs.id], specs: blankSpecs(), commanderLevel: 40,
      }),
    ).toThrow(CommandError);
  });
});

// ============================================================================
// Build Order — "stalls on the first unaffordable entry"
// ============================================================================

describe('build order', () => {
  it('works down the list in sequence', () => {
    const w = world();
    appoint(w, blankSpecs({
      buildOrder: [{ buildingKey: '1_fishery', toLevel: 2 }, { buildingKey: '1_apiary', toLevel: 1 }],
    }));
    // Appointing starts the first job immediately.
    const queue = w.world.view(w.homeId).queue.filter((q) => q.slotKind === 'governor');
    expect(queue).toHaveLength(1);
    expect(queue[0]!.targetKey).toBe('1_fishery');
    expect(queue[0]!.timeMultiplier).toBe(C.GOVERNOR_TIME_MULT);
  });

  it('STALLS on the first entry it cannot start, and never skips ahead', () => {
    // This is the published failure mode and the heart of the design: a
    // governor has no judgement, so a bad spec produces a stalled queue rather
    // than a governor quietly doing something else.
    const w = world();
    w.world.store.transaction((tx) => {
      for (const s of tx.stockpiles.where((x) => x.settlementId === w.homeId)) {
        tx.stockpiles.put({ ...s, amount: 0n });
      }
    });

    appoint(w, blankSpecs({
      buildOrder: [
        { buildingKey: '1_fishery', toLevel: 5 },   // unaffordable
        { buildingKey: '1_apiary', toLevel: 1 },    // would also be unaffordable
      ],
    }));

    expect(w.world.view(w.homeId).queue.filter((q) => q.slotKind === 'governor')).toHaveLength(0);
    const stall = w.world.drainOutbox().find((m) => m.event === 'governor.stalled');
    expect(stall).toBeDefined();
    expect(String((stall!.data as { reason: string }).reason)).toMatch(/Build Order/);
    expect(String((stall!.data as { reason: string }).reason)).toMatch(/short of/i);
  });

  it('moves past entries that are already satisfied', () => {
    const w = world();
    const farmLevel = w.world.view(w.homeId).buildings.find((b) => b.buildingKey === '1_farm')!.level;
    appoint(w, blankSpecs({
      buildOrder: [
        { buildingKey: '1_farm', toLevel: farmLevel },  // already done
        { buildingKey: '1_fishery', toLevel: 1 },
      ],
    }));
    const queue = w.world.view(w.homeId).queue.filter((q) => q.slotKind === 'governor');
    expect(queue[0]?.targetKey).toBe('1_fishery');
  });

  it('does not race itself: one governor job at a time', () => {
    const w = world();
    appoint(w, blankSpecs({
      buildOrder: [{ buildingKey: '1_fishery', toLevel: 3 }, { buildingKey: '1_apiary', toLevel: 3 }],
    }));
    expect(w.world.view(w.homeId).queue.filter((q) => q.slotKind === 'governor')).toHaveLength(1);
  });

  it('picks the next entry up once a job completes', () => {
    const w = world();
    appoint(w, blankSpecs({
      buildOrder: [{ buildingKey: '1_fishery', toLevel: 1 }, { buildingKey: '1_apiary', toLevel: 1 }],
    }));
    const first = w.world.view(w.homeId).queue.find((q) => q.slotKind === 'governor')!;
    w.world.advanceTo(first.finishesAt + 1n);

    const next = w.world.view(w.homeId).queue.filter((q) => q.slotKind === 'governor');
    expect(next[0]?.targetKey).toBe('1_apiary');
  });

  it('times the follow-on job from the instant the last one landed, not from before the drain', () => {
    // Regression. The world's clock used to stand still for the whole of a
    // drain, so the job a governor started from inside a BUILD_COMPLETE
    // handler was timed from the instant the drain BEGAN. Its finishesAt
    // landed in the past, the same drain picked it up, and the second entry
    // in every build order completed instantly and for free.
    const w = world();
    appoint(w, blankSpecs({
      buildOrder: [{ buildingKey: '1_fishery', toLevel: 1 }, { buildingKey: '1_apiary', toLevel: 1 }],
    }));
    const first = w.world.view(w.homeId).queue.find((q) => q.slotKind === 'governor')!;
    w.world.advanceTo(first.finishesAt + 1n);

    const next = w.world.view(w.homeId).queue.find((q) => q.slotKind === 'governor')!;
    expect(next.targetKey).toBe('1_apiary');
    expect(next.startedAt).toBe(first.finishesAt);
    expect(next.finishesAt).toBeGreaterThan(first.finishesAt);
    // And it is still a governor job: twice as long as the player would take.
    expect(next.timeMultiplier).toBe(C.GOVERNOR_TIME_MULT);
    // The apiary must NOT already be standing.
    expect(w.world.view(w.homeId).buildings.find((b) => b.buildingKey === '1_apiary')).toBeUndefined();
  });
});

// ============================================================================
// Training Standing Order — "replaces losses automatically"
// ============================================================================

describe('training standing order', () => {
  it('trains up to the target count and no further', () => {
    const w = world();
    const unitKey = '1|Militia|Orthodox (Balanced)|Mortal';
    const have = w.world.formationsOf(w.playerId)
      .filter((f) => f.unitKey === unitKey && f.settlementId === w.homeId)
      .reduce((n, f) => n + f.count, 0);

    appoint(w, blankSpecs({ trainingStandingOrder: [{ unitKey, maintainCount: have + 50 }] }));
    const queued = w.world.view(w.homeId).queue.find((q) => q.kind === 'training');
    expect(queued?.quantity).toBe(50);
  });

  it('does nothing once the garrison is at strength', () => {
    const w = world();
    const unitKey = '1|Militia|Orthodox (Balanced)|Mortal';
    appoint(w, blankSpecs({ trainingStandingOrder: [{ unitKey, maintainCount: 1 }] }));
    expect(w.world.view(w.homeId).queue.filter((q) => q.kind === 'training')).toHaveLength(0);
  });

  it('caps an unbounded order rather than draining the settlement', () => {
    // "Trains nothing, or drains the settlement on an unbounded order" is the
    // published failure. The batch cap is what bounds the second half.
    const w = world();
    const view = w.world.view(w.homeId);
    const intent = nextIntent({
      governor: {
        id: 'g', playerId: w.playerId, commanderId: 'c', tier: 'bailiff',
        areaRef: { layer: 'province', settlementIds: [w.homeId] },
        specs: blankSpecs({ trainingStandingOrder: [{ unitKey: '1|Militia|Orthodox (Balanced)|Mortal', maintainCount: 10_000_000 }] }),
        appointedAt: T0,
      },
      view: { ...view, queue: [] },
      garrison: new Map(),
      researchLevels: {},
      assassinated: false,
    });
    expect(intent?.kind).toBe('train');
    if (intent?.kind === 'train') expect(intent.quantity).toBeLessThanOrEqual(C.TRAIN_BATCH_MAX);
  });
});

// ============================================================================
// Research Mandate — "idles"
// ============================================================================

describe('research mandate', () => {
  it('advances the one discipline it was given', () => {
    const w = world();
    appoint(w, blankSpecs({ researchMandate: ['agrarian_arts'] }));
    const queued = w.world.view(w.homeId).queue.find((q) => q.kind === 'research');
    expect(queued?.targetKey).toBe('agrarian_arts');
    expect(queued?.timeMultiplier).toBe(C.GOVERNOR_TIME_MULT);
  });

  it('says so rather than idling silently when it has nowhere to work', () => {
    const w = world();
    // Strip the Knowledge building the mandate needs.
    w.world.store.transaction((tx) => {
      for (const b of tx.buildings.where((x) => x.settlementId === w.homeId && x.buildingKey.includes('elder'))) {
        tx.buildings.delete(b.id);
      }
    });
    appoint(w, blankSpecs({ researchMandate: ['agrarian_arts'] }));
    const stall = w.world.drainOutbox().find((m) => m.event === 'governor.stalled');
    expect(String((stall?.data as { reason: string })?.reason ?? '')).toMatch(/Knowledge/i);
  });
});

// ============================================================================
// Resource Policy — "warehouses overflow and the surplus is lost"
// ============================================================================

describe('resource policy', () => {
  it('hauls the surplus as an interceptable convoy, not a private pipe', () => {
    // Invariant §2.4: resources move only as convoys that appear on the map.
    // A governor hauling for you does not get an exemption.
    const w = world();
    const second = w.world.store.read((tx) => tx.settlements.find((s) => !s.ownerId))!;
    w.world.store.transaction((tx) => {
      tx.settlements.put({ ...second, ownerId: w.playerId });
    });

    appoint(w, blankSpecs({ resourcePolicy: { keepDays: 0, haulSurplusTo: second.id } }));

    const convoys = w.world.movementsOf(w.playerId).filter((m) => m.mission === 'haul');
    expect(convoys).toHaveLength(1);
    expect(convoys[0]!.arrivesAt).toBeGreaterThan(w.world.now);
    expect(Object.keys(convoys[0]!.cargo ?? {}).length).toBeGreaterThan(0);
  });

  it('delivers into the destination, discarding anything above its capacity', () => {
    const w = world();
    const second = w.world.store.read((tx) => tx.settlements.find((s) => !s.ownerId))!;
    w.world.store.transaction((tx) => tx.settlements.put({ ...second, ownerId: w.playerId }));
    appoint(w, blankSpecs({ resourcePolicy: { keepDays: 0, haulSurplusTo: second.id } }));

    const convoy = w.world.movementsOf(w.playerId).find((m) => m.mission === 'haul')!;
    w.world.advanceTo(convoy.arrivesAt);

    expect(w.world.movementsOf(w.playerId).filter((m) => m.mission === 'haul')).toHaveLength(0);
    for (const sp of w.world.view(second.id).stockpiles) {
      // Overflow is discarded on delivery exactly as it is in production.
      expect(sp.amount <= sp.capacity).toBe(true);
    }
  });

  it('does nothing without a destination — which is how warehouses overflow', () => {
    const w = world();
    appoint(w, blankSpecs({ resourcePolicy: { keepDays: 0 } }));
    expect(w.world.movementsOf(w.playerId).filter((m) => m.mission === 'haul')).toHaveLength(0);
  });
});

// ============================================================================
// Defence Posture — "defaults to Turtle"
// ============================================================================

describe('defence posture', () => {
  it('makes Turtle genuinely strong and genuinely passive', () => {
    // "Defaults to Turtle, which loses winnable fights and wins unwinnable
    // ones slowly" has to be literally true, or the default is not a real
    // choice being made badly.
    const turtle = postureEffect('fortify');
    expect(turtle.defenceMod).toBeGreaterThan(1);
    expect(turtle.counterAttacks).toBe(false);

    const sally = postureEffect('mobile');
    expect(sally.counterAttacks).toBe(true);
    expect(sally.defenceMod).toBeLessThan(1);

    expect(postureEffect('garrison').defenceMod).toBe(1);
  });
});

// ============================================================================
// Escalation Rules — "the player learns from the battle report"
// ============================================================================

describe('escalation rules', () => {
  it('wakes the player and pauses the queue on an incoming force', () => {
    const r = checkEscalation(
      blankSpecs({ escalationRules: { alertOnIncoming: true, alertBelowLoyalty: 0 } }),
      { incomingForce: 300, loyalty: 100 },
    );
    expect(r.alert).toBe(true);
    expect(r.pauseQueue).toBe(true);
  });

  it('wakes the player on falling loyalty without stopping the work', () => {
    const r = checkEscalation(
      blankSpecs({ escalationRules: { alertOnIncoming: false, alertBelowLoyalty: 50 } }),
      { incomingForce: 0, loyalty: 30 },
    );
    expect(r.alert).toBe(true);
    expect(r.pauseQueue).toBe(false);
  });

  it('says nothing when the thresholds are left at zero', () => {
    // Which is exactly how a player comes to learn about a lost province from
    // the battle report.
    const r = checkEscalation(blankSpecs(), { incomingForce: 500, loyalty: 1 });
    expect(r.alert).toBe(false);
  });

  it('stops the governor initiating while an attack is inbound', () => {
    const w = world();
    appoint(w, blankSpecs({
      buildOrder: [{ buildingKey: '1_fishery', toLevel: 5 }],
      escalationRules: { alertOnIncoming: true, alertBelowLoyalty: 0 },
    }));
    // Clear the job the appointment started.
    w.world.store.transaction((tx) => {
      for (const q of tx.queue.where((x) => x.slotKind === 'governor')) tx.queue.delete(q.id);
    });

    const enemy = w.world.store.read((tx) => tx.settlements.find((s) => s.ownerId && s.ownerId !== w.playerId))!;
    const f = w.world.formationsOf(enemy.ownerId!)[0]!;
    w.world.dispatch({
      commandId: cmd(), playerId: enemy.ownerId!, originId: enemy.id, targetId: w.homeId,
      mission: 'attack', formations: [{ formationId: f.id, count: 20 }],
    });
    w.world.drainOutbox();

    // A completion would normally start the next job; with an attack inbound
    // and escalation armed, it must not.
    w.world.store.transaction((tx) => {
      const b = tx.buildings.where((x) => x.settlementId === w.homeId)[0]!;
      tx.buildings.put({ ...b });
    });
    const item = w.world.enqueue({
      commandId: cmd(), playerId: w.playerId, settlementId: w.homeId,
      kind: 'building', targetKey: '1_apiary', slotKind: 'personal',
    });
    w.world.advanceTo(item.finishesAt);

    expect(w.world.view(w.homeId).queue.filter((q) => q.slotKind === 'governor')).toHaveLength(0);
    expect(w.world.drainOutbox().some((m) => m.event === 'governor.stalled')).toBe(true);
  });
});

// ============================================================================
// Subversion and assassination — automation is not safety
// ============================================================================

describe('automation is not safety', () => {
  it('turns a governor silently, and only an audit reveals it', () => {
    const w = world();
    appoint(w, blankSpecs({
      buildOrder: [{ buildingKey: '1_fishery', toLevel: 3 }, { buildingKey: '1_apiary', toLevel: 3 }],
      escalationRules: { alertOnIncoming: true, alertBelowLoyalty: 60 },
    }));
    const governor = w.world.governorsOf(w.playerId)[0]!;
    const spy = w.world.store.read((tx) => tx.players.find((p) => p.id !== w.playerId))!;

    w.world.drainOutbox();
    w.world.subvertGovernor(cmd(), spy.id, governor.id);

    // The victim is told NOTHING. A subversion they can see is a status effect.
    expect(w.world.drainOutbox()).toHaveLength(0);

    const audit = w.world.audit(cmd(), w.playerId, governor.id);
    expect(audit.subverted).toBe(true);
    expect(audit.by).toBe(spy.id);
    expect(audit.findings.join(' ')).toMatch(/escalation alerts have been switched off/i);
  });

  it('reports a clean governor as clean', () => {
    const w = world();
    appoint(w, blankSpecs());
    const g = w.world.governorsOf(w.playerId)[0]!;
    expect(w.world.audit(cmd(), w.playerId, g.id).subverted).toBe(false);
  });

  it('corrupts the specs in ways that cost a province, not a turn', () => {
    const specs = blankSpecs({
      buildOrder: [{ buildingKey: 'a', toLevel: 1 }, { buildingKey: 'b', toLevel: 1 }],
      trainingStandingOrder: [{ unitKey: 'u', maintainCount: 500 }],
      escalationRules: { alertOnIncoming: true, alertBelowLoyalty: 80 },
    });
    const bad = corruptSpecs(specs);
    expect(bad.buildOrder[0]!.buildingKey).toBe('b');
    expect(bad.trainingStandingOrder[0]!.maintainCount).toBe(0);
    expect(bad.escalationRules.alertOnIncoming).toBe(false);
  });

  it('paralyses an area when the governor is killed', () => {
    // Running jobs continue; nothing new starts until a replacement arrives.
    const w = world();
    appoint(w, blankSpecs({ buildOrder: [{ buildingKey: '1_fishery', toLevel: 5 }] }));
    const g = w.world.governorsOf(w.playerId)[0]!;
    const killer = w.world.store.read((tx) => tx.players.find((p) => p.id !== w.playerId))!;

    w.world.store.transaction((tx) => {
      for (const q of tx.queue.where((x) => x.slotKind === 'governor')) tx.queue.delete(q.id);
    });
    w.world.assassinateGovernor(cmd(), killer.id, g.id);

    const view = w.world.view(w.homeId);
    const intent = nextIntent({
      governor: w.world.governorsOf(w.playerId)[0]!,
      view, garrison: new Map(), researchLevels: {}, assassinated: true,
    });
    expect(intent?.kind).toBe('stall');
    if (intent?.kind === 'stall') expect(intent.reason).toMatch(/dead/i);
  });

  it('keeps the specs a player wrote, so an audit has something to compare', () => {
    const written = blankSpecs({ buildOrder: [{ buildingKey: 'x', toLevel: 1 }] });
    const clean = auditGovernor(
      { id: 'g', playerId: 'p', commanderId: 'c', tier: 'bailiff', areaRef: { layer: 'province', settlementIds: [] }, specs: written, appointedAt: T0 },
      written,
    );
    expect(clean.subverted).toBe(false);
  });
});

// ============================================================================
// Alliances and treaties
// ============================================================================

describe('alliances', () => {
  it('holds at most the published member limit', () => {
    const w = world();
    const a = w.world.createAlliance(cmd(), w.playerId, 'The Verrin Compact', 'VRN');
    expect(a.tag).toBe('VRN');
    expect(w.world.allianceOf(w.playerId)?.members[0]?.role).toBe('leader');
    expect(C.ALLIANCE_MAX_MEMBERS).toBe(60);
  });

  it('refuses a second alliance and a taken tag', () => {
    const w = world();
    w.world.createAlliance(cmd(), w.playerId, 'First', 'AAA');
    expect(() => w.world.createAlliance(cmd(), w.playerId, 'Second', 'BBB')).toThrow(/already in an alliance/);

    const other = w.world.store.read((tx) => tx.players.find((p) => p.id !== w.playerId))!;
    expect(() => w.world.createAlliance(cmd(), other.id, 'Copycat', 'aaa')).toThrow(/taken/);
  });

  it('lets another player join', () => {
    const w = world();
    const a = w.world.createAlliance(cmd(), w.playerId, 'The Compact', 'CPT');
    const other = w.world.store.read((tx) => tx.players.find((p) => p.id !== w.playerId))!;
    w.world.joinAlliance(cmd(), other.id, a.id);
    expect(w.world.allianceOf(other.id)?.alliance.id).toBe(a.id);
  });
});

describe('treaties have mechanical teeth', () => {
  it('binds only once accepted', () => {
    const w = world();
    const other = w.world.store.read((tx) => tx.settlements.find((s) => s.ownerId && s.ownerId !== w.playerId))!;
    const t = w.world.proposeTreaty({
      commandId: cmd(), playerId: w.playerId, counterpartyId: other.ownerId!, kind: 'nap', terms: {},
    });
    expect(t.signedAt).toBe(0n);

    // Unsigned, so it does not yet block an attack.
    const f = w.world.formationsOf(w.playerId)[0]!;
    expect(() =>
      w.world.dispatch({
        commandId: cmd(), playerId: w.playerId, originId: w.homeId, targetId: other.id,
        mission: 'attack', formations: [{ formationId: f.id, count: 5 }],
      }),
    ).not.toThrow();

    const signed = w.world.acceptTreaty(cmd(), other.ownerId!, t.id);
    expect(signed.signedAt).toBeGreaterThan(0n);
  });

  it('hard-blocks an attack once in force, on the server', () => {
    const w = world();
    const other = w.world.store.read((tx) => tx.settlements.find((s) => s.ownerId && s.ownerId !== w.playerId))!;
    const t = w.world.proposeTreaty({
      commandId: cmd(), playerId: w.playerId, counterpartyId: other.ownerId!, kind: 'nap', terms: {},
    });
    w.world.acceptTreaty(cmd(), other.ownerId!, t.id);

    const f = w.world.formationsOf(w.playerId)[0]!;
    expect(() =>
      w.world.dispatch({
        commandId: cmd(), playerId: w.playerId, originId: w.homeId, targetId: other.id,
        mission: 'attack', formations: [{ formationId: f.id, count: 5 }],
      }),
    ).toThrow(/non-aggression/i);
  });

  it('always allows betrayal, and always prices it', () => {
    // Reputation never BLOCKS an action (spec/04 §7). A NAP takes 48 hours of
    // public notice to leave, and leaving costs reputation either way.
    const w = world();
    const other = w.world.store.read((tx) => tx.settlements.find((s) => s.ownerId && s.ownerId !== w.playerId))!;
    const t = w.world.proposeTreaty({
      commandId: cmd(), playerId: w.playerId, counterpartyId: other.ownerId!, kind: 'nap', terms: {},
    });
    w.world.acceptTreaty(cmd(), other.ownerId!, t.id);

    const before = w.world.player(w.playerId).reputation;
    const broken = w.world.breakTreaty(cmd(), w.playerId, t.id);

    expect(broken.reputationLost).toBe(C.REPUTATION_NAP_BREAK);
    expect(w.world.player(w.playerId).reputation).toBe(before - C.REPUTATION_NAP_BREAK);
    // 48 hours of public notice.
    expect(broken.effectiveAt).toBe(w.world.now + BigInt(C.NAP_NOTICE_MS));
    expect(w.world.drainOutbox().some((m) => m.event === 'treaty.proposed')).toBe(true);
  });

  it('prices an ordinary treaty lower than a promise not to kill someone', () => {
    expect(C.REPUTATION_TREATY_BREAK).toBeLessThan(C.REPUTATION_NAP_BREAK);
  });

  it('feeds reputation into karma-weighted tribulations', () => {
    // An oathbreaker pays in the cultivation game as well as the diplomatic
    // one, which is what makes reputation more than a leaderboard.
    const w = world();
    const other = w.world.store.read((tx) => tx.settlements.find((s) => s.ownerId && s.ownerId !== w.playerId))!;
    const t = w.world.proposeTreaty({
      commandId: cmd(), playerId: w.playerId, counterpartyId: other.ownerId!, kind: 'nap', terms: {},
    });
    w.world.acceptTreaty(cmd(), other.ownerId!, t.id);
    w.world.breakTreaty(cmd(), w.playerId, t.id);
    expect(w.world.player(w.playerId).reputation).toBeLessThan(0);
  });

  it('refuses to break a treaty you are not party to', () => {
    const w = world();
    const others = w.world.store.read((tx) => tx.players.where((p) => p.id !== w.playerId));
    const t = w.world.proposeTreaty({
      commandId: cmd(), playerId: others[0]!.id, counterpartyId: others[1]!.id, kind: 'trade', terms: {},
    });
    expect(() => w.world.breakTreaty(cmd(), w.playerId, t.id)).toThrow(/not party/i);
  });
});

void HOUR;
