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

    /*
     * A world that has been going on without you.
     *
     * The inbox and the board are where a persistent world stops feeling
     * procedurally generated, and an empty one on first login teaches a new
     * player that nobody is there. These are the neighbours already seeded
     * above, writing about the things the game actually models — a border, a
     * pact, a stalled governor — so the text layer has something in it before
     * the player has done anything.
     */
    const neighbours = tx.players.all().filter((p) => p.id !== playerId);
    const hoursAgo = (h: number): Millis => opts.now - BigInt(h) * 3_600_000n;

    if (neighbours[0]) {
      tx.messages.put({
        id: world.ids.next('msg', opts.now),
        worldId,
        fromId: neighbours[0].id,
        toId: playerId,
        subject: 'The stretch of river below your mill',
        body:
          'You have been fair about the crossing, so I will be plain. My herds water at the bend below your ' +
          'mill and I would rather pay for it than argue about it. A non-aggression pact, and I will keep to ' +
          'my bank.\n\nIf you would rather have the river than the peace, say so now and not with soldiers.',
        sentAt: hoursAgo(19),
      });
    }
    if (neighbours[1]) {
      tx.messages.put({
        id: world.ids.next('msg', opts.now),
        worldId,
        fromId: neighbours[1].id,
        toId: playerId,
        subject: 'Do not trust a pact from upriver',
        body:
          'Whatever they have offered you, they offered me first, and then they took the bend anyway while ' +
          'my levies were out.\n\nI am not asking for an alliance. I am telling you what I know, and you can ' +
          'do what you like with it.',
        sentAt: hoursAgo(6),
      });
    }

    // The world board, mid-conversation. Threads carry their own posts.
    const board = (
      title: string, authorId: Uuid, atHours: number,
      posts: { authorId: Uuid; body: string; atHours: number }[],
    ): void => {
      const threadId = world.ids.next('th', opts.now);
      const last = posts.reduce((n, p) => Math.min(n, p.atHours), atHours);
      tx.threads.put({
        id: threadId,
        worldId,
        scope: 'world',
        title,
        authorId,
        createdAt: hoursAgo(atHours),
        lastPostAt: hoursAgo(last),
        postCount: posts.length,
      });
      for (const p of posts) {
        tx.posts.put({
          id: world.ids.next('po', opts.now),
          threadId,
          authorId: p.authorId,
          body: p.body,
          postedAt: hoursAgo(p.atHours),
        });
      }
    };

    const a = neighbours[0]?.id ?? playerId;
    const b = neighbours[1]?.id ?? playerId;
    const c = neighbours[2]?.id ?? a;

    board('Read this before you appoint your first governor', a, 52, [
      { authorId: a, atHours: 52, body:
        'Everything a governor starts takes exactly twice as long. That is the whole system — there is no ' +
        'output tax and no upkeep, just the 2x.\n\nWhat catches people is that governors have NO judgement. ' +
        'Write a build order that hits a shortfall and it stalls there. It will not skip ahead to something ' +
        'it can afford. That is working correctly, and the stall shows on your Attention dashboard.' },
      { authorId: b, atHours: 44, body:
        'Learned this the hard way. Left a Granary at the top of the order, could not afford it for two days, ' +
        'and the province built nothing at all in that time. Seize is what saved me — you keep the elapsed ' +
        'progress and the rest recalculates at 1x.' },
      { authorId: c, atHours: 9, body:
        'Worth adding that Seize needs a free PERSONAL slot. That scarcity is the only reason governing ' +
        'everything and instantly seizing it all back is not simply the correct play.' },
    ]);

    board('Empire weight is not a penalty and people keep saying it is', b, 31, [
      { authorId: b, atHours: 31, body:
        'It raises the XP your armies need, up to about 9.9 million times at the very top. It does not reduce ' +
        'your output and it does not cap your holdings — there is no cap.\n\nIt is a 30-day rolling average, ' +
        'which is the part that matters: dropping territory before a war costs you a month, not an afternoon.' },
      { authorId: a, atHours: 12, body:
        'Right. Going wide is allowed. It just means your veterans stop being cheap.' },
    ]);

    board('If you are breaking through, do it somewhere quiet', c, 27, [
      { authorId: c, atHours: 27, body:
        'The Qi is spent when you DECLARE, not when you succeed. And several trials are visible to everyone ' +
        'nearby, which means rivals can come and crash them.\n\nCheck whether your next one is crashable ' +
        'before you commit. The Dao screen says so plainly, and it says it before you press the button.' },
      { authorId: a, atHours: 4, body:
        'Also: no amount of Chrono Shards will touch a breakthrough. They are barred outright, and the ' +
        'Temporal Debt from spending them anywhere else makes every trial harder. That one is not a bug.' },
    ]);

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
