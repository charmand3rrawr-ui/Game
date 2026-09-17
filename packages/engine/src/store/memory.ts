/**
 * store/memory.ts — the in-memory Store
 *
 * Runs the entire game with no infrastructure: in tests, in CI, in a single
 * server process, and in a browser tab. See DECISIONS.md D4.
 *
 * TRANSACTIONS are implemented by snapshot-and-rollback. That is not how
 * Postgres does it, but it gives callers the property they depend on — a
 * handler either completes or leaves no trace — so handler code written against
 * this store is correct against the real one.
 */

import type {
  Alliance, AllianceMember, Battle, Building, Dynasty, Formation, Governor,
  LoggedEvent, Message, Movement, NpcBand, Player, Post, Proficiency, QueueItem, ResearchLevel, ScheduledEvent,
  Settlement, Stockpile, Thread, Treaty, Tribulation, Uuid, Millis,
} from '@ascendance/shared';
import type { Store, Tx, Repo, KeyedRepo } from './types.js';

/** Composite-key separator. A unit separator cannot occur in a UUID or a key. */
const SEP = String.fromCharCode(31);

/**
 * One reversal: put `key` in `rows` back to `prior`, or delete it if there was
 * nothing there before. `undefined` prior means the row did not exist.
 */
interface Undo {
  rows: Map<string, unknown>;
  key: string;
  prior: unknown;
  existed: boolean;
}

/**
 * The open transaction's undo journal, or null outside a transaction.
 *
 * Writes append to it; a rollback replays it backwards. It is module-level
 * rather than threaded through every repo because the repos are rebuilt per
 * transaction and there is exactly one store writing at a time — this is an
 * in-memory, single-threaded store by construction (DECISIONS.md D4).
 */
let journal: Undo[] | null = null;

/** Record the current value of `key` before it is overwritten or removed. */
function remember(rows: Map<string, unknown>, key: string): void {
  if (!journal) return;
  const existed = rows.has(key);
  journal.push({ rows, key, prior: existed ? rows.get(key) : undefined, existed });
}

/**
 * `where` and `find` scan the map DIRECTLY rather than via `all()`.
 *
 * `all()` materialises the whole table into a fresh array. Routing the two
 * filtering reads through it meant every one of them allocated a full copy of
 * the table before looking at a single row — and `find` then threw that copy
 * away after reading, on average, half of it. These are the hottest reads in
 * the engine (`viewIn` alone does three per call, and it is called on every
 * command), so the copy was the dominant cost of reading anything.
 *
 * Iterating `rows.values()` allocates only the result, and `find` stops at the
 * first match instead of scanning to the end. Same results, same order — Map
 * preserves insertion order and so did the array — so nothing observable moves.
 */
class MapRepo<T extends { id: string }> implements Repo<T> {
  constructor(private readonly rows: Map<string, T>, private readonly label: string) {}
  get(id: string): T | undefined { return this.rows.get(id); }
  require(id: string): T {
    const r = this.rows.get(id);
    if (!r) throw new NotFound(`${this.label} ${id} does not exist`);
    return r;
  }
  put(row: T): void {
    remember(this.rows as Map<string, unknown>, row.id);
    this.rows.set(row.id, row);
  }
  delete(id: string): boolean {
    remember(this.rows as Map<string, unknown>, id);
    return this.rows.delete(id);
  }
  all(): T[] { return [...this.rows.values()]; }
  where(pred: (row: T) => boolean): T[] {
    const out: T[] = [];
    for (const row of this.rows.values()) if (pred(row)) out.push(row);
    return out;
  }
  find(pred: (row: T) => boolean): T | undefined {
    for (const row of this.rows.values()) if (pred(row)) return row;
    return undefined;
  }
  count(): number { return this.rows.size; }
}

class CompositeRepo<T> implements KeyedRepo<T> {
  constructor(private readonly rows: Map<string, T>, private readonly keyOf: (row: T) => string[]) {}
  private k(parts: string[]): string { return parts.join(SEP); }
  get(...key: string[]): T | undefined { return this.rows.get(this.k(key)); }
  put(row: T): void {
    const k = this.k(this.keyOf(row));
    remember(this.rows as Map<string, unknown>, k);
    this.rows.set(k, row);
  }
  delete(...key: string[]): boolean {
    const k = this.k(key);
    remember(this.rows as Map<string, unknown>, k);
    return this.rows.delete(k);
  }
  all(): T[] { return [...this.rows.values()]; }
  where(pred: (row: T) => boolean): T[] {
    const out: T[] = [];
    for (const row of this.rows.values()) if (pred(row)) out.push(row);
    return out;
  }
}

export class NotFound extends Error {
  override name = 'NotFound';
}

interface Tables {
  players: Map<string, Player>;
  dynasties: Map<string, Dynasty>;
  proficiencies: Map<string, Proficiency>;
  research: Map<string, ResearchLevel>;
  settlements: Map<string, Settlement>;
  buildings: Map<string, Building>;
  stockpiles: Map<string, Stockpile>;
  queue: Map<string, QueueItem>;
  formations: Map<string, Formation>;
  movements: Map<string, Movement>;
  battles: Map<string, Battle>;
  alliances: Map<string, Alliance>;
  allianceMembers: Map<string, AllianceMember>;
  treaties: Map<string, Treaty>;
  governors: Map<string, Governor>;
  npcBands: Map<string, NpcBand>;
  tribulations: Map<string, Tribulation>;
  messages: Map<string, Message>;
  threads: Map<string, Thread>;
  posts: Map<string, Post>;
  scheduled: Map<string, ScheduledEvent>;
  commands: Map<string, unknown>;
}

function emptyTables(): Tables {
  return {
    players: new Map(), dynasties: new Map(), proficiencies: new Map(), research: new Map(),
    settlements: new Map(), buildings: new Map(), stockpiles: new Map(),
    queue: new Map(), formations: new Map(), movements: new Map(),
    battles: new Map(), alliances: new Map(), allianceMembers: new Map(),
    treaties: new Map(), governors: new Map(), npcBands: new Map(),
    tribulations: new Map(), scheduled: new Map(),
    messages: new Map(), threads: new Map(), posts: new Map(),
    commands: new Map(),
  };
}

export class MemoryStore implements Store {
  private tables = emptyTables();
  private log: LoggedEvent[] = [];
  private depth = 0;

  /**
   * Atomic by UNDO JOURNAL rather than by snapshot.
   *
   * The contract callers depend on is unchanged: a transaction either completes
   * or leaves no trace. What changed is the price of offering it. Copying all
   * seventeen tables up front made every command cost a full copy of the world
   * BEFORE doing any work — an empty transaction on a 300-holding world took
   * longer than reading a settlement — and a command typically touches a
   * handful of rows. So instead each write records the row it is about to
   * overwrite, and a rollback puts those rows back.
   *
   * Replay is BACKWARDS, which is what makes repeated writes to the same row
   * safe: the last entry restores the second-to-last value, and so on down to
   * the value the row held when the transaction opened.
   *
   * This is still the simple in-memory store. Postgres provides the same
   * guarantee properly; handler code written against either is correct.
   */
  transaction<T>(fn: (tx: Tx) => T): T {
    // Nested calls join the outer transaction rather than starting a second
    // one, so a handler that calls another handler still commits atomically —
    // and shares the outer journal, so an inner failure unwinds the whole thing.
    if (this.depth > 0) return fn(this.makeTx());

    const entries: Undo[] = [];
    journal = entries;
    const logLength = this.log.length;
    this.depth++;
    try {
      const out = fn(this.makeTx());
      this.depth--;
      journal = null;
      return out;
    } catch (e) {
      this.depth--;
      journal = null;
      // Backwards: the earliest entry for a row holds its pre-transaction value.
      for (let i = entries.length - 1; i >= 0; i--) {
        const u = entries[i]!;
        if (u.existed) u.rows.set(u.key, u.prior);
        else u.rows.delete(u.key);
      }
      this.log.length = logLength;
      throw e;
    }
  }

  read<T>(fn: (tx: Tx) => T): T {
    return fn(this.makeTx());
  }

  private makeTx(): Tx {
    const t = this.tables;
    const log = this.log;
    return {
      players: new MapRepo(t.players, 'player'),
      dynasties: new MapRepo(t.dynasties, 'dynasty'),
      proficiencies: new CompositeRepo(t.proficiencies, (p) => [p.playerId, p.track]),
      research: new CompositeRepo(t.research, (r) => [r.playerId, r.researchKey]),
      settlements: new MapRepo(t.settlements, 'settlement'),
      buildings: new MapRepo(t.buildings, 'building'),
      stockpiles: new CompositeRepo(t.stockpiles, (s) => [s.settlementId, s.resourceKey]),
      queue: new MapRepo(t.queue, 'queue item'),
      formations: new MapRepo(t.formations, 'formation'),
      movements: new MapRepo(t.movements, 'movement'),
      battles: new MapRepo(t.battles, 'battle'),
      alliances: new MapRepo(t.alliances, 'alliance'),
      allianceMembers: new CompositeRepo(t.allianceMembers, (m) => [m.allianceId, m.playerId]),
      treaties: new MapRepo(t.treaties, 'treaty'),
      governors: new MapRepo(t.governors, 'governor'),
      npcBands: new MapRepo(t.npcBands, 'barbarian band'),
      tribulations: new MapRepo(t.tribulations, 'tribulation'),
      messages: new MapRepo(t.messages, 'message'),
      threads: new MapRepo(t.threads, 'thread'),
      posts: new MapRepo(t.posts, 'post'),
      scheduled: new MapRepo(t.scheduled, 'scheduled event'),

      appendEvent(e: LoggedEvent): void { log.push(e); },
      eventsFor(subjectId: Uuid, limit: number): LoggedEvent[] {
        const out: LoggedEvent[] = [];
        for (let i = log.length - 1; i >= 0 && out.length < limit; i--) {
          const e = log[i]!;
          if (e.subjectId === subjectId || e.actorId === subjectId) out.push(e);
        }
        return out;
      },
      eventsSince(at: Millis, limit: number): LoggedEvent[] {
        return log.filter((e) => e.occurredAt >= at).slice(0, limit);
      },
      allEvents(): readonly LoggedEvent[] { return log; },

      // Journaled like any other write. A command whose transaction rolls back
      // must NOT stay recorded — otherwise the retry would be served the result
      // of the attempt that failed.
      recordCommand(commandId: Uuid, result: unknown): void {
        remember(t.commands, commandId);
        t.commands.set(commandId, result);
      },
      commandResult(commandId: Uuid): { found: boolean; result: unknown } {
        return t.commands.has(commandId)
          ? { found: true, result: t.commands.get(commandId) }
          : { found: false, result: undefined };
      },
    };
  }
}
