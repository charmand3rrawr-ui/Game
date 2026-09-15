/**
 * world.ts — the authoritative game world
 *
 * THE SERVER IS AUTHORITATIVE FOR EVERYTHING (invariant §2.1). Every command
 * here validates, decides, and persists. The client requests; this decides.
 * There is no code path by which a caller reports an outcome.
 *
 * This class is the only place that touches both the store and the simulation.
 * The sim modules stay pure; the store stays dumb; `World` is the seam, and it
 * is deliberately the only stateful thing in the engine.
 *
 * Both the HTTP server and the browser run this same class (DECISIONS.md D4),
 * which is what lets the client's Simulator be genuinely the same code.
 */

import {
  C,
  BALANCE_REVISION,
  HOLDINGS,
  adminUpkeep,
  applyShards,
  battleSeed,
  distance,
  empireWeightMultiplier,
  gradeForLevel,
  personalQueueSlots,
  prng,
  rngFromSeed,
  shardsPermitted,
  temporalDebtAfterSpend,
  travelTimeMs,
  unitDef,
  type AttentionItem,
  type Battle,
  type Building,
  type Formation,
  type Millis,
  type Movement,
  type Player,
  type ProblemType,
  type QueueItem,
  type ScheduledEvent,
  type Settlement,
  type SlotKind,
  type Stockpile,
  type Uuid,
} from '@ascendance/shared';
import { MemoryStore } from './store/memory.js';
import type { Store, Tx } from './store/types.js';
import { IdFactory, Scheduler } from './scheduler.js';
import {
  accrueProduction,
  buildingRef,
  holdingRef,
  hqFactorFor,
  hqLevel,
  plotsTotal,
  plotsUsed,
  productionRows,
  staffing,
  storageCapacity,
  upgradeCost,
  validateAffordable,
  validateBuildingEnqueue,
  type SettlementView,
} from './sim/settlement.js';
import { resolveBattle, isOccupier, type BattleInput, type CombatUnit, type SideInput } from './sim/combat.js';
import { attributeBattle, applyAward, checkPromotion, reinforce } from './sim/veterancy.js';

export class CommandError extends Error {
  constructor(
    readonly problemType: ProblemType,
    message: string,
    readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export interface WorldOptions {
  worldId: string;
  store?: Store;
  /** Simulation time. Callers advance it; the world never reads a clock. */
  now: Millis;
}

export interface EnqueueArgs {
  commandId: Uuid;
  playerId: Uuid;
  settlementId: Uuid;
  kind: 'building' | 'research' | 'training' | 'repair';
  targetKey: string;
  quantity?: number;
  slotKind: SlotKind;
}

export interface DispatchArgs {
  commandId: Uuid;
  playerId: Uuid;
  originId: Uuid;
  targetId: Uuid;
  mission: string;
  formations: { formationId: Uuid; count: number }[];
}

export class World {
  readonly worldId: string;
  readonly store: Store;
  readonly scheduler: Scheduler;
  readonly ids: IdFactory;
  private clock: Millis;
  /** Everything that happened during the last advance, for the WS fan-out. */
  private outbox: { event: string; channel: string; data: unknown }[] = [];

  constructor(opts: WorldOptions) {
    this.worldId = opts.worldId;
    this.store = opts.store ?? new MemoryStore();
    this.ids = new IdFactory(opts.worldId);
    this.clock = opts.now;
    this.scheduler = new Scheduler(this.store, this.ids);
    this.registerHandlers();
  }

  get now(): Millis {
    return this.clock;
  }

  get balanceRevision(): string {
    return BALANCE_REVISION;
  }

  /**
   * Advance simulation time, running every event that falls due.
   *
   * This is the ONLY way time passes. Nothing polls, and no handler reads the
   * wall clock — each one is given its own scheduled instant, so a world
   * advanced in one jump ends in the same state as one advanced in a thousand.
   */
  advanceTo(t: Millis): { executed: number; failed: number } {
    if (t < this.clock) throw new RangeError('time does not run backwards');
    const r = this.scheduler.advanceTo(t);
    this.clock = t;
    return { executed: r.executed, failed: r.failed.length };
  }

  drainOutbox(): { event: string; channel: string; data: unknown }[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  private emit(event: string, channel: string, data: unknown): void {
    this.outbox.push({ event, channel, data });
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  view(settlementId: Uuid): SettlementView {
    return this.store.read((tx) => this.viewIn(tx, settlementId));
  }

  private viewIn(tx: Tx, settlementId: Uuid): SettlementView {
    const settlement = tx.settlements.require(settlementId);
    return {
      settlement,
      buildings: tx.buildings.where((b) => b.settlementId === settlementId),
      queue: tx.queue.where((q) => q.settlementId === settlementId).sort((a, b) => a.position - b.position),
      stockpiles: tx.stockpiles.where((s) => s.settlementId === settlementId),
    };
  }

  player(id: Uuid): Player {
    return this.store.read((tx) => tx.players.require(id));
  }

  settlementsOf(playerId: Uuid): Settlement[] {
    return this.store.read((tx) => tx.settlements.where((s) => s.ownerId === playerId));
  }

  formationsOf(playerId: Uuid): Formation[] {
    return this.store.read((tx) => tx.formations.where((f) => f.ownerId === playerId));
  }

  movementsOf(playerId: Uuid): Movement[] {
    return this.store.read((tx) => tx.movements.where((m) => m.ownerId === playerId));
  }

  battle(id: Uuid): Battle | undefined {
    return this.store.read((tx) => tx.battles.get(id));
  }

  battlesAt(settlementId: Uuid): Battle[] {
    return this.store.read((tx) =>
      tx.battles.where((b) => b.settlementId === settlementId).sort((a, b) => Number(b.resolvedAt - a.resolvedAt)),
    );
  }

  /**
   * Empire Weight: the summed admin costs of OWNED holdings.
   *
   * Vassalized holdings are not owned and contribute nothing — which is why
   * vassalizing rather than annexing keeps an empire's armies able to learn,
   * the strongest incentive alignment in the design (spec/04 §5).
   */
  empireWeight(playerId: Uuid): number {
    return this.store.read((tx) =>
      adminUpkeep(tx.settlements.where((s) => s.ownerId === playerId).map((s) => holdingRef(s.holdingType).adminCost)),
    );
  }

  /**
   * THE ATTENTION DASHBOARD — the most important endpoint in the game.
   *
   * With full production isolation and no cap on holdings, this is where
   * players will live. If it is bad, nothing else matters (spec/06 §3).
   *
   * Every row carries a one-tap resolution where one exists, and is sorted by
   * urgency so the top of the list is always the thing that matters most.
   */
  attention(playerId: Uuid): AttentionItem[] {
    return this.store.read((tx) => {
      const items: AttentionItem[] = [];
      const player = tx.players.require(playerId);
      const settlements = tx.settlements.where((s) => s.ownerId === playerId);

      for (const s of settlements) {
        const view = this.viewIn(tx, s.id);
        const hq = gradeForLevel(hqLevel(view));

        // Idle build queues, by settlement. An empty personal slot is unspent
        // time, and in a game measured in months that compounds.
        const personalUsed = view.queue.filter((q) => q.slotKind === 'personal').length;
        const personalSlots = personalQueueSlots(hq);
        if (personalUsed < personalSlots) {
          items.push({
            id: `idle:${s.id}`,
            kind: 'idle_queue',
            urgency: 40,
            settlementId: s.id,
            settlementName: s.name,
            title: `${s.name}: ${personalSlots - personalUsed} idle build slot${personalSlots - personalUsed === 1 ? '' : 's'}`,
            detail: `${personalUsed} of ${personalSlots} personal slots in use.`,
            action: { label: 'Queue a building', command: 'open-settlement', params: { settlementId: s.id } },
          });
        }

        // Warehouses at capacity are ACTIVELY LOSING OUTPUT every second.
        // Overflow is discarded, not carried — so this is urgent, not cosmetic.
        const accrued = accrueProduction(view, this.clock);
        for (const key of accrued.overflowed) {
          items.push({
            id: `overflow:${s.id}:${key}`,
            kind: 'warehouse_full',
            urgency: 70,
            settlementId: s.id,
            settlementName: s.name,
            title: `${s.name}: ${key} store is full`,
            detail: 'Production above capacity is being lost. Spend it, haul it, or raise storage.',
            action: { label: 'Haul to a neighbour', command: 'open-haul', params: { settlementId: s.id, resourceKey: key } },
          });
        }

        // Understaffed buildings dragging output. The normal state of a growing
        // settlement, so this sits low unless it is severe.
        const st = staffing(view);
        if (st.ratio < 0.8 && st.demand > 0) {
          items.push({
            id: `staff:${s.id}`,
            kind: 'understaffed',
            urgency: st.ratio < 0.5 ? 55 : 25,
            settlementId: s.id,
            settlementName: s.name,
            title: `${s.name}: ${Math.round(st.ratio * 100)}% staffed`,
            detail: `${st.demand} workers needed, ${st.supply} available. Output scales linearly with staffing.`,
            action: { label: 'Restaff', command: 'open-settlement', params: { settlementId: s.id } },
          });
        }

        // Brownout: insolvency halves output, and after 72h sheds a level a day.
        for (const b of view.buildings) {
          if (b.brownoutSince === undefined) continue;
          items.push({
            id: `brownout:${b.id}`,
            kind: 'brownout',
            urgency: 80,
            settlementId: s.id,
            settlementName: s.name,
            title: `${s.name}: ${buildingRef(b.buildingKey).name} is in Brownout`,
            detail: 'Upkeep is unpaid. Output is halved, and after 72 hours the building sheds a level per day.',
            deadline: b.brownoutSince + BigInt(C.BROWNOUT_GRACE_MS),
          });
        }

        // Stalled governor specs. A governor has NO JUDGEMENT: a build order
        // that hits a resource shortfall stalls rather than skipping ahead, and
        // that stall MUST surface here (spec/04 §6).
        const gov = s.governorId ? tx.governors.get(s.governorId) : undefined;
        if (gov && view.queue.filter((q) => q.slotKind === 'governor').length === 0 && gov.specs.buildOrder.length > 0) {
          items.push({
            id: `gov:${s.id}`,
            kind: 'governor_stalled',
            urgency: 60,
            settlementId: s.id,
            settlementName: s.name,
            title: `${s.name}: governor stalled`,
            detail: `Next in the build order is ${gov.specs.buildOrder[0]?.buildingKey}, and it cannot start. Usually a resource shortfall.`,
            action: { label: 'Seize the job', command: 'seize', params: { settlementId: s.id } },
          });
        }
      }

      // Incoming hostile movements, with countdown and estimated composition.
      // The most urgent thing on the board, always.
      const owned = new Set(settlements.map((s) => s.id));
      for (const m of tx.movements.all()) {
        if (!owned.has(m.targetId)) continue;
        if (m.ownerId === playerId) continue;
        if (m.mission !== 'attack' && m.mission !== 'raid' && m.mission !== 'conquer') continue;
        const target = tx.settlements.get(m.targetId);
        const size = m.formations.reduce((n, f) => n + f.count, 0);
        items.push({
          id: `attack:${m.id}`,
          kind: 'incoming_attack',
          urgency: 100,
          settlementId: m.targetId,
          settlementName: target?.name,
          title: `Incoming ${m.mission} on ${target?.name ?? 'a holding'}`,
          detail: `Roughly ${size} units, arriving in ${humanise(m.arrivesAt - this.clock)}.`,
          deadline: m.arrivesAt,
          action: { label: 'Reinforce', command: 'open-dispatch', params: { targetId: m.targetId } },
        });
      }

      // Formations eligible for promotion. A tier-up is announced regionally, so
      // it is a moment, not a housekeeping task.
      for (const f of tx.formations.where((x) => x.ownerId === playerId)) {
        for (const track of ['atk', 'def'] as const) {
          const home = tx.stockpiles.get(f.settlementId, 'special');
          const check = checkPromotion(f, track, player.era, home?.amount ?? 0n);
          if (check.eligible) {
            items.push({
              id: `promote:${f.id}:${track}`,
              kind: 'promotion_eligible',
              urgency: 50,
              title: `${f.name} can promote (${track === 'atk' ? 'attack' : 'defence'} track)`,
              detail: `Level ${C.LEVELS_PER_TIER} reached, deed on record, and the cost of ${check.cost} is in the home stockpile.`,
              action: { label: 'Promote', command: 'tier-up', params: { formationId: f.id, track } },
            });
          }
        }
      }

      return items.sort((a, b) => b.urgency - a.urgency);
    });
  }

  // ==========================================================================
  // Commands
  // ==========================================================================

  /**
   * Idempotency by client-supplied `commandId` (spec/05 §1).
   *
   * Retrying a command that already executed returns the ORIGINAL result rather
   * than acting twice. On mobile, a dropped connection during an attack
   * dispatch would otherwise double-send an army.
   */
  private idempotent<T>(commandId: Uuid, fn: (tx: Tx) => T): T {
    return this.store.transaction((tx) => {
      const prior = tx.commandResult(commandId);
      if (prior.found) return prior.result as T;
      const result = fn(tx);
      tx.recordCommand(commandId, result);
      return result;
    });
  }

  /**
   * Enqueue a building, research, training or repair item.
   *
   * The server computes cost and `finishesAt`; the client never does. Every
   * framework constraint is checked here, and a failure names what was short so
   * the client can say something useful.
   */
  enqueue(args: EnqueueArgs): QueueItem {
    return this.idempotent(args.commandId, (tx) => {
      const view = this.viewIn(tx, args.settlementId);
      if (view.settlement.ownerId !== args.playerId) {
        throw new CommandError('not-owner', 'you do not own this settlement');
      }

      const check = validateBuildingEnqueue(view, args.targetKey, args.slotKind);
      if (!check.ok) throw new CommandError(check.type, check.detail, check.meta);

      const existing = view.buildings.find((b) => b.buildingKey === args.targetKey);
      const fromLevel = existing?.level ?? 0;

      // A governor-initiated job takes twice as long. That one number is the
      // entire governor system (spec/04 §6).
      const timeMultiplier = args.slotKind === 'governor' ? C.GOVERNOR_TIME_MULT : C.PLAYER_TIME_MULT;
      const cost = upgradeCost(args.targetKey, fromLevel, hqFactorFor(hqLevel(view)), 1, timeMultiplier);

      // Accrue first, so a player is never told they cannot afford something
      // their mines already produced.
      this.settleAccrual(tx, view);
      const fresh = this.viewIn(tx, args.settlementId);
      const afford = validateAffordable(fresh, cost.resources);
      if (!afford.ok) throw new CommandError(afford.type, afford.detail, afford.meta);

      for (const [key, amount] of Object.entries(cost.resources)) {
        const sp = tx.stockpiles.get(args.settlementId, key);
        if (sp) tx.stockpiles.put({ ...sp, amount: sp.amount - amount });
      }

      // finishesAt is computed ONCE and stored absolute. Nothing recomputes it
      // downward except an audited Seize or Chrono Shard spend (invariant §2.8).
      const item: QueueItem = {
        id: this.ids.next('q', this.clock),
        settlementId: args.settlementId,
        kind: args.kind,
        targetKey: args.targetKey,
        targetLevel: fromLevel + 1,
        quantity: args.quantity ?? 1,
        slotKind: args.slotKind,
        startedAt: this.clock,
        finishesAt: this.clock + cost.totalTimeMs,
        timeMultiplier,
        shardHoursSpent: 0,
        compressedMs: 0n,
        position: view.queue.length,
      };
      tx.queue.put(item);

      this.scheduler.schedule(tx, {
        shardId: view.settlement.shardId,
        executeAt: item.finishesAt,
        kind: 'BUILD_COMPLETE',
        payload: { queueItemId: item.id, settlementId: args.settlementId },
      });

      tx.appendEvent({
        id: this.ids.next('log', this.clock),
        worldId: this.worldId,
        shardId: view.settlement.shardId,
        occurredAt: this.clock,
        kind: 'queue.enqueued',
        actorId: args.playerId,
        subjectId: args.settlementId,
        payload: { targetKey: args.targetKey, toLevel: fromLevel + 1, slotKind: args.slotKind, finishesAt: item.finishesAt.toString() },
      });

      return item;
    });
  }

  /** Cancel a queue item. Refunds 80% of resources (spec/05 §2). */
  cancelQueueItem(commandId: Uuid, playerId: Uuid, itemId: Uuid): { refunded: Record<string, string> } {
    return this.idempotent(commandId, (tx) => {
      const item = tx.queue.get(itemId);
      if (!item) throw new CommandError('not-found', 'no such queue item');
      const view = this.viewIn(tx, item.settlementId);
      if (view.settlement.ownerId !== playerId) throw new CommandError('not-owner', 'you do not own this settlement');
      if (item.finishesAt <= this.clock) throw new CommandError('already-complete', 'this item has already completed');

      const existing = view.buildings.find((b) => b.buildingKey === item.targetKey);
      const cost = upgradeCost(item.targetKey, existing?.level ?? 0, hqFactorFor(hqLevel(view)), 1, item.timeMultiplier);
      const refunded: Record<string, string> = {};
      for (const [key, amount] of Object.entries(cost.resources)) {
        const back = (amount * BigInt(Math.round(C.CANCEL_REFUND_PCT * 100))) / 100n;
        const sp = tx.stockpiles.get(item.settlementId, key);
        if (sp) tx.stockpiles.put({ ...sp, amount: sp.amount + back });
        refunded[key] = back.toString();
      }

      tx.queue.delete(itemId);
      for (const ev of tx.scheduled.where((e) => (e.payload as { queueItemId?: string }).queueItemId === itemId)) {
        this.scheduler.cancel(tx, ev.id);
      }
      return { refunded };
    });
  }

  /**
   * Take a governor job into personal control.
   *
   * Elapsed progress is KEPT and the remainder recalculates at 1.0x. It
   * requires a free PERSONAL slot, and that scarcity is the only thing
   * preventing a player from governing everything and instantly seizing it all
   * back — which would be free automation at full speed and would collapse the
   * entire governor system (Bible §5.6).
   */
  seize(commandId: Uuid, playerId: Uuid, itemId: Uuid): QueueItem {
    return this.idempotent(commandId, (tx) => {
      const item = tx.queue.get(itemId);
      if (!item) throw new CommandError('not-found', 'no such queue item');
      if (item.slotKind !== 'governor') throw new CommandError('validation', 'this job is already under personal control');

      const view = this.viewIn(tx, item.settlementId);
      if (view.settlement.ownerId !== playerId) throw new CommandError('not-owner', 'you do not own this settlement');

      const personalUsed = view.queue.filter((q) => q.slotKind === 'personal').length;
      const personalSlots = personalQueueSlots(gradeForLevel(hqLevel(view)));
      if (personalUsed >= personalSlots) {
        throw new CommandError(
          'no-free-personal-slot',
          `seizing needs a free personal slot; all ${personalSlots} are busy`,
          { used: personalUsed, available: personalSlots },
        );
      }

      const elapsed = this.clock - item.startedAt;
      const total = item.finishesAt - item.startedAt;
      const remaining = total - elapsed;
      // The remainder recalculates at 1.0x: the governor's 2x penalty applied
      // to the work done, not to the work left.
      const rescaled = (remaining * BigInt(Math.round(C.PLAYER_TIME_MULT * 100))) / BigInt(Math.round(item.timeMultiplier * 100));

      const seized: QueueItem = {
        ...item,
        slotKind: 'personal',
        timeMultiplier: C.PLAYER_TIME_MULT,
        finishesAt: this.clock + (rescaled > 0n ? rescaled : 0n),
      };
      tx.queue.put(seized);

      for (const ev of tx.scheduled.where((e) => (e.payload as { queueItemId?: string }).queueItemId === itemId)) {
        this.scheduler.cancel(tx, ev.id);
      }
      this.scheduler.schedule(tx, {
        shardId: view.settlement.shardId,
        executeAt: seized.finishesAt,
        kind: 'BUILD_COMPLETE',
        payload: { queueItemId: seized.id, settlementId: seized.settlementId },
      });

      // Seize is an AUDITED action — one of only two things that may move a
      // completion time downward (invariant §2.8).
      tx.appendEvent({
        id: this.ids.next('log', this.clock),
        worldId: this.worldId,
        shardId: view.settlement.shardId,
        occurredAt: this.clock,
        kind: 'queue.seized',
        actorId: playerId,
        subjectId: item.settlementId,
        payload: {
          itemId,
          elapsedMs: elapsed.toString(),
          wasFinishingAt: item.finishesAt.toString(),
          nowFinishingAt: seized.finishesAt.toString(),
        },
      });

      return seized;
    });
  }

  /**
   * Spend Chrono Shards on a queue item.
   *
   * All four guardrails are enforced HERE, server-side, regardless of whether
   * the shards were earned or purchased (spec/04 §11).
   */
  spendShards(commandId: Uuid, playerId: Uuid, itemId: Uuid, shardHours: number): QueueItem {
    return this.idempotent(commandId, (tx) => {
      const item = tx.queue.get(itemId);
      if (!item) throw new CommandError('not-found', 'no such queue item');
      const view = this.viewIn(tx, item.settlementId);
      if (view.settlement.ownerId !== playerId) throw new CommandError('not-owner', 'you do not own this settlement');
      const player = tx.players.require(playerId);

      // GUARDRAIL 2 — prohibited targets. The through-line: shards accelerate
      // development but can never be a battlefield trump card. The moments the
      // game is actually about stay on real time.
      const inbound = tx.movements
        .where((m) => m.targetId === item.settlementId && m.ownerId !== playerId && (m.mission === 'attack' || m.mission === 'conquer' || m.mission === 'raid'))
        .map((m) => Number(m.arrivesAt - this.clock))
        .sort((a, b) => a - b)[0];

      const ref = item.kind === 'building' ? buildingRef(item.targetKey) : undefined;
      const permitted = shardsPermitted({
        hostileInboundMs: inbound ?? null,
        atWarAsBelligerent: tx.treaties.where((t) => t.kind === 'war' && !t.brokenAt && (t.partyA === playerId || t.partyB === playerId)).length > 0,
        itemKind: item.kind,
        isAscensionProject: ref?.category === 'Special' && /ascension/i.test(ref.name),
        isEpochVictoryProject: /epoch|victory/i.test(item.targetKey),
        isMegastructure: /megastructure|dyson|ringworld/i.test(item.targetKey),
        isCultivationBreakthrough: ref?.category === 'Cultivation',
        isFortificationRepairUnderSiege: item.kind === 'repair' && inbound !== undefined,
        targetEraGap: 0,
      });
      if (!permitted.allowed) {
        throw new CommandError('shard-prohibited-target', `shards cannot be applied: ${permitted.reason}`, { reason: permitted.reason });
      }

      if (player.shardBalanceHours < shardHours) {
        throw new CommandError('validation', 'not enough shard-hours', { have: player.shardBalanceHours });
      }

      // GUARDRAIL 1 — the absorption ceiling. Money buys you up to your earned
      // ceiling, never past it.
      const construction = tx.proficiencies.get(playerId, 'construction');
      const applied = applyShards({
        now: this.clock,
        startedAt: item.startedAt,
        finishesAt: item.finishesAt,
        shardHoursOffered: shardHours,
        constructionRank: construction?.rank ?? 0,
        era: player.era,
        alreadyCompressedMs: item.compressedMs,
      });

      if (applied.shardHoursSpent === 0) {
        throw new CommandError('shard-ceiling-reached', 'this item is already at your compression ceiling', {
          ceiling: C.SHARD_BASE + C.SHARD_PER_RANK * (construction?.rank ?? 0) + C.SHARD_PER_ERA * player.era,
        });
      }

      const updated: QueueItem = {
        ...item,
        finishesAt: applied.finishesAt,
        shardHoursSpent: item.shardHoursSpent + applied.shardHoursSpent,
        compressedMs: item.compressedMs + applied.compressedMs,
      };
      tx.queue.put(updated);

      // GUARDRAIL 3 — Temporal Debt. The cost of buying time is paid in the
      // cultivation game, which money cannot touch.
      tx.players.put({
        ...player,
        shardBalanceHours: player.shardBalanceHours - applied.shardHoursSpent,
        temporalDebt: temporalDebtAfterSpend(player.temporalDebt, applied.shardHoursSpent),
      });

      for (const ev of tx.scheduled.where((e) => (e.payload as { queueItemId?: string }).queueItemId === itemId)) {
        this.scheduler.cancel(tx, ev.id);
      }
      this.scheduler.schedule(tx, {
        shardId: view.settlement.shardId,
        executeAt: updated.finishesAt,
        kind: 'BUILD_COMPLETE',
        payload: { queueItemId: updated.id, settlementId: updated.settlementId },
      });

      // GUARDRAIL 4 — disclosure. Shard spending is logged permanently and the
      // 30-day rolling total is public on the profile.
      tx.appendEvent({
        id: this.ids.next('log', this.clock),
        worldId: this.worldId,
        shardId: view.settlement.shardId,
        occurredAt: this.clock,
        kind: 'shards.spent',
        actorId: playerId,
        subjectId: item.settlementId,
        payload: { itemId, shardHours: applied.shardHoursSpent, ceilingReached: applied.ceilingReached },
      });

      return updated;
    });
  }

  /**
   * Dispatch an army, fleet, convoy or agent.
   *
   * The server computes travel time and schedules MOVEMENT_ARRIVE at an exact
   * timestamp, and returns it so the client can display a precise countdown.
   * Arrival precision is what makes coordinated multi-wave attacks work, so the
   * timestamp is never rounded.
   */
  dispatch(args: DispatchArgs): Movement {
    return this.idempotent(args.commandId, (tx) => {
      const origin = tx.settlements.require(args.originId);
      const target = tx.settlements.require(args.targetId);
      if (origin.ownerId !== args.playerId) throw new CommandError('not-owner', 'you do not own the origin settlement');

      // A NAP hard-blocks attacks on the SERVER, not only in the UI. Betrayal
      // is always allowed and always priced — but it has to be an explicit
      // treaty break, not a dispatch that quietly ignores the treaty.
      if (args.mission === 'attack' || args.mission === 'conquer' || args.mission === 'raid') {
        const nap = tx.treaties.find(
          (t) =>
            t.kind === 'nap' && !t.brokenAt &&
            ((t.partyA === args.playerId && t.partyB === target.ownerId) || (t.partyB === args.playerId && t.partyA === target.ownerId)),
        );
        if (nap) {
          throw new CommandError('nap-blocks-attack', 'a non-aggression pact blocks this attack; break it first (48h public notice)', { treatyId: nap.id });
        }
      }

      let slowest = Infinity;
      for (const slice of args.formations) {
        const f = tx.formations.require(slice.formationId);
        if (f.ownerId !== args.playerId) throw new CommandError('not-owner', 'that formation is not yours');
        if (f.settlementId !== args.originId) throw new CommandError('validation', `${f.name} is not at the origin settlement`);
        if (slice.count > f.count) throw new CommandError('validation', `${f.name} has only ${f.count} units`);
        slowest = Math.min(slowest, unitDef(f.unitKey).speed);
        tx.formations.put({ ...f, count: f.count - slice.count });
      }
      if (!Number.isFinite(slowest)) throw new CommandError('validation', 'no formations selected');

      const d = distance(origin.coordX, origin.coordY, target.coordX, target.coordY);
      const travel = travelTimeMs(d, slowest, 1, 1, false);

      const movement: Movement = {
        id: this.ids.next('mv', this.clock),
        shardId: origin.shardId,
        ownerId: args.playerId,
        originId: args.originId,
        targetId: args.targetId,
        mission: args.mission as Movement['mission'],
        formations: args.formations,
        departsAt: this.clock,
        arrivesAt: this.clock + travel,
        revealedTo: [],
      };
      tx.movements.put(movement);

      this.scheduler.schedule(tx, {
        shardId: origin.shardId,
        executeAt: movement.arrivesAt,
        kind: 'MOVEMENT_ARRIVE',
        payload: { movementId: movement.id },
      });

      // The attack warning. Latency budget: under one second (spec/05 §4).
      // Sent the moment the movement enters the defender's warning radius —
      // which, for now, is on dispatch.
      if (target.ownerId && target.ownerId !== args.playerId && movement.mission !== 'reinforce') {
        this.emit('attack.incoming', `player:${target.ownerId}`, {
          movementId: movement.id,
          targetId: target.id,
          arrivesAt: movement.arrivesAt.toString(),
          estimatedSize: args.formations.reduce((n, f) => n + f.count, 0),
          flags: [movement.mission],
        });
      }

      return movement;
    });
  }

  /**
   * Promote a formation into its next veterancy tier.
   *
   * Requires all three conditions: level 1337, the resource cost paid from the
   * home settlement, and a qualifying deed on record. Announced regionally on
   * success — a tier-up is a moment in the world's history, not a menu click.
   */
  tierUp(commandId: Uuid, playerId: Uuid, formationId: Uuid, track: 'atk' | 'def'): Formation {
    return this.idempotent(commandId, (tx) => {
      const f = tx.formations.require(formationId);
      if (f.ownerId !== playerId) throw new CommandError('not-owner', 'that formation is not yours');
      const player = tx.players.require(playerId);
      const home = tx.stockpiles.get(f.settlementId, 'special');

      const check = checkPromotion(f, track, player.era, home?.amount ?? 0n);
      if (!check.eligible) throw new CommandError('tier-up-requirements', check.reason ?? 'not eligible', { cost: check.cost.toString() });

      if (home) tx.stockpiles.put({ ...home, amount: home.amount - check.cost });
      const promoted: Formation =
        track === 'atk'
          ? { ...f, atkTier: f.atkTier + 1, atkLevel: 0, atkXp: 0n }
          : { ...f, defTier: f.defTier + 1, defLevel: 0, defXp: 0n };
      tx.formations.put(promoted);

      tx.appendEvent({
        id: this.ids.next('log', this.clock),
        worldId: this.worldId,
        shardId: tx.settlements.require(f.settlementId).shardId,
        occurredAt: this.clock,
        kind: 'formation.promoted',
        actorId: playerId,
        subjectId: formationId,
        payload: { name: f.name, track, toTier: track === 'atk' ? promoted.atkTier : promoted.defTier, cost: check.cost.toString() },
      });

      return promoted;
    });
  }

  /** Reinforce a formation, diluting its veterancy by headcount. */
  reinforceFormation(commandId: Uuid, playerId: Uuid, formationId: Uuid, addedCount: number): Formation {
    return this.idempotent(commandId, (tx) => {
      const f = tx.formations.require(formationId);
      if (f.ownerId !== playerId) throw new CommandError('not-owner', 'that formation is not yours');
      const out = reinforce(f, addedCount);
      tx.formations.put(out);
      return out;
    });
  }

  // ==========================================================================
  // Event handlers
  // ==========================================================================

  private registerHandlers(): void {
    this.scheduler
      .on('BUILD_COMPLETE', (tx, e, now) => this.onBuildComplete(tx, e, now))
      .on('TRAINING_COMPLETE', (tx, e, now) => this.onTrainingComplete(tx, e, now))
      .on('MOVEMENT_ARRIVE', (tx, e, now) => this.onMovementArrive(tx, e, now))
      .on('HEAVENS_ENVY_RESOLVE', (tx, e, now) => this.onEnvyResolve(tx, e, now));
  }

  private onBuildComplete(tx: Tx, e: ScheduledEvent, now: Millis): void {
    const { queueItemId, settlementId } = e.payload as { queueItemId: string; settlementId: string };
    const item = tx.queue.get(queueItemId);
    if (!item) return; // cancelled before it landed

    const view = this.viewIn(tx, settlementId);
    const existing = view.buildings.find((b) => b.buildingKey === item.targetKey);
    const ref = buildingRef(item.targetKey);

    const building: Building = existing
      ? { ...existing, level: existing.level + 1 }
      : {
          id: this.ids.next('b', now),
          settlementId,
          buildingKey: item.targetKey,
          level: 1,
          damage: 0,
          plotIndex: plotsUsed(view),
          staffedPct: 100,
        };
    tx.buildings.put(building);
    tx.queue.delete(queueItemId);

    // Capacity rises with Logistics buildings, so recompute it here rather than
    // letting a stale cap silently throttle production.
    for (const sp of tx.stockpiles.where((s) => s.settlementId === settlementId)) {
      tx.stockpiles.put({ ...sp, capacity: storageCapacity(this.viewIn(tx, settlementId), sp.resourceKey) });
    }

    tx.appendEvent({
      id: this.ids.next('log', now),
      worldId: this.worldId,
      shardId: view.settlement.shardId,
      occurredAt: now,
      kind: 'building.completed',
      subjectId: settlementId,
      payload: { buildingKey: item.targetKey, level: building.level, slotKind: item.slotKind },
    });

    this.emit('queue.completed', `settlement:${settlementId}`, {
      settlementId,
      itemId: queueItemId,
      kind: item.kind,
      targetKey: item.targetKey,
      newLevel: building.level,
    });

    // A governor with a build order starts the next job immediately — at 2x,
    // and it stalls rather than skipping ahead if it cannot afford it.
    this.runGovernorSpec(tx, settlementId, now);
    void ref;
  }

  private onTrainingComplete(tx: Tx, e: ScheduledEvent, now: Millis): void {
    const { settlementId, unitKey, quantity, formationName } = e.payload as {
      settlementId: string; unitKey: string; quantity: number; formationName: string;
    };
    const settlement = tx.settlements.require(settlementId);
    // Units spawn in their production settlement and must physically travel.
    const existing = tx.formations.find((f) => f.settlementId === settlementId && f.unitKey === unitKey && f.name === formationName);
    if (existing) {
      // Reinforcing dilutes veterancy by headcount — green dilution applies on
      // reinforcement, not on loss.
      tx.formations.put(reinforce(existing, quantity));
    } else {
      tx.formations.put({
        id: this.ids.next('f', now),
        settlementId,
        ownerId: settlement.ownerId!,
        name: formationName,
        unitKey,
        count: quantity,
        atkTier: 1, atkLevel: 0, atkXp: 0n,
        defTier: 1, defLevel: 0, defXp: 0n,
        equipment: {},
        deeds: [],
        createdAt: now,
      });
    }
    this.emit('queue.completed', `settlement:${settlementId}`, {
      settlementId, itemId: e.id, kind: 'training', targetKey: unitKey,
    });
  }

  /**
   * An army arrives. Resolve the engagement and write the report.
   *
   * `now` is the event's SCHEDULED instant, never the wall clock — a worker
   * running late must still resolve the battle as though it happened when it
   * was meant to, or a replay would diverge.
   */
  private onMovementArrive(tx: Tx, e: ScheduledEvent, now: Millis): void {
    const { movementId } = e.payload as { movementId: string };
    const m = tx.movements.get(movementId);
    if (!m) return;
    tx.movements.delete(movementId);

    const target = tx.settlements.require(m.targetId);
    const origin = tx.settlements.get(m.originId);

    if (m.mission === 'reinforce' || m.mission === 'haul' || target.ownerId === m.ownerId) {
      for (const slice of m.formations) {
        const f = tx.formations.get(slice.formationId);
        if (!f) continue;
        tx.formations.put({ ...f, settlementId: m.targetId, count: f.count + slice.count });
      }
      this.emit('movement.arrived', `player:${m.ownerId}`, { movementId, result: 'arrived' });
      return;
    }

    const attackerPlayer = tx.players.get(m.ownerId);
    const defenderPlayer = target.ownerId ? tx.players.get(target.ownerId) : undefined;
    const view = this.viewIn(tx, m.targetId);

    const attackerUnits: CombatUnit[] = [];
    for (const slice of m.formations) {
      const f = tx.formations.get(slice.formationId);
      if (!f) continue;
      attackerUnits.push({
        formationId: f.id, formationName: f.name, unitKey: f.unitKey, count: slice.count,
        tier: f.atkTier, levelInTier: f.atkLevel, equipmentMod: 1,
      });
    }
    const defenderUnits: CombatUnit[] = tx.formations
      .where((f) => f.settlementId === m.targetId)
      .map((f) => ({
        formationId: f.id, formationName: f.name, unitKey: f.unitKey, count: f.count,
        tier: f.defTier, levelInTier: f.defLevel, equipmentMod: 1,
      }));

    const wallGrade = Math.max(
      0,
      ...view.buildings.filter((b) => buildingRef(b.buildingKey).category === 'Defense').map((b) => gradeForLevel(b.level)),
      0,
    );

    const input: BattleInput = {
      battleId: this.ids.next('bt', now),
      settlementName: target.name,
      layer: target.layer,
      mission: m.mission,
      attacker: sideInput(attackerPlayer?.name ?? 'Unknown', attackerPlayer, attackerUnits, this.empireWeightIn(tx, m.ownerId)),
      defender: sideInput(defenderPlayer?.name ?? 'Neutral', defenderPlayer, defenderUnits, target.ownerId ? this.empireWeightIn(tx, target.ownerId) : 0),
      fortification: { wallGrade, flatGarrisonHp: wallGrade * C.GARRISON_HP_PER_WALL_GRADE, concealment: target.terrain.hazards.length * 0.1 },
      plunderable: Object.fromEntries(view.stockpiles.map((s) => [s.resourceKey, s.amount])),
      carryCapacity: BigInt(attackerUnits.reduce((n, u) => n + u.count, 0)) * BigInt(C.CARRY_PER_UNIT),
      hiddenCellar: BigInt(C.HIDDEN_CELLAR),
      defenderLoyalty: target.loyalty,
    };

    // The seed is stored on the battle row, which is what makes the fight
    // re-runnable exactly — by the player in the Simulator, and by a dispute
    // resolver years later.
    const seed = battleSeed(this.worldId, input.battleId);
    const result = resolveBattle(input, rngFromSeed(seed));

    // Casualties.
    for (const [formationId, survivors] of Object.entries(result.survivors)) {
      const f = tx.formations.get(formationId);
      if (!f) continue;
      if (survivors <= 0) {
        // A formation reduced to zero is DESTROYED and loses all accrued
        // veterancy XP. Experience is held by the formation, never banked.
        tx.formations.delete(formationId);
      } else if (attackerUnits.some((u) => u.formationId === formationId)) {
        // Survivors return to the origin carrying their veterancy forward.
        tx.formations.put({ ...f, count: survivors, settlementId: origin?.id ?? f.settlementId });
      } else {
        tx.formations.put({ ...f, count: survivors });
      }
    }

    // Plunder moves as stockpile, from the defender to the attacker's origin.
    for (const [key, amount] of Object.entries(result.plunder)) {
      const from = tx.stockpiles.get(m.targetId, key);
      if (from) tx.stockpiles.put({ ...from, amount: from.amount - amount });
      if (origin) {
        const to = tx.stockpiles.get(origin.id, key);
        tx.stockpiles.put(
          to
            ? { ...to, amount: to.amount + amount }
            : { settlementId: origin.id, resourceKey: key, amount, capacity: BigInt(C.BASE_STORAGE) },
        );
      }
    }

    // Loyalty and capture.
    let updatedTarget: Settlement = { ...target, loyalty: Math.max(0, target.loyalty - result.loyaltyDamage) };
    if (result.captured) {
      updatedTarget = { ...updatedTarget, ownerId: m.ownerId, loyalty: C.CAPTURED_LOYALTY };
      // Captured settlements keep their buildings at -3 grades. Cultivation and
      // Special buildings reset fully — they are bound to their builder.
      for (const b of view.buildings) {
        const ref = buildingRef(b.buildingKey);
        const reset = ref.category === 'Cultivation' || ref.category === 'Special';
        tx.buildings.put({ ...b, level: reset ? 0 : Math.max(0, b.level - C.CAPTURE_GRADE_PENALTY * C.LEVELS_PER_GRADE) });
      }
    }
    tx.settlements.put(updatedTarget);

    // XP attribution runs after resolution, off the critical path.
    const formations = new Map(tx.formations.all().map((f) => [f.id, f]));
    const awards = attributeBattle(input, result, formations, {
      engagementsToday: new Map(),
      attackerEmpireWeight: input.attacker.empireWeight,
      defenderEmpireWeight: input.defender.empireWeight,
      attackerEra: input.attacker.era,
      defenderEra: input.defender.era,
      defenderIsNpc: !target.ownerId,
      attackerIsNpc: !attackerPlayer,
      linkedAccounts:
        attackerPlayer?.linkGroupId !== undefined && attackerPlayer.linkGroupId === defenderPlayer?.linkGroupId,
    });

    for (const award of awards) {
      const f = tx.formations.get(award.formationId);
      if (!f) continue; // destroyed; experience dies with it
      const era = (award.track === 'atk' ? attackerPlayer?.era : defenderPlayer?.era) ?? 1;
      const weight = award.track === 'atk' ? input.attacker.empireWeight : input.defender.empireWeight;
      const after = applyAward(f, award.track, award.xp, weight, era);
      // A battle fought is a deed on record — the third promotion requirement.
      tx.formations.put({ ...after, deeds: [...new Set([...f.deeds, `battle:${input.battleId}`])] });
      result.report.attribution.push(award.summary);
    }

    const battle: Battle = {
      id: input.battleId,
      shardId: target.shardId,
      settlementId: target.id,
      attackerId: m.ownerId,
      defenderId: target.ownerId,
      resolvedAt: now,
      seed,
      report: result.report,
    };
    tx.battles.put(battle);

    tx.appendEvent({
      id: this.ids.next('log', now),
      worldId: this.worldId,
      shardId: target.shardId,
      occurredAt: now,
      kind: 'battle.resolved',
      actorId: m.ownerId,
      subjectId: target.id,
      payload: { battleId: battle.id, outcome: result.report.outcome, captured: result.captured },
    });

    const summary = `${result.report.outcome === 'attacker' ? 'Attacker' : 'Defender'} prevailed at ${target.name}${result.captured ? ' — the settlement changed hands' : ''}.`;
    this.emit('battle.resolved', `settlement:${target.id}`, { battleId: battle.id, settlementId: target.id, outcome: result.report.outcome, summary });
    if (target.ownerId) this.emit('battle.resolved', `player:${target.ownerId}`, { battleId: battle.id, settlementId: target.id, outcome: result.report.outcome, summary });
    this.emit('battle.resolved', `player:${m.ownerId}`, { battleId: battle.id, settlementId: target.id, outcome: result.report.outcome, summary });
  }

  /**
   * The daily Heaven's Envy resolution.
   *
   * Three leaderboards rank shard-hours PURCHASED in a rolling 24h window,
   * resolved at a fixed daily tick. The mark is the point: it is public,
   * cannot be cleansed, and attacking a marked player carries no reputation
   * penalty for the duration (spec/04 §11).
   */
  private onEnvyResolve(tx: Tx, e: ScheduledEvent, now: Millis): void {
    const players = tx.players.all().filter((p) => p.shardHoursPurchased30d > 0);
    // Linked accounts aggregate, so alt-splitting does not dodge the mark.
    const byGroup = new Map<string, Player[]>();
    for (const p of players) {
      const key = p.linkGroupId ?? p.id;
      byGroup.set(key, [...(byGroup.get(key) ?? []), p]);
    }
    const ranked = [...byGroup.values()]
      .map((group) => ({ group, total: group.reduce((n, p) => n + p.shardHoursPurchased30d, 0) }))
      .filter((r) => r.total >= C.ENVY_MIN_SPEND_FLOOR)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    const markedIds = new Set<string>();
    for (const r of ranked) for (const p of r.group) markedIds.add(p.id);

    for (const p of tx.players.all()) {
      const marked = markedIds.has(p.id);
      const scopes = marked ? ['universe'] : [];
      tx.players.put({ ...p, envyScopes: scopes, envyExpiresAt: marked ? now + BigInt(C.ENVY_WINDOW_MS) : undefined });
      if (marked) {
        this.emit('envy.marked', `player:${p.id}`, { playerId: p.id, scopes, expiresAt: (now + BigInt(C.ENVY_WINDOW_MS)).toString() });
      }
    }

    // Re-arm for the next daily tick.
    this.scheduler.schedule(tx, {
      shardId: e.shardId,
      executeAt: now + BigInt(C.ENVY_WINDOW_MS),
      kind: 'HEAVENS_ENVY_RESOLVE',
      payload: {},
    });
    void now;
  }

  /**
   * A governor initiates the next job in its build order — at 2x, with no
   * judgement. If it cannot afford the next item it STALLS rather than skipping
   * ahead, and the stall surfaces on the attention dashboard.
   */
  private runGovernorSpec(tx: Tx, settlementId: Uuid, now: Millis): void {
    const settlement = tx.settlements.get(settlementId);
    if (!settlement?.governorId || !settlement.ownerId) return;
    const gov = tx.governors.get(settlement.governorId);
    if (!gov) return;

    const view = this.viewIn(tx, settlementId);
    if (view.queue.some((q) => q.slotKind === 'governor')) return;

    for (const step of gov.specs.buildOrder) {
      const existing = view.buildings.find((b) => b.buildingKey === step.buildingKey);
      if ((existing?.level ?? 0) >= step.toLevel) continue;
      try {
        this.enqueue({
          commandId: this.ids.next('gc', now),
          playerId: settlement.ownerId,
          settlementId,
          kind: 'building',
          targetKey: step.buildingKey,
          slotKind: 'governor',
        });
      } catch {
        // No judgement. The queue stalls on the first step it cannot start,
        // rather than quietly reordering the player's intent.
        this.emit('governor.stalled', `player:${settlement.ownerId}`, {
          governorId: gov.id,
          settlementId,
          reason: `cannot start ${step.buildingKey}`,
        });
      }
      return;
    }
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /** Persist lazily-accrued production. Called before anything spends. */
  private settleAccrual(tx: Tx, view: SettlementView): void {
    const r = accrueProduction(view, this.clock);
    if (r.lastAccruedAt === view.settlement.lastAccruedAt) return;
    for (const sp of r.stockpiles) tx.stockpiles.put(sp);
    tx.settlements.put({ ...view.settlement, lastAccruedAt: r.lastAccruedAt });
    for (const key of r.overflowed) {
      this.emit('resource.overflow', `settlement:${view.settlement.id}`, { settlementId: view.settlement.id, resourceKey: key });
    }
  }

  private empireWeightIn(tx: Tx, playerId: Uuid): number {
    return adminUpkeep(tx.settlements.where((s) => s.ownerId === playerId).map((s) => holdingRef(s.holdingType).adminCost));
  }

  /** Force accrual now, for a settlement the caller is about to read. */
  refresh(settlementId: Uuid): void {
    this.store.transaction((tx) => this.settleAccrual(tx, this.viewIn(tx, settlementId)));
  }
}

function sideInput(name: string, player: Player | undefined, units: CombatUnit[], empireWeight: number): SideInput {
  return {
    playerId: player?.id,
    playerName: name,
    empireWeight,
    era: player?.era ?? 1,
    units,
    techTier: 1,
    doctrineMod: 1,
    commanderMod: 1,
    envyScopes: player?.envyScopes.length ?? 0,
    munitions: C.STARTING_MUNITIONS,
    statecraft: 0,
    scoutingQuality: 0,
  };
}

function humanise(ms: Millis): string {
  const n = Number(ms);
  if (n <= 0) return 'moments';
  const h = Math.floor(n / 3_600_000);
  const m = Math.floor((n % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export { isOccupier, plotsTotal, productionRows, empireWeightMultiplier, prng };
