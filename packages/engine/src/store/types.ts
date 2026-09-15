/**
 * store/types.ts — the persistence boundary
 *
 * WHY AN INTERFACE AND NOT DIRECT SQL
 *   spec/03 requires the simulation core to be pure: no I/O, no clock reads, no
 *   framework imports. Callers load state, call a pure function, and persist the
 *   result. This interface is that boundary.
 *
 *   spec/01 §6 says to build the single-process version first, because "a
 *   distributed system built before the game logic is a distributed system you
 *   will debug instead of building a game". The shipped implementation is
 *   in-memory; the Postgres schema lives in packages/server/migrations/ and
 *   plugs in behind this same interface. See DECISIONS.md D4.
 *
 * TRANSACTIONS
 *   `transaction()` must be atomic: a build completing and the next queue item
 *   starting are one unit of work. There is no window in which a settlement has
 *   finished something but not started the next thing.
 */

import type {
  Alliance,
  AllianceMember,
  Battle,
  Building,
  Dynasty,
  Formation,
  Governor,
  LoggedEvent,
  Movement,
  Player,
  Proficiency,
  QueueItem,
  ResearchLevel,
  ScheduledEvent,
  Settlement,
  Stockpile,
  Treaty,
  Uuid,
  Millis,
} from '@ascendance/shared';

export interface Store {
  transaction<T>(fn: (tx: Tx) => T): T;
  /** A read-only view. Convenience for queries that mutate nothing. */
  read<T>(fn: (tx: Tx) => T): T;
}

export interface Tx {
  players: Repo<Player>;
  dynasties: Repo<Dynasty>;
  proficiencies: KeyedRepo<Proficiency>;
  research: KeyedRepo<ResearchLevel>;
  settlements: Repo<Settlement>;
  buildings: Repo<Building>;
  stockpiles: KeyedRepo<Stockpile>;
  queue: Repo<QueueItem>;
  formations: Repo<Formation>;
  movements: Repo<Movement>;
  battles: Repo<Battle>;
  alliances: Repo<Alliance>;
  allianceMembers: KeyedRepo<AllianceMember>;
  treaties: Repo<Treaty>;
  governors: Repo<Governor>;
  scheduled: Repo<ScheduledEvent>;

  /** Append-only. Never updated, never deleted (spec/02 §7). */
  appendEvent(e: LoggedEvent): void;
  eventsFor(subjectId: Uuid, limit: number): LoggedEvent[];
  eventsSince(at: Millis, limit: number): LoggedEvent[];
  allEvents(): readonly LoggedEvent[];

  /**
   * Idempotency ledger for commands (spec/05 §1). Retrying a command that
   * already executed returns the original result rather than acting twice —
   * which on mobile is the difference between sending an army and sending two.
   */
  recordCommand(commandId: Uuid, result: unknown): void;
  commandResult(commandId: Uuid): { found: boolean; result: unknown };
}

export interface Repo<T extends { id: string }> {
  get(id: string): T | undefined;
  require(id: string): T;
  put(row: T): void;
  delete(id: string): boolean;
  all(): T[];
  where(pred: (row: T) => boolean): T[];
  find(pred: (row: T) => boolean): T | undefined;
  count(): number;
}

export interface KeyedRepo<T> {
  get(...key: string[]): T | undefined;
  put(row: T): void;
  delete(...key: string[]): boolean;
  all(): T[];
  where(pred: (row: T) => boolean): T[];
}
