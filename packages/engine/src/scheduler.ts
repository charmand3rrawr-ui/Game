/**
 * scheduler.ts — the event scheduler
 *
 * THIS IS THE MOST IMPORTANT COMPONENT IN THE SYSTEM (spec/01 §4). Everything
 * else is downstream of it.
 *
 * THE CORE IDEA
 *   There is no game loop. Nothing polls. Nothing iterates idle entities.
 *   Every future state change — a building completing, an army arriving, a
 *   revolt check, a tribulation window opening — is registered as a scheduled
 *   event with an exact execution timestamp. Workers claim due events and
 *   execute them.
 *
 * WHY THIS AND NOT A TICK LOOP
 *   A tick loop is O(entities) per tick forever. This is O(events actually
 *   happening). Ten thousand quiet settlements schedule nothing and cost
 *   exactly zero CPU — the difference between a server that handles a province
 *   and one that handles a galaxy.
 *
 *   It also gives exact timing for free. Coordinated multi-wave attacks landing
 *   seconds apart are a core skill in this genre; they work here because
 *   arrival is a timestamped event rather than a polling artefact.
 *
 * THE RULE THAT MAKES REPLAY WORK
 *   A handler receives the event's SCHEDULED time, never the wall clock, even
 *   when the worker is running late. A battle scheduled for 14:00:00.000 must
 *   resolve as though it happened then, or a replay of the event log would
 *   diverge from the original run — and replay-identity is what makes
 *   archaeology, dispute resolution and every balance simulation possible.
 *
 * SPEC: spec/03_simulation_engine.md §1–3, reference/scheduler.ts
 */

import type { EventKind, Millis, ScheduledEvent, Uuid } from '@ascendance/shared';
import type { Store, Tx } from './store/types.js';

export type Handler = (tx: Tx, event: ScheduledEvent, now: Millis) => void;
export type Handlers = Partial<Record<EventKind, Handler>>;

export interface DrainResult {
  executed: number;
  failed: { eventId: Uuid; kind: EventKind; error: string }[];
}

/**
 * Deterministic id generation.
 *
 * Event ids order two events that share a timestamp, so they must be stable
 * across a replay. UUIDv7's random tail is not, which is why ids here are
 * derived from a counter seeded per world rather than from `crypto.randomUUID`.
 * The prefix keeps them time-ordered and index-friendly, as spec/02 asks.
 */
export class IdFactory {
  private counter = 0;

  constructor(private readonly worldId: string) {}

  next(prefix: string, at: Millis): Uuid {
    const seq = (this.counter++).toString(16).padStart(8, '0');
    const ts = at.toString(16).padStart(12, '0');
    return `${prefix}-${ts}-${seq}-${this.worldId.slice(0, 8)}`;
  }

  /** Restore the counter when resuming a world, so ids never collide. */
  restore(counter: number): void {
    this.counter = Math.max(this.counter, counter);
  }

  get issued(): number {
    return this.counter;
  }
}

export class Scheduler {
  private readonly handlers: Handlers = {};

  constructor(
    private readonly store: Store,
    readonly ids: IdFactory,
  ) {}

  on(kind: EventKind, handler: Handler): this {
    this.handlers[kind] = handler;
    return this;
  }

  /**
   * Register a future state change.
   *
   * Called INSIDE the caller's transaction wherever possible, so a build
   * completing and the next item starting are atomic.
   */
  schedule(tx: Tx, e: Omit<ScheduledEvent, 'id'> & { id?: Uuid }): ScheduledEvent {
    const row: ScheduledEvent = {
      id: e.id ?? this.ids.next('ev', e.executeAt),
      shardId: e.shardId,
      executeAt: e.executeAt,
      kind: e.kind,
      payload: e.payload,
    };
    tx.scheduled.put(row);
    return row;
  }

  /**
   * Cancel a pending event — an attack recalled before departure, a queue item
   * cancelled by the player.
   *
   * Returns false if the event has already been claimed, because at that point
   * it is executing or has executed, and cancelling would corrupt state.
   * Callers must handle that rather than assume success.
   */
  cancel(tx: Tx, eventId: Uuid): boolean {
    const row = tx.scheduled.get(eventId);
    if (!row || row.claimedBy) return false;
    return tx.scheduled.delete(eventId);
  }

  /** Pending events for a shard, soonest first. */
  pending(tx: Tx, shardId?: Uuid): ScheduledEvent[] {
    return tx.scheduled
      .where((r) => !r.claimedBy && (shardId === undefined || r.shardId === shardId))
      .sort(compareEvents);
  }

  /** When the next event is due, or undefined if nothing is scheduled. */
  nextDueAt(shardId?: Uuid): Millis | undefined {
    return this.store.read((tx) => this.pending(tx, shardId)[0]?.executeAt);
  }

  /**
   * Claim and execute every event due at or before `now`.
   *
   * ORDERING: events run in `executeAt` order, ties broken by id — which is
   * time-ordered by creation — so a deterministic replay produces the same
   * sequence. Follow-on events scheduled by a handler are picked up in the same
   * drain if they are also due, which is what lets a chain of instant
   * consequences settle inside one call.
   *
   * ONE TRANSACTION PER EVENT, deliberately not batched: a single poisoned
   * event would otherwise roll back an entire batch of unrelated valid work.
   */
  drain(now: Millis, batchSize = 1000): DrainResult {
    const out: DrainResult = { executed: 0, failed: [] };

    for (let i = 0; i < batchSize; i++) {
      const due = this.store.read((tx) =>
        tx.scheduled.where((r) => !r.claimedBy && r.executeAt <= now).sort(compareEvents)[0],
      );
      if (!due) break;

      const handler = this.handlers[due.kind];
      if (!handler) {
        // An unhandled kind must not spin the drain loop forever. Drop it and
        // report: a missing handler is a bug to fix, not a runtime condition to
        // retry into.
        this.store.transaction((tx) => tx.scheduled.delete(due.id));
        out.failed.push({ eventId: due.id, kind: due.kind, error: `no handler registered for ${due.kind}` });
        continue;
      }

      try {
        this.store.transaction((tx) => {
          // The handler mutates state, appends to the event log, and may
          // schedule follow-on events inside this same transaction.
          //
          // `due.executeAt` — NOT `now` — is what the handler sees. A worker
          // running two seconds late must still resolve the battle as though it
          // happened at its scheduled instant.
          handler(tx, due, due.executeAt);
          tx.scheduled.delete(due.id);
        });
        out.executed++;
      } catch (e) {
        // The transaction rolled back, so the event never happened. Remove it
        // rather than retry forever; the failure is reported to the caller.
        this.store.transaction((tx) => tx.scheduled.delete(due.id));
        out.failed.push({ eventId: due.id, kind: due.kind, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return out;
  }

  /**
   * Run every scheduled event up to `until`, including ones created along the
   * way. This is how a world is advanced — by time, not by ticks.
   */
  advanceTo(until: Millis, maxEvents = 100_000): DrainResult {
    const total: DrainResult = { executed: 0, failed: [] };
    for (let guard = 0; guard < maxEvents; guard++) {
      const next = this.nextDueAt();
      if (next === undefined || next > until) break;
      const r = this.drain(next, 1000);
      total.executed += r.executed;
      total.failed.push(...r.failed);
      if (r.executed === 0 && r.failed.length === 0) break;
    }
    return total;
  }
}

/**
 * Stable ordering for two events. Timestamp first, then id.
 *
 * This comparator is load-bearing for determinism: it is the only thing
 * deciding which of two simultaneous battles resolves first, and a replay must
 * make the same choice.
 */
export function compareEvents(a: ScheduledEvent, b: ScheduledEvent): number {
  if (a.executeAt !== b.executeAt) return a.executeAt < b.executeAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
