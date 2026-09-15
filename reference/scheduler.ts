/**
 * scheduler.ts — The event scheduler
 * ============================================================================
 *
 * THIS IS THE MOST IMPORTANT COMPONENT IN THE SYSTEM. Build it first and get it
 * right; everything else is downstream of it.
 *
 * THE CORE IDEA
 *   There is no game loop. Nothing polls. Nothing iterates idle entities.
 *   Every future state change — a building completing, an army arriving, a revolt
 *   check, a tribulation window opening — is registered as a scheduled event with
 *   an exact execution timestamp. Workers claim due events and execute them.
 *
 * WHY THIS AND NOT A TICK LOOP
 *   A tick loop over entities is O(entities) per tick forever. This design is
 *   O(events actually happening). Ten thousand quiet settlements schedule nothing
 *   and cost exactly zero CPU, which is the difference between a server that
 *   handles a province and one that handles a galaxy.
 *
 *   It also gives exact timing for free. Coordinated multi-wave attacks landing
 *   seconds apart are a core skill in this genre; they work here because arrival
 *   is a timestamped event rather than a polling artefact.
 *
 * DURABILITY
 *   Events live in Postgres (the truth) and are mirrored into a Redis sorted set
 *   (the fast index). If Redis is lost the wheel is rebuilt from Postgres. If a
 *   worker dies mid-execution the transaction rolls back and the claim expires, so
 *   the event is retried exactly once.
 *
 * SPEC: spec/03_simulation_engine.md §1-3
 */

import type { Redis } from 'ioredis';
import type { DB, Tx } from '../db';

export type EventKind =
  | 'BUILD_COMPLETE'
  | 'RESEARCH_COMPLETE'
  | 'TRAINING_COMPLETE'
  | 'TIER_UP_COMPLETE'
  | 'MOVEMENT_ARRIVE'
  | 'CONVOY_ARRIVE'
  | 'ATTRITION_TICK'
  | 'REVOLT_CHECK'
  | 'TRIBULATION_WINDOW'
  | 'DECAY_TICK'
  | 'HEAVENS_ENVY_RESOLVE'
  | 'EPOCH_TRANSITION';

export interface ScheduledEvent {
  id: string;            // UUIDv7 — time-ordered, index-friendly
  shardId: string;
  executeAt: bigint;     // epoch ms UTC. NEVER a relative duration.
  kind: EventKind;
  payload: Record<string, unknown>;
}

const WHEEL_KEY = (shardId: string) => `wheel:${shardId}`;

/**
 * Register a future state change.
 *
 * The Postgres insert and the Redis ZADD happen in that order, inside the caller's
 * transaction where possible. If the process dies between them, the recovery sweep
 * (see rebuildWheel) restores the Redis entry from Postgres. The reverse ordering
 * would risk an event in the wheel that does not exist in the truth store, which
 * would be executed against nothing.
 */
export async function schedule(
  tx: Tx,
  redis: Redis,
  e: ScheduledEvent,
): Promise<void> {
  await tx.insertInto('scheduled_event').values({
    id: e.id,
    shard_id: e.shardId,
    execute_at: e.executeAt,
    kind: e.kind,
    payload: e.payload,
    claimed_by: null,
    claimed_at: null,
  }).execute();

  await redis.zadd(WHEEL_KEY(e.shardId), Number(e.executeAt), e.id);
}

/**
 * Cancel a pending event — for example an attack recalled before departure, or a
 * queue item cancelled by the player.
 *
 * Returns false if the event has already been claimed, because at that point it is
 * executing or has executed and cancelling it would corrupt state. Callers must
 * handle that case rather than assuming success.
 */
export async function cancel(
  tx: Tx,
  redis: Redis,
  shardId: string,
  eventId: string,
): Promise<boolean> {
  const deleted = await tx
    .deleteFrom('scheduled_event')
    .where('id', '=', eventId)
    .where('claimed_by', 'is', null)   // refuse to cancel an in-flight event
    .executeTakeFirst();

  if (!deleted.numDeletedRows) return false;
  await redis.zrem(WHEEL_KEY(shardId), eventId);
  return true;
}

/**
 * Claim and execute due events.
 *
 * Called in a tight loop by each simulation worker. The loop should sleep briefly
 * when nothing is due rather than spinning — but keep the sleep short (25-50ms),
 * because attack-arrival precision is a gameplay feature, not an implementation
 * detail.
 *
 * CLAIMING: `FOR UPDATE SKIP LOCKED` is what makes this safe with multiple workers
 * on the same shard. Each worker takes a disjoint batch; no coordination needed,
 * no distributed lock, no leader election.
 *
 * ORDERING: events are claimed in `execute_at` order. Two events with the same
 * timestamp are ordered by UUIDv7, which is time-ordered by creation — so a
 * deterministic replay produces the same sequence.
 */
export async function drain(
  db: DB,
  redis: Redis,
  shardId: string,
  now: bigint,
  batchSize: number,
  handlers: Record<EventKind, (tx: Tx, e: ScheduledEvent, now: bigint) => Promise<void>>,
  workerId: string,
): Promise<number> {
  // Fast path: ask Redis what is due before touching Postgres at all.
  const dueIds = await redis.zrangebyscore(
    WHEEL_KEY(shardId), '-inf', Number(now), 'LIMIT', 0, batchSize,
  );
  if (dueIds.length === 0) return 0;

  let executed = 0;

  for (const id of dueIds) {
    // One transaction per event. Deliberately NOT batched into a single
    // transaction: a single poisoned event would otherwise roll back an entire
    // batch of unrelated, valid work.
    await db.transaction().execute(async (tx) => {
      const rows = await tx
        .selectFrom('scheduled_event')
        .selectAll()
        .where('id', '=', id)
        .where('claimed_by', 'is', null)
        .forUpdate()
        .skipLocked()
        .execute();

      if (rows.length === 0) return;  // another worker has it, or it was cancelled
      const row = rows[0];

      await tx.updateTable('scheduled_event')
        .set({ claimed_by: workerId, claimed_at: now })
        .where('id', '=', id)
        .execute();

      const event: ScheduledEvent = {
        id: row.id,
        shardId: row.shard_id,
        executeAt: row.execute_at,
        kind: row.kind as EventKind,
        payload: row.payload,
      };

      // The handler mutates state, appends to the event log, and may schedule
      // follow-on events inside this same transaction — so a build completing and
      // the next queue item starting are atomic. There is no window in which a
      // settlement has finished something but not started the next thing.
      await handlers[event.kind](tx, event, now);

      await tx.deleteFrom('scheduled_event').where('id', '=', id).execute();
      executed++;
    });

    await redis.zrem(WHEEL_KEY(shardId), id);
  }

  return executed;
}

/**
 * Recovery sweep. Run on worker startup and periodically thereafter.
 *
 * Two jobs:
 *   1. Rebuild the Redis wheel from Postgres, in case Redis was flushed or lost.
 *   2. Release claims older than the timeout — these belong to workers that died
 *      mid-execution. Their transactions rolled back, so the event never happened
 *      and is safe to retry.
 *
 * The claim timeout must be comfortably longer than the slowest legitimate handler
 * (a large battle resolution), or healthy work will be double-executed.
 */
export async function recover(
  db: DB,
  redis: Redis,
  shardId: string,
  now: bigint,
  claimTimeoutMs: bigint,
): Promise<void> {
  await db.updateTable('scheduled_event')
    .set({ claimed_by: null, claimed_at: null })
    .where('shard_id', '=', shardId)
    .where('claimed_by', 'is not', null)
    .where('claimed_at', '<', now - claimTimeoutMs)
    .execute();

  const pending = await db.selectFrom('scheduled_event')
    .select(['id', 'execute_at'])
    .where('shard_id', '=', shardId)
    .where('claimed_by', 'is', null)
    .execute();

  if (pending.length === 0) return;

  const pipeline = redis.pipeline();
  pipeline.del(WHEEL_KEY(shardId));
  for (const p of pending) {
    pipeline.zadd(WHEEL_KEY(shardId), Number(p.execute_at), p.id);
  }
  await pipeline.exec();
}

/**
 * DETERMINISM NOTE
 *
 * Handlers must never read the wall clock. The `now` passed into a handler is the
 * event's scheduled time, not the actual execution time, even if the worker is
 * running late. This matters: if a worker falls two seconds behind, a battle must
 * still resolve as though it happened at its scheduled instant, or a replay of the
 * event log would diverge from the original run — and replay-identity is what makes
 * archaeology, dispute resolution, and every balance simulation possible.
 *
 * Any handler needing randomness must derive it from prng(worldId, event.id), never
 * from Math.random().
 */
