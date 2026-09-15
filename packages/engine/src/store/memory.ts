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
  LoggedEvent, Movement, Player, Proficiency, QueueItem, ResearchLevel, ScheduledEvent,
  Settlement, Stockpile, Treaty, Uuid, Millis,
} from '@ascendance/shared';
import type { Store, Tx, Repo, KeyedRepo } from './types.js';

/** Composite-key separator. A unit separator cannot occur in a UUID or a key. */
const SEP = String.fromCharCode(31);

class MapRepo<T extends { id: string }> implements Repo<T> {
  constructor(private readonly rows: Map<string, T>, private readonly label: string) {}
  get(id: string): T | undefined { return this.rows.get(id); }
  require(id: string): T {
    const r = this.rows.get(id);
    if (!r) throw new NotFound(`${this.label} ${id} does not exist`);
    return r;
  }
  put(row: T): void { this.rows.set(row.id, row); }
  delete(id: string): boolean { return this.rows.delete(id); }
  all(): T[] { return [...this.rows.values()]; }
  where(pred: (row: T) => boolean): T[] { return this.all().filter(pred); }
  find(pred: (row: T) => boolean): T | undefined { return this.all().find(pred); }
  count(): number { return this.rows.size; }
}

class CompositeRepo<T> implements KeyedRepo<T> {
  constructor(private readonly rows: Map<string, T>, private readonly keyOf: (row: T) => string[]) {}
  private k(parts: string[]): string { return parts.join(SEP); }
  get(...key: string[]): T | undefined { return this.rows.get(this.k(key)); }
  put(row: T): void { this.rows.set(this.k(this.keyOf(row)), row); }
  delete(...key: string[]): boolean { return this.rows.delete(this.k(key)); }
  all(): T[] { return [...this.rows.values()]; }
  where(pred: (row: T) => boolean): T[] { return this.all().filter(pred); }
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
  scheduled: Map<string, ScheduledEvent>;
  commands: Map<string, unknown>;
}

function emptyTables(): Tables {
  return {
    players: new Map(), dynasties: new Map(), proficiencies: new Map(), research: new Map(),
    settlements: new Map(), buildings: new Map(), stockpiles: new Map(),
    queue: new Map(), formations: new Map(), movements: new Map(),
    battles: new Map(), alliances: new Map(), allianceMembers: new Map(),
    treaties: new Map(), governors: new Map(), scheduled: new Map(),
    commands: new Map(),
  };
}

export class MemoryStore implements Store {
  private tables = emptyTables();
  private log: LoggedEvent[] = [];
  private depth = 0;

  transaction<T>(fn: (tx: Tx) => T): T {
    // Nested calls join the outer transaction rather than starting a second
    // one, so a handler that calls another handler still commits atomically.
    if (this.depth > 0) return fn(this.makeTx());
    const snapshot = this.snapshot();
    const logLength = this.log.length;
    this.depth++;
    try {
      const out = fn(this.makeTx());
      this.depth--;
      return out;
    } catch (e) {
      this.depth--;
      this.tables = snapshot;
      this.log.length = logLength;
      throw e;
    }
  }

  read<T>(fn: (tx: Tx) => T): T {
    return fn(this.makeTx());
  }

  /** Rows are treated as immutable; handlers replace them rather than mutate. */
  private snapshot(): Tables {
    const t = this.tables;
    return {
      players: new Map(t.players), dynasties: new Map(t.dynasties),
      proficiencies: new Map(t.proficiencies), research: new Map(t.research), settlements: new Map(t.settlements),
      buildings: new Map(t.buildings), stockpiles: new Map(t.stockpiles),
      queue: new Map(t.queue), formations: new Map(t.formations),
      movements: new Map(t.movements), battles: new Map(t.battles),
      alliances: new Map(t.alliances), allianceMembers: new Map(t.allianceMembers),
      treaties: new Map(t.treaties), governors: new Map(t.governors),
      scheduled: new Map(t.scheduled), commands: new Map(t.commands),
    };
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

      recordCommand(commandId: Uuid, result: unknown): void { t.commands.set(commandId, result); },
      commandResult(commandId: Uuid): { found: boolean; result: unknown } {
        return t.commands.has(commandId)
          ? { found: true, result: t.commands.get(commandId) }
          : { found: false, result: undefined };
      },
    };
  }
}
