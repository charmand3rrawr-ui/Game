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
  GRADES,
  HOLDINGS,
  adminUpkeep,
  countWhere,
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
  type Alliance,
  type AllianceMember,
  type AllianceRole,
  type Governor,
  type GovernorSpecs,
  type GovernorTier,
  type Stockpile,
  type Treaty,
  type TreatyKind,
  type Tribulation,
  type Uuid,
  qiBreakthroughCost,
  prng as prngFor,
} from '@ascendance/shared';
import { MemoryStore } from './store/memory.js';
import type { Store, Tx } from './store/types.js';
import { IdFactory, Scheduler } from './scheduler.js';
import {
  accrueProduction,
  buildingRef,
  buildingsForEra,
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
import {
  defaultFormationName, facilitySpeedFor, trainableHere, trainingCost, trainingSlots,
  validateTrainingEnqueue, type TrainingContext,
} from './sim/military.js';
import {
  disciplinesForEra, knowledgeFactorFor, levelOf, researchCost, researchEffects, researchRef,
  techTier, validateResearchEnqueue, type ResearchLevels,
} from './sim/research.js';
import {
  accrueQi, cultivationAura, gradeRef, qiPerHour, realmName, resolveTribulation,
  tribulationOdds, validateBreakthrough, type QiSources, type TribulationOdds,
} from './sim/cultivation.js';
import {
  auditGovernor, checkEscalation, corruptSpecs, governorTier, nextIntent, postureEffect,
  validateAppointment, type Audit, type Intent,
} from './sim/governor.js';

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

/** What a settlement could do next, with the server's costs already computed. */
export interface Options {
  buildings: { key: string; name: string; category: string; currentLevel: number; cost: Record<string, bigint>; timeMs: Millis }[];
  training: { unitKey: string; name: string; role: string; grade: string; allowed: boolean; reason?: string; cost: Record<string, bigint>; timeMs: Millis }[];
  research: { key: string; name: string; era: number; branch: string; level: number; grade: number; allowed: boolean; reason?: string; cost: Record<string, bigint>; timeMs: Millis }[];
}

/** A player you could plausibly treat with: someone whose holdings you can see. */
export interface KnownPlayer {
  id: Uuid;
  name: string;
  reputation: number;
  allianceId?: Uuid;
  holdings: number;
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
    // Keep the world's clock in step with the drain. A handler that issues a
    // command — a governor starting its next build the moment the last one
    // lands — goes through the same enqueue path a player uses, and that path
    // reads `this.clock`. Left at the pre-drain instant it would set the new
    // job's finishesAt in the past, and the job would complete for free inside
    // the same drain.
    this.scheduler.onInstant = (t) => { if (t > this.clock) this.clock = t; };
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

  /**
   * Every view a player owns, built in one pass over each table.
   *
   * Calling `viewIn` per settlement re-walks the buildings, queue and stockpile
   * tables once for EACH holding — so reading a ten-holding empire scanned every
   * building in the world ten times over. Since there is no cap on holdings and
   * the empire is meant to grow without limit (spec/04 §6), that cost grows as
   * the square of exactly the thing the game encourages.
   *
   * Here each table is walked once and its rows dropped into the bucket for
   * their settlement, so the work is proportional to the tables plus the
   * holdings rather than their product. The per-settlement `viewIn` is still
   * the right call for a single holding; this is for the whole-empire reads
   * (Qi income, admin upkeep) that run on every header render.
   */
  private viewsOfOwner(tx: Tx, playerId: Uuid): SettlementView[] {
    const views = new Map<Uuid, SettlementView>();
    for (const s of tx.settlements.all()) {
      if (s.ownerId === playerId) views.set(s.id, { settlement: s, buildings: [], queue: [], stockpiles: [] });
    }
    if (views.size === 0) return [];

    for (const b of tx.buildings.all()) views.get(b.settlementId)?.buildings.push(b);
    for (const q of tx.queue.all()) views.get(q.settlementId)?.queue.push(q);
    for (const sp of tx.stockpiles.all()) views.get(sp.settlementId)?.stockpiles.push(sp);

    // Queue order is load-bearing — slots are consumed in position order — so
    // it is restored per holding, on lists that are only a few items long.
    const out: SettlementView[] = [];
    for (const v of views.values()) {
      v.queue.sort((a, b) => a.position - b.position);
      out.push(v);
    }
    return out;
  }

  /**
   * A player, with lazily-accrued values brought up to date.
   *
   * Qi is banked on the row but accrues continuously, so reading the raw row
   * would show a number that disagrees with the cultivation screen. One stale
   * number in a header is worse than no number at all.
   */
  player(id: Uuid): Player {
    return this.store.read((tx) => {
      const p = tx.players.require(id);
      const income = qiPerHour(this.viewsOfOwner(tx, id));
      return {
        ...p,
        qi: accrueQi(p.qi, income.perHour, p.temporalDebt, p.lastQiAccruedAt ?? p.createdAt, this.clock),
      };
    });
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
      // Every holding's view in one pass. This screen reads the whole empire on
      // every open, and a per-holding viewIn re-walked all three tables per
      // holding — the cost of checking on a wide empire grew with its square.
      const views = this.viewsOfOwner(tx, playerId);

      for (const view of views) {
        const s = view.settlement;
        const hq = gradeForLevel(hqLevel(view));

        // Idle build queues, by settlement. An empty personal slot is unspent
        // time, and in a game measured in months that compounds.
        //
        // Both slot kinds are counted in ONE walk of the queue. Two `filter`
        // calls built two throwaway arrays only to read their lengths.
        let personalUsed = 0;
        let governorUsed = 0;
        for (const q of view.queue) {
          if (q.slotKind === 'personal') personalUsed++;
          else if (q.slotKind === 'governor') governorUsed++;
        }
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
        if (gov && governorUsed === 0 && gov.specs.buildOrder.length > 0) {
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
      const owned = new Set(views.map((v) => v.settlement.id));
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
    // Each kind has its own gates, its own cost curve and its own slot pool.
    // They share only the queue row and the rule that finishesAt is computed
    // once and stored absolute (invariant §2.8).
    if (args.kind === 'training') return this.enqueueTraining(args);
    if (args.kind === 'research') return this.enqueueResearch(args);
    return this.enqueueBuilding(args);
  }

  private enqueueBuilding(args: EnqueueArgs): QueueItem {
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

  /**
   * Train a batch of units.
   *
   * They spawn in THIS settlement and must physically travel to be anywhere
   * else (spec/04 §4). There is no empire-wide muster: an army exists where it
   * was built, and moving it is a movement that can be seen and intercepted.
   */
  private enqueueTraining(args: EnqueueArgs): QueueItem {
    return this.idempotent(args.commandId, (tx) => {
      const view = this.viewIn(tx, args.settlementId);
      if (view.settlement.ownerId !== args.playerId) {
        throw new CommandError('not-owner', 'you do not own this settlement');
      }
      const quantity = args.quantity ?? 1;
      const ctx = this.trainingContext(tx, args.playerId, args.settlementId);

      const check = validateTrainingEnqueue(ctx, args.targetKey, quantity);
      if (!check.ok) throw new CommandError(check.type, check.detail, check.meta);

      const timeMultiplier = args.slotKind === 'governor' ? C.GOVERNOR_TIME_MULT : C.PLAYER_TIME_MULT;
      const cost = trainingCost(args.targetKey, quantity, facilitySpeedFor(view), timeMultiplier);

      this.settleAccrual(tx, view);
      const afford = validateAffordable(this.viewIn(tx, args.settlementId), cost.resources);
      if (!afford.ok) throw new CommandError(afford.type, afford.detail, afford.meta);
      for (const [key, amount] of Object.entries(cost.resources)) {
        const sp = tx.stockpiles.get(args.settlementId, key);
        if (sp) tx.stockpiles.put({ ...sp, amount: sp.amount - amount });
      }

      const def = unitDef(args.targetKey);
      const existing = tx.formations.where((f) => f.settlementId === args.settlementId && f.unitKey === args.targetKey);
      const item: QueueItem = {
        id: this.ids.next('q', this.clock),
        settlementId: args.settlementId,
        kind: 'training',
        targetKey: args.targetKey,
        quantity,
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
        kind: 'TRAINING_COMPLETE',
        payload: {
          queueItemId: item.id,
          settlementId: args.settlementId,
          unitKey: args.targetKey,
          quantity,
          formationName: existing[0]?.name ?? defaultFormationName(def, existing.length),
        },
      });

      tx.appendEvent({
        id: this.ids.next('log', this.clock),
        worldId: this.worldId,
        shardId: view.settlement.shardId,
        occurredAt: this.clock,
        kind: 'training.enqueued',
        actorId: args.playerId,
        subjectId: args.settlementId,
        payload: { unitKey: args.targetKey, quantity, finishesAt: item.finishesAt.toString() },
      });

      return item;
    });
  }

  /**
   * Raise a research discipline by one level.
   *
   * THE LEVEL IS GLOBAL; THE COST IS LOCAL. Research is the single exception to
   * production isolation (spec/04 §3) — but the resources come out of the
   * settlement that hosts the work, and it occupies that settlement's queue
   * slot. That split is what makes a wide empire playable without dissolving
   * the isolation invariant.
   */
  private enqueueResearch(args: EnqueueArgs): QueueItem {
    return this.idempotent(args.commandId, (tx) => {
      const view = this.viewIn(tx, args.settlementId);
      if (view.settlement.ownerId !== args.playerId) {
        throw new CommandError('not-owner', 'you do not own this settlement');
      }
      const player = tx.players.require(args.playerId);
      const levels = this.researchLevels(tx, args.playerId);

      const check = validateResearchEnqueue(args.targetKey, {
        levels,
        playerEra: player.era,
        cultivationGrade: player.cultivationGrade,
        hasKnowledgeBuilding: view.buildings.some((b) => buildingRef(b.buildingKey).category === 'Knowledge'),
      });
      if (!check.ok) throw new CommandError(check.type, check.detail, check.meta);

      // A discipline may only be in progress once at a time anywhere in the
      // empire. Without this, a wide player could queue the same level in
      // forty settlements and buy the global level forty times over.
      const already = tx.queue.find(
        (q) => q.kind === 'research' && q.targetKey === args.targetKey &&
          tx.settlements.get(q.settlementId)?.ownerId === args.playerId,
      );
      if (already) {
        throw new CommandError('validation', `${researchRef(args.targetKey).name} is already being researched`, {
          settlementId: already.settlementId,
        });
      }

      const slotKind = args.slotKind;
      const used = countWhere(view.queue, (q) => q.slotKind === slotKind && q.kind !== 'training');
      const available = slotKind === 'personal'
        ? personalQueueSlots(gradeForLevel(hqLevel(view)))
        : C.GOVERNOR_QUEUE_SLOTS;
      if (used >= available) {
        throw new CommandError(
          slotKind === 'personal' ? 'no-free-personal-slot' : 'no-free-queue-slot',
          `all ${available} ${slotKind} slots are busy`,
          { used, available, slotKind },
        );
      }

      const bestKnowledge = Math.max(
        0,
        ...view.buildings.filter((b) => buildingRef(b.buildingKey).category === 'Knowledge').map((b) => b.level),
        0,
      );
      const timeMultiplier = slotKind === 'governor' ? C.GOVERNOR_TIME_MULT : C.PLAYER_TIME_MULT;
      const fromLevel = levelOf(levels, args.targetKey);
      const cost = researchCost(args.targetKey, fromLevel, knowledgeFactorFor(bestKnowledge), timeMultiplier);

      this.settleAccrual(tx, view);
      const afford = validateAffordable(this.viewIn(tx, args.settlementId), cost.resources);
      if (!afford.ok) throw new CommandError(afford.type, afford.detail, afford.meta);
      for (const [key, amount] of Object.entries(cost.resources)) {
        const sp = tx.stockpiles.get(args.settlementId, key);
        if (sp) tx.stockpiles.put({ ...sp, amount: sp.amount - amount });
      }

      const item: QueueItem = {
        id: this.ids.next('q', this.clock),
        settlementId: args.settlementId,
        kind: 'research',
        targetKey: args.targetKey,
        targetLevel: fromLevel + 1,
        quantity: 1,
        slotKind,
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
        kind: 'RESEARCH_COMPLETE',
        payload: { queueItemId: item.id, settlementId: args.settlementId, playerId: args.playerId, researchKey: args.targetKey },
      });

      tx.appendEvent({
        id: this.ids.next('log', this.clock),
        worldId: this.worldId,
        shardId: view.settlement.shardId,
        occurredAt: this.clock,
        kind: 'research.enqueued',
        actorId: args.playerId,
        subjectId: args.settlementId,
        payload: { researchKey: args.targetKey, toLevel: fromLevel + 1 },
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

      // Refund what this kind of item actually cost. A training batch and a
      // research level do not ride the building curve, and refunding them as
      // though they did would hand back the wrong resources.
      const resources = this.costOf(tx, item, view);
      const refunded: Record<string, string> = {};
      for (const [key, amount] of Object.entries(resources)) {
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

  /** What a queue item cost when it was enqueued, by kind. */
  private costOf(tx: Tx, item: QueueItem, view: SettlementView): Record<string, bigint> {
    if (item.kind === 'training') {
      return trainingCost(item.targetKey, item.quantity, facilitySpeedFor(view), item.timeMultiplier).resources;
    }
    if (item.kind === 'research') {
      const owner = view.settlement.ownerId;
      const level = owner ? levelOf(this.researchLevels(tx, owner), item.targetKey) : 0;
      const bestKnowledge = Math.max(
        0,
        ...view.buildings.filter((b) => buildingRef(b.buildingKey).category === 'Knowledge').map((b) => b.level),
        0,
      );
      return researchCost(item.targetKey, level, knowledgeFactorFor(bestKnowledge), item.timeMultiplier).resources;
    }
    const existing = view.buildings.find((b) => b.buildingKey === item.targetKey);
    return upgradeCost(item.targetKey, existing?.level ?? 0, hqFactorFor(hqLevel(view)), 1, item.timeMultiplier).resources;
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

      const personalUsed = countWhere(view.queue, (q) => q.slotKind === 'personal');
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
      this.rescheduleCompletion(tx, seized, view);

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
      this.rescheduleCompletion(tx, updated, view);

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
            t.kind === 'nap' &&
            // IN FORCE, not merely proposed. Blocking on an unsigned proposal
            // would let anyone freeze an enemy's armies by spamming offers.
            t.signedAt > 0n &&
            // And not yet lapsed: breaking a NAP takes 48h of public notice,
            // during which it still binds.
            (t.brokenAt === undefined || t.brokenAt > this.clock) &&
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

  /**
   * Declare a breakthrough.
   *
   * Qi is spent NOW and a tribulation opens. This is not a purchase: several
   * trials are publicly visible and can be crashed by rivals, so the moment
   * between declaring and resolving is real, exposed time (spec/04 §10).
   *
   * Chrono Shards cannot touch any of it — cultivation breakthroughs are on
   * the prohibition list, and the Temporal Debt from having spent shards
   * elsewhere makes this harder. This is where buying time is paid for.
   */
  beginBreakthrough(commandId: Uuid, playerId: Uuid, settlementId: Uuid): Tribulation {
    return this.idempotent(commandId, (tx) => {
      const player = tx.players.require(playerId);
      const settlement = tx.settlements.require(settlementId);
      if (settlement.ownerId !== playerId) throw new CommandError('not-owner', 'you do not own this settlement');

      const income = qiPerHour(this.viewsOfOwner(tx, playerId));
      const qi = accrueQi(player.qi, income.perHour, player.temporalDebt, player.lastQiAccruedAt ?? player.createdAt, this.clock);

      const check = validateBreakthrough({
        grade: player.cultivationGrade,
        qi,
        temporalDebt: player.temporalDebt,
        reputation: player.reputation,
        stunnedUntil: player.cultivationStunnedUntil,
        now: this.clock,
        tribulationOpen: tx.tribulations.find((t) => t.playerId === playerId) !== undefined,
      });
      if (!check.ok) throw new CommandError(check.type, check.detail, check.meta);

      const next = player.cultivationGrade + 1;
      const cost = qiBreakthroughCost(next);
      const trial = gradeRef(player.cultivationGrade).trial;

      tx.players.put({ ...player, qi: qi - cost, lastQiAccruedAt: this.clock });

      const tribulation: Tribulation = {
        id: this.ids.next('tb', this.clock),
        playerId,
        worldId: this.worldId,
        shardId: settlement.shardId,
        grade: player.cultivationGrade,
        trialName: trial.name,
        visible: trial.visible,
        crashable: trial.crashable,
        qiSpent: cost,
        settlementId,
        openedAt: this.clock,
        resolvesAt: this.clock + BigInt(C.TRIBULATION_WINDOW_MS),
        interferers: [],
      };
      tx.tribulations.put(tribulation);

      this.scheduler.schedule(tx, {
        shardId: settlement.shardId,
        executeAt: tribulation.resolvesAt,
        kind: 'TRIBULATION_WINDOW',
        payload: { tribulationId: tribulation.id },
      });

      tx.appendEvent({
        id: this.ids.next('log', this.clock),
        worldId: this.worldId,
        shardId: settlement.shardId,
        occurredAt: this.clock,
        kind: 'tribulation.opened',
        actorId: playerId,
        subjectId: settlementId,
        payload: {
          grade: next, trial: trial.name, visible: trial.visible, crashable: trial.crashable,
          qiSpent: cost.toString(), resolvesAt: tribulation.resolvesAt.toString(),
        },
      });

      // A visible tribulation is announced to the world. That is the point of
      // it being visible: rivals are meant to know, and are meant to come.
      if (trial.visible) {
        this.emit('tribulation.opened', `map:${settlement.shardId}`, {
          tribulationId: tribulation.id,
          playerId,
          playerName: player.name,
          settlementId,
          trial: trial.name,
          crashable: trial.crashable,
          resolvesAt: tribulation.resolvesAt.toString(),
        });
      }

      return tribulation;
    });
  }

  /**
   * Crash someone else's tribulation.
   *
   * Only a trial the workbook marks crashable, only while it is open, and only
   * once per rival. Each interferer lowers the odds but none of them can make
   * it impossible — a breakthrough can always be earned through a crowd.
   */
  interfere(commandId: Uuid, playerId: Uuid, tribulationId: Uuid): Tribulation {
    return this.idempotent(commandId, (tx) => {
      const t = tx.tribulations.get(tribulationId);
      if (!t) throw new CommandError('not-found', 'no such tribulation');
      if (t.playerId === playerId) throw new CommandError('validation', 'you cannot crash your own tribulation');
      if (!t.visible) throw new CommandError('validation', 'that tribulation is not visible to you');
      if (!t.crashable) {
        throw new CommandError('validation', `a ${t.trialName} cannot be interfered with`, { trial: t.trialName });
      }
      if (t.resolvesAt <= this.clock) throw new CommandError('already-complete', 'that tribulation has resolved');
      if (t.interferers.includes(playerId)) {
        throw new CommandError('validation', 'you are already interfering with it');
      }

      const updated: Tribulation = { ...t, interferers: [...t.interferers, playerId] };
      tx.tribulations.put(updated);

      tx.appendEvent({
        id: this.ids.next('log', this.clock),
        worldId: this.worldId,
        shardId: t.shardId,
        occurredAt: this.clock,
        kind: 'tribulation.crashed',
        actorId: playerId,
        subjectId: t.playerId,
        payload: { tribulationId, trial: t.trialName, interferers: updated.interferers.length },
      });

      // The victim is told. Being crashed in silence would be indistinguishable
      // from bad luck, and the whole mechanic depends on knowing who did it.
      this.emit('tribulation.crashed', `player:${t.playerId}`, {
        tribulationId, by: playerId, interferers: updated.interferers.length,
      });

      return updated;
    });
  }

  // ==========================================================================
  // Governors — automation priced in time, never in efficiency
  // ==========================================================================

  /**
   * Appoint a governor over an area.
   *
   * The area is a LAYER, not a list the player curates: a Bailiff governs a
   * province and therefore every holding you have in it. That is what makes
   * governors scale with an empire instead of needing re-appointment every time
   * you found something.
   */
  appointGovernor(args: {
    commandId: Uuid; playerId: Uuid; commanderId: Uuid; tier: GovernorTier;
    settlementIds: Uuid[]; specs: GovernorSpecs; commanderLevel: number;
  }): Governor {
    return this.idempotent(args.commandId, (tx) => {
      const settlements = args.settlementIds.map((id) => tx.settlements.require(id));
      for (const s of settlements) {
        if (s.ownerId !== args.playerId) throw new CommandError('not-owner', `${s.name} is not yours`);
      }

      const mandated = new Set<string>();
      for (const g of tx.governors.where((g) => g.playerId === args.playerId)) {
        for (const key of g.specs.researchMandate) mandated.add(key);
      }

      const check = validateAppointment({
        tier: args.tier,
        commanderLevel: args.commanderLevel,
        settlements,
        mandatedDisciplines: mandated,
        specs: args.specs,
      });
      if (!check.ok) throw new CommandError(check.type, check.detail, check.meta);

      const governor: Governor = {
        id: this.ids.next('gv', this.clock),
        playerId: args.playerId,
        commanderId: args.commanderId,
        tier: args.tier,
        areaRef: { layer: settlements[0]!.layer, settlementIds: args.settlementIds },
        specs: args.specs,
        appointedAt: this.clock,
      };
      tx.governors.put(governor);
      for (const s of settlements) tx.settlements.put({ ...s, governorId: governor.id });

      tx.appendEvent({
        id: this.ids.next('log', this.clock),
        worldId: this.worldId,
        shardId: settlements[0]!.shardId,
        occurredAt: this.clock,
        kind: 'governor.appointed',
        actorId: args.playerId,
        subjectId: governor.id,
        payload: { tier: args.tier, holdings: args.settlementIds.length, commanderId: args.commanderId },
      });

      // Start immediately rather than waiting for the next completion, or a
      // fresh appointment looks broken for as long as the first job would take.
      for (const s of settlements) this.runGovernorSpec(tx, s.id, this.clock);

      return governor;
    });
  }

  /**
   * Rewrite a governor's specs. Takes effect on the NEXT initiation.
   *
   * Never retroactively: a job already running was initiated under the old spec
   * and finishes under it. Rewriting history mid-build would break the one
   * promise the queue makes — that `finishesAt` is computed once (§2.8).
   */
  updateGovernorSpecs(commandId: Uuid, playerId: Uuid, governorId: Uuid, specs: GovernorSpecs): Governor {
    return this.idempotent(commandId, (tx) => {
      const g = tx.governors.require(governorId);
      if (g.playerId !== playerId) throw new CommandError('not-owner', 'that governor is not yours');

      const mandated = new Set<string>();
      for (const other of tx.governors.where((x) => x.playerId === playerId && x.id !== governorId)) {
        for (const key of other.specs.researchMandate) mandated.add(key);
      }
      const check = validateAppointment({
        tier: g.tier,
        commanderLevel: governorTier(g.tier).commanderLevel,
        settlements: g.areaRef.settlementIds.map((id) => tx.settlements.require(id)),
        mandatedDisciplines: mandated,
        specs,
      });
      if (!check.ok) throw new CommandError(check.type, check.detail, check.meta);

      const updated: Governor = { ...g, specs };
      tx.governors.put(updated);
      return updated;
    });
  }

  dismissGovernor(commandId: Uuid, playerId: Uuid, governorId: Uuid): { dismissed: true } {
    return this.idempotent(commandId, (tx) => {
      const g = tx.governors.require(governorId);
      if (g.playerId !== playerId) throw new CommandError('not-owner', 'that governor is not yours');
      for (const id of g.areaRef.settlementIds) {
        const s = tx.settlements.get(id);
        if (s?.governorId === governorId) tx.settlements.put({ ...s, governorId: undefined });
      }
      tx.governors.delete(governorId);
      return { dismissed: true as const };
    });
  }

  /**
   * Audit a governor.
   *
   * The ONLY way to discover a subverted one. A turned governor follows
   * corrupted specs silently (spec/04 §9), so nothing on a normal read gives it
   * away — which is precisely why this command has to exist and why a
   * suspicious player has to spend an action on it.
   */
  audit(commandId: Uuid, playerId: Uuid, governorId: Uuid): Audit {
    return this.idempotent(commandId, (tx) => {
      const g = tx.governors.require(governorId);
      if (g.playerId !== playerId) throw new CommandError('not-owner', 'that governor is not yours');
      const result = auditGovernor(g, (g as Governor & { writtenSpecs?: GovernorSpecs }).writtenSpecs ?? g.specs);

      tx.appendEvent({
        id: this.ids.next('log', this.clock),
        worldId: this.worldId,
        shardId: tx.settlements.require(g.areaRef.settlementIds[0]!).shardId,
        occurredAt: this.clock,
        kind: 'governor.audited',
        actorId: playerId,
        subjectId: governorId,
        payload: { subverted: result.subverted, findings: result.findings },
      });
      return result;
    });
  }

  /**
   * Turn someone else's governor rather than killing them.
   *
   * The corrupted specs are applied and the ORIGINAL is kept so an audit has
   * something to compare against. The victim is told nothing.
   */
  subvertGovernor(commandId: Uuid, spymasterId: Uuid, governorId: Uuid): { subverted: true } {
    return this.idempotent(commandId, (tx) => {
      const g = tx.governors.require(governorId);
      if (g.playerId === spymasterId) throw new CommandError('validation', 'that governor is already yours');
      if (g.subvertedBy) throw new CommandError('validation', 'that governor has already been turned');

      tx.governors.put({
        ...g,
        subvertedBy: spymasterId,
        specs: corruptSpecs(g.specs),
        // Kept so an audit can show the player what they actually wrote.
        writtenSpecs: g.specs,
      } as Governor & { writtenSpecs: GovernorSpecs });

      // Logged, because the World Atlas remembers everything — but NOT emitted
      // to the victim. A subversion they are told about is a status effect.
      tx.appendEvent({
        id: this.ids.next('log', this.clock),
        worldId: this.worldId,
        shardId: tx.settlements.require(g.areaRef.settlementIds[0]!).shardId,
        occurredAt: this.clock,
        kind: 'governor.subverted',
        actorId: spymasterId,
        subjectId: governorId,
        payload: { victim: g.playerId },
      });
      return { subverted: true as const };
    });
  }

  /** Assassinate a governor: the whole area stops initiating anything. */
  assassinateGovernor(commandId: Uuid, killerId: Uuid, governorId: Uuid): { killed: true } {
    return this.idempotent(commandId, (tx) => {
      const g = tx.governors.require(governorId);
      if (g.playerId === killerId) throw new CommandError('validation', 'that governor is yours');
      // Running jobs continue; nothing new starts. The area is not destroyed,
      // it is paralysed — which is worse, and quieter.
      tx.governors.put({ ...g, commanderId: '' });
      this.emit('governor.stalled', `player:${g.playerId}`, {
        governorId, settlementId: g.areaRef.settlementIds[0], reason: 'the governor is dead',
      });
      return { killed: true as const };
    });
  }

  governorsOf(playerId: Uuid): Governor[] {
    return this.store.read((tx) => tx.governors.where((g) => g.playerId === playerId));
  }

  /**
   * The level of the best officer this player can put over a province.
   *
   * ASSUMED — see DECISIONS.md D6. The workbook gates each
   * governor tier on a commander level — Bailiff 5, Planetary 15, System 25,
   * Sector 40 — but ships no Commanders sheet saying where a commander's level
   * comes from, and nothing in the spec set defines one.
   *
   * Those four numbers place themselves, though. 5 through 40 is nowhere on the
   * 1–42 cultivation ladder (a Bailiff would need most of Era II, a Sector
   * Governor would be endgame) and sits naturally near the bottom of the 0–1337
   * level ladder that veterancy, formations and the Grades table all share. So
   * a commander's level is read as a level on THAT ladder, and the best
   * commander a player can field is the most experienced formation they have:
   * someone who has actually led troops.
   *
   * The consequences are the ones the workbook's notes describe. A brand-new
   * player has nobody — every formation is green at level 0 — so delegation is
   * something you earn by fighting, not something you start with. Level 5 comes
   * quickly once a formation has seen action; level 40 wants a genuinely
   * veteran officer. When a Commanders sheet arrives this is the one function
   * to replace.
   *
   * It exists so the API never takes the level from the client. A client that
   * could state it could appoint a Sector Governor on day one.
   */
  commanderLevelOf(playerId: Uuid): number {
    return this.store.read((tx) => {
      let best = 0;
      for (const f of tx.formations.where((f) => f.ownerId === playerId)) {
        // Either track qualifies. An officer who has only ever held a wall is
        // still an officer.
        best = Math.max(best, f.atkLevel, f.defLevel);
      }
      return best;
    });
  }

  // ==========================================================================
  // Alliances and treaties
  // ==========================================================================

  createAlliance(commandId: Uuid, playerId: Uuid, name: string, tag: string): Alliance {
    return this.idempotent(commandId, (tx) => {
      const player = tx.players.require(playerId);
      if (player.allianceId) throw new CommandError('validation', 'you are already in an alliance');
      if (tx.alliances.find((a) => a.tag.toLowerCase() === tag.toLowerCase())) {
        throw new CommandError('validation', `the tag ${tag} is taken`);
      }

      const alliance: Alliance = {
        id: this.ids.next('al', this.clock),
        worldId: this.worldId,
        name,
        tag,
        treasury: {},
        foundedAt: this.clock,
      };
      tx.alliances.put(alliance);
      tx.allianceMembers.put({
        allianceId: alliance.id, playerId, role: 'leader',
        permissions: ['all'], joinedAt: this.clock,
      });
      tx.players.put({ ...player, allianceId: alliance.id });
      return alliance;
    });
  }

  joinAlliance(commandId: Uuid, playerId: Uuid, allianceId: Uuid, role: AllianceRole = 'member'): AllianceMember {
    return this.idempotent(commandId, (tx) => {
      const player = tx.players.require(playerId);
      if (player.allianceId) throw new CommandError('validation', 'you are already in an alliance');
      tx.alliances.require(allianceId);

      // Up to 60 members (spec/04 §7). An alliance that can absorb a server is
      // not an alliance, it is the server.
      const members = tx.allianceMembers.where((m) => m.allianceId === allianceId);
      if (members.length >= C.ALLIANCE_MAX_MEMBERS) {
        throw new CommandError('validation', `an alliance holds at most ${C.ALLIANCE_MAX_MEMBERS} members`, {
          limit: C.ALLIANCE_MAX_MEMBERS,
        });
      }

      const member: AllianceMember = { allianceId, playerId, role, permissions: [], joinedAt: this.clock };
      tx.allianceMembers.put(member);
      tx.players.put({ ...player, allianceId });
      this.emit('treaty.proposed', `alliance:${allianceId}`, {
        treatyId: '', from: playerId, kind: 'joined', terms: { role },
      });
      return member;
    });
  }

  /**
   * Propose a treaty. It binds only once the counterparty accepts.
   *
   * Treaties carry mechanical teeth, not just text (spec/04 §7): a NAP
   * hard-blocks attacks on the server, which `dispatch` already enforces.
   */
  proposeTreaty(args: {
    commandId: Uuid; playerId: Uuid; counterpartyId: Uuid; kind: TreatyKind;
    terms: Record<string, unknown>; expiresAt?: Millis;
  }): Treaty {
    return this.idempotent(args.commandId, (tx) => {
      tx.players.require(args.counterpartyId);
      if (args.counterpartyId === args.playerId) throw new CommandError('validation', 'you cannot treat with yourself');

      const treaty: Treaty = {
        id: this.ids.next('tr', this.clock),
        kind: args.kind,
        partyA: args.playerId,
        partyB: args.counterpartyId,
        // Unsigned until accepted: `signedAt` is what `dispatch` checks.
        terms: { ...args.terms, accepted: false },
        signedAt: 0n,
        expiresAt: args.expiresAt,
      };
      tx.treaties.put(treaty);

      this.emit('treaty.proposed', `player:${args.counterpartyId}`, {
        treatyId: treaty.id, from: args.playerId, kind: args.kind, terms: args.terms,
      });
      return treaty;
    });
  }

  acceptTreaty(commandId: Uuid, playerId: Uuid, treatyId: Uuid): Treaty {
    return this.idempotent(commandId, (tx) => {
      const t = tx.treaties.require(treatyId);
      if (t.partyB !== playerId) throw new CommandError('not-owner', 'that proposal was not made to you');
      if (t.signedAt > 0n) throw new CommandError('already-complete', 'that treaty is already in force');

      const signed: Treaty = { ...t, signedAt: this.clock, terms: { ...t.terms, accepted: true } };
      tx.treaties.put(signed);

      tx.appendEvent({
        id: this.ids.next('log', this.clock),
        worldId: this.worldId,
        shardId: 'world',
        occurredAt: this.clock,
        kind: 'treaty.signed',
        actorId: playerId,
        subjectId: t.partyA,
        payload: { treatyId, kind: t.kind },
      });
      return signed;
    });
  }

  /**
   * Break a treaty.
   *
   * ALWAYS ALLOWED, ALWAYS PRICED (spec/04 §7). Reputation never blocks an
   * action — betrayal is a move, not an exploit — but a NAP requires 48 hours
   * of public notice, and breaking one early costs reputation on top.
   */
  breakTreaty(commandId: Uuid, playerId: Uuid, treatyId: Uuid): { treaty: Treaty; reputationLost: number; effectiveAt: Millis } {
    return this.idempotent(commandId, (tx) => {
      const t = tx.treaties.require(treatyId);
      if (t.partyA !== playerId && t.partyB !== playerId) {
        throw new CommandError('not-owner', 'you are not party to that treaty');
      }
      if (t.brokenAt) throw new CommandError('already-complete', 'that treaty is already broken');

      const player = tx.players.require(playerId);
      const other = t.partyA === playerId ? t.partyB : t.partyA;

      // A NAP takes 48 hours of public notice to leave. Walking out without it
      // is possible and costs more — that is what "always priced" means.
      const notice = t.kind === 'nap' ? BigInt(C.NAP_NOTICE_MS) : 0n;
      const effectiveAt = this.clock + notice;
      const penalty = t.kind === 'nap' ? C.REPUTATION_NAP_BREAK : C.REPUTATION_TREATY_BREAK;

      tx.treaties.put({ ...t, brokenAt: effectiveAt });
      tx.players.put({ ...player, reputation: player.reputation - penalty });

      tx.appendEvent({
        id: this.ids.next('log', this.clock),
        worldId: this.worldId,
        shardId: 'world',
        occurredAt: this.clock,
        kind: 'treaty.broken',
        actorId: playerId,
        subjectId: other,
        payload: { treatyId, kind: t.kind, effectiveAt: effectiveAt.toString(), reputationLost: penalty },
      });

      // The other party is told immediately. A NAP that lapses silently is a
      // trap, and the 48 hours exist precisely so it is not one.
      this.emit('treaty.proposed', `player:${other}`, {
        treatyId, from: playerId, kind: `${t.kind}-broken`, terms: { effectiveAt: effectiveAt.toString() },
      });

      return { treaty: { ...t, brokenAt: effectiveAt }, reputationLost: penalty, effectiveAt };
    });
  }

  treatiesOf(playerId: Uuid): Treaty[] {
    return this.store.read((tx) => tx.treaties.where((t) => t.partyA === playerId || t.partyB === playerId));
  }

  /**
   * Everyone this player could plausibly treat with.
   *
   * Diplomacy needs a counterparty list, and "every player in the world" is the
   * wrong one — it would name people the player has never seen. This is the
   * owners of settlements on the player's own shard, which is what a map
   * already discloses.
   */
  knownPlayers(playerId: Uuid): KnownPlayer[] {
    return this.store.read((tx) => {
      const shards = new Set(tx.settlements.where((s) => s.ownerId === playerId).map((s) => s.shardId));
      const holdings = new Map<Uuid, number>();
      for (const s of tx.settlements.all()) {
        if (s.ownerId === undefined || s.ownerId === playerId || !shards.has(s.shardId)) continue;
        holdings.set(s.ownerId, (holdings.get(s.ownerId) ?? 0) + 1);
      }
      const out: KnownPlayer[] = [];
      for (const [id, count] of holdings) {
        const p = tx.players.get(id);
        if (!p) continue;
        out.push({ id, name: p.name, reputation: p.reputation, allianceId: p.allianceId, holdings: count });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  allianceOf(playerId: Uuid): { alliance: Alliance; members: AllianceMember[] } | undefined {
    return this.store.read((tx) => {
      const player = tx.players.require(playerId);
      if (!player.allianceId) return undefined;
      const alliance = tx.alliances.get(player.allianceId);
      if (!alliance) return undefined;
      return { alliance, members: tx.allianceMembers.where((m) => m.allianceId === alliance.id) };
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

  /**
   * Re-arm a queue item's completion event after Seize or a shard spend.
   *
   * Both of those move `finishesAt` downward, which means the old event is
   * wrong and a new one must replace it — and it has to be the RIGHT kind, or
   * a seized training batch would complete as a building.
   */
  private rescheduleCompletion(tx: Tx, item: QueueItem, view: SettlementView): void {
    const kind = item.kind === 'training' ? 'TRAINING_COMPLETE'
      : item.kind === 'research' ? 'RESEARCH_COMPLETE'
        : 'BUILD_COMPLETE';
    const base = { queueItemId: item.id, settlementId: item.settlementId };
    const payload =
      kind === 'TRAINING_COMPLETE'
        ? {
            ...base,
            unitKey: item.targetKey,
            quantity: item.quantity,
            formationName:
              tx.formations.find((f) => f.settlementId === item.settlementId && f.unitKey === item.targetKey)?.name ??
              defaultFormationName(unitDef(item.targetKey), 0),
          }
        : kind === 'RESEARCH_COMPLETE'
          ? { ...base, playerId: view.settlement.ownerId, researchKey: item.targetKey }
          : base;

    this.scheduler.schedule(tx, {
      shardId: view.settlement.shardId,
      executeAt: item.finishesAt,
      kind,
      payload,
    });
  }

  // ==========================================================================
  // Event handlers
  // ==========================================================================

  private registerHandlers(): void {
    this.scheduler
      .on('BUILD_COMPLETE', (tx, e, now) => this.onBuildComplete(tx, e, now))
      .on('TRAINING_COMPLETE', (tx, e, now) => this.onTrainingComplete(tx, e, now))
      .on('RESEARCH_COMPLETE', (tx, e, now) => this.onResearchComplete(tx, e, now))
      .on('MOVEMENT_ARRIVE', (tx, e, now) => this.onMovementArrive(tx, e, now))
      .on('HEAVENS_ENVY_RESOLVE', (tx, e, now) => this.onEnvyResolve(tx, e, now))
      .on('TRIBULATION_WINDOW', (tx, e, now) => this.onTribulation(tx, e, now))
      .on('CONVOY_ARRIVE', (tx, e, now) => this.onConvoyArrive(tx, e, now));
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
    //
    // The view is built ONCE, outside the loop. Building it per stockpile meant
    // three full table scans and a sort for each resource, to re-derive a
    // building list that the new level had already settled — the same answer,
    // recomputed a dozen times.
    const afterBuild = this.viewIn(tx, settlementId);
    for (const sp of tx.stockpiles.where((s) => s.settlementId === settlementId)) {
      tx.stockpiles.put({ ...sp, capacity: storageCapacity(afterBuild, sp.resourceKey) });
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
    const { settlementId, unitKey, quantity, formationName, queueItemId } = e.payload as {
      settlementId: string; unitKey: string; quantity: number; formationName: string; queueItemId?: string;
    };
    if (queueItemId) tx.queue.delete(queueItemId);
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
    tx.appendEvent({
      id: this.ids.next('log', now),
      worldId: this.worldId,
      shardId: settlement.shardId,
      occurredAt: now,
      kind: 'training.completed',
      subjectId: settlementId,
      payload: { unitKey, quantity, formationName },
    });

    this.emit('queue.completed', `settlement:${settlementId}`, {
      settlementId, itemId: queueItemId ?? e.id, kind: 'training', targetKey: unitKey,
    });
  }

  /**
   * A research level lands.
   *
   * The level is written to the PLAYER, not the settlement — research is the
   * one global progression (spec/04 §3). The settlement only paid for it and
   * lent a queue slot.
   */
  private onResearchComplete(tx: Tx, e: ScheduledEvent, now: Millis): void {
    const { queueItemId, settlementId, playerId, researchKey } = e.payload as {
      queueItemId: string; settlementId: string; playerId: string; researchKey: string;
    };
    const item = tx.queue.get(queueItemId);
    if (!item) return; // cancelled before it landed
    tx.queue.delete(queueItemId);

    const existing = tx.research.get(playerId, researchKey);
    const level = (existing?.level ?? 0) + 1;
    tx.research.put({ playerId, researchKey, level });

    const settlement = tx.settlements.require(settlementId);
    const grade = gradeForLevel(level);
    const brokeThrough = grade > gradeForLevel(level - 1);

    tx.appendEvent({
      id: this.ids.next('log', now),
      worldId: this.worldId,
      shardId: settlement.shardId,
      occurredAt: now,
      kind: brokeThrough ? 'research.breakthrough' : 'research.completed',
      actorId: playerId,
      subjectId: settlementId,
      payload: { researchKey, level, grade },
    });

    this.emit('queue.completed', `settlement:${settlementId}`, {
      settlementId, itemId: queueItemId, kind: 'research', targetKey: researchKey, newLevel: level,
    });

    // A grade breakthrough is what unlocks content — fork choices, unit-grade
    // gates, edicts — so it is worth telling the player about specifically.
    if (brokeThrough) {
      this.emit('queue.completed', `player:${playerId}`, {
        settlementId, itemId: queueItemId, kind: 'research-breakthrough',
        targetKey: researchKey, newLevel: level,
      });
    }
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
      attacker: sideInput(
        attackerPlayer?.name ?? 'Unknown', attackerPlayer, attackerUnits,
        this.empireWeightIn(tx, m.ownerId),
        // Research folds into the joint +40% cap with everything else. It does
        // not get to sit outside it just because it took a long time.
        // Research and cultivation both fold into the joint +40% cap.
        attackerPlayer
          ? techTier(this.researchLevels(tx, m.ownerId), attackerPlayer.era) * cultivationAura(attackerPlayer.cultivationGrade)
          : 1,
      ),
      defender: sideInput(
        defenderPlayer?.name ?? 'Neutral', defenderPlayer, defenderUnits,
        target.ownerId ? this.empireWeightIn(tx, target.ownerId) : 0,
        defenderPlayer && target.ownerId
          ? techTier(this.researchLevels(tx, target.ownerId), defenderPlayer.era) * cultivationAura(defenderPlayer.cultivationGrade)
          : 1,
      ),
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

  /** A haul convoy lands. Cargo joins the destination's stockpile, capped. */
  private onConvoyArrive(tx: Tx, e: ScheduledEvent, now: Millis): void {
    const { movementId } = e.payload as { movementId: string };
    const m = tx.movements.get(movementId);
    if (!m) return;
    tx.movements.delete(movementId);

    for (const [key, amount] of Object.entries(m.cargo ?? {})) {
      const existing = tx.stockpiles.get(m.targetId, key);
      const capacity = existing?.capacity ?? BigInt(C.BASE_STORAGE);
      const held = existing?.amount ?? 0n;
      // Overflow is discarded here exactly as it is in production. Hauling a
      // surplus into a full warehouse loses it just the same.
      const landed = held + BigInt(amount) > capacity ? capacity : held + BigInt(amount);
      tx.stockpiles.put({ settlementId: m.targetId, resourceKey: key, amount: landed, capacity });
    }

    this.emit('movement.arrived', `player:${m.ownerId}`, { movementId, result: 'delivered' });
    void now;
  }

  /**
   * A tribulation resolves.
   *
   * Randomness comes from the seeded generator keyed on this event, so the
   * outcome is replayable like everything else (spec/03 §2) — a player who
   * loses a breakthrough to a crowd of rivals can have it re-run and see that
   * it was not arbitrary.
   */
  private onTribulation(tx: Tx, e: ScheduledEvent, now: Millis): void {
    const { tribulationId } = e.payload as { tribulationId: string };
    const t = tx.tribulations.get(tribulationId);
    if (!t) return;
    tx.tribulations.delete(tribulationId);

    const player = tx.players.get(t.playerId);
    if (!player) return;

    const result = resolveTribulation({
      grade: t.grade,
      qiSpent: t.qiSpent,
      temporalDebt: player.temporalDebt,
      reputation: player.reputation,
      interferers: t.interferers.length,
      now,
      rng: prngFor(this.worldId, e.id),
    });

    tx.players.put({
      ...player,
      cultivationGrade: result.newGrade,
      qi: player.qi + result.qiRefunded,
      cultivationStunnedUntil: result.stunnedUntil,
    });

    tx.appendEvent({
      id: this.ids.next('log', now),
      worldId: this.worldId,
      shardId: t.shardId,
      occurredAt: now,
      kind: result.passed ? 'tribulation.passed' : 'tribulation.failed',
      actorId: t.playerId,
      subjectId: t.settlementId,
      payload: {
        trial: t.trialName,
        grade: result.newGrade,
        realm: realmName(result.newGrade),
        roll: result.roll,
        chance: result.odds.chance,
        interferers: t.interferers.length,
        narrative: result.narrative,
      },
    });

    this.emit('tribulation.resolved', `player:${t.playerId}`, {
      tribulationId, passed: result.passed, grade: result.newGrade,
      realm: realmName(result.newGrade), narrative: result.narrative,
      chance: result.odds.chance, roll: result.roll,
    });
    // Everyone who came to crash it deserves to learn whether it worked.
    for (const rival of t.interferers) {
      this.emit('tribulation.resolved', `player:${rival}`, {
        tribulationId, passed: result.passed, narrative: result.narrative,
      });
    }
    if (t.visible) {
      this.emit('tribulation.resolved', `map:${t.shardId}`, {
        tribulationId, playerId: t.playerId, passed: result.passed, narrative: result.narrative,
      });
    }
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
    //
    // Each player is pushed onto their group's existing array. Rebuilding the
    // array on every insert — the spread that used to be here — copied the
    // whole group per member, which is quadratic in the size of exactly the
    // thing this check exists to catch: a large ring of linked accounts.
    const byGroup = new Map<string, Player[]>();
    // The group's running total is accumulated in the same pass, so the ranking
    // below does not have to walk every group a second time.
    const totals = new Map<string, number>();
    for (const p of players) {
      const key = p.linkGroupId ?? p.id;
      const group = byGroup.get(key);
      if (group) group.push(p);
      else byGroup.set(key, [p]);
      totals.set(key, (totals.get(key) ?? 0) + p.shardHoursPurchased30d);
    }

    const ranked: { group: Player[]; total: number }[] = [];
    for (const [key, group] of byGroup) {
      const total = totals.get(key)!;
      if (total >= C.ENVY_MIN_SPEND_FLOOR) ranked.push({ group, total });
    }
    ranked.sort((a, b) => b.total - a.total);
    ranked.length = Math.min(ranked.length, 10);

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
   * A governor initiates its next job — at 2x, with no judgement.
   *
   * ONE job, from whichever spec sheet comes first: build order, then training
   * standing order, then research mandate, then resource policy. A governor
   * does not run four things at once and does not choose between them; it
   * works the list.
   *
   * And when it cannot start the next thing, IT STALLS RATHER THAN SKIPPING
   * AHEAD (spec/04 §6). That stall is surfaced with its reason, because a
   * silent stall is indistinguishable from a governor that is simply idle, and
   * the difference is the whole point of writing a spec.
   */
  private runGovernorSpec(tx: Tx, settlementId: Uuid, now: Millis): void {
    const settlement = tx.settlements.get(settlementId);
    if (!settlement?.governorId || !settlement.ownerId) return;
    const governor = tx.governors.get(settlement.governorId);
    if (!governor) return;

    const view = this.viewIn(tx, settlementId);

    // Escalation first: a governor that is meant to stop and shout must do
    // that BEFORE it starts anything new. Otherwise the player learns about a
    // lost province from the battle report, which is the published failure.
    const incoming = tx.movements
      .where((m) => m.targetId === settlementId && m.ownerId !== settlement.ownerId)
      .reduce((n, m) => n + m.formations.reduce((k, f) => k + f.count, 0), 0);
    const escalation = checkEscalation(governor.specs, { incomingForce: incoming, loyalty: settlement.loyalty });
    if (escalation.alert) {
      this.emit('governor.stalled', `player:${settlement.ownerId}`, {
        governorId: governor.id, settlementId, reason: escalation.reason ?? 'escalation threshold reached',
      });
      if (escalation.pauseQueue) return;
    }

    const garrison = new Map<string, number>();
    for (const f of tx.formations.where((f) => f.settlementId === settlementId)) {
      garrison.set(f.unitKey, (garrison.get(f.unitKey) ?? 0) + f.count);
    }

    const intent = nextIntent({
      governor,
      view,
      garrison,
      researchLevels: this.researchLevels(tx, settlement.ownerId),
      // A dead governor is one whose commander is gone. Running jobs continue;
      // nothing new starts.
      assassinated: governor.commanderId === '',
      costOf: (key, v) =>
        upgradeCost(key, v.buildings.find((b) => b.buildingKey === key)?.level ?? 0,
          hqFactorFor(hqLevel(v)), 1, C.GOVERNOR_TIME_MULT).resources,
    });
    if (!intent) return;

    if (intent.kind === 'stall') {
      this.emit('governor.stalled', `player:${settlement.ownerId}`, {
        governorId: governor.id, settlementId, reason: `${intent.sheet}: ${intent.reason}`,
      });
      return;
    }

    // Everything a governor initiates goes in at 2x, through the same command
    // path a player uses — so it is subject to the same validation, spends the
    // same resources, and can be seized back.
    try {
      if (intent.kind === 'build') {
        this.enqueue({
          commandId: this.ids.next('gc', now), playerId: settlement.ownerId, settlementId,
          kind: 'building', targetKey: intent.buildingKey, slotKind: 'governor',
        });
      } else if (intent.kind === 'train') {
        this.enqueue({
          commandId: this.ids.next('gc', now), playerId: settlement.ownerId, settlementId,
          kind: 'training', targetKey: intent.unitKey, quantity: intent.quantity, slotKind: 'governor',
        });
      } else if (intent.kind === 'research') {
        this.enqueue({
          commandId: this.ids.next('gc', now), playerId: settlement.ownerId, settlementId,
          kind: 'research', targetKey: intent.researchKey, slotKind: 'governor',
        });
      } else if (intent.kind === 'haul') {
        this.haulSurplus(tx, settlement.ownerId, settlementId, intent.targetId, intent.cargo, now);
      }
    } catch (e) {
      // The command refused. That IS the stall, and the refusal carries the
      // reason — which is exactly what the player needs to fix their spec.
      this.emit('governor.stalled', `player:${settlement.ownerId}`, {
        governorId: governor.id, settlementId,
        reason: e instanceof CommandError ? e.message : 'the governor could not start its next job',
      });
    }
  }

  /**
   * Move a surplus to where it is useful.
   *
   * Resources move ONLY as interceptable convoys (invariant §2.4). A governor
   * hauling for you does not get a private pipe; it dispatches a movement that
   * appears on the map like anyone else's.
   */
  private haulSurplus(
    tx: Tx, playerId: Uuid, originId: Uuid, targetId: Uuid, cargo: Record<string, bigint>, now: Millis,
  ): void {
    const origin = tx.settlements.require(originId);
    const target = tx.settlements.get(targetId);
    if (!target || target.ownerId !== playerId) return;

    for (const [key, amount] of Object.entries(cargo)) {
      const sp = tx.stockpiles.get(originId, key);
      if (!sp || sp.amount < amount) return;
    }
    for (const [key, amount] of Object.entries(cargo)) {
      const sp = tx.stockpiles.get(originId, key)!;
      tx.stockpiles.put({ ...sp, amount: sp.amount - amount });
    }

    const d = distance(origin.coordX, origin.coordY, target.coordX, target.coordY);
    const movement: Movement = {
      id: this.ids.next('mv', now),
      shardId: origin.shardId,
      ownerId: playerId,
      originId,
      targetId,
      mission: 'haul',
      formations: [],
      cargo,
      departsAt: now,
      // Convoys are slower than armies and just as visible.
      arrivesAt: now + travelTimeMs(d, C.CONVOY_SPEED, 1, 1, false),
      revealedTo: [],
    };
    tx.movements.put(movement);
    this.scheduler.schedule(tx, {
      shardId: origin.shardId, executeAt: movement.arrivesAt,
      kind: 'CONVOY_ARRIVE', payload: { movementId: movement.id },
    });
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

  /**
   * The player's cultivation standing, with Qi brought up to date.
   *
   * Qi accrues lazily like everything else — nothing ticks, and a player away
   * for a month costs nothing while they are gone.
   */
  cultivation(playerId: Uuid): {
    grade: number; realm: string; qi: bigint; income: QiSources;
    nextCost: bigint; canAfford: boolean; stunnedUntil?: Millis;
    tribulation?: Tribulation; odds: TribulationOdds;
    aura: number; ladder: { grade: number; realm: string; qiCost: string; trial: string; visible: boolean; crashable: boolean }[];
  } {
    return this.store.read((tx) => {
      const player = tx.players.require(playerId);
      const income = qiPerHour(this.viewsOfOwner(tx, playerId));
      const qi = accrueQi(player.qi, income.perHour, player.temporalDebt, player.lastQiAccruedAt ?? player.createdAt, this.clock);
      const next = Math.min(C.MAX_GRADE, player.cultivationGrade + 1);
      return {
        grade: player.cultivationGrade,
        realm: realmName(player.cultivationGrade),
        qi,
        income,
        nextCost: qiBreakthroughCost(next),
        canAfford: qi >= qiBreakthroughCost(next),
        stunnedUntil: player.cultivationStunnedUntil,
        tribulation: tx.tribulations.find((t) => t.playerId === playerId),
        odds: tribulationOdds({
          grade: player.cultivationGrade,
          temporalDebt: player.temporalDebt,
          reputation: player.reputation,
          interferers: 0,
        }),
        aura: cultivationAura(player.cultivationGrade),
        ladder: GRADES.map((g) => ({
          grade: g.grade, realm: g.realmStage, qiCost: g.qiCost,
          trial: g.tribulation, visible: g.trial.visible, crashable: g.trial.crashable,
        })),
      };
    });
  }

  /**
   * Tribulations a player can SEE — and therefore interfere with.
   *
   * Only the visible ones, and never their own. This is the public half of
   * spec/04 §10: a breakthrough at the Golden Core is an event in the world,
   * not a private timer.
   */
  visibleTribulations(playerId: Uuid): Tribulation[] {
    return this.store.read((tx) =>
      tx.tribulations.where((t) => t.visible && t.playerId !== playerId && t.resolvesAt > this.clock),
    );
  }

  /** A player's research levels, as the flat map the sim modules want. */
  researchLevelsOf(playerId: Uuid): ResearchLevels {
    return this.store.read((tx) => this.researchLevels(tx, playerId));
  }

  private researchLevels(tx: Tx, playerId: Uuid): ResearchLevels {
    const out: Record<string, number> = {};
    for (const r of tx.research.where((x) => x.playerId === playerId)) out[r.researchKey] = r.level;
    return out;
  }

  private trainingContext(tx: Tx, playerId: Uuid, settlementId: Uuid): TrainingContext {
    const player = tx.players.require(playerId);
    return {
      view: this.viewIn(tx, settlementId),
      playerEra: player.era,
      research: this.researchLevels(tx, playerId),
      warfareRank: tx.proficiencies.get(playerId, 'warfare')?.rank ?? 0,
      cultivationGrade: player.cultivationGrade,
    };
  }

  /**
   * Everything this settlement could start right now, costed by the server.
   *
   * The client displays these; it never computes one. A cost or a gate the
   * client worked out for itself is a cost or a gate that can disagree with
   * the server (invariant §2.1).
   */
  options(playerId: Uuid, settlementId: Uuid): Options {
    return this.store.read((tx) => {
      const view = this.viewIn(tx, settlementId);
      const player = tx.players.require(playerId);
      const levels = this.researchLevels(tx, playerId);
      const hq = hqLevel(view);
      const hasKnowledge = view.buildings.some((b) => buildingRef(b.buildingKey).category === 'Knowledge');
      const bestKnowledge = Math.max(
        0,
        ...view.buildings.filter((b) => buildingRef(b.buildingKey).category === 'Knowledge').map((b) => b.level),
        0,
      );
      const ctx = this.trainingContext(tx, playerId, settlementId);

      return {
        buildings: buildingsForEra(player.era).map((r) => {
          const existing = view.buildings.find((b) => b.buildingKey === r.key);
          const cost = upgradeCost(r.key, existing?.level ?? 0, hqFactorFor(hq), 1, C.PLAYER_TIME_MULT);
          return {
            key: r.key, name: r.name, category: r.category,
            currentLevel: existing?.level ?? 0,
            cost: cost.resources, timeMs: cost.totalTimeMs,
          };
        }),
        training: trainableHere(ctx).map((t) => ({
          unitKey: t.unit.unitKey, name: t.unit.name, role: t.unit.role, grade: t.unit.grade,
          allowed: t.allowed, reason: t.reason,
          cost: t.cost.resources, timeMs: t.cost.perUnitMs,
        })),
        research: disciplinesForEra(player.era).map((r) => {
          const level = levelOf(levels, r.key);
          const check = validateResearchEnqueue(r.key, {
            levels, playerEra: player.era, cultivationGrade: player.cultivationGrade,
            hasKnowledgeBuilding: hasKnowledge,
          });
          const cost = researchCost(r.key, level, knowledgeFactorFor(bestKnowledge), C.PLAYER_TIME_MULT);
          return {
            key: r.key, name: r.name, era: r.era, branch: r.branch,
            level, grade: gradeForLevel(level),
            allowed: check.ok, reason: check.ok ? undefined : check.detail,
            cost: cost.resources, timeMs: cost.totalTimeMs,
          };
        }),
      };
    });
  }

  /** The aggregate effect of a player's research, as the UI shows it. */
  researchEffectsOf(playerId: Uuid): ReturnType<typeof researchEffects> {
    return this.store.read((tx) =>
      researchEffects(this.researchLevels(tx, playerId), tx.players.require(playerId).era),
    );
  }

  /** Force accrual now, for a settlement the caller is about to read. */
  refresh(settlementId: Uuid): void {
    this.store.transaction((tx) => this.settleAccrual(tx, this.viewIn(tx, settlementId)));
  }
}

function sideInput(
  name: string,
  player: Player | undefined,
  units: CombatUnit[],
  empireWeight: number,
  techTierValue = 1,
): SideInput {
  return {
    playerId: player?.id,
    playerName: name,
    empireWeight,
    era: player?.era ?? 1,
    units,
    techTier: techTierValue,
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
