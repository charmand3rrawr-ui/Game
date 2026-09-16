/**
 * social.test.ts — the text layer around the game
 *
 * Leaderboards, the inbox and the board carry no combat maths, but they carry
 * two rules that are easy to get quietly wrong: a board must be DERIVED from
 * live state rather than stored, and a private board must be private on the
 * SERVER rather than merely unrendered by the client.
 */

import { describe, it, expect } from 'vitest';
import { C } from '@ascendance/shared';
import { seedWorld } from './bootstrap.js';
import { CommandError } from './world.js';
import { BOARDS, inboxCounts, rankBoard, validateMessage, type BoardSubject } from './sim/social.js';

const T0 = 1_700_000_000_000n;
const cmd = (() => { let n = 0; return (): string => `so-${n++}`; })();
const world = () => seedWorld({ worldId: 'social', now: T0, neighbours: 6 });

const subject = (over: Partial<BoardSubject> = {}): BoardSubject => ({
  playerId: 'p1', name: 'A', empireWeightAvg: 10, cultivationGrade: 3, realm: 'Mortal Vessel',
  reputation: 5, holdings: 2, bestVeterancy: 40, veterancyTier: 'Copper',
  shardHoursPurchased30d: 0, envyScopes: [], ...over,
});

describe('leaderboards', () => {
  it('offers a board for each thing the game actually measures', () => {
    expect(BOARDS.map((b) => b.key)).toEqual([
      'empire_weight', 'cultivation', 'reputation', 'holdings', 'veterancy', 'shard_spend',
    ]);
    // Every board explains what its number means; a ranking nobody understands
    // is a ranking players invent explanations for.
    for (const b of BOARDS) {
      expect(b.what.length).toBeGreaterThan(20);
      expect(b.note.length).toBeGreaterThan(20);
    }
  });

  it('is derived from live state, so it moves when the state moves', () => {
    const w = world();
    const before = w.world.leaderboard(w.playerId, 'holdings');
    const mine = before.find((r) => r.isYou)!;
    expect(mine.value).toBe(1);

    // Take a neighbour's holding; the board must already know.
    w.world.store.transaction((tx) => {
      const other = tx.settlements.all().find((s) => s.ownerId && s.ownerId !== w.playerId)!;
      tx.settlements.put({ ...other, ownerId: w.playerId });
    });
    expect(w.world.leaderboard(w.playerId, 'holdings').find((r) => r.isYou)!.value).toBe(2);
  });

  it('ranks highest first and marks the reading player', () => {
    const rows = rankBoard('reputation', [
      subject({ playerId: 'a', name: 'Low', reputation: 1 }),
      subject({ playerId: 'b', name: 'High', reputation: 99 }),
    ], 'a');
    expect(rows[0]!.name).toBe('High');
    expect(rows[0]!.rank).toBe(1);
    expect(rows.find((r) => r.playerId === 'a')!.isYou).toBe(true);
  });

  it('breaks ties by name so the board does not reshuffle on every refresh', () => {
    const rows = rankBoard('reputation', [
      subject({ playerId: 'b', name: 'Zara', reputation: 5 }),
      subject({ playerId: 'a', name: 'Aldric', reputation: 5 }),
    ], 'x');
    expect(rows.map((r) => r.name)).toEqual(['Aldric', 'Zara']);
  });

  it('leaves off players with nothing to show, but never the reader', () => {
    const rows = rankBoard('shard_spend', [
      subject({ playerId: 'a', name: 'Spender', shardHoursPurchased30d: 40 }),
      subject({ playerId: 'b', name: 'Nobody', shardHoursPurchased30d: 0 }),
      subject({ playerId: 'me', name: 'Me', shardHoursPurchased30d: 0 }),
    ], 'me');
    expect(rows.map((r) => r.name)).toEqual(['Spender', 'Me']);
  });

  it('publishes shard spend, because it is never private', () => {
    // spec/04 §11: 30-day purchased shard-hours are PUBLIC on the profile, and
    // Heaven's Envy marks the top of that list. Buying advantage is allowed;
    // hiding it is what is not.
    const w = world();
    w.world.store.transaction((tx) => {
      const other = tx.players.all().find((p) => p.id !== w.playerId)!;
      tx.players.put({ ...other, shardHoursPurchased30d: 500, envyScopes: ['universe'] });
    });
    const rows = w.world.leaderboard(w.playerId, 'shard_spend');
    expect(rows[0]!.value).toBe(500);
    expect(rows[0]!.envyScopes).toContain('universe');
    expect(rows[0]!.detail).toMatch(/marked/);
    expect(BOARDS.find((b) => b.key === 'shard_spend')!.higherIsBetter).toBe(false);
  });
});

describe('the inbox', () => {
  it('starts with the world already talking to you', () => {
    // An empty inbox on first login teaches a new player that nobody is there.
    const w = world();
    const box = w.world.inbox(w.playerId);
    expect(box.length).toBeGreaterThan(0);
    expect(inboxCounts(box).unread).toBe(box.length);
  });

  it('delivers a message and marks it read only for the recipient', () => {
    const w = world();
    const other = w.world.knownPlayers(w.playerId)[0]!;
    const m = w.world.sendMessage({
      commandId: cmd(), fromId: w.playerId, toId: other.id,
      subject: 'Terms', body: 'The bend is yours if the crossing is mine.',
    });
    expect(w.world.inbox(w.playerId, 'out').some((x) => x.id === m.id)).toBe(true);

    // The sender opening their own sent message does not mark it read.
    const still = w.world.readMessage(cmd(), w.playerId, m.id);
    expect(still.readAt).toBeUndefined();

    const read = w.world.readMessage(cmd(), other.id, m.id);
    expect(read.readAt).toBe(T0);
  });

  it('pushes to the recipient rather than waiting for a refresh', () => {
    const w = world();
    w.world.drainOutbox();
    const other = w.world.knownPlayers(w.playerId)[0]!;
    w.world.sendMessage({ commandId: cmd(), fromId: w.playerId, toId: other.id, subject: 'Hi', body: 'Hello.' });
    const pushed = w.world.drainOutbox().find((x) => x.event === 'message.received');
    expect(pushed?.channel).toBe(`player:${other.id}`);
  });

  it('refuses a message to nobody, an empty one, and one to yourself', () => {
    const w = world();
    expect(() => w.world.sendMessage({
      commandId: cmd(), fromId: w.playerId, toId: w.playerId, subject: 'x', body: 'y',
    })).toThrow(CommandError);

    const other = w.world.knownPlayers(w.playerId)[0]!;
    expect(() => w.world.sendMessage({
      commandId: cmd(), fromId: w.playerId, toId: other.id, subject: '', body: 'y',
    })).toThrow(/subject/);
    expect(() => w.world.sendMessage({
      commandId: cmd(), fromId: w.playerId, toId: other.id, subject: 'x', body: '   ',
    })).toThrow(/body/);
  });

  it('caps volume without capping conversation', () => {
    // The limit is on mass-mailing. It must sit far past anything a real
    // negotiation would produce.
    expect(C.MESSAGE_WINDOW_LIMIT).toBeGreaterThanOrEqual(20);
    const under = validateMessage({
      fromId: 'a', toId: 'b', subject: 's', body: 'b', sentInWindow: 5, windowLimit: 30,
    });
    expect(under.ok).toBe(true);
    const over = validateMessage({
      fromId: 'a', toId: 'b', subject: 's', body: 'b', sentInWindow: 30, windowLimit: 30,
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toMatch(/not conversation/);
  });

  it('archives out of the inbox without deleting anything', () => {
    const w = world();
    const first = w.world.inbox(w.playerId)[0]!;
    w.world.archiveMessage(cmd(), w.playerId, first.id);
    expect(w.world.inbox(w.playerId).some((m) => m.id === first.id)).toBe(false);
    expect(w.world.inbox(w.playerId, 'archive').some((m) => m.id === first.id)).toBe(true);
  });

  it('refuses to let a stranger archive your mail', () => {
    const w = world();
    const other = w.world.knownPlayers(w.playerId)[0]!;
    const mine = w.world.inbox(w.playerId)[0]!;
    expect(() => w.world.archiveMessage(cmd(), other.id, mine.id)).toThrow(/not yours/);
  });
});

describe('the forum', () => {
  it('opens with the world mid-conversation', () => {
    const w = world();
    const threads = w.world.threads(w.playerId, 'world');
    expect(threads.length).toBeGreaterThan(0);
    // Sorted by life, not by birth.
    for (let i = 1; i < threads.length; i++) {
      expect(threads[i - 1]!.lastPostAt >= threads[i]!.lastPostAt).toBe(true);
    }
  });

  it('reads a thread with its posts oldest first', () => {
    const w = world();
    const t = w.world.threads(w.playerId, 'world')[0]!;
    const { posts } = w.world.thread(w.playerId, t.id);
    expect(posts.length).toBeGreaterThan(1);
    for (let i = 1; i < posts.length; i++) {
      expect(posts[i - 1]!.postedAt <= posts[i]!.postedAt).toBe(true);
    }
    expect(posts[0]!.authorName).toBeTruthy();
  });

  it('opens a thread and bumps it on reply', () => {
    const w = world();
    const t = w.world.openThread({
      commandId: cmd(), playerId: w.playerId, scope: 'world',
      title: 'Anyone else seeing convoys on the north road?',
      body: 'Three in a day, all heading the same way. I am not the only one, surely.',
    });
    expect(t.postCount).toBe(1);

    const other = w.world.knownPlayers(w.playerId)[0]!;
    w.world.reply(cmd(), other.id, t.id, 'Two here as well. Somebody is stockpiling.');
    const after = w.world.threads(w.playerId, 'world')[0]!;
    expect(after.id).toBe(t.id);
    expect(after.postCount).toBe(2);
  });

  it('refuses an empty thread or an empty reply', () => {
    const w = world();
    expect(() => w.world.openThread({
      commandId: cmd(), playerId: w.playerId, scope: 'world', title: 'x', body: 'hello',
    })).toThrow(/title/);
    const t = w.world.threads(w.playerId, 'world')[0]!;
    expect(() => w.world.reply(cmd(), w.playerId, t.id, '  ')).toThrow(CommandError);
  });

  it('keeps an alliance board private on the server, not just in the UI', () => {
    const w = world();
    w.world.createAlliance(cmd(), w.playerId, 'The Verrin Compact', 'VRN');
    const t = w.world.openThread({
      commandId: cmd(), playerId: w.playerId, scope: 'alliance',
      title: 'Operation timing', body: 'Waves land 04:00 server. Do not be early.',
    });

    // A non-member is refused the read outright — they cannot simply call the
    // endpoint the client does not show them.
    const outsider = w.world.knownPlayers(w.playerId)[0]!;
    expect(w.world.threads(outsider.id, 'alliance')).toHaveLength(0);
    expect(() => w.world.thread(outsider.id, t.id)).toThrow(/not yours/);
    expect(() => w.world.reply(cmd(), outsider.id, t.id, 'noted')).toThrow(/not yours/);

    // The member sees it.
    expect(w.world.threads(w.playerId, 'alliance').map((x) => x.id)).toContain(t.id);
  });

  it('refuses an alliance thread from someone with no alliance', () => {
    const w = world();
    expect(() => w.world.openThread({
      commandId: cmd(), playerId: w.playerId, scope: 'alliance', title: 'Plans', body: 'Later.',
    })).toThrow(/not in an alliance/);
  });
});
