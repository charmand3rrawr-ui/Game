/**
 * npc.test.ts — the barbarians, and the promises the design makes about them
 *
 * There is no milestone for this in spec/08 and no acceptance test to copy:
 * the specification treats NPCs as scenery. So these tests assert the design's
 * OWN claims, which are the things that would make the system dishonest if they
 * turned out not to hold:
 *
 *   1. Escalation answers the players, not the calendar.
 *   2. The ladder is climbed a rung at a time, and each rung keeps the ones
 *      below it.
 *   3. A band that is not dangerous yet costs nothing at all.
 *   4. Defeat pushes menace back down, so fighting barbarians is worth doing.
 *   5. The doomsday engine is a LAST RESORT — a consequence of beating a band,
 *      never a timer — and it is announced, and it can be stopped.
 *   6. Everything the barbarians can do that players cannot is written down.
 *
 * The decision layer is pure, so most of this is table-driven against `decide`.
 * The parts that are not — the levy, the strike, the confederation — go through
 * a real seeded world, because those are exactly the places where a pure
 * function can be right and the wiring still wrong.
 */

import { describe, it, expect } from 'vitest';
import {
  C,
  MENACE_LADDER,
  NPC_PRIVILEGES,
  menaceFor,
  menaceRung,
  pressureForMenace,
  worldPressure,
  type NpcBand,
  type NpcDoctrine,
  type Uuid,
} from '@ascendance/shared';
import { seedWorld } from './bootstrap.js';
import {
  commitForce, decide, isLosing, musterStrength, scoreTarget, sleepFor, turnInterval,
  type BandSnapshot, type MusterSlice, type TargetSnapshot,
} from './sim/npc.js';

const T0 = 1_700_000_000_000n;
const HOUR = 3_600_000n;
const DAY = 24n * HOUR;

// ---------------------------------------------------------------- fixtures

function band(over: Partial<NpcBand> = {}): NpcBand {
  return {
    id: 'band-1',
    worldId: 'w',
    shardId: 'sh',
    playerId: 'npc-1',
    name: 'Ashjaw',
    seatId: 'seat-1',
    doctrine: 'raider',
    menace: 0,
    peakHoldings: 4,
    spoils: 0n,
    grudges: {},
    lastActedAt: T0,
    createdAt: T0,
    ...over,
  };
}

function target(over: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return {
    settlementId: 'st-1',
    name: 'Mill Bottom',
    ownerId: 'human-1',
    ownerIsNpc: false,
    isSelf: false,
    coordX: 10,
    coordY: 0,
    garrison: 100,
    loot: 20_000,
    wallGrade: 0,
    ...over,
  };
}

const WARBAND: MusterSlice[] = [
  { formationId: 'f-1', unitKey: '1|Spearman|Orthodox (Balanced)|Mortal', count: 400 },
];

function snapshot(over: Partial<BandSnapshot> = {}): BandSnapshot {
  return {
    band: band(),
    seatX: 0,
    seatY: 0,
    holdings: 4,
    muster: WARBAND,
    targets: [target()],
    neighbours: [],
    pressure: 0,
    now: T0,
    ...over,
  };
}

/** The pressure at which a band of this doctrine sits exactly on `tier`. */
function atMenace(tier: number, doctrine: NpcDoctrine = 'raider'): number {
  return pressureForMenace(tier, doctrine) + 0.001;
}

// ============================================================================
// 1. Escalation answers the players
// ============================================================================

describe('world pressure', () => {
  it('rises with time, with the largest empire, and with settled ground', () => {
    const quiet = worldPressure({ worldAgeDays: 30, strongestEmpireWeight: 0, playerHoldings: 1 });
    const busy = worldPressure({ worldAgeDays: 30, strongestEmpireWeight: 40, playerHoldings: 12 });
    expect(busy.total).toBeGreaterThan(quiet.total);
  });

  it('is driven MORE by what players did than by how long they took', () => {
    // This is the whole design claim. A world left alone for a year must be
    // less dangerous than one conquered in a month, or the barbarians are a
    // clock wearing a costume.
    const patient = worldPressure({ worldAgeDays: 365, strongestEmpireWeight: 0, playerHoldings: 1 });
    const rapacious = worldPressure({ worldAgeDays: 30, strongestEmpireWeight: 60, playerHoldings: 40 });
    expect(rapacious.total).toBeGreaterThan(patient.total);
  });

  it('explains itself, term by term', () => {
    const p = worldPressure({ worldAgeDays: 10, strongestEmpireWeight: 5, playerHoldings: 3 });
    expect(p.terms).toHaveLength(3);
    expect(p.terms.reduce((n, t) => n + t.amount, 0)).toBeCloseTo(p.total, 9);
    for (const t of p.terms) expect(t.detail).toMatch(/\d/);
  });

  it('never goes negative on nonsense input', () => {
    const p = worldPressure({ worldAgeDays: -100, strongestEmpireWeight: -5, playerHoldings: -3 });
    expect(p.total).toBe(0);
  });
});

describe('the menace ladder', () => {
  it('has a rung for every tier, each adding a behaviour', () => {
    expect(MENACE_LADDER).toHaveLength(C.NPC_MAX_MENACE + 1);
    expect(MENACE_LADDER.map((r) => r.tier)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const rung of MENACE_LADDER) expect(rung.unlocks.length).toBeGreaterThan(20);
  });

  it('is monotonic in pressure and clamped at the top', () => {
    let last = -1;
    for (let p = 0; p < 400; p += 3) {
      const m = menaceFor(p, 'raider');
      expect(m).toBeGreaterThanOrEqual(last);
      last = m;
    }
    expect(menaceFor(1e9, 'raider')).toBe(C.NPC_MAX_MENACE);
    expect(menaceFor(0, 'raider')).toBe(0);
  });

  it('lets doctrine change the RATE of escalation but never the ceiling', () => {
    // A warlord is slower than a raider at the same pressure...
    const p = 30;
    expect(menaceFor(p, 'raider')).toBeGreaterThan(menaceFor(p, 'warlord'));
    // ...but every doctrine can still reach the top, or three quarters of the
    // bands in a world would be permanently irrelevant.
    for (const d of ['raider', 'slaver', 'zealot', 'warlord'] as const) {
      expect(menaceFor(1e6, d)).toBe(C.NPC_MAX_MENACE);
    }
  });

  it('agrees with pressureForMenace, which is what the sleep schedule uses', () => {
    for (const d of ['raider', 'slaver', 'zealot', 'warlord'] as const) {
      for (let tier = 1; tier <= C.NPC_MAX_MENACE; tier++) {
        expect(menaceFor(pressureForMenace(tier, d) + 1e-6, d)).toBe(tier);
      }
    }
  });

  it('clamps a nonsense tier rather than returning nothing', () => {
    expect(menaceRung(-5).tier).toBe(0);
    expect(menaceRung(99).tier).toBe(C.NPC_MAX_MENACE);
  });
});

// ============================================================================
// 2. One rung at a time, and each keeps the ones below it
// ============================================================================

describe('what a band will do at each rung', () => {
  it('sleeps below the first rung, and asks to be woken at a stated pressure', () => {
    const intent = decide(snapshot({ pressure: 0 }));
    expect(intent.kind).toBe('sleep');
    if (intent.kind !== 'sleep') return;
    expect(intent.untilPressure).toBeCloseTo(pressureForMenace(1, 'raider'), 6);
  });

  it('raids at menace 1 but will not take ground', () => {
    const intent = decide(snapshot({ pressure: atMenace(1) }));
    expect(intent.kind).toBe('raid');
  });

  it('prefers other bands at menace 2 — this is what farming means', () => {
    const intent = decide(
      snapshot({
        pressure: atMenace(2),
        targets: [
          target({ settlementId: 'st-human', ownerId: 'human-1', ownerIsNpc: false, loot: 60_000 }),
          target({ settlementId: 'st-band', ownerId: 'npc-2', ownerIsNpc: true, loot: 8_000, coordX: 40 }),
        ],
      }),
    );
    expect(intent.kind).toBe('raid');
    // The human holding is nearer and three times richer, and it is still
    // passed over, because at this rung the band is hunting its own kind.
    if (intent.kind === 'raid') expect(intent.targetId).toBe('st-band');
  });

  it('takes other bands’ camps at menace 3 and still will not touch a player', () => {
    const targets = [
      target({ settlementId: 'st-band', ownerId: 'npc-2', ownerIsNpc: true, garrison: 10, loot: 5_000 }),
      target({ settlementId: 'st-human', ownerId: 'human-1', ownerIsNpc: false, garrison: 10, loot: 90_000 }),
    ];
    const intent = decide(snapshot({ pressure: atMenace(3), targets }));
    expect(intent.kind).toBe('conquer');
    if (intent.kind === 'conquer') expect(intent.targetId).toBe('st-band');
  });

  it('will not conquer a player below menace 6, however weak the player is', () => {
    const naked = [target({ settlementId: 'st-human', ownerId: 'human-1', ownerIsNpc: false, garrison: 0, loot: 500_000 })];
    for (let tier = 3; tier < 6; tier++) {
      const intent = decide(snapshot({ pressure: atMenace(tier), targets: naked }));
      // It will happily rob them. It will not keep the place.
      expect(intent.kind).toBe('raid');
    }
  });

  it('conquers a player at menace 6', () => {
    const naked = [target({ settlementId: 'st-human', ownerId: 'human-1', ownerIsNpc: false, garrison: 0, loot: 500_000 })];
    const intent = decide(snapshot({ pressure: atMenace(6), targets: naked }));
    expect(intent.kind).toBe('conquer');
    if (intent.kind === 'conquer') expect(intent.targetId).toBe('st-human');
  });

  it('keeps raiding at the top of the ladder — rungs add, they do not replace', () => {
    // Garrisoned enough to survive an assault but not enough to stop a raid:
    // the margin for keeping a place is deliberately far above the margin for
    // emptying one. Expressed against the band's own strength so this stays
    // true if the roster is ever rebalanced.
    const strength = musterStrength(commitForce(WARBAND, C.NPC_MUSTER_FRACTION));
    const intent = decide(
      snapshot({
        pressure: atMenace(6),
        targets: [target({ garrison: strength / 1.4, wallGrade: 0, loot: 40_000 })],
      }),
    );
    expect(intent.kind).toBe('raid');
  });

  it('waits rather than marching into a garrison it cannot beat', () => {
    // A band that attacked regardless would be a free XP fountain, which is
    // worse for the game than one that never attacks at all.
    const intent = decide(
      snapshot({ pressure: atMenace(6), targets: [target({ garrison: 500_000, loot: 1_000_000 })] }),
    );
    expect(intent.kind).toBe('wait');
  });

  it('waits when it has nothing left to march with, and says so', () => {
    const intent = decide(snapshot({ pressure: atMenace(6), muster: [] }));
    expect(intent.kind).toBe('wait');
    if (intent.kind === 'wait') expect(intent.reason).toMatch(/nothing left to march/);
  });

  it('always explains itself', () => {
    for (let tier = 0; tier <= C.NPC_MAX_MENACE; tier++) {
      expect(decide(snapshot({ pressure: atMenace(tier) })).reason.length).toBeGreaterThan(10);
    }
  });
});

describe('confederation', () => {
  const ally = {
    bandId: 'band-2',
    playerId: 'npc-2',
    name: 'Grimhold',
    menace: C.NPC_CONFEDERATE_MENACE,
    seatX: 30,
    seatY: 0,
  };

  it('does not happen below the published tier', () => {
    const intent = decide(snapshot({ pressure: atMenace(3), neighbours: [ally] }));
    expect(intent.kind).not.toBe('confederate');
  });

  it('happens at the published tier, with the nearest eligible band', () => {
    const intent = decide(
      snapshot({
        pressure: atMenace(4),
        neighbours: [
          { ...ally, bandId: 'far', seatX: C.NPC_CONFEDERATE_RADIUS - 1 },
          { ...ally, bandId: 'near', seatX: 12 },
        ],
      }),
    );
    expect(intent.kind).toBe('confederate');
    if (intent.kind === 'confederate') expect(intent.withBandId).toBe('near');
  });

  it('ignores a band too far away to share a border with', () => {
    const intent = decide(
      snapshot({ pressure: atMenace(4), neighbours: [{ ...ally, seatX: C.NPC_CONFEDERATE_RADIUS + 50 }] }),
    );
    expect(intent.kind).not.toBe('confederate');
  });

  it('ignores a band that is not dangerous enough to be worth swearing to', () => {
    const intent = decide(snapshot({ pressure: atMenace(4), neighbours: [{ ...ally, menace: 1 }] }));
    expect(intent.kind).not.toBe('confederate');
  });

  it('does not confederate twice', () => {
    const intent = decide(
      snapshot({ pressure: atMenace(4), band: band({ confederacyId: 'al-1' }), neighbours: [ally] }),
    );
    expect(intent.kind).not.toBe('confederate');
  });
});

describe('the warpath', () => {
  const partner = {
    bandId: 'band-2',
    playerId: 'npc-2',
    name: 'Grimhold',
    menace: 5,
    seatX: 20,
    seatY: 0,
    confederacyId: 'al-1',
  };

  it('is reserved for what a band cannot take alone', () => {
    // Beyond this band by itself, but not beyond the confederacy.
    const tough = [target({ settlementId: 'st-big', ownerId: 'human-1', garrison: 1_000, loot: 100_000 })];
    const intent = decide(
      snapshot({
        pressure: atMenace(5),
        band: band({ confederacyId: 'al-1' }),
        neighbours: [partner],
        targets: tough,
      }),
    );
    expect(intent.kind).toBe('warpath');
    if (intent.kind !== 'warpath') return;
    expect(intent.withBandIds).toEqual(['band-2']);
    // Menace 5 opens the joint strike; menace 6 opens capture. A confederacy
    // one rung early comes to rob, not to keep.
    expect(intent.mission).toBe('raid');
  });

  it('comes to keep the place once conquest is unlocked', () => {
    const tough = [target({ settlementId: 'st-big', ownerId: 'human-1', garrison: 1_000, loot: 100_000 })];
    const intent = decide(
      snapshot({
        pressure: atMenace(6),
        band: band({ confederacyId: 'al-1' }),
        neighbours: [{ ...partner, menace: 6 }],
        targets: tough,
      }),
    );
    expect(intent.kind).toBe('warpath');
    if (intent.kind === 'warpath') expect(intent.mission).toBe('conquer');
  });

  it('is not used on something the band could simply take', () => {
    const easy = [target({ settlementId: 'st-soft', ownerId: 'human-1', garrison: 0, loot: 20_000 })];
    // Warpath is checked BEFORE conquest, so this also proves it declines.
    const intent = decide(
      snapshot({
        pressure: atMenace(6),
        band: band({ confederacyId: 'al-1' }),
        neighbours: [partner],
        targets: easy,
      }),
    );
    expect(intent.kind).toBe('conquer');
  });

  it('needs confederates, not merely a confederacy', () => {
    const tough = [target({ ownerId: 'human-1', garrison: 1_000 })];
    const intent = decide(
      snapshot({ pressure: atMenace(5), band: band({ confederacyId: 'al-1' }), neighbours: [], targets: tough }),
    );
    expect(intent.kind).not.toBe('warpath');
  });
});

// ============================================================================
// 3. Target selection has a character
// ============================================================================

describe('how a band weighs a target', () => {
  it('prefers loot it can reach over loot it cannot', () => {
    const near = scoreTarget(snapshot(), target({ coordX: 10 }), 'raid');
    const far = scoreTarget(snapshot(), target({ coordX: 400 }), 'raid');
    expect(near).toBeGreaterThan(far);
  });

  it('prefers a weak garrison to a strong one', () => {
    const soft = scoreTarget(snapshot(), target({ garrison: 10 }), 'raid');
    const hard = scoreTarget(snapshot(), target({ garrison: 5_000 }), 'raid');
    expect(soft).toBeGreaterThan(hard);
  });

  it('counts walls far more heavily when it means to keep the place', () => {
    const t = target({ wallGrade: 8 });
    const raid = scoreTarget(snapshot(), t, 'raid');
    const assault = scoreTarget(snapshot(), t, 'conquer');
    // Not directly comparable in magnitude, so compare how each degrades.
    const raidPlain = scoreTarget(snapshot(), target({ wallGrade: 0 }), 'raid');
    const assaultPlain = scoreTarget(snapshot(), target({ wallGrade: 0 }), 'conquer');
    expect(raid / raidPlain).toBeGreaterThan(assault / assaultPlain);
  });

  it('remembers who burned it, and a zealot remembers hardest', () => {
    const plain = scoreTarget(snapshot(), target(), 'raid');
    const grudged = scoreTarget(
      snapshot({ band: band({ grudges: { 'human-1': 4 } }) }),
      target(),
      'raid',
    );
    const zealot = scoreTarget(
      snapshot({ band: band({ doctrine: 'zealot', grudges: { 'human-1': 4 } }) }),
      target(),
      'raid',
    );
    expect(grudged).toBeGreaterThan(plain);
    expect(zealot / scoreTarget(snapshot({ band: band({ doctrine: 'zealot' }) }), target(), 'raid'))
      .toBeGreaterThan(grudged / plain);
  });

  it('makes a warlord value ground and a raider value loot', () => {
    const poorGround = target({ loot: 0, garrison: 0 });
    const warlord = scoreTarget(snapshot({ band: band({ doctrine: 'warlord' }) }), poorGround, 'conquer');
    const raider = scoreTarget(snapshot({ band: band({ doctrine: 'raider' }) }), poorGround, 'conquer');
    expect(warlord).toBeGreaterThan(raider);
  });
});

describe('mustering', () => {
  it('never commits the whole band, so the seat is never left open', () => {
    const committed = commitForce(WARBAND, C.NPC_MUSTER_FRACTION);
    expect(musterStrength(committed)).toBeLessThan(musterStrength(WARBAND));
    expect(musterStrength(committed)).toBeGreaterThan(0);
  });

  it('is stable — the same muster always produces the same column', () => {
    expect(commitForce(WARBAND, 0.6)).toEqual(commitForce(WARBAND, 0.6));
  });

  it('copes with an empty muster rather than throwing', () => {
    expect(commitForce([], 0.6)).toEqual([]);
  });
});

describe('cadence', () => {
  it('shortens with menace, so escalation is felt as tempo', () => {
    expect(turnInterval(7)).toBeLessThan(turnInterval(1));
  });

  it('never drops below an hour, whatever it is handed', () => {
    for (const m of [-5, 0, 1, 7, 99]) expect(turnInterval(m)).toBeGreaterThanOrEqual(HOUR);
  });

  it('sleeps roughly as long as time alone would take to reach the threshold', () => {
    // A shortfall small enough to fall inside the cap, so this measures the
    // formula rather than the ceiling below.
    const shortfall = 2;
    const expectDays = shortfall / C.NPC_PRESSURE_PER_DAY;
    expect(expectDays).toBeLessThan(90);
    const slept = Number(sleepFor(0, shortfall)) / 86_400_000;
    expect(slept).toBeCloseTo(expectDays, 1);
  });

  it('caps a very long sleep, so a band in a quiet world still checks in', () => {
    expect(sleepFor(0, 1e9)).toBeLessThanOrEqual(BigInt(90 * 24 * 3_600_000));
  });
});

// ============================================================================
// 4 and 5. Defeat, and the last resort
// ============================================================================

describe('the doomsday engine', () => {
  const losing = band({ menace: 7, peakHoldings: 8 });

  it('is not built by a band that is winning, however old the world is', () => {
    const intent = decide(snapshot({ pressure: 1e6, band: band({ peakHoldings: 4 }), holdings: 4 }));
    expect(intent.kind).not.toBe('doomsday');
  });

  it('is built by a band that has been driven back', () => {
    const intent = decide(snapshot({ pressure: atMenace(7), band: losing, holdings: 1 }));
    expect(intent.kind).toBe('doomsday');
  });

  it('needs the top of the ladder as well as the defeat', () => {
    const intent = decide(snapshot({ pressure: atMenace(6), band: band({ peakHoldings: 8 }), holdings: 1 }));
    expect(intent.kind).not.toBe('doomsday');
  });

  it('is built once, ever', () => {
    const used = decide(snapshot({ pressure: atMenace(7), band: band({ ...losing, doomsdayUsedAt: T0 }), holdings: 1 }));
    expect(used.kind).not.toBe('doomsday');
    const building = decide(
      snapshot({ pressure: atMenace(7), band: band({ ...losing, doomsdayStartedAt: T0 }), holdings: 1 }),
    );
    expect(building.kind).not.toBe('doomsday');
  });

  it('goes at whoever took the most from the band', () => {
    const intent = decide(
      snapshot({
        pressure: atMenace(7),
        band: band({ ...losing, grudges: { 'human-2': 9, 'human-1': 1 } }),
        holdings: 1,
        targets: [
          target({ settlementId: 'st-rich', ownerId: 'human-1', loot: 900_000, garrison: 0 }),
          target({ settlementId: 'st-enemy', ownerId: 'human-2', loot: 10, garrison: 9_000, coordX: 300 }),
        ],
      }),
    );
    expect(intent.kind).toBe('doomsday');
    // Not the richest and not the nearest. The one that hurt it.
    if (intent.kind === 'doomsday') expect(intent.targetId).toBe('st-enemy');
  });

  it('reads "losing" off holdings against the band’s own high-water mark', () => {
    expect(isLosing(snapshot({ band: band({ peakHoldings: 10 }), holdings: 10 }))).toBe(false);
    expect(isLosing(snapshot({ band: band({ peakHoldings: 10 }), holdings: 5 }))).toBe(true);
    // A band that never held anything cannot be "losing" its way into a weapon.
    expect(isLosing(snapshot({ band: band({ peakHoldings: 0 }), holdings: 0 }))).toBe(false);
  });
});

// ============================================================================
// 6. The asymmetry is published
// ============================================================================

describe('what barbarians can do that players cannot', () => {
  it('is written down, in full, with the reason it is unfair', () => {
    expect(NPC_PRIVILEGES.length).toBeGreaterThanOrEqual(4);
    for (const p of NPC_PRIVILEGES) {
      expect(p.name.length).toBeGreaterThan(3);
      expect(p.detail.length).toBeGreaterThan(60);
    }
    expect(NPC_PRIVILEGES.map((p) => p.key).sort()).toEqual(['doomsday', 'levy', 'warpath', 'weightless']);
  });
});

// ============================================================================
// Through a real world: the wiring, not the arithmetic
// ============================================================================

describe('a seeded world', () => {
  function w(): ReturnType<typeof seedWorld> {
    return seedWorld({ worldId: 'npc', now: T0, neighbours: 4, barbarians: 3 });
  }

  it('founds bands in the wilds without taking the abandoned camps', () => {
    const s = w();
    const bands = s.world.store.read((tx) => tx.npcBands.all());
    expect(bands).toHaveLength(3);
    // The ruins are still there. They are a different mechanic (spec/02 §3)
    // and handing them all to barbarians would have quietly deleted it.
    const unowned = s.world.store.read((tx) => tx.settlements.where((st) => !st.ownerId));
    expect(unowned.length).toBeGreaterThan(0);
  });

  it('marks band players as NPCs, so kills against them stay capped at Steel', () => {
    const s = w();
    const bandPlayers = s.world.store.read((tx) => tx.players.where((p) => p.isNpc === true));
    expect(bandPlayers).toHaveLength(3);
    // And the simulated neighbours are NOT marked, because the social layer
    // needs them as counterparties to treat with and write to.
    const people = s.world.store.read((tx) => tx.players.where((p) => !p.isNpc));
    expect(people.length).toBeGreaterThan(1);
  });

  it('costs one scheduled event per band while the world is quiet', () => {
    const s = w();
    const turns = s.world.store.read((tx) => tx.scheduled.where((e) => e.kind === 'NPC_TURN'));
    expect(turns).toHaveLength(3);
  });

  it('stays asleep through a quiet year rather than escalating on the calendar', () => {
    const s = w();
    s.world.advanceTo(T0 + 365n * DAY);
    const threat = s.world.npcThreat();
    // Time alone gets a raider to the lower rungs, but nowhere near conquest.
    expect(Math.max(...threat.bands.map((b) => b.menace))).toBeLessThan(6);
  });

  it('reports the threat with its derivation and what each tier unlocks', () => {
    const s = w();
    const threat = s.world.npcThreat();
    expect(threat.bands).toHaveLength(3);
    expect(threat.pressure.terms).toHaveLength(3);
    for (const b of threat.bands) {
      expect(b.rung.unlocks.length).toBeGreaterThan(20);
      expect(b.dossier).toContain(b.name);
      expect(b.seatName).toContain('Camp');
    }
    expect(threat.privileges).toBe(NPC_PRIVILEGES);
  });

  it('replays identically — two worlds from one seed reach the same barbarians', () => {
    const a = seedWorld({ worldId: 'same', now: T0, neighbours: 4, barbarians: 3 });
    const b = seedWorld({ worldId: 'same', now: T0, neighbours: 4, barbarians: 3 });
    a.world.advanceTo(T0 + 200n * DAY);
    b.world.advanceTo(T0 + 200n * DAY);
    const strip = (s: typeof a): unknown =>
      s.world.store
        .read((tx) => tx.npcBands.all())
        .map((x) => ({ ...x, spoils: x.spoils.toString(), lastActedAt: x.lastActedAt.toString(), createdAt: '' }));
    expect(strip(a)).toEqual(strip(b));
  });

  it('breaks a band when its seat is taken, and stops scheduling for it', () => {
    const s = w();
    const target = s.world.store.read((tx) => tx.npcBands.all())[0]!;
    s.world.store.transaction((tx) => {
      const seat = tx.settlements.require(target.seatId);
      tx.settlements.put({ ...seat, ownerId: s.playerId });
    });
    // Run far enough for the band's own next turn to come round and find itself
    // homeless. It should remove itself rather than carry on from nowhere.
    s.world.advanceTo(T0 + 400n * DAY);
    const bands = s.world.store.read((tx) => tx.npcBands.all());
    expect(bands.find((x) => x.id === target.id)).toBeUndefined();
    const turns = s.world.store.read((tx) =>
      tx.scheduled.where((e) => e.kind === 'NPC_TURN' && (e.payload as { bandId: string }).bandId === target.id),
    );
    expect(turns).toHaveLength(0);
  });
});

/**
 * The escalation, end to end.
 *
 * Rather than asserting a particular battle, this drives a world that keeps
 * GROWING — which is the input the whole model is built around — and checks
 * that the barbarians answer it. A world where the player does nothing and a
 * world where the player conquers everything must not produce the same
 * barbarians, or none of the above matters.
 */
describe('escalation in a growing world', () => {
  function grow(holdings: number): number {
    const s = seedWorld({ worldId: 'grow', now: T0, neighbours: 6, barbarians: 3 });
    s.world.store.transaction((tx) => {
      // Hand the player ground, which is exactly what the barbarians can see.
      const free = tx.settlements.where((st) => st.ownerId !== s.playerId && !tx.npcBands.find((b) => b.playerId === st.ownerId));
      for (const st of free.slice(0, holdings)) tx.settlements.put({ ...st, ownerId: s.playerId });
    });
    s.world.advanceTo(T0 + 120n * DAY);
    return Math.max(0, ...s.world.npcThreat().bands.map((b) => b.menace));
  }

  it('produces worse barbarians for a player who took more ground', () => {
    const quiet = grow(0);
    const greedy = grow(8);
    expect(greedy).toBeGreaterThan(quiet);
    // And the difference is a real rung of the ladder, not a rounding artefact
    // that a small rebalance would erase.
    expect(greedy - quiet).toBeGreaterThanOrEqual(1);
  });
});

/**
 * The wiring, driven through a real world.
 *
 * Everything above tests the decision. These test what the World does with
 * one — the levy, the confederation, the synchronised arrival, and the whole
 * doomsday chain from announcement to crater. Each of these is a place where
 * `decide` can be perfectly right and the world still do nothing.
 */
describe('barbarians in a world that is being won', () => {
  /**
   * A world with a large, rich player empire in it — which is the input the
   * escalation model is built around. Ground is what barbarians can see, so
   * handing the player ground is how a test makes them dangerous.
   */
  function dangerousWorld(holdings = 40): ReturnType<typeof seedWorld> {
    const s = seedWorld({ worldId: 'danger', now: T0, neighbours: 4, barbarians: 3 });
    s.world.store.transaction((tx) => {
      const home = tx.settlements.require(s.homeId);
      for (let i = 0; i < holdings; i++) {
        tx.settlements.put({
          ...home,
          id: `extra-${i}`,
          name: `Holding ${i}`,
          coordX: 20 + (i % 8) * 6,
          coordY: 20 + Math.floor(i / 8) * 6,
        });
        tx.stockpiles.put({
          settlementId: `extra-${i}`,
          resourceKey: 'timber',
          amount: 400_000n,
          capacity: 1_000_000n,
        });
      }
    });
    return s;
  }

  /**
   * Garrison the player's capital to a stated multiple of the strongest band's
   * striking power, and fill it with something worth coming for.
   *
   * Derived from the bands' actual strength rather than hardcoded, so this
   * keeps meaning the same thing if the roster or the muster fraction moves.
   */
  function fortify(s: ReturnType<typeof seedWorld>, multiple: number): void {
    const strongest = s.world.store.read((tx) =>
      Math.max(
        ...tx.npcBands.all().map((b) =>
          musterStrength(
            commitForce(
              tx.formations
                .where((f) => f.ownerId === b.playerId && f.settlementId === b.seatId)
                .map((f) => ({ formationId: f.id, unitKey: f.unitKey, count: f.count })),
              C.NPC_MUSTER_FRACTION,
            ),
          ),
        ),
      ),
    );
    // Garrisons are REPLACED, not added to, and every player holding gets one.
    //
    // Both parts were learned the hard way. Sizing a guard on top of the seeded
    // capital's own garrison put the capital beyond the entire confederacy;
    // leaving the outlying holdings undefended meant a confederacy always had
    // free real estate to help itself to, and it was RIGHT to take that over
    // storming a fortress. A warpath is only ever the best move in a world
    // where nothing is easy.
    const unitKey = '1|Shield Bearer|Guardian (Defense)|Mortal';
    const perUnit = musterStrength([{ formationId: 'x', unitKey, count: 1 }]);
    const guard = Math.ceil((strongest * multiple) / perUnit);
    s.world.store.transaction((tx) => {
      const mine = tx.settlements.where((st) => st.ownerId === s.playerId);
      for (const st of mine) {
        for (const f of tx.formations.where((row) => row.settlementId === st.id)) tx.formations.delete(f.id);
        tx.formations.put({
          id: `guard-${st.id}`,
          settlementId: st.id,
          ownerId: s.playerId,
          name: `${st.name} Guard`,
          unitKey,
          count: guard,
          atkTier: 1, atkLevel: 0, atkXp: 0n,
          defTier: 1, defLevel: 0, defXp: 0n,
          equipment: {},
          deeds: [],
          createdAt: T0,
        });
        // The capital is the prize; the rest is not worth the march on its own.
        tx.stockpiles.put({
          settlementId: st.id,
          resourceKey: 'timber',
          amount: st.id === s.homeId ? 5_000_000n : 0n,
          capacity: 9_000_000n,
        });
      }
    });
  }

  it('escalates the bands and sends them out', () => {
    const s = dangerousWorld();
    s.world.advanceTo(T0 + 120n * DAY);
    const threat = s.world.npcThreat();
    expect(Math.max(...threat.bands.map((b) => b.menace))).toBeGreaterThanOrEqual(5);

    // And the escalation is not just a number on a screen: columns are moving.
    const marching = s.world.store.read((tx) =>
      tx.movements.where((m) => tx.players.get(m.ownerId)?.isNpc === true),
    );
    const fought = s.world.store.read((tx) =>
      tx.battles.all().filter((b) => b.attackerId && tx.players.get(b.attackerId)?.isNpc === true),
    );
    expect(marching.length + fought.length).toBeGreaterThan(0);
  });

  it('turns plunder into troops with no barracks and no queue', () => {
    const s = dangerousWorld();
    s.world.advanceTo(T0 + 200n * DAY);
    const levies = s.world.store.read((tx) => tx.formations.where((f) => f.name.endsWith('Levy')));
    expect(levies.length).toBeGreaterThan(0);
    // The privilege: nothing was ever queued to produce these.
    const queued = s.world.store.read((tx) =>
      tx.queue.where((q) => {
        const st = tx.settlements.get(q.settlementId);
        return st?.ownerId !== undefined && tx.players.get(st.ownerId)?.isNpc === true;
      }),
    );
    expect(queued).toHaveLength(0);
  });

  it('forms a confederation that appears beside the players’ own alliances', () => {
    const s = dangerousWorld();
    s.world.advanceTo(T0 + 300n * DAY);
    const bands = s.world.store.read((tx) => tx.npcBands.all());
    const confederated = bands.filter((b) => b.confederacyId !== undefined);
    expect(confederated.length).toBeGreaterThanOrEqual(2);

    // A real Alliance row, readable through the same tables players use.
    const allianceId = confederated[0]!.confederacyId!;
    const alliance = s.world.store.read((tx) => tx.alliances.get(allianceId));
    expect(alliance?.name).toMatch(/Confederacy/);
    const members = s.world.store.read((tx) => tx.allianceMembers.where((m) => m.allianceId === allianceId));
    expect(members.length).toBeGreaterThanOrEqual(2);
  });

  it('lands a joint strike in one instant, however far apart the bands set out', () => {
    const s = dangerousWorld();
    // A capital no single band can crack but three together can, and rich
    // enough to be worth the trip. Without a target like this there is nothing
    // in the world a confederacy could not simply take alone, and the warpath
    // correctly never fires.
    fortify(s, 1.5);
    // Movements are deleted the moment they land, so a single snapshot at the
    // end of a long advance sees nothing. Sample as time passes instead, and
    // group every barbarian column by the instant it is due to arrive.
    const byArrival = new Map<string, Set<string>>();
    for (let day = 5n; day <= 400n; day += 5n) {
      s.world.advanceTo(T0 + day * DAY);
      s.world.store.read((tx) => {
        for (const m of tx.movements.all()) {
          if (tx.players.get(m.ownerId)?.isNpc !== true) continue;
          const key = `${m.targetId}@${m.arrivesAt}`;
          const seats = byArrival.get(key) ?? new Set<string>();
          seats.add(m.originId);
          byArrival.set(key, seats);
        }
      });
    }
    expect(byArrival.size).toBeGreaterThan(0);

    // A warpath is two or more columns, from DIFFERENT seats, sharing an
    // arrival to the millisecond — which is exactly what a player cannot do.
    const synchronised = [...byArrival.values()].filter((seats) => seats.size > 1);
    expect(synchronised.length).toBeGreaterThan(0);
  });
});

describe('the doomsday engine, end to end', () => {
  /** A band at the top of the ladder that has been beaten back to its seat. */
  function beatenBand(): { s: ReturnType<typeof seedWorld>; bandId: Uuid; seatId: Uuid } {
    const s = seedWorld({ worldId: 'doom', now: T0, neighbours: 4, barbarians: 1 });
    s.world.store.transaction((tx) => {
      // A very large player empire: enough pressure to put every band at the
      // top rung without waiting years for it.
      const home = tx.settlements.require(s.homeId);
      for (let i = 0; i < 120; i++) {
        tx.settlements.put({ ...home, id: `big-${i}`, name: `Holding ${i}`, coordX: 15 + i, coordY: 15 });
      }
      // And a band that once held eight camps and now holds one.
      const band = tx.npcBands.all()[0]!;
      tx.npcBands.put({ ...band, peakHoldings: 8, menace: C.NPC_MAX_MENACE });
    });
    const band = s.world.store.read((tx) => tx.npcBands.all()[0]!);
    return { s, bandId: band.id, seatId: band.seatId };
  }

  it('is announced publicly, by name, with a date, before anything happens', () => {
    const { s } = beatenBand();
    // Just past the band's first turn. Jumping a month would sail straight
    // through the announcement, the launch and the crater in one call.
    s.world.advanceTo(T0 + DAY);

    const band = s.world.store.read((tx) => tx.npcBands.all()[0]);
    expect(band?.doomsdayStartedAt).toBeDefined();
    expect(band?.doomsdayReadyAt).toBeGreaterThan(band!.doomsdayStartedAt!);

    // On the world board, where everyone can read it.
    const thread = s.world.store.read((tx) => tx.threads.find((t) => /building something/i.test(t.title)));
    expect(thread).toBeDefined();
    const post = s.world.store.read((tx) => tx.posts.find((p) => p.threadId === thread!.id));
    expect(post?.body).toMatch(/Burn .* before it is done/);

    // And the window is long enough to actually do something about.
    expect(band!.doomsdayReadyAt! - band!.doomsdayStartedAt!).toBe(BigInt(C.NPC_DOOMSDAY_BUILD_MS));
  });

  it('dies on the slipway if the band’s camp is taken in time', () => {
    const { s, seatId } = beatenBand();
    s.world.advanceTo(T0 + DAY);
    const band = s.world.store.read((tx) => tx.npcBands.all()[0]!);
    expect(band.doomsdayReadyAt).toBeDefined();

    // The counterplay the announcement promised: take the seat.
    s.world.store.transaction((tx) => {
      const seat = tx.settlements.require(seatId);
      tx.settlements.put({ ...seat, ownerId: s.playerId });
    });
    s.world.advanceTo(band.doomsdayReadyAt! + DAY);

    // No Worldbreaker was ever fielded, and no strike was ever scheduled.
    const engine = s.world.store.read((tx) => tx.formations.find((f) => f.name.includes('Worldbreaker')));
    expect(engine).toBeUndefined();
    const strikes = s.world.store.read((tx) => tx.scheduled.where((e) => e.kind === 'NPC_DOOMSDAY_STRIKE'));
    expect(strikes).toHaveLength(0);
  });

  it('fields a real formation that can be seen coming and fought on the road', () => {
    const { s } = beatenBand();
    const band = (): NpcBand => s.world.store.read((tx) => tx.npcBands.all()[0]!);
    s.world.advanceTo(T0 + DAY);
    const readyAt = band().doomsdayReadyAt!;
    s.world.advanceTo(readyAt);

    const movement = s.world.store.read((tx) =>
      tx.movements.find((m) => m.formations.some((f) => tx.formations.get(f.formationId)?.name.includes('Worldbreaker'))),
    );
    expect(movement).toBeDefined();
    expect(movement!.arrivesAt).toBeGreaterThan(readyAt);
    // It is an ordinary movement on an ordinary mission, so every existing
    // interception, warning and combat rule applies to it unchanged.
    expect(['raid', 'conquer']).toContain(movement!.mission);
  });

  it('razes and kills by the published figures when it lands', () => {
    const { s } = beatenBand();
    s.world.advanceTo(T0 + DAY);
    const readyAt = s.world.store.read((tx) => tx.npcBands.all()[0]!.doomsdayReadyAt!);
    s.world.advanceTo(readyAt);

    const strike = s.world.store.read((tx) => tx.scheduled.where((e) => e.kind === 'NPC_DOOMSDAY_STRIKE')[0]);
    expect(strike).toBeDefined();
    const targetId = (strike!.payload as { targetId: string }).targetId;

    const before = s.world.store.read((tx) => tx.buildings.where((b) => b.settlementId === targetId));
    const garrisonBefore = s.world.store.read((tx) =>
      tx.formations.where((f) => f.settlementId === targetId).reduce((n, f) => n + f.count, 0),
    );

    s.world.advanceTo(strike!.executeAt);

    const struck = s.world.store.read((tx) => tx.buildings.where((b) => b.settlementId === targetId));
    for (const b of before) {
      if (b.level === 0) continue;
      const after = struck.find((x) => x.id === b.id)!;
      expect(after.level).toBe(Math.max(0, b.level - C.NPC_DOOMSDAY_RAZE_GRADES * C.LEVELS_PER_GRADE));
    }
    if (garrisonBefore > 0) {
      const garrisonAfter = s.world.store.read((tx) =>
        tx.formations.where((f) => f.settlementId === targetId).reduce((n, f) => n + f.count, 0),
      );
      expect(garrisonAfter).toBeLessThan(garrisonBefore);
    }

    // It is written to the log with its arithmetic, like every other number in
    // this game that can lose somebody a city.
    const logged = s.world.store.read((tx) =>
      tx.eventsFor(targetId, 50).find((e) => e.kind === 'npc.doomsday.struck'),
    );
    expect(logged).toBeDefined();
    expect((logged!.payload as { razedGrades: number }).razedGrades).toBe(C.NPC_DOOMSDAY_RAZE_GRADES);
  });

  it('is spent once — a band does not get a second one', () => {
    const { s } = beatenBand();
    s.world.advanceTo(T0 + DAY);
    const readyAt = s.world.store.read((tx) => tx.npcBands.all()[0]!.doomsdayReadyAt!);
    s.world.advanceTo(readyAt + 200n * DAY);
    const band = s.world.store.read((tx) => tx.npcBands.all()[0]);
    if (!band) return; // broken in the meantime, which is a fine outcome
    expect(band.doomsdayUsedAt).toBeDefined();
    const engines = s.world.store.read((tx) => tx.formations.where((f) => f.name.includes('Worldbreaker')));
    expect(engines.length).toBeLessThanOrEqual(1);
  });
});

/**
 * Barbarians are not people, and the rest of the game has to know it.
 *
 * They need a Player row because they own settlements and formations, and that
 * row is exactly the sort of thing that leaks: a horde at the top of the
 * rankings, a treaty offer to a warband, a letter nobody will ever read. Each
 * of these is a place where a convenience in the data model would surface as a
 * dead end in the interface.
 */
describe('barbarians are not counterparties', () => {
  function w(): ReturnType<typeof seedWorld> {
    return seedWorld({ worldId: 'npcline', now: T0, neighbours: 4, barbarians: 3 });
  }

  it('keeps them off the leaderboards, however much ground they take', () => {
    const s = w();
    const bandPlayerIds = new Set(s.world.store.read((tx) => tx.npcBands.all().map((b) => b.playerId)));
    // Hand a band a pile of holdings, which by the late game is the normal case.
    s.world.store.transaction((tx) => {
      const band = tx.npcBands.all()[0]!;
      for (const st of tx.settlements.where((x) => x.ownerId === undefined).slice(0, 2)) {
        tx.settlements.put({ ...st, ownerId: band.playerId });
      }
    });
    for (const key of ['holdings', 'empire_weight'] as const) {
      const rows = s.world.leaderboard(s.playerId, key);
      expect(rows.some((r) => bandPlayerIds.has(r.playerId))).toBe(false);
    }
  });

  it('keeps them out of the list of people you can treat with', () => {
    const s = w();
    const bandPlayerIds = new Set(s.world.store.read((tx) => tx.npcBands.all().map((b) => b.playerId)));
    s.world.store.transaction((tx) => {
      // Put a band on the player's own shard, so only the NPC flag excludes it.
      const band = tx.npcBands.all()[0]!;
      const st = tx.settlements.where((x) => x.ownerId === undefined)[0];
      if (st) tx.settlements.put({ ...st, ownerId: band.playerId });
    });
    expect(s.world.knownPlayers(s.playerId).some((k) => bandPlayerIds.has(k.id))).toBe(false);
  });

  it('refuses a letter addressed to one, rather than swallowing it', () => {
    const s = w();
    const bandPlayer = s.world.store.read((tx) => tx.npcBands.all()[0]!.playerId);
    expect(() =>
      s.world.sendMessage({
        commandId: 'msg-npc-1',
        fromId: s.playerId,
        toId: bandPlayer,
        subject: 'Terms',
        body: 'We could come to an arrangement about the river.',
      }),
    ).toThrow(/do not take letters/);
  });
});
