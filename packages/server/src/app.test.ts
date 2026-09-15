/**
 * app.test.ts — M6 acceptance: the API contract and realtime push
 *
 * spec/08 M6: "`attack.incoming` delivers in under one second at 10,000
 * concurrent sockets; replaying a command with the same `commandId` does not
 * double-execute."
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { seedWorld } from '@ascendance/engine';
import { problemCode, type Problem } from '@ascendance/shared';
import { buildApp, type App } from './app.js';
import { Hub } from './hub.js';
import { RateLimiter } from './ratelimit.js';
import { wire, stableJson } from './serialize.js';

const T0 = 1_700_000_000_000n;
let app: App;
let homeId: string;
let n = 0;
const cmd = (): string => `11111111-1111-4111-8111-${String(n++).padStart(12, '0')}`;

beforeEach(async () => {
  const seeded = seedWorld({ worldId: 'api', now: T0, neighbours: 4 });
  homeId = seeded.homeId;
  // liveClock off: the test drives simulation time explicitly, so a slow CI
  // machine cannot change what the assertions see.
  app = await buildApp({ world: seeded.world, playerId: seeded.playerId, homeId: seeded.homeId, liveClock: false });
});

async function get(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await app.fastify.inject({ method: 'GET', url });
  return { status: r.statusCode, body: r.json() };
}

async function post(url: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await app.fastify.inject({ method: 'POST', url, payload: payload as object });
  return { status: r.statusCode, body: r.json() };
}

describe('M6 acceptance — the API contract', () => {
  it('reports which balance revision it is running', () => {
    // A running server must be able to say exactly which balance revision
    // produced a given result (spec/07 §1).
    return get('/v1/meta').then(({ body }) => {
      expect(body['balanceRevision']).toMatch(/^[0-9a-f]{64}$/);
      expect((body['counts'] as Record<string, number>)['units']).toBe(2268);
      expect(Array.isArray(body['assumedConstants'])).toBe(true);
    });
  });

  it('serializes every big integer as a string, never a JSON number', async () => {
    // Resource amounts and XP exceed the IEEE-754 safe range. A truncated
    // stockpile is the worst kind of bug: plausible, and wrong.
    const { body } = await get(`/v1/settlements/${homeId}`);
    for (const s of body['stockpiles'] as { amount: unknown; capacity: unknown }[]) {
      expect(typeof s.amount).toBe('string');
      expect(typeof s.capacity).toBe('string');
    }
    const { body: me } = await get('/v1/me');
    expect(typeof (me['player'] as { qi: unknown }).qi).toBe('string');
  });

  it('does not double-execute a replayed commandId', async () => {
    const commandId = cmd();
    const first = await post(`/v1/settlements/${homeId}/queue`, {
      commandId, kind: 'building', targetKey: '1_fishery', slotKind: 'personal',
    });
    const second = await post(`/v1/settlements/${homeId}/queue`, {
      commandId, kind: 'building', targetKey: '1_fishery', slotKind: 'personal',
    });
    expect(first.status).toBe(201);
    expect(second.body['id']).toBe(first.body['id']);
    const { body } = await get(`/v1/settlements/${homeId}`);
    expect((body['queue'] as unknown[]).length).toBe(1);
  });

  it('returns RFC 9457 problem details with a stable type per failure mode', async () => {
    // The client reacts specifically: "you are three plots short" rather than
    // "something went wrong".
    app.world.store.transaction((tx) => {
      for (const s of tx.stockpiles.where((x) => x.settlementId === homeId)) tx.stockpiles.put({ ...s, amount: 0n });
    });
    const r = await app.fastify.inject({
      method: 'POST', url: `/v1/settlements/${homeId}/queue`,
      payload: { commandId: cmd(), kind: 'building', targetKey: '1_fishery', slotKind: 'personal' },
    });
    expect(r.statusCode).toBe(422);
    expect(r.headers['content-type']).toContain('application/problem+json');
    const p = r.json() as Problem;
    expect(problemCode(p)).toBe('insufficient-resources');
    expect(p.meta?.['short']).toBeDefined();
  });

  it('rejects a malformed command before it reaches the engine', async () => {
    const r = await app.fastify.inject({
      method: 'POST', url: `/v1/settlements/${homeId}/queue`,
      payload: { commandId: 'not-a-uuid', kind: 'building', targetKey: '1_farm', slotKind: 'personal' },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('returns an exact arrival timestamp so the client can count down', async () => {
    // Arrival precision is what makes coordinated multi-wave attacks work.
    const { body: me } = await get('/v1/me');
    const { body: map } = await get('/v1/map');
    const target = (map['settlements'] as { id: string; mine: boolean; ownerId?: string }[]).find((s) => !s.mine && s.ownerId);
    const { body: fm } = await get('/v1/formations');
    const f = (fm['formations'] as { id: string; count: number }[])[0]!;

    const r = await post('/v1/movements', {
      commandId: cmd(), originId: homeId, targetId: target!.id, mission: 'attack',
      formations: [{ formationId: f.id, count: 10 }],
    });
    expect(r.status).toBe(201);
    expect(typeof r.body['arrivesAt']).toBe('string');
    expect(BigInt(r.body['arrivesAt'] as string)).toBeGreaterThan(T0);
    void me;
  });

  it('hides what a scout has not seen', async () => {
    // All layers begin fogged; building levels are hidden from enemies, which
    // is what rewards scouting (spec/04 §8).
    const { body: map } = await get('/v1/map');
    const other = (map['settlements'] as { id: string; mine: boolean }[]).find((s) => !s.mine)!;
    const { body } = await get(`/v1/settlements/${other.id}`);
    expect(body['fogged']).toContain('levels');
    expect(body['stockpiles']).toBeUndefined();
    for (const b of body['buildings'] as Record<string, unknown>[]) {
      expect(b['level']).toBeUndefined();
    }
  });

  it('serves the attention dashboard sorted by urgency', async () => {
    const { body } = await get('/v1/attention');
    const items = body['items'] as { urgency: number }[];
    expect(items.length).toBeGreaterThan(0);
    for (let i = 1; i < items.length; i++) {
      expect(items[i]!.urgency).toBeLessThanOrEqual(items[i - 1]!.urgency);
    }
  });

  it('serves the full battle report, with every multiplier', async () => {
    const { body: map } = await get('/v1/map');
    const target = (map['settlements'] as { id: string; mine: boolean; ownerId?: string }[]).find((s) => !s.mine && s.ownerId)!;
    const { body: fm } = await get('/v1/formations');
    const formations = (fm['formations'] as { id: string; count: number }[]).map((f) => ({ formationId: f.id, count: Math.floor(f.count / 2) }));

    const dispatch = await post('/v1/movements', { commandId: cmd(), originId: homeId, targetId: target.id, mission: 'attack', formations });
    app.world.advanceTo(BigInt(dispatch.body['arrivesAt'] as string));

    const { body } = await get(`/v1/settlements/${target.id}/battles`);
    const battles = body['battles'] as { id: string }[];
    expect(battles.length).toBe(1);

    const { body: report } = await get(`/v1/battles/${battles[0]!.id}`);
    const r = report['report'] as { phases: { attackerPower: Record<string, unknown> }[]; attribution: unknown[] };
    expect(r.phases.length).toBeGreaterThanOrEqual(5);
    const main = r.phases[2]!.attackerPower;
    // Every multiplier that touched the result appears, uncapped and capped.
    for (const key of ['techTier', 'equipment', 'doctrine', 'commander', 'veterancy', 'morale', 'uncapped', 'capped', 'jointCapEngaged']) {
      expect(main[key]).toBeDefined();
    }
    expect(typeof report['seed']).toBe('string');
  });
});

describe('rate limiting', () => {
  it('permits a coordinated wave but rejects a machine-gun pattern', () => {
    // Sending twenty armies to land three seconds apart is the game played
    // well; two hundred in a second is a script (spec/05 §5).
    let clock = 0;
    const limiter = new RateLimiter(() => clock);
    let allowed = 0;
    for (let i = 0; i < 200; i++) {
      if (limiter.check('p1', 'command').allowed) allowed++;
    }
    expect(allowed).toBeGreaterThanOrEqual(20); // a real wave gets through
    expect(allowed).toBeLessThan(200); // a script does not
  });

  it('refills over time and always says when to retry', () => {
    let clock = 0;
    const limiter = new RateLimiter(() => clock);
    while (limiter.check('p2', 'command').allowed) { /* drain */ }
    const denied = limiter.check('p2', 'command');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    clock += 60_000;
    expect(limiter.check('p2', 'command').allowed).toBe(true);
  });

  it('answers 429 with Retry-After rather than dropping silently', async () => {
    let last = await app.fastify.inject({ method: 'GET', url: '/v1/health' });
    for (let i = 0; i < 200 && last.statusCode !== 429; i++) {
      last = await app.fastify.inject({ method: 'GET', url: '/v1/health' });
    }
    expect(last.statusCode).toBe(429);
    expect(last.headers['retry-after']).toBeDefined();
  });
});

describe('the WebSocket fan-out', () => {
  it('delivers to every subscriber of a channel', () => {
    const hub = new Hub();
    const received: string[] = [];
    const a = hub.join({ send: (d) => received.push(`a:${d}`) });
    const b = hub.join({ send: (d) => received.push(`b:${d}`) });
    hub.subscribe(a, 'player:1');
    hub.subscribe(b, 'player:1');
    expect(hub.publish('player:1', 'attack.incoming', { movementId: 'm1' })).toBe(2);
    expect(received).toHaveLength(2);
    expect(received[0]).toContain('attack.incoming');
  });

  it('does not let one dead socket swallow a warning for everyone else', () => {
    // In a coordinated attack this is the difference between one player
    // missing the alert and the whole alliance missing it.
    const hub = new Hub();
    let delivered = 0;
    const dead = hub.join({ send: () => { throw new Error('socket closed'); } });
    const alive = hub.join({ send: () => { delivered++; } });
    hub.subscribe(dead, 'alliance:1');
    hub.subscribe(alive, 'alliance:1');
    expect(hub.publish('alliance:1', 'attack.incoming', {})).toBe(1);
    expect(delivered).toBe(1);
    expect(hub.size).toBe(1); // the dead client was reaped
  });

  it('stamps every envelope with server time, because clients render from it', () => {
    const hub = new Hub();
    let payload = '';
    const c = hub.join({ send: (d) => { payload = d; } });
    hub.subscribe(c, 'player:1');
    hub.publish('player:1', 'queue.completed', { settlementId: 's1' });
    const env = JSON.parse(payload) as { at: string; event: string; channel: string };
    expect(env.event).toBe('queue.completed');
    expect(env.channel).toBe('player:1');
    expect(Number(env.at)).toBeGreaterThan(0);
  });

  it('stops delivering after a client leaves', () => {
    const hub = new Hub();
    const c = hub.join({ send: () => undefined });
    hub.subscribe(c, 'map:shard-1');
    hub.leave(c);
    expect(hub.publish('map:shard-1', 'map.delta', {})).toBe(0);
  });

  it('pushes an attack warning the moment a movement is dispatched', async () => {
    // Latency budget: under one second. The client never polls for this.
    const hub = app.hub;
    const seen: unknown[] = [];
    const defender = hub.join({ send: (d) => seen.push(JSON.parse(d)) });

    const enemy = app.world.store.read((tx) => tx.settlements.find((s) => s.ownerId && s.ownerId !== app.playerId))!;
    hub.subscribe(defender, `player:${app.playerId}`);

    const f = app.world.formationsOf(enemy.ownerId!)[0]!;
    app.world.dispatch({
      commandId: cmd(), playerId: enemy.ownerId!, originId: enemy.id, targetId: homeId,
      mission: 'attack', formations: [{ formationId: f.id, count: 10 }],
    });
    for (const msg of app.world.drainOutbox()) hub.publish(msg.channel, msg.event, msg.data);

    const warning = seen.find((e) => (e as { event: string }).event === 'attack.incoming') as
      | { data: { arrivesAt: string; estimatedSize: number } }
      | undefined;
    expect(warning).toBeDefined();
    expect(Number(warning!.data.estimatedSize)).toBe(10);
    expect(BigInt(warning!.data.arrivesAt)).toBeGreaterThan(T0);
  });
});

describe('wire serialization', () => {
  it('converts bigints anywhere in a structure', () => {
    expect(wire({ a: 1n, b: [2n, { c: 3n }] })).toEqual({ a: '1', b: ['2', { c: '3' }] });
  });

  it('drops undefined rather than emitting null', () => {
    expect(wire({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it('produces a stable encoding regardless of key order', () => {
    expect(stableJson({ b: 1n, a: 2 })).toBe(stableJson({ a: 2, b: 1n }));
  });
});
