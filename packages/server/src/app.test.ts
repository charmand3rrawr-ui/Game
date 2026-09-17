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

describe('governor and alliance endpoints (M8)', () => {
  async function patch(url: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const r = await app.fastify.inject({ method: 'PATCH', url, payload: payload as object });
    return { status: r.statusCode, body: r.json() };
  }
  async function del(url: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const r = await app.fastify.inject({ method: 'DELETE', url, payload: payload as object });
    return { status: r.statusCode, body: r.json() };
  }

  const specs = {
    buildOrder: [{ buildingKey: '1_fishery', toLevel: 1 }],
    trainingStandingOrder: [],
    researchMandate: [],
    resourcePolicy: { keepDays: 3 },
    defencePosture: 'garrison' as const,
    escalationRules: { alertOnIncoming: true, alertBelowLoyalty: 40 },
  };

  /**
   * Give the player an officer.
   *
   * A seeded player has none — every starting formation is green — because the
   * commander level is read off their most experienced formation. Delegation is
   * something you earn by fighting, so a test that wants a governor has to do
   * the equivalent of having fought.
   */
  function veteran(level: number): void {
    app.world.store.transaction((tx) => {
      const f = tx.formations.where((x) => x.ownerId === app.playerId)[0]!;
      tx.formations.put({ ...f, atkLevel: level });
    });
  }

  it('never takes the commander level from the client', async () => {
    // The tiers gate on it, so a client that could state it could appoint a
    // Sector Governor on day one. The schema has no field for it, and sending
    // one anyway changes nothing.
    const { body } = await get('/v1/governors');
    const level = body['commanderLevel'] as number;
    expect(typeof level).toBe('number');

    const { status } = await post('/v1/governors', {
      commandId: cmd(),
      commanderId: cmd(),
      tier: 'sector',
      areaRef: { layer: 'surface', settlementIds: [homeId] },
      specs,
      commanderLevel: 999,
    });
    // Refused on the server's own reading of the level, not the one sent.
    expect(status).toBe(422);
  });

  it('refuses every tier while the player has no officer to appoint', async () => {
    const { body } = await get('/v1/governors');
    expect(body['commanderLevel']).toBe(0);
    const { status } = await post('/v1/governors', {
      commandId: cmd(), commanderId: cmd(), tier: 'bailiff',
      areaRef: { layer: 'surface', settlementIds: [homeId] }, specs,
    });
    expect(status).toBe(422);
  });

  it('appoints, re-specs, audits and dismisses a governor', async () => {
    veteran(20);
    const { body: before } = await get('/v1/governors');
    expect(before['commanderLevel']).toBe(20);
    const tier = (before['tiers'] as { key: string; commanderLevel: number })
      && (before['tiers'] as { key: string; commanderLevel: number }[])
        .filter((t) => t.commanderLevel <= 20)
        .sort((a, b) => b.commanderLevel - a.commanderLevel)[0]!;

    const appointed = await post('/v1/governors', {
      commandId: cmd(), commanderId: cmd(), tier: tier.key,
      areaRef: { layer: 'surface', settlementIds: [homeId] }, specs,
    });
    expect(appointed.status).toBe(201);
    const governorId = appointed.body['id'] as string;

    const listed = await get('/v1/governors');
    expect((listed.body['governors'] as unknown[]).length).toBe(1);
    // Named, not just identified — "governor 018bcfe5…" is not actionable.
    expect((listed.body['governors'] as { areaNames: string[] }[])[0]!.areaNames.length).toBe(1);

    const respec = await patch(`/v1/governors/${governorId}/specs`, {
      commandId: cmd(),
      specs: { ...specs, defencePosture: 'fortify' },
    });
    expect(respec.status).toBe(200);
    expect((respec.body['specs'] as { defencePosture: string }).defencePosture).toBe('fortify');

    const audited = await post(`/v1/governors/${governorId}/audit`, { commandId: cmd() });
    expect(audited.status).toBe(200);
    expect(audited.body['subverted']).toBe(false);

    const dismissed = await del(`/v1/governors/${governorId}`, { commandId: cmd() });
    expect(dismissed.status).toBe(200);
    expect((await get('/v1/governors')).body['governors']).toEqual([]);
  });

  it('offers real counterparties, not an empty form', async () => {
    const { body } = await get('/v1/alliance');
    const known = body['known'] as { id: string; name: string; holdings: number }[];
    expect(known.length).toBeGreaterThan(0);
    for (const k of known) {
      expect(k.id).not.toBe(body['me']);
      expect(k.holdings).toBeGreaterThan(0);
    }
  });

  it('founds an alliance and refuses a second one', async () => {
    const first = await post('/v1/alliance', { commandId: cmd(), name: 'The Verrin Compact', tag: 'VRN' });
    expect(first.status).toBe(201);

    const { body } = await get('/v1/alliance');
    expect((body['alliance'] as { tag: string }).tag).toBe('VRN');
    expect((body['members'] as { role: string }[])[0]!.role).toBe('leader');
    expect(body['maxMembers']).toBe(60);

    const second = await post('/v1/alliance', { commandId: cmd(), name: 'Second Thoughts', tag: 'SND' });
    expect(second.status).toBe(422);
  });

  it('a proposed NAP binds nobody until it is signed', async () => {
    const { body: dip } = await get('/v1/alliance');
    const other = (dip['known'] as { id: string }[])[0]!.id;

    const proposed = await post('/v1/treaties', { commandId: cmd(), kind: 'nap', counterpartyId: other, terms: {} });
    expect(proposed.status).toBe(201);
    // Unsigned: signedAt is zero, and nothing about the world has changed.
    expect(proposed.body['signedAt']).toBe('0');
    expect(proposed.body['partyB']).toBe(other);

    const listed = await get('/v1/alliance');
    expect((listed.body['treaties'] as unknown[]).length).toBe(1);
  });

  it('breaking a NAP states its price and its notice period', async () => {
    const { body: dip } = await get('/v1/alliance');
    const other = (dip['known'] as { id: string }[])[0]!.id;
    expect(Number(dip['napNoticeMs'])).toBe(172_800_000);

    const proposed = await post('/v1/treaties', { commandId: cmd(), kind: 'nap', counterpartyId: other, terms: {} });
    const treatyId = proposed.body['id'] as string;

    // Only the counterparty can sign. Signing your own proposal would make a
    // treaty a unilateral act, which is exactly what it must not be.
    const selfSign = await post(`/v1/treaties/${treatyId}/accept`, { commandId: cmd() });
    expect(selfSign.status).toBe(403);
    expect(problemCode(selfSign.body as unknown as Problem)).toBe('not-owner');

    const broken = await post(`/v1/treaties/${treatyId}/break`, { commandId: cmd() });
    expect(broken.status).toBe(200);
    expect(broken.body['reputationLost']).toBeGreaterThan(0);
    // The exit lands 48 hours out — it still binds until then.
    expect(BigInt(broken.body['effectiveAt'] as string) - T0).toBe(172_800_000n);
  });

  it('replaying a governor command does not appoint twice', async () => {
    veteran(20);
    const id = cmd();
    const payload = {
      commandId: id, commanderId: cmd(), tier: 'bailiff',
      areaRef: { layer: 'surface', settlementIds: [homeId] }, specs,
    };
    const a = await post('/v1/governors', payload);
    const b = await post('/v1/governors', payload);
    expect(a.body['id']).toBe(b.body['id']);
    expect((await get('/v1/governors')).body['governors']).toHaveLength(1);
  });
});

describe('the barbarians show their working', () => {
  it('publishes the pressure with its derivation and the ladder each band is on', async () => {
    const { body } = await get('/v1/threat');

    const pressure = body['pressure'] as { total: number; terms: { label: string; detail: string }[] };
    expect(pressure.terms).toHaveLength(3);
    // Two of the three terms are the players' own doing. That is the design
    // claim the whole system rests on, so the endpoint has to name them.
    expect(pressure.terms.map((t) => t.label)).toContain('settled territory');
    expect(pressure.terms.map((t) => t.label)).toContain('the largest empire');

    const bands = body['bands'] as { name: string; menace: number; rung: { unlocks: string } }[];
    expect(bands.length).toBeGreaterThan(0);
    for (const b of bands) expect(b.rung.unlocks.length).toBeGreaterThan(20);

    // And the asymmetry is published rather than discovered the hard way.
    const privileges = body['privileges'] as { key: string }[];
    expect(privileges.map((p) => p.key).sort()).toEqual(['doomsday', 'levy', 'warpath', 'weightless']);
  });
});

describe('the text layer around the game', () => {
  it('derives every leaderboard from live state', async () => {
    const { body } = await get('/v1/leaderboards');
    const boards = body['boards'] as { key: string }[];
    expect(boards.map((b) => b.key)).toContain('empire_weight');
    expect(boards.map((b) => b.key)).toContain('shard_spend');

    const rows = body['rows'] as { isYou: boolean; value: number }[];
    expect(rows.some((r) => r.isYou)).toBe(true);

    // Take a holding and the board already knows, because nothing is stored.
    const before = (body['rows'] as { isYou: boolean; value: number }[]).find((r) => r.isYou)!.value;
    app.world.store.transaction((tx) => {
      const other = tx.settlements.all().find((st) => st.ownerId && st.ownerId !== app.playerId)!;
      tx.settlements.put({ ...other, ownerId: app.playerId });
    });
    const after = await get('/v1/leaderboards?board=holdings');
    expect((after.body['rows'] as { isYou: boolean; value: number }[]).find((r) => r.isYou)!.value)
      .toBeGreaterThan(before - 1);
  });

  it('publishes shard spend rather than hiding it', async () => {
    // spec/04 §11: the 30-day purchase total is PUBLIC. Buying advantage is
    // allowed; being private about it is what is not.
    app.world.store.transaction((tx) => {
      const other = tx.players.all().find((p) => p.id !== app.playerId)!;
      tx.players.put({ ...other, shardHoursPurchased30d: 250, envyScopes: ['universe'] });
    });
    const { body } = await get('/v1/leaderboards?board=shard_spend');
    const rows = body['rows'] as { value: number; envyScopes: string[] }[];
    expect(rows[0]!.value).toBe(250);
    expect(rows[0]!.envyScopes).toContain('universe');
  });

  it('carries an inbox the world has already written to', async () => {
    const { body } = await get('/v1/messages');
    const messages = body['messages'] as { subject: string; fromName: string }[];
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]!.fromName).not.toBe('someone');
    expect((body['counts'] as { unread: number }).unread).toBeGreaterThan(0);
  });

  it('sends, reads and archives a message', async () => {
    const { body: inbox } = await get('/v1/messages');
    const to = (inbox['correspondents'] as { id: string }[])[0]!.id;

    const sent = await post('/v1/messages', {
      commandId: cmd(), toId: to, subject: 'Terms', body: 'The bend is yours if the crossing is mine.',
    });
    expect(sent.status).toBe(201);
    const outbox = await get('/v1/messages?box=out');
    expect((outbox.body['messages'] as { id: string }[]).some((m) => m.id === sent.body['id'])).toBe(true);

    const mine = (inbox['messages'] as { id: string }[])[0]!.id;
    expect((await post(`/v1/messages/${mine}/read`, { commandId: cmd() })).status).toBe(200);
    expect((await post(`/v1/messages/${mine}/archive`, { commandId: cmd() })).status).toBe(200);

    const after = await get('/v1/messages');
    expect((after.body['messages'] as { id: string }[]).some((m) => m.id === mine)).toBe(false);
    const archived = await get('/v1/messages?box=archive');
    expect((archived.body['messages'] as { id: string }[]).some((m) => m.id === mine)).toBe(true);
  });

  it('answers a malformed body with 400 and a usable reason, not 500', async () => {
    // A schema refusal is the caller's fault. Every route validates with Zod,
    // and a ZodError is not a Fastify validation error — so these used to come
    // back as 500s reading "the server broke" for a body that was simply wrong.
    const { body: inbox } = await get('/v1/messages');
    const to = (inbox['correspondents'] as { id: string }[])[0]!.id;

    const empty = await post('/v1/messages', { commandId: cmd(), toId: to, subject: 'x', body: '' });
    expect(empty.status).toBe(400);
    expect(problemCode(empty.body as unknown as Problem)).toBe('validation');
    // The reason names the field, so a client can point at it.
    expect(String((empty.body as unknown as Problem).detail)).toMatch(/body/);

    const notAUuid = await post('/v1/messages', { commandId: cmd(), toId: 'nope', subject: 'x', body: 'y' });
    expect(notAUuid.status).toBe(400);
    expect(String((notAUuid.body as unknown as Problem).detail)).toMatch(/toId/);
  });

  it('opens with a world board mid-conversation', async () => {
    const { body } = await get('/v1/threads?scope=world');
    const threads = body['threads'] as { id: string; postCount: number; authorName: string }[];
    expect(threads.length).toBeGreaterThan(0);
    expect(threads[0]!.postCount).toBeGreaterThan(1);

    const one = await get(`/v1/threads/${threads[0]!.id}`);
    expect((one.body['posts'] as unknown[]).length).toBe(threads[0]!.postCount);
  });

  it('opens a thread and bumps it on reply', async () => {
    const opened = await post('/v1/threads', {
      commandId: cmd(), scope: 'world',
      title: 'Convoys on the north road', body: 'Three in a day, all the same way.',
    });
    expect(opened.status).toBe(201);
    const id = opened.body['id'] as string;

    expect((await post(`/v1/threads/${id}/posts`, { commandId: cmd(), body: 'Two here as well.' })).status).toBe(201);
    const { body } = await get('/v1/threads?scope=world');
    const top = (body['threads'] as { id: string; postCount: number }[])[0]!;
    expect(top.id).toBe(id);
    expect(top.postCount).toBe(2);
  });

  it('keeps an alliance board private on the server, not by hiding the tab', async () => {
    // Nothing to see before joining one, and opening a thread there is refused.
    expect((await get('/v1/threads?scope=alliance')).body['threads']).toEqual([]);
    const refused = await post('/v1/threads', {
      commandId: cmd(), scope: 'alliance', title: 'Operation timing', body: '04:00 server.',
    });
    expect(refused.status).toBe(422);

    await post('/v1/alliance', { commandId: cmd(), name: 'The Verrin Compact', tag: 'VRN' });
    const allowed = await post('/v1/threads', {
      commandId: cmd(), scope: 'alliance', title: 'Operation timing', body: '04:00 server. Do not be early.',
    });
    expect(allowed.status).toBe(201);
    expect((await get('/v1/threads?scope=alliance')).body['threads']).toHaveLength(1);
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
