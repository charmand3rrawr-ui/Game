/**
 * bootstrap.ts — creating a world people can actually play
 *
 * A new player gets a Village with a Chieftain's Hall, a few Era I buildings,
 * a starting garrison, and neighbours worth having opinions about. spec/08 M7's
 * acceptance test is "a full play loop — build, train, dispatch, resolve, read
 * the report — completable on a phone in under ten minutes", and that loop
 * needs a world to happen in.
 *
 * Everything here is DETERMINISTIC: the same seed produces the same world, so a
 * bug report can be reproduced from its seed alone.
 */

import {
  C,
  BUILDINGS,
  prng,
  rngInt,
  type Formation,
  type Millis,
  type Player,
  type Settlement,
  type Uuid,
} from '@ascendance/shared';
import { World } from './world.js';
import { storageCapacity, buildingRef } from './sim/settlement.js';

export interface SeedOptions {
  worldId?: string;
  now: Millis;
  /** How many AI-held neighbours to place around the player. */
  neighbours?: number;
}

export interface SeededWorld {
  world: World;
  playerId: Uuid;
  homeId: Uuid;
}

/**
 * The Era I starting kit.
 *
 * It has to fit inside a Village's plots with room left to build, and plot
 * scarcity is a hard constraint rather than a guideline (spec/04 §1) — so this
 * list is already a set of choices, exactly as the player's will be. A
 * Chieftain's Hall alone takes four of twenty-six.
 *
 * One building per thing a new player needs to be able to DO:
 *   - three extractors and a warehouse, so there is something to spend;
 *   - a Barracks and an Archery Range, so the starting formations can be
 *     reinforced and the training loop is reachable on day one;
 *   - a Palisade, so an attack on you is survivable;
 *   - an Elder's Lodge, because research cannot start without a Knowledge
 *     building anywhere;
 *   - a Meditation Ledge, because cultivation income has to come from
 *     somewhere before a player knows to build for it.
 */
const STARTING_BUILDINGS: { key: string; level: number }[] = [
  { key: '1_chieftain_s_hall', level: 12 },  // 4 plots
  { key: '1_farm', level: 8 },               // 1
  { key: '1_lumber_camp', level: 8 },        // 1
  { key: '1_mine', level: 7 },               // 1
  { key: '1_warehouse', level: 9 },          // 2
  { key: '1_barracks', level: 5 },           // 3
  { key: '1_archery_range', level: 4 },      // 3
  { key: '1_palisade', level: 4 },           // 3
  { key: '1_elder_s_lodge', level: 5 },      // 2
  { key: '1_meditation_ledge', level: 4 },   // 2
];                                           // 22 of 26, leaving room to choose

const STARTING_RESOURCES: Record<string, bigint> = {
  timber: 250_000n,
  stone: 220_000n,
  special: 180_000n,
  grain: 60_000n,
  ore: 40_000n,
};

export function seedWorld(opts: SeedOptions): SeededWorld {
  const worldId = opts.worldId ?? 'ascendance-1';
  const world = new World({ worldId, now: opts.now });
  const rng = prng(worldId, 'genesis');
  const shardId = 'shard-1';

  const dynastyId = world.ids.next('dy', opts.now);
  const playerId = world.ids.next('pl', opts.now);
  const homeId = world.ids.next('st', opts.now);

  world.store.transaction((tx) => {
    tx.dynasties.put({
      id: dynastyId,
      accountId: world.ids.next('ac', opts.now),
      name: 'House Verrin',
      heraldry: { primary: '#b5651d', secondary: '#1d2b3a', charge: 'ascending sun' },
      prestige: 0n,
      traditions: [],
      foundedAt: opts.now,
    });

    const player: Player = {
      id: playerId,
      dynastyId,
      worldId,
      name: 'Verrin',
      era: 1,
      reputation: 0,
      empireWeightAvg: 0,
      cultivationGrade: 1,
      qi: 0n,
      temporalDebt: 0,
      envyScopes: [],
      shardBalanceHours: 24,
      shardHoursPurchased30d: 0,
      createdAt: opts.now,
    };
    tx.players.put(player);

    for (const track of ['construction', 'technology', 'warfare', 'commerce', 'exploration'] as const) {
      tx.proficiencies.put({ playerId, track, rank: 0, xp: 0n, xpToday: 0n });
    }

    placeSettlement(tx, world, {
      id: homeId, shardId, worldId, ownerId: playerId, name: 'Verrin Hold',
      holdingType: 'village', coordX: 0, coordY: 0, now: opts.now,
    });

    // Neighbours. Some hold real garrisons — a world with nothing worth
    // attacking teaches a player nothing about attacking.
    const count = opts.neighbours ?? 6;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const radius = 40 + rngInt(rng, 60);
      const id = world.ids.next('st', opts.now);
      const npcOwner = i % 3 === 0 ? undefined : world.ids.next('pl', opts.now);
      if (npcOwner) {
        tx.players.put({
          ...player,
          id: npcOwner,
          name: NEIGHBOUR_NAMES[i % NEIGHBOUR_NAMES.length]!,
          dynastyId: world.ids.next('dy', opts.now),
          shardBalanceHours: 0,
        });
      }
      placeSettlement(tx, world, {
        id, shardId, worldId,
        ownerId: npcOwner,
        name: npcOwner ? `${NEIGHBOUR_NAMES[i % NEIGHBOUR_NAMES.length]}'s Steading` : 'Abandoned Camp',
        holdingType: i % 4 === 0 ? 'outpost_camp' : 'village',
        coordX: Math.round(Math.cos(angle) * radius),
        coordY: Math.round(Math.sin(angle) * radius),
        now: opts.now,
      });

      if (npcOwner) {
        tx.formations.put(garrison(world, id, npcOwner, '1|Spearman|Orthodox (Balanced)|Mortal', 40 + rngInt(rng, 60), 'Steading Levy', opts.now));
        tx.formations.put(garrison(world, id, npcOwner, '1|Shield Bearer|Guardian (Defense)|Mortal', 20 + rngInt(rng, 30), 'Wall Watch', opts.now));
      }
    }

    // The player's own starting force.
    tx.formations.put(garrison(world, homeId, playerId, '1|Militia|Orthodox (Balanced)|Mortal', 120, 'The Hearth Levy', opts.now));
    tx.formations.put(garrison(world, homeId, playerId, '1|Hunter-Archer|Asura (Offense)|Mortal', 60, 'Verrin Longbows', opts.now));
    tx.formations.put(garrison(world, homeId, playerId, '1|Shield Bearer|Guardian (Defense)|Mortal', 50, 'The Standing Shields', opts.now));

    // The daily Heaven's Envy resolution, armed from genesis.
    world.scheduler.schedule(tx, {
      shardId,
      executeAt: opts.now + BigInt(C.ENVY_WINDOW_MS),
      kind: 'HEAVENS_ENVY_RESOLVE',
      payload: {},
    });
  });

  return { world, playerId, homeId };
}

const NEIGHBOUR_NAMES = ['Aelric', 'Bryndis', 'Corvan', 'Dala', 'Esker', 'Fenwyn', 'Gorrim', 'Hestia'];

function placeSettlement(
  tx: Parameters<Parameters<World['store']['transaction']>[0]>[0],
  world: World,
  args: {
    id: Uuid; shardId: string; worldId: string; ownerId?: Uuid; name: string;
    holdingType: string; coordX: number; coordY: number; now: Millis;
  },
): void {
  const settlement: Settlement = {
    id: args.id,
    shardId: args.shardId,
    worldId: args.worldId,
    ownerId: args.ownerId,
    holdingType: args.holdingType,
    name: args.name,
    layer: 'province',
    coordX: args.coordX,
    coordY: args.coordY,
    terrain: {
      richness: { timber: 1.2, ore: 1, grain: 1.1, clay: 1, stone: 1, special: 1 },
      hazards: [],
      biome: 'temperate',
      // Spirit Vein tiles pay far more Qi than buildings do, which is what
      // makes them worth fighting over rather than merely nice to have.
      spiritVeins: args.ownerId ? 1 : 0,
    },
    plotsTotal: 24,
    population: 400,
    happiness: 100,
    health: 100,
    loyalty: 100,
    integrity: args.ownerId ? 100 : 50,
    lastAccruedAt: args.now,
    createdAt: args.now,
    version: 0,
  };
  tx.settlements.put(settlement);

  const isOutpost = args.holdingType === 'outpost_camp';
  for (const b of STARTING_BUILDINGS) {
    if (!BUILDINGS.some((r) => r.key === b.key)) continue;
    // An Outpost is extraction only and trains nothing (Holdings_Hierarchy).
    if (isOutpost && !['Extraction', 'HQ/Governance', 'Logistics'].includes(buildingRef(b.key).category)) continue;
    tx.buildings.put({
      id: world.ids.next('b', args.now),
      settlementId: args.id,
      buildingKey: b.key,
      level: args.ownerId ? b.level : Math.floor(b.level / 2),
      damage: 0,
      plotIndex: STARTING_BUILDINGS.indexOf(b),
      staffedPct: 100,
    });
  }

  const view = {
    settlement,
    buildings: tx.buildings.where((x) => x.settlementId === args.id),
    queue: [],
    stockpiles: [],
  };
  for (const [key, amount] of Object.entries(STARTING_RESOURCES)) {
    const capacity = storageCapacity(view, key);
    const wanted = args.ownerId ? amount : amount / 4n;
    tx.stockpiles.put({
      settlementId: args.id,
      resourceKey: key,
      // A settlement can never hold more than its capacity, not even at
      // founding. Seeding above it would put the world into a state the
      // simulation itself can never produce, and the first accrual would
      // silently delete the difference.
      amount: wanted < capacity ? wanted : capacity,
      capacity,
    });
  }
}

function garrison(
  world: World,
  settlementId: Uuid,
  ownerId: Uuid,
  unitKey: string,
  count: number,
  name: string,
  now: Millis,
): Formation {
  return {
    id: world.ids.next('f', now),
    settlementId,
    ownerId,
    name,
    unitKey,
    count,
    atkTier: 1, atkLevel: 0, atkXp: 0n,
    defTier: 1, defLevel: 0, defXp: 0n,
    equipment: {},
    deeds: [],
    createdAt: now,
  };
}
