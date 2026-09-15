/**
 * api/index.ts — the REST and WebSocket contract
 *
 * All request and response bodies are Zod schemas imported by BOTH server and
 * client, so a contract change is a compile error rather than a runtime
 * surprise (spec/05 §1).
 *
 * TWO RULES THAT SHAPE EVERY SCHEMA HERE
 *   1. Big integers cross the wire as STRINGS, never JSON numbers. Resource
 *      amounts and XP exceed the IEEE-754 safe range, and a silently truncated
 *      stockpile is the worst kind of bug — plausible, and wrong.
 *   2. Every mutating endpoint is idempotent by a client-supplied `commandId`.
 *      On mobile, a dropped connection during an attack dispatch would
 *      otherwise double-send an army.
 */

import { z } from 'zod';

export const uuid = z.string().uuid();
/** A big integer on the wire. Always a string. */
export const bigintString = z.string().regex(/^-?\d+$/, 'big integers cross the API as decimal strings');
export const millisString = bigintString;

// ============================================================================
// Errors — RFC 9457 problem details with a stable `type` per failure mode
// ============================================================================

/**
 * The client reacts SPECIFICALLY to these, so they are part of the contract.
 * Adding a failure mode without adding it here means the client can only show
 * a generic error, which in this game is the difference between "you are three
 * plots short" and "something went wrong".
 */
export const PROBLEM_TYPES = [
  'insufficient-plots',
  'insufficient-resources',
  'hq-level-cap',
  'grade-prerequisite',
  'specialization-cap',
  'no-free-queue-slot',
  'no-free-personal-slot',
  'nap-blocks-attack',
  'already-complete',
  'not-found',
  'not-owner',
  'layer-limit',
  'shard-ceiling-reached',
  'shard-prohibited-target',
  'era-gate',
  'tier-up-requirements',
  'rate-limited',
  'validation',
] as const;

export type ProblemType = (typeof PROBLEM_TYPES)[number];

export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string().optional(),
  /** Machine-readable specifics: what was short, by how much. */
  meta: z.record(z.unknown()).optional(),
});
export type Problem = z.infer<typeof problemSchema>;

export function problem(type: ProblemType, title: string, status: number, detail?: string, meta?: Record<string, unknown>): Problem {
  return { type: `https://ascendance.game/problems/${type}`, title, status, detail, meta };
}

/** Recover the short code from a problem `type` URI. */
export function problemCode(p: Problem): string {
  const i = p.type.lastIndexOf('/');
  return i === -1 ? p.type : p.type.slice(i + 1);
}

// ============================================================================
// Commands
// ============================================================================

const commandBase = z.object({
  /** Idempotency key. Replaying the same id returns the original result. */
  commandId: uuid,
});

export const enqueueSchema = commandBase.extend({
  kind: z.enum(['building', 'research', 'training', 'repair']),
  targetKey: z.string().min(1),
  targetLevel: z.number().int().min(0).max(1337).optional(),
  quantity: z.number().int().min(1).max(100_000).optional(),
  slotKind: z.enum(['personal', 'governor']),
});
export type EnqueueCommand = z.infer<typeof enqueueSchema>;

export const cancelQueueSchema = commandBase;

export const seizeSchema = commandBase;

export const spendShardsSchema = commandBase.extend({
  shardHours: z.number().positive().max(100_000),
});
export type SpendShardsCommand = z.infer<typeof spendShardsSchema>;

export const dispatchSchema = commandBase.extend({
  originId: uuid,
  targetId: uuid,
  mission: z.enum(['attack', 'raid', 'reinforce', 'scout', 'haul', 'settle', 'conquer']),
  formations: z.array(z.object({ formationId: uuid, count: z.number().int().positive() })).min(1),
  cargo: z.record(bigintString).optional(),
});
export type DispatchCommand = z.infer<typeof dispatchSchema>;

export const tierUpSchema = commandBase;

export const appointGovernorSchema = commandBase.extend({
  commanderId: uuid,
  tier: z.enum(['bailiff', 'planetary', 'system', 'sector']),
  areaRef: z.object({ layer: z.string(), settlementIds: z.array(uuid) }),
  specs: z.object({
    buildOrder: z.array(z.object({ buildingKey: z.string(), toLevel: z.number().int().min(0).max(1337) })),
    trainingStandingOrder: z.array(z.object({ unitKey: z.string(), maintainCount: z.number().int().min(0) })),
    researchMandate: z.array(z.string()),
    resourcePolicy: z.object({ keepDays: z.number().min(0), haulSurplusTo: uuid.optional() }),
    defencePosture: z.enum(['garrison', 'mobile', 'fortify']),
    escalationRules: z.object({ alertOnIncoming: z.boolean(), alertBelowLoyalty: z.number().min(0).max(100) }),
  }),
});
export type AppointGovernorCommand = z.infer<typeof appointGovernorSchema>;

export const proposeTreatySchema = commandBase.extend({
  kind: z.enum(['nap', 'trade', 'defensive', 'tribute', 'border', 'war', 'armistice']),
  counterpartyId: uuid,
  terms: z.record(z.unknown()),
  expiresAt: millisString.optional(),
});

export const renameFormationSchema = commandBase.extend({
  name: z.string().min(1).max(64),
});

export const restaffSchema = commandBase.extend({
  buildingKey: z.string(),
  staffedPct: z.number().int().min(0).max(100),
});

// ============================================================================
// WebSocket events (spec/05 §4)
// ============================================================================

export type ChannelId = `player:${string}` | `settlement:${string}` | `alliance:${string}` | `map:${string}`;

/**
 * `attack.incoming` is the single most time-critical message in the system.
 * Latency budget: under one second from the moment the movement enters the
 * defender's warning radius (spec/05 §4). The client never polls for it.
 */
export interface ServerEvents {
  'attack.incoming': { movementId: string; targetId: string; arrivesAt: string; estimatedSize?: number; flags: string[] };
  'queue.completed': { settlementId: string; itemId: string; kind: string; targetKey: string; newLevel?: number };
  'battle.resolved': { battleId: string; settlementId: string; outcome: string; summary: string };
  'movement.arrived': { movementId: string; result: string };
  'resource.overflow': { settlementId: string; resourceKey: string };
  'governor.stalled': { governorId: string; settlementId: string; reason: string };
  'treaty.proposed': { treatyId: string; from: string; kind: string; terms: Record<string, unknown> };
  'envy.marked': { playerId: string; scopes: string[]; expiresAt: string };
  'map.delta': { shard: string; changes: MapChange[] };
  'epoch.progress': { conditionKey: string; leaders: string[]; pct: number };
}

export interface MapChange {
  settlementId: string;
  ownerId?: string;
  holdingType?: string;
  /** Damage and Overdriven persist visibly; Heaven's Envy is meant to be seen. */
  flags?: string[];
  removed?: boolean;
}

export type ServerEventName = keyof ServerEvents;

export interface Envelope<K extends ServerEventName = ServerEventName> {
  event: K;
  channel: string;
  /** Server time, so the client can measure and re-measure its clock offset. */
  at: string;
  data: ServerEvents[K];
}

export const subscribeSchema = z.object({
  action: z.literal('subscribe'),
  channels: z.array(z.string()).max(64),
});

export const unsubscribeSchema = z.object({
  action: z.literal('unsubscribe'),
  channels: z.array(z.string()).max(64),
});

/**
 * Clock sync. Players coordinate attacks across time zones constantly, so the
 * client renders every timer from an absolute server timestamp plus a measured
 * offset, and shows both server and local time (spec/06 §5).
 */
export const clockSchema = z.object({ action: z.literal('clock'), clientSent: z.number() });

export const clientMessageSchema = z.union([subscribeSchema, unsubscribeSchema, clockSchema]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
