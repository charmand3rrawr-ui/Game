/**
 * npc.ts — how dangerous the world has become, and why
 *
 * THE ONE IDEA
 *   Barbarians do not escalate on a timer. They escalate in answer to the
 *   players. A world where nobody is winning stays a nuisance for months; a
 *   world with a runaway empire in it produces hordes that can take that
 *   empire's cities, and it produces them because of the empire, not despite
 *   it. `worldPressure` is that sentence as arithmetic.
 *
 * WHY IT LIVES IN `shared`
 *   The client has to be able to explain the threat — what tier the bands are
 *   at, what that unlocks, and what the player did to cause it. Invariant §2.7
 *   is about battles, but the principle generalises: a number that decides
 *   whether your capital burns has to be showable with its derivation. So the
 *   math is here, on both sides, and the server remains the only thing that
 *   ACTS on it (invariant §2.1).
 *
 * WHY IT IS PURE
 *   No clock reads, no store, no randomness. Everything is a function of a
 *   snapshot the caller assembles. That is what lets the whole escalation model
 *   be tested as a table of inputs and expected tiers, and what lets a replay
 *   reach the same menace for the same reasons (invariant §2.2).
 */

import { C } from './generated/constants.js';
import type { NpcDoctrine } from './types.js';

/** What the barbarians can see of the world, and nothing else. */
export interface PressureInput {
  /** Days since the world was created. */
  worldAgeDays: number;
  /** The single largest player empire weight on the shard. */
  strongestEmpireWeight: number;
  /** Settlements in player hands. Territory is the visible face of success. */
  playerHoldings: number;
}

/** One term of the pressure sum, kept so the total can be explained. */
export interface PressureTerm {
  label: string;
  amount: number;
  detail: string;
}

export interface Pressure {
  total: number;
  terms: PressureTerm[];
}

/**
 * How dangerous the world has become, with the derivation attached.
 *
 * Three terms, deliberately: one the players cannot influence (time), and two
 * they cause (the biggest empire, and how much ground is settled). The second
 * two dominate in any world where anything is happening, which is the point —
 * pressure is mostly a bill for the players' own success.
 */
export function worldPressure(input: PressureInput): Pressure {
  const terms: PressureTerm[] = [
    {
      label: 'age of the world',
      amount: Math.max(0, input.worldAgeDays) * C.NPC_PRESSURE_PER_DAY,
      detail: `${Math.max(0, Math.floor(input.worldAgeDays))} days x ${C.NPC_PRESSURE_PER_DAY}`,
    },
    {
      label: 'the largest empire',
      amount: Math.max(0, input.strongestEmpireWeight) * C.NPC_PRESSURE_PER_WEIGHT,
      detail: `weight ${Math.max(0, input.strongestEmpireWeight).toFixed(1)} x ${C.NPC_PRESSURE_PER_WEIGHT}`,
    },
    {
      label: 'settled territory',
      amount: Math.max(0, input.playerHoldings) * C.NPC_PRESSURE_PER_HOLDING,
      detail: `${Math.max(0, input.playerHoldings)} holdings x ${C.NPC_PRESSURE_PER_HOLDING}`,
    },
  ];
  return { total: terms.reduce((n, t) => n + t.amount, 0), terms };
}

/**
 * Doctrine changes the RATE of escalation, never the ceiling.
 *
 * A raider reaches open war sooner than a warlord and a warlord holds what it
 * takes; both can eventually reach the top of the ladder. Making doctrine a
 * ceiling instead would mean three quarters of the bands in a world are
 * permanently irrelevant, which is the opposite of the point.
 */
const DOCTRINE_RATE: Readonly<Record<NpcDoctrine, number>> = Object.freeze({
  raider: 1.25,
  slaver: 1.05,
  zealot: 1.0,
  warlord: 0.8,
});

export function doctrineRate(doctrine: NpcDoctrine): number {
  return DOCTRINE_RATE[doctrine];
}

/**
 * The menace tier a band of this doctrine has earned at this pressure.
 *
 * Integer, monotonic in pressure, and clamped to the ladder. Menace never
 * falls here — only a defeat in the field lowers it, and that happens in the
 * engine where the defeat is known.
 */
export function menaceFor(pressure: number, doctrine: NpcDoctrine): number {
  const scaled = Math.max(0, pressure) * doctrineRate(doctrine);
  return Math.max(0, Math.min(C.NPC_MAX_MENACE, Math.floor(scaled / C.NPC_PRESSURE_PER_MENACE)));
}

/** The pressure at which a band of this doctrine reaches `menace`. */
export function pressureForMenace(menace: number, doctrine: NpcDoctrine): number {
  return (menace * C.NPC_PRESSURE_PER_MENACE) / doctrineRate(doctrine);
}

/**
 * The ladder, in the order a world climbs it.
 *
 * Each rung ADDS a behaviour and never removes one below it: a horde at
 * `conquer_player` still raids, still farms, still confederates. That is what
 * makes escalation feel like a world getting worse rather than a world
 * switching modes.
 */
export const MENACE_LADDER = Object.freeze([
  { tier: 0, key: 'skulk', name: 'Skulking', unlocks: 'Nothing. The band sits in its camp and is counted as scenery.' },
  { tier: 1, key: 'raid', name: 'Raiding', unlocks: 'Raids the weakest holding in reach for plunder. Never tries to hold ground.' },
  { tier: 2, key: 'farm', name: 'Farming', unlocks: 'Hunts other bands for spoils, and converts what it takes straight into levies.' },
  { tier: 3, key: 'conquer_npc', name: 'Subjugating', unlocks: 'Takes other bands’ camps outright. Barbarian territory starts consolidating.' },
  { tier: 4, key: 'confederate', name: 'Confederating', unlocks: 'Forms confederations with neighbouring bands. The first one is a turning point.' },
  { tier: 5, key: 'warpath', name: 'On the warpath', unlocks: 'Confederates strike one target together, arriving in the same instant.' },
  { tier: 6, key: 'conquer_player', name: 'Conquering', unlocks: 'Attacks to capture player settlements, not merely to loot them.' },
  { tier: 7, key: 'doomsday', name: 'Doomsday', unlocks: 'A losing band may build a doomsday engine. Announced when work starts.' },
] as const);

export function menaceRung(tier: number): (typeof MENACE_LADDER)[number] {
  const clamped = Math.max(0, Math.min(MENACE_LADDER.length - 1, Math.floor(tier)));
  // Indexing a frozen literal tuple cannot miss after the clamp, but
  // noUncheckedIndexedAccess does not know that.
  return MENACE_LADDER[clamped] ?? MENACE_LADDER[0];
}

/**
 * The four things barbarians can do that no player can.
 *
 * This asymmetry is intentional and it is PUBLISHED — it renders in the Codex
 * verbatim. An AI with hidden advantages reads to a player as a broken game;
 * the same AI with the same advantages, stated plainly, reads as a faction
 * with a different nature. The difference is entirely whether they were told.
 */
export const NPC_PRIVILEGES = Object.freeze([
  {
    key: 'levy',
    name: 'Levy from spoils and ground',
    detail:
      'Barbarians convert plunder directly into troops, and a band with nothing left to march with ' +
      'raises more from the camps it holds. No barracks, no queue, no training time \u2014 a band ' +
      'that sacks a rich holding fields the resulting army the same hour, and a beaten one rebuilds ' +
      'out of its own territory. A player must build, pay again, and wait out a timer.',
  },
  {
    key: 'weightless',
    name: 'No administrative weight',
    detail:
      'Holding ground costs a band nothing. Players pay empire weight for every settlement, which ' +
      'suppresses morale and slows progression; barbarians never do.',
  },
  {
    key: 'warpath',
    name: 'Perfect synchronisation',
    detail:
      'Confederated bands arrive in the same instant regardless of distance or unit speed. Players ' +
      'must time multi-wave attacks by hand, and getting it right is a skill.',
  },
  {
    key: 'doomsday',
    name: 'The doomsday engine',
    detail:
      'A band that is losing badly can build a weapon no player can research or capture. It is ' +
      'announced publicly when work begins, and it dies with the band’s camp if you get there first.',
  },
] as const);
