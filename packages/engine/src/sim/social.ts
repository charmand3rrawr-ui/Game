/**
 * sim/social.ts — leaderboards, the inbox, and the board
 *
 * The text layer around the game. None of it resolves combat or moves a
 * resource, but all of it is why a persistent world has players in it a year
 * later: a ranking worth climbing, an inbox where a war gets negotiated before
 * it is declared, and a board where the server argues about it.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE
 *
 *   1. A LEADERBOARD IS DERIVED, NEVER STORED. Every ranking here is computed
 *      from the same state the game runs on, so it cannot drift from the
 *      truth and cannot be written to directly. A stored rank is a rank that
 *      eventually disagrees with the thing it ranks.
 *
 *   2. SPEND IS PUBLIC. `spec/04 §11` makes 30-day purchased shard-hours
 *      public on the profile, and Heaven's Envy marks the top of that list
 *      daily. So it is a board like any other — visible by default, not
 *      something a player opts into showing. That is the whole integrity
 *      mechanic: buying advantage is allowed, and it is never private.
 */

import { C, type Millis, type Uuid } from '@ascendance/shared';

// ============================================================================
// Leaderboards
// ============================================================================

/** Every board the world keeps, each derived from live state. */
export type BoardKey =
  | 'empire_weight' | 'cultivation' | 'reputation' | 'holdings' | 'veterancy' | 'shard_spend';

export interface BoardRow {
  rank: number;
  playerId: Uuid;
  name: string;
  allianceTag?: string;
  /** The ranked quantity, already formatted by the caller's rules. */
  value: number;
  /** A second line the board shows beside the value. */
  detail: string;
  /** True for the requesting player, so a client can pin their own row. */
  isYou: boolean;
  /** Heaven's Envy scopes currently marked. Public and uncleansable. */
  envyScopes: string[];
}

export interface BoardMeta {
  key: BoardKey;
  title: string;
  /** What the number means, in a sentence. Shown above the board. */
  what: string;
  /** Why it is worth caring about, or what it costs. */
  note: string;
  /** Larger is better on most boards; `shard_spend` is deliberately neutral. */
  higherIsBetter: boolean;
}

export const BOARDS: readonly BoardMeta[] = Object.freeze([
  {
    key: 'empire_weight',
    title: 'Empire weight',
    what: 'A 30-day rolling average of the administrative cost of everything you hold.',
    note:
      `It is the great equaliser: weight raises the XP your armies need, up to ${C.EW_CAP.toLocaleString()}x ` +
      'at the top. A rolling average is why shedding territory before a war costs you a month, not an afternoon.',
    higherIsBetter: true,
  },
  {
    key: 'cultivation',
    title: 'Realm',
    what: 'The Sovereign’s own cultivation grade, 1 to 42.',
    note:
      'The only progression Chrono Shards cannot touch. Shards are barred from breakthroughs outright, and the ' +
      'Temporal Debt from spending them elsewhere makes every trial harder.',
    higherIsBetter: true,
  },
  {
    key: 'reputation',
    title: 'Reputation',
    what: 'What the world thinks of your word, earned and spent through treaties.',
    note:
      'Reputation never blocks an action. Betrayal is always allowed and always priced — this board is the price.',
    higherIsBetter: true,
  },
  {
    key: 'holdings',
    title: 'Holdings',
    what: 'How many settlements you hold.',
    note:
      'There is no cap and no administrative overload penalty. The only limit on going wide is your own ' +
      'attention, which is what governors buy back at double time.',
    higherIsBetter: true,
  },
  {
    key: 'veterancy',
    title: 'Veterancy',
    what: 'The level of your most experienced formation.',
    note:
      'Formations are what players name and grow attached to. Reinforcing one dilutes its veterancy by ' +
      'headcount, so a famous formation is one that was never rebuilt cheaply.',
    higherIsBetter: true,
  },
  {
    key: 'shard_spend',
    title: 'Chrono Shards purchased',
    what: 'Shard-hours bought in the last 30 days. Public on every profile.',
    note:
      'Not a wall of shame and not a ranking to win — simply not private. The top of this board is marked by ' +
      'Heaven’s Envy daily, and a marked player can be attacked with no reputation penalty until it lapses.',
    higherIsBetter: false,
  },
]);

/** What a board needs about one player. Assembled by the caller from state. */
export interface BoardSubject {
  playerId: Uuid;
  name: string;
  allianceTag?: string;
  empireWeightAvg: number;
  cultivationGrade: number;
  realm: string;
  reputation: number;
  holdings: number;
  bestVeterancy: number;
  veterancyTier: string;
  shardHoursPurchased30d: number;
  envyScopes: string[];
}

/**
 * Rank the world on one board.
 *
 * Ties keep a stable order by name rather than by id, because a leaderboard
 * that reshuffles equal players on every refresh looks broken even when it is
 * not. Players with nothing to show on a board are left off it entirely: a
 * ranking padded with zeroes tells you less, not more.
 */
export function rankBoard(key: BoardKey, subjects: readonly BoardSubject[], me: Uuid, limit = 50): BoardRow[] {
  const pick = (s: BoardSubject): { value: number; detail: string } => {
    switch (key) {
      case 'empire_weight':
        return { value: s.empireWeightAvg, detail: `${s.holdings} holding${s.holdings === 1 ? '' : 's'}` };
      case 'cultivation':
        return { value: s.cultivationGrade, detail: s.realm };
      case 'reputation':
        return { value: s.reputation, detail: s.allianceTag ? `[${s.allianceTag}]` : 'unaligned' };
      case 'holdings':
        return { value: s.holdings, detail: `weight ${Math.round(s.empireWeightAvg)}` };
      case 'veterancy':
        return { value: s.bestVeterancy, detail: s.veterancyTier };
      case 'shard_spend':
        return {
          value: s.shardHoursPurchased30d,
          detail: s.envyScopes.length > 0 ? `marked: ${s.envyScopes.join(', ')}` : 'unmarked',
        };
    }
  };

  return subjects
    .map((s) => ({ s, ...pick(s) }))
    .filter((r) => r.value > 0 || r.s.playerId === me)
    .sort((a, b) => (b.value - a.value) || a.s.name.localeCompare(b.s.name))
    .slice(0, limit)
    .map((r, i) => ({
      rank: i + 1,
      playerId: r.s.playerId,
      name: r.s.name,
      allianceTag: r.s.allianceTag,
      value: r.value,
      detail: r.detail,
      isYou: r.s.playerId === me,
      envyScopes: r.s.envyScopes,
    }));
}

// ============================================================================
// Messages
// ============================================================================

export const MESSAGE_SUBJECT_MAX = 120;
export const MESSAGE_BODY_MAX = 8_000;
export const POST_BODY_MAX = 8_000;
export const THREAD_TITLE_MAX = 140;

export interface Refusal { ok: false; reason: string }
export type Check = { ok: true } | Refusal;

/**
 * Whether one player may write to another.
 *
 * Deliberately permissive about WHO — diplomacy with an enemy is the whole
 * point, so being at war with someone is not a reason to be unable to reach
 * them. The limits are on shape and volume, which is where abuse actually
 * lives.
 */
export function validateMessage(args: {
  fromId: Uuid; toId: Uuid; subject: string; body: string;
  /** Messages this sender has already sent in the current window. */
  sentInWindow: number;
  windowLimit: number;
}): Check {
  if (args.toId === args.fromId) return { ok: false, reason: 'you cannot write to yourself' };
  const subject = args.subject.trim();
  const body = args.body.trim();
  if (subject.length === 0) return { ok: false, reason: 'a message needs a subject' };
  if (subject.length > MESSAGE_SUBJECT_MAX) {
    return { ok: false, reason: `a subject is at most ${MESSAGE_SUBJECT_MAX} characters` };
  }
  if (body.length === 0) return { ok: false, reason: 'a message needs a body' };
  if (body.length > MESSAGE_BODY_MAX) {
    return { ok: false, reason: `a message is at most ${MESSAGE_BODY_MAX} characters` };
  }
  if (args.sentInWindow >= args.windowLimit) {
    return {
      ok: false,
      reason: `you have sent ${args.sentInWindow} messages recently; the limit is ${args.windowLimit}. ` +
        'This exists to stop mass-mailing, not conversation.',
    };
  }
  return { ok: true };
}

/** An inbox summary, for the unread badge and the list header. */
export function inboxCounts(messages: readonly { readAt?: Millis; archivedAt?: Millis }[]): {
  unread: number; total: number;
} {
  let unread = 0;
  let total = 0;
  for (const m of messages) {
    if (m.archivedAt !== undefined) continue;
    total++;
    if (m.readAt === undefined) unread++;
  }
  return { unread, total };
}

// ============================================================================
// Forum
// ============================================================================

export function validateThread(args: { title: string; body: string }): Check {
  const title = args.title.trim();
  if (title.length < 3) return { ok: false, reason: 'a thread needs a title' };
  if (title.length > THREAD_TITLE_MAX) {
    return { ok: false, reason: `a title is at most ${THREAD_TITLE_MAX} characters` };
  }
  if (args.body.trim().length === 0) return { ok: false, reason: 'a thread needs an opening post' };
  if (args.body.length > POST_BODY_MAX) return { ok: false, reason: `a post is at most ${POST_BODY_MAX} characters` };
  return { ok: true };
}

export function validatePost(args: { body: string; locked: boolean }): Check {
  if (args.locked) return { ok: false, reason: 'that thread is locked; its history stays readable' };
  const body = args.body.trim();
  if (body.length === 0) return { ok: false, reason: 'a post needs something in it' };
  if (body.length > POST_BODY_MAX) return { ok: false, reason: `a post is at most ${POST_BODY_MAX} characters` };
  return { ok: true };
}

/**
 * Whether a player can see a board.
 *
 * The world board is open to everyone on the shard. An alliance board is
 * private to its members — and the check is HERE, on the server, rather than
 * in a client that simply does not render the tab.
 */
export function canReadBoard(scope: 'world' | 'alliance', viewerAlliance: Uuid | undefined, boardAlliance: Uuid | undefined): boolean {
  if (scope === 'world') return true;
  return viewerAlliance !== undefined && viewerAlliance === boardAlliance;
}
