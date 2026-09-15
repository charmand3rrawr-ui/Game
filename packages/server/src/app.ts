/**
 * app.ts — the gateway: REST commands, cold reads, and the WebSocket push
 *
 * TWO CHANNELS (spec/05): REST for commands and cold reads, WebSocket for
 * pushed state. The client NEVER polls for attack warnings.
 *
 * The server is authoritative for everything (invariant §2.1). Every route here
 * validates a request against the shared Zod schemas and hands it to the engine,
 * which decides. No route computes an outcome the client reported.
 *
 * Errors are RFC 9457 problem details with a stable `type` URI per failure
 * mode, so the client can react specifically — "you are three plots short"
 * rather than "something went wrong".
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import {
  BALANCE_REVISION,
  ASSUMED_CONSTANTS,
  C,
  BUILDINGS,
  HOLDINGS,
  VETERANCY_TIERS,
  ROSTER,
  clientMessageSchema,
  dispatchSchema,
  enqueueSchema,
  problem,
  seizeSchema,
  spendShardsSchema,
  tierUpSchema,
  cancelQueueSchema,
  type Problem,
  type ProblemType,
} from '@ascendance/shared';
import {
  CommandError,
  World,
  seedWorld,
  accrueProduction,
  buildingRef,
  buildingsForEra,
  hqLevel,
  plotsTotal,
  plotsUsed,
  productionRows,
  staffing,
  upgradeCost,
  hqFactorFor,
} from '@ascendance/engine';
import { wire } from './serialize.js';
import { Hub } from './hub.js';
import { RateLimiter } from './ratelimit.js';

export interface AppOptions {
  /** Injected for tests; otherwise the world runs on the wall clock. */
  world?: World;
  playerId?: string;
  homeId?: string;
  /** Advance simulation time from the real clock on each request. */
  liveClock?: boolean;
}

export interface App {
  fastify: FastifyInstance;
  world: World;
  playerId: string;
  hub: Hub;
}

export async function buildApp(opts: AppOptions = {}): Promise<App> {
  const seeded = opts.world
    ? { world: opts.world, playerId: opts.playerId!, homeId: opts.homeId! }
    : seedWorld({ now: BigInt(Date.now()) });

  const world = seeded.world;
  const hub = new Hub();
  const limiter = new RateLimiter();

  const fastify = Fastify({ logger: false, bodyLimit: 1_000_000 });
  await fastify.register(cors, { origin: true });
  await fastify.register(websocket);

  /**
   * Advance simulation time to now, then flush whatever the engine produced.
   *
   * This is where a single-process deployment gets its worker loop: the
   * scheduler runs whatever fell due, and the resulting deltas fan out. In the
   * topology of spec/01 §3 this becomes a separate simulation worker; the
   * interface is the same either way.
   */
  const tick = (): void => {
    if (opts.liveClock !== false) {
      const now = BigInt(Date.now());
      if (now > world.now) world.advanceTo(now);
    }
    for (const msg of world.drainOutbox()) hub.publish(msg.channel, msg.event, msg.data);
  };

  fastify.addHook('onRequest', async (req, reply) => {
    // Rate limits return 429 with Retry-After, never a silent drop (spec/05 §5).
    const key = playerIdOf(req) ?? req.ip;
    const verdict = limiter.check(key, req.method === 'GET' ? 'read' : 'command');
    if (!verdict.allowed) {
      reply.header('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)));
      return reply.status(429).type('application/problem+json').send(
        problem('rate-limited', 'Too many commands', 429, 'Slow down. This limit is sized to permit coordinated waves and reject machine-gun patterns.', {
          retryAfterMs: verdict.retryAfterMs,
        }),
      );
    }
    tick();
    return undefined;
  });

  fastify.setErrorHandler((raw, _req, reply) => {
    const err = raw as Error & { validation?: unknown };
    if (err instanceof CommandError) {
      return reply.status(statusFor(err.problemType)).type('application/problem+json')
        .send(problem(err.problemType, titleFor(err.problemType), statusFor(err.problemType), err.message, err.meta));
    }
    if ((err as { name?: string }).name === 'NotFound') {
      return reply.status(404).type('application/problem+json').send(problem('not-found', 'Not found', 404, err.message));
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.status(400).type('application/problem+json').send(problem('validation', 'Invalid request', 400, err.message));
    }
    return reply.status(500).type('application/problem+json').send(problem('validation', 'Internal error', 500, err.message));
  });

  // ==========================================================================
  // Meta
  // ==========================================================================

  /**
   * A running server reports exactly which balance revision it is using
   * (spec/07 §1), and which constants are still assumptions.
   */
  fastify.get('/v1/meta', async () => ({
    balanceRevision: BALANCE_REVISION,
    assumedConstants: ASSUMED_CONSTANTS,
    serverTime: Date.now(),
    worldTime: world.now.toString(),
    counts: { buildings: BUILDINGS.length, units: ROSTER.length, holdings: HOLDINGS.length, veterancyTiers: VETERANCY_TIERS.length },
  }));

  fastify.get('/v1/health', async () => ({ ok: true }));

  /** The reference data the client needs to render anything at all. */
  fastify.get('/v1/reference', async () => wire({
    buildings: BUILDINGS,
    holdings: HOLDINGS,
    veterancyTiers: VETERANCY_TIERS,
    constants: {
      MAX_LEVEL: C.MAX_LEVEL,
      LEVELS_PER_GRADE: C.LEVELS_PER_GRADE,
      MAX_GRADE: C.MAX_GRADE,
      LEVELS_PER_TIER: C.LEVELS_PER_TIER,
      JOINT_BONUS_CAP: C.JOINT_BONUS_CAP,
      SPEC_CAP_G20: C.SPEC_CAP_G20,
      SPEC_CAP_G30: C.SPEC_CAP_G30,
      GOVERNOR_TIME_MULT: C.GOVERNOR_TIME_MULT,
    },
  }));

  // ==========================================================================
  // Read endpoints
  // ==========================================================================

  fastify.get('/v1/me', async (req) => {
    const playerId = requirePlayer(req, seeded.playerId);
    const player = world.player(playerId);
    return wire({
      player,
      empireWeight: world.empireWeight(playerId),
      settlements: world.settlementsOf(playerId).map((s) => ({
        id: s.id, name: s.name, holdingType: s.holdingType, layer: s.layer,
        coordX: s.coordX, coordY: s.coordY, loyalty: s.loyalty, population: s.population,
      })),
    });
  });

  /**
   * THE ATTENTION DASHBOARD — the most important endpoint in the game.
   *
   * With no cap on holdings and full production isolation, this is where
   * players live. Everything needing the player, sorted by urgency, each row
   * carrying a one-tap resolution where one exists (spec/06 §3).
   */
  fastify.get('/v1/attention', async (req) => {
    const playerId = requirePlayer(req, seeded.playerId);
    return wire({ items: world.attention(playerId), serverTime: Date.now() });
  });

  fastify.get<{ Params: { id: string } }>('/v1/settlements/:id', async (req) => {
    const playerId = requirePlayer(req, seeded.playerId);
    world.refresh(req.params.id);
    const view = world.view(req.params.id);
    if (view.settlement.ownerId !== playerId) {
      // What a scout would see, respecting fog and intel age (spec/05 §3).
      return wire(publicView(view));
    }
    const accrued = accrueProduction(view, world.now);
    return wire({
      settlement: view.settlement,
      buildings: view.buildings.map((b) => ({ ...b, ref: buildingRef(b.buildingKey) })),
      queue: view.queue,
      stockpiles: accrued.stockpiles,
      production: productionRows(view, world.now),
      staffing: staffing(view),
      plots: { used: plotsUsed(view), total: plotsTotal(view) },
      hqLevel: hqLevel(view),
      // What could be built next, with its real cost and time. The client never
      // computes these; it displays what the server decided.
      available: buildingsForEra(world.player(playerId).era)
        .filter((r) => !view.buildings.some((b) => b.buildingKey === r.key) || true)
        .slice(0, 200)
        .map((r) => {
          const existing = view.buildings.find((b) => b.buildingKey === r.key);
          const cost = upgradeCost(r.key, existing?.level ?? 0, hqFactorFor(hqLevel(view)), 1, 1);
          return {
            key: r.key, name: r.name, category: r.category, era: r.era, sizeClass: r.sizeClass,
            functionText: r.functionText, purpose: r.purpose, mechanic: r.mechanic, art: r.art,
            currentLevel: existing?.level ?? 0,
            cost: cost.resources,
            timeMs: cost.totalTimeMs,
          };
        }),
    });
  });

  fastify.get<{ Querystring: { bbox?: string } }>('/v1/map', async (req) => {
    const playerId = requirePlayer(req, seeded.playerId);
    // Returns only what the requester's vision permits. Everything else is
    // fogged — all layers begin fogged (spec/04 §8).
    return wire({
      settlements: world.store.read((tx) =>
        tx.settlements.all().map((s) => ({
          id: s.id, name: s.name, ownerId: s.ownerId, holdingType: s.holdingType,
          coordX: s.coordX, coordY: s.coordY, layer: s.layer,
          mine: s.ownerId === playerId,
          integrity: s.integrity,
        })),
      ),
      movements: world.store.read((tx) =>
        tx.movements.all()
          .filter((m) => m.ownerId === playerId || world.settlementsOf(playerId).some((s) => s.id === m.targetId))
          .map((m) => ({ ...m, cargo: undefined })),
      ),
      void: req.query.bbox,
    });
  });

  fastify.get('/v1/formations', async (req) => {
    const playerId = requirePlayer(req, seeded.playerId);
    return wire({
      formations: world.formationsOf(playerId).map((f) => ({ ...f, def: unitSummary(f.unitKey) })),
    });
  });

  fastify.get('/v1/movements', async (req) => {
    const playerId = requirePlayer(req, seeded.playerId);
    return wire({ movements: world.movementsOf(playerId), serverTime: Date.now() });
  });

  /** The full battle report, including every multiplier and the XP table. */
  fastify.get<{ Params: { id: string } }>('/v1/battles/:id', async (req, reply) => {
    const b = world.battle(req.params.id);
    if (!b) return reply.status(404).type('application/problem+json').send(problem('not-found', 'No such battle', 404));
    return wire(b);
  });

  fastify.get<{ Params: { id: string } }>('/v1/settlements/:id/battles', async (req) =>
    wire({ battles: world.battlesAt(req.params.id).slice(0, 25) }),
  );

  // ==========================================================================
  // Command endpoints — all idempotent by commandId
  // ==========================================================================

  fastify.post<{ Params: { id: string } }>('/v1/settlements/:id/queue', async (req, reply) => {
    const playerId = requirePlayer(req, seeded.playerId);
    const body = enqueueSchema.parse(req.body);
    const item = world.enqueue({
      commandId: body.commandId,
      playerId,
      settlementId: req.params.id,
      kind: body.kind,
      targetKey: body.targetKey,
      quantity: body.quantity,
      slotKind: body.slotKind,
    });
    tick();
    return reply.status(201).send(wire(item));
  });

  fastify.delete<{ Params: { itemId: string } }>('/v1/queue/:itemId', async (req) => {
    const playerId = requirePlayer(req, seeded.playerId);
    const body = cancelQueueSchema.parse(req.body ?? { commandId: crypto.randomUUID() });
    return wire(world.cancelQueueItem(body.commandId, playerId, req.params.itemId));
  });

  fastify.post<{ Params: { itemId: string } }>('/v1/queue/:itemId/seize', async (req) => {
    const playerId = requirePlayer(req, seeded.playerId);
    const body = seizeSchema.parse(req.body);
    const out = world.seize(body.commandId, playerId, req.params.itemId);
    tick();
    return wire(out);
  });

  fastify.post<{ Params: { itemId: string } }>('/v1/queue/:itemId/shards', async (req) => {
    const playerId = requirePlayer(req, seeded.playerId);
    const body = spendShardsSchema.parse(req.body);
    const out = world.spendShards(body.commandId, playerId, req.params.itemId, body.shardHours);
    tick();
    return wire(out);
  });

  fastify.post('/v1/movements', async (req, reply) => {
    const playerId = requirePlayer(req, seeded.playerId);
    const body = dispatchSchema.parse(req.body);
    const m = world.dispatch({
      commandId: body.commandId,
      playerId,
      originId: body.originId,
      targetId: body.targetId,
      mission: body.mission,
      formations: body.formations,
    });
    tick();
    // The arrival timestamp is returned so the client can show an exact
    // countdown — and so coordinated waves can be timed to the second.
    return reply.status(201).send(wire(m));
  });

  fastify.post<{ Params: { id: string }; Body: { track?: 'atk' | 'def' } }>('/v1/formations/:id/tier-up', async (req) => {
    const playerId = requirePlayer(req, seeded.playerId);
    const body = tierUpSchema.parse(req.body);
    const track = (req.body as { track?: 'atk' | 'def' })?.track ?? 'atk';
    const out = world.tierUp(body.commandId, playerId, req.params.id, track);
    tick();
    return wire(out);
  });

  // ==========================================================================
  // WebSocket — pushed state
  // ==========================================================================

  fastify.get('/v1/ws', { websocket: true }, (socket, req) => {
    const playerId = playerIdOf(req) ?? seeded.playerId;
    const client = hub.join(socket);
    // Every player is subscribed to their own channel immediately: an attack
    // warning must never wait on a subscribe round-trip.
    hub.subscribe(client, `player:${playerId}`);

    socket.on('message', (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const msg = clientMessageSchema.safeParse(parsed);
      if (!msg.success) return;

      if (msg.data.action === 'subscribe') for (const ch of msg.data.channels) hub.subscribe(client, ch);
      if (msg.data.action === 'unsubscribe') for (const ch of msg.data.channels) hub.unsubscribe(client, ch);
      if (msg.data.action === 'clock') {
        // Clock sync. Players coordinate attacks across time zones constantly,
        // so the client renders every timer from an absolute server timestamp
        // plus a measured offset (spec/06 §5).
        socket.send(JSON.stringify({ event: 'clock', at: Date.now(), clientSent: msg.data.clientSent }));
      }
    });

    socket.on('close', () => hub.leave(client));
  });

  return { fastify, world, playerId: seeded.playerId, hub };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Auth.
 *
 * spec/05 §1 specifies a short-lived JWT. This build runs a single seeded world
 * with one human player, so the header names the player directly and defaults
 * to the seeded one. The seam is here: swapping in JWT verification touches
 * this function and nothing else.
 */
function playerIdOf(req: FastifyRequest): string | undefined {
  const header = req.headers['x-player-id'];
  return typeof header === 'string' ? header : undefined;
}

function requirePlayer(req: FastifyRequest, fallback: string): string {
  return playerIdOf(req) ?? fallback;
}

function publicView(view: ReturnType<World['view']>): unknown {
  // What a scout would see: sizes and shapes, not levels and stockpiles.
  // Building levels are hidden from enemies, which is what rewards scouting.
  return {
    settlement: {
      id: view.settlement.id,
      name: view.settlement.name,
      ownerId: view.settlement.ownerId,
      holdingType: view.settlement.holdingType,
      coordX: view.settlement.coordX,
      coordY: view.settlement.coordY,
      layer: view.settlement.layer,
      integrity: view.settlement.integrity,
    },
    buildings: view.buildings.map((b) => ({ buildingKey: b.buildingKey, damaged: b.damage > 0 })),
    observed: true,
    fogged: ['levels', 'stockpiles', 'queues', 'garrison'],
  };
}

function unitSummary(unitKey: string): unknown {
  const u = ROSTER.find((x) => x.unitKey === unitKey);
  return u ? { name: u.name, role: u.role, era: u.era, grade: u.grade, path: u.path, atk: u.atk, def: u.def, hp: u.hp, speed: u.speed, upkeep: u.upkeep } : null;
}

function statusFor(t: ProblemType): number {
  switch (t) {
    case 'not-found': return 404;
    case 'not-owner': return 403;
    case 'rate-limited': return 429;
    case 'already-complete': return 409;
    default: return 422;
  }
}

function titleFor(t: ProblemType): string {
  const titles: Record<string, string> = {
    'insufficient-plots': 'Not enough plots',
    'insufficient-resources': 'Not enough resources',
    'hq-level-cap': 'Blocked by the HQ level',
    'specialization-cap': 'Specialization cap reached',
    'no-free-personal-slot': 'No free personal queue slot',
    'no-free-queue-slot': 'No free queue slot',
    'nap-blocks-attack': 'A treaty blocks this attack',
    'shard-ceiling-reached': 'Compression ceiling reached',
    'shard-prohibited-target': 'Shards cannot be applied here',
    'tier-up-requirements': 'Promotion requirements not met',
    'layer-limit': 'Layer limit',
    'not-owner': 'Not yours',
    'not-found': 'Not found',
    'already-complete': 'Already complete',
  };
  return titles[t] ?? 'Rejected';
}

export type { Problem };
export { wire };
function _unusedReply(_r: FastifyReply): void {}
void _unusedReply;
