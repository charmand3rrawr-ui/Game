/**
 * state/api.ts — the single door to the server
 *
 * THE CLIENT NEVER COMPUTES A GAME OUTCOME (invariant §2.1, spec/06 §5). It
 * requests; the server decides. Everything below either asks a question or
 * issues a command; nothing here derives a result the server did not send.
 *
 * TWO TRANSPORTS, ONE INTERFACE
 *   Against the gateway this is `fetch`. On GitHub Pages there is no gateway,
 *   so the same calls run against an in-process World — the identical engine,
 *   because it has no I/O and no clock reads (DECISIONS.md D4). The Simulator
 *   is genuinely the resolver either way, which is the point of the one-language
 *   choice in spec/01 §2.
 */

import type { AttentionItem, Battle } from '@ascendance/shared';
import { localApi, isLocalMode } from './local.js';

export interface ApiProblem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  meta?: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(readonly problem: ApiProblem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
  }

  /** The stable short code, e.g. `insufficient-plots`. */
  get code(): string {
    const i = this.problem.type.lastIndexOf('/');
    return i === -1 ? this.problem.type : this.problem.type.slice(i + 1);
  }
}

export interface Meta {
  balanceRevision: string;
  assumedConstants: string[];
  serverTime: number;
  worldTime: string;
  counts: { buildings: number; units: number; holdings: number; veterancyTiers: number };
}

export interface MeResponse {
  player: {
    id: string; name: string; era: number; reputation: number; qi: string;
    cultivationGrade: number; temporalDebt: number; shardBalanceHours: number;
    envyScopes: string[]; empireWeightAvg: number;
    /** Set once the player founds or joins an alliance. */
    allianceId?: string;
  };
  empireWeight: number;
  settlements: { id: string; name: string; holdingType: string; layer: string; coordX: number; coordY: number; loyalty: number; population: number }[];
}

export interface SettlementDetail {
  settlement: {
    id: string; name: string; holdingType: string; population: number;
    happiness: number; loyalty: number; ownerId?: string;
    /** Surface, orbital, void — drives the canvas biome pass. */
    layer: string;
  };
  buildings: {
    id: string; buildingKey: string; level: number; damage: number; staffedPct: number;
    /** Which plot it stands on — the canvas lays the settlement out by this. */
    plotIndex: number;
    /** Set while upkeep is unpaid: output halved, shedding a level a day after 72h. */
    brownoutSince?: string;
    ref: BuildingRef;
  }[];
  queue: QueueItemDto[];
  stockpiles: { resourceKey: string; amount: string; capacity: string }[];
  production: { buildingName: string; resourceKey: string; ratePerHour: number; staffedPct: number; adjacencyBonus: number; brownout: boolean }[];
  staffing: { demand: number; supply: number; ratio: number };
  plots: { used: number; total: number };
  hqLevel: number;
  available: AvailableBuilding[];
  fogged?: string[];
}

export interface BuildingRef {
  key: string; name: string; category: string; era: number; sizeClass: number;
  functionText: string; purpose?: string; mechanic?: string; synergies?: string; art?: string;
}

export interface AvailableBuilding extends BuildingRef {
  currentLevel: number;
  cost: Record<string, string>;
  timeMs: string;
}

export interface QueueItemDto {
  id: string; settlementId: string; kind: string; targetKey: string; targetLevel?: number; quantity?: number;
  slotKind: 'personal' | 'governor'; startedAt: string; finishesAt: string;
  timeMultiplier: number; shardHoursSpent: number; position: number;
}

export interface MapResponse {
  settlements: { id: string; name: string; ownerId?: string; holdingType: string; coordX: number; coordY: number; layer: string; mine: boolean; integrity: number }[];
  movements: { id: string; ownerId: string; originId: string; targetId: string; mission: string; departsAt: string; arrivesAt: string }[];
}

export interface FormationDto {
  id: string; name: string; unitKey: string; count: number; settlementId: string;
  atkTier: number; atkLevel: number; atkXp: string;
  defTier: number; defLevel: number; defXp: string;
  deeds: string[];
  def: { name: string; role: string; era: number; grade: string; path: string; atk: number; def: number; hp: number; speed: number; upkeep: number } | null;
}

/** Everything a settlement could start, as the server costed it. */
export interface OptionsDto {
  buildings: { key: string; name: string; category: string; currentLevel: number; cost: Record<string, string>; timeMs: string }[];
  training: { unitKey: string; name: string; role: string; grade: string; allowed: boolean; reason?: string; cost: Record<string, string>; timeMs: string }[];
  research: { key: string; name: string; era: number; branch: string; level: number; grade: number; allowed: boolean; reason?: string; cost: Record<string, string>; timeMs: string }[];
}

export interface ResearchDto {
  levels: Record<string, number>;
  effects: { output: number; unitEffectiveness: number; governance: number };
  disciplines: { key: string; name: string; era: number; branch: string; perLevel: string; perLevelPct: number; prerequisite: string; level: number }[];
  inProgress: { researchKey: string; settlementId: string; finishesAt: string }[];
}

export interface TribulationDto {
  id: string; playerId: string; grade: number; trialName: string;
  visible: boolean; crashable: boolean; qiSpent: string; settlementId: string;
  openedAt: string; resolvesAt: string; interferers: string[];
}

export interface CultivationDto {
  grade: number;
  realm: string;
  qi: string;
  income: { buildings: number; spiritVeins: number; meditation: number; perHour: number };
  nextCost: string;
  canAfford: boolean;
  stunnedUntil?: string;
  tribulation?: TribulationDto;
  odds: { base: number; karma: number; debt: number; interference: number; chance: number };
  aura: number;
  ladder: { grade: number; realm: string; qiCost: string; trial: string; visible: boolean; crashable: boolean }[];
  visibleNearby: TribulationDto[];
}

// ---------------------------------------------------------------- governors

/**
 * Note there is no `commanderLevel` on the appointment call.
 *
 * The tiers gate on it, so the server derives it; the client only learns what
 * its own level IS, in order to grey out the tiers it cannot reach and say why.
 */
export interface GovernorSpecsDto {
  buildOrder: { buildingKey: string; toLevel: number }[];
  trainingStandingOrder: { unitKey: string; maintainCount: number }[];
  researchMandate: string[];
  resourcePolicy: { keepDays: number; haulSurplusTo?: string };
  defencePosture: 'garrison' | 'mobile' | 'fortify';
  escalationRules: { alertOnIncoming: boolean; alertBelowLoyalty: number };
}

export interface GovernorDto {
  id: string;
  playerId: string;
  commanderId: string;
  tier: 'bailiff' | 'planetary' | 'system' | 'sector';
  areaRef: { layer: string; settlementIds: string[] };
  areaNames: string[];
  specs: GovernorSpecsDto;
  appointedAt: string;
}

export interface GovernorsDto {
  commanderLevel: number;
  tiers: { key: string; name: string; area: string; commanderLevel: number; covers: string; notes: string }[];
  sheets: { sheet: string; key: string; defines: string; behaviour: string; failure: string }[];
  settlements: { id: string; name: string; governorId?: string }[];
  governors: GovernorDto[];
}

export interface AuditDto {
  subverted: boolean;
  by?: string;
  /** Plain sentences naming each way the running specs differ from yours. */
  findings: string[];
}

// ---------------------------------------------------------------- diplomacy

export interface TreatyDto {
  id: string;
  kind: 'nap' | 'trade' | 'defensive' | 'tribute' | 'border' | 'war' | 'armistice';
  partyA: string;
  partyB: string;
  terms: Record<string, unknown>;
  proposedAt: string;
  signedAt: string;
  expiresAt?: string;
  brokenAt?: string;
}

export interface AllianceDto {
  alliance: { id: string; name: string; tag: string; treasury: Record<string, string>; foundedAt: string } | null;
  members: { allianceId: string; playerId: string; role: string; permissions: string[]; joinedAt: string }[];
  maxMembers: number;
  treaties: TreatyDto[];
  known: { id: string; name: string; reputation: number; allianceId?: string; holdings: number }[];
  me: string;
  serverTime: number;
  napNoticeMs: string;
  napBreakReputation: number;
  treatyBreakReputation: number;
}

// --------------------------------------------------- the text layer

export interface BoardMetaDto {
  key: string; title: string; what: string; note: string; higherIsBetter: boolean;
}
export interface BoardRowDto {
  rank: number; playerId: string; name: string; allianceTag?: string;
  value: number; detail: string; isYou: boolean; envyScopes: string[];
}
export interface LeaderboardsDto {
  boards: BoardMetaDto[];
  active: string;
  rows: BoardRowDto[];
  me: string;
}

/**
 * What the barbarians are, and what the players did to cause it.
 *
 * Deliberately verbose. The whole design position on an escalating AI is that
 * it has to be legible — the tier, what that tier unlocks, the pressure and its
 * three terms, and the list of things barbarians can do that players cannot.
 */
export interface ThreatDto {
  pressure: { total: number; terms: { label: string; amount: number; detail: string }[] };
  bands: {
    id: string;
    name: string;
    doctrine: string;
    menace: number;
    rung: { name: string; unlocks: string };
    holdings: number;
    seatName: string;
    confederacy?: string;
    doomsdayReadyAt?: string;
    dossier: string;
  }[];
  privileges: { key: string; name: string; detail: string }[];
}

export interface MessageDto {
  id: string; fromId: string; toId: string; fromName: string; toName: string;
  subject: string; body: string; sentAt: string; readAt?: string; archivedAt?: string;
}
export interface InboxDto {
  box: 'in' | 'out' | 'archive';
  messages: MessageDto[];
  counts: { unread: number; total: number };
  correspondents: { id: string; name: string; reputation: number; holdings: number }[];
}

export interface ThreadDto {
  id: string; scope: 'world' | 'alliance'; title: string;
  authorId: string; authorName: string;
  createdAt: string; lastPostAt: string; postCount: number; lockedAt?: string;
}
export interface PostDto {
  id: string; threadId: string; authorId: string; authorName: string; body: string; postedAt: string;
}

export interface MovementDto {
  id: string; ownerId: string; originId: string; targetId: string; mission: string;
  departsAt: string; arrivesAt: string; formations: { formationId: string; count: number }[];
}

const BASE = '/v1';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!r.ok) {
    const problem = (await r.json().catch(() => ({ type: 'about:blank', title: r.statusText, status: r.status }))) as ApiProblem;
    throw new ApiError(problem);
  }
  return (await r.json()) as T;
}

/** A fresh idempotency key per command attempt (spec/05 §1). */
export function newCommandId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Fallback for older browsers. Uniqueness is all that matters here: the id
  // only has to be distinct per command, never unpredictable.
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

export interface Api {
  meta(): Promise<Meta>;
  me(): Promise<MeResponse>;
  attention(): Promise<{ items: AttentionItem[]; serverTime: number }>;
  settlement(id: string): Promise<SettlementDetail>;
  map(): Promise<MapResponse>;
  formations(): Promise<{ formations: FormationDto[] }>;
  movements(): Promise<{ movements: MovementDto[]; serverTime: number }>;
  options(settlementId: string): Promise<OptionsDto>;
  research(): Promise<ResearchDto>;
  cultivation(): Promise<CultivationDto>;
  breakthrough(settlementId: string): Promise<TribulationDto>;
  interfere(tribulationId: string): Promise<TribulationDto>;
  battles(settlementId: string): Promise<{ battles: Battle[] }>;
  battle(id: string): Promise<Battle>;
  enqueue(settlementId: string, targetKey: string, slotKind: 'personal' | 'governor'): Promise<QueueItemDto>;
  train(settlementId: string, unitKey: string, quantity: number, slotKind: 'personal' | 'governor'): Promise<QueueItemDto>;
  startResearch(settlementId: string, researchKey: string, slotKind: 'personal' | 'governor'): Promise<QueueItemDto>;
  cancel(itemId: string): Promise<{ refunded: Record<string, string> }>;
  seize(itemId: string): Promise<QueueItemDto>;
  spendShards(itemId: string, shardHours: number): Promise<QueueItemDto>;
  dispatch(args: { originId: string; targetId: string; mission: string; formations: { formationId: string; count: number }[] }): Promise<MovementDto>;
  tierUp(formationId: string, track: 'atk' | 'def'): Promise<FormationDto>;
  governors(): Promise<GovernorsDto>;
  appointGovernor(args: { commanderId: string; tier: string; settlementIds: string[]; layer: string; specs: GovernorSpecsDto }): Promise<GovernorDto>;
  updateGovernorSpecs(governorId: string, specs: GovernorSpecsDto): Promise<GovernorDto>;
  dismissGovernor(governorId: string): Promise<{ dismissed: true }>;
  auditGovernor(governorId: string): Promise<AuditDto>;
  alliance(): Promise<AllianceDto>;
  createAlliance(name: string, tag: string): Promise<AllianceDto['alliance']>;
  proposeTreaty(args: { counterpartyId: string; kind: string; terms: Record<string, unknown> }): Promise<TreatyDto>;
  acceptTreaty(treatyId: string): Promise<TreatyDto>;
  breakTreaty(treatyId: string): Promise<{ treaty: TreatyDto; reputationLost: number; effectiveAt: string }>;
  leaderboards(board?: string): Promise<LeaderboardsDto>;
  threat(): Promise<ThreatDto>;
  messages(box?: 'in' | 'out' | 'archive'): Promise<InboxDto>;
  sendMessage(args: { toId: string; subject: string; body: string }): Promise<MessageDto>;
  readMessage(id: string): Promise<MessageDto>;
  archiveMessage(id: string): Promise<MessageDto>;
  threads(scope: 'world' | 'alliance'): Promise<{ scope: string; threads: ThreadDto[] }>;
  thread(id: string): Promise<{ thread: ThreadDto; posts: PostDto[] }>;
  openThread(args: { scope: 'world' | 'alliance'; title: string; body: string }): Promise<ThreadDto>;
  reply(threadId: string, body: string): Promise<PostDto>;
  /** Advance the local world. No-op against a real server, which has a clock. */
  tick?(): void;
}

const remoteApi: Api = {
  meta: () => call('/meta'),
  me: () => call('/me'),
  attention: () => call('/attention'),
  settlement: (id) => call(`/settlements/${id}`),
  map: () => call('/map'),
  formations: () => call('/formations'),
  movements: () => call('/movements'),
  options: (settlementId) => call(`/settlements/${settlementId}/options`),
  research: () => call('/research'),
  cultivation: () => call('/cultivation'),
  breakthrough: (settlementId) =>
    call('/cultivation/breakthrough', { method: 'POST', body: JSON.stringify({ commandId: newCommandId(), settlementId }) }),
  interfere: (tribulationId) =>
    call(`/tribulations/${tribulationId}/interfere`, { method: 'POST', body: JSON.stringify({ commandId: newCommandId() }) }),
  battles: (settlementId) => call(`/settlements/${settlementId}/battles`),
  battle: (id) => call(`/battles/${id}`),
  enqueue: (settlementId, targetKey, slotKind) =>
    call(`/settlements/${settlementId}/queue`, {
      method: 'POST',
      body: JSON.stringify({ commandId: newCommandId(), kind: 'building', targetKey, slotKind }),
    }),
  train: (settlementId, targetKey, quantity, slotKind) =>
    call(`/settlements/${settlementId}/queue`, {
      method: 'POST',
      body: JSON.stringify({ commandId: newCommandId(), kind: 'training', targetKey, quantity, slotKind }),
    }),
  startResearch: (settlementId, targetKey, slotKind) =>
    call(`/settlements/${settlementId}/queue`, {
      method: 'POST',
      body: JSON.stringify({ commandId: newCommandId(), kind: 'research', targetKey, slotKind }),
    }),
  cancel: (itemId) => call(`/queue/${itemId}`, { method: 'DELETE', body: JSON.stringify({ commandId: newCommandId() }) }),
  seize: (itemId) => call(`/queue/${itemId}/seize`, { method: 'POST', body: JSON.stringify({ commandId: newCommandId() }) }),
  spendShards: (itemId, shardHours) =>
    call(`/queue/${itemId}/shards`, { method: 'POST', body: JSON.stringify({ commandId: newCommandId(), shardHours }) }),
  dispatch: (args) => call('/movements', { method: 'POST', body: JSON.stringify({ commandId: newCommandId(), ...args }) }),
  tierUp: (formationId, track) =>
    call(`/formations/${formationId}/tier-up`, { method: 'POST', body: JSON.stringify({ commandId: newCommandId(), track }) }),
  governors: () => call('/governors'),
  appointGovernor: (args) =>
    call('/governors', {
      method: 'POST',
      body: JSON.stringify({
        commandId: newCommandId(),
        commanderId: args.commanderId,
        tier: args.tier,
        areaRef: { layer: args.layer, settlementIds: args.settlementIds },
        specs: args.specs,
      }),
    }),
  updateGovernorSpecs: (governorId, specs) =>
    call(`/governors/${governorId}/specs`, { method: 'PATCH', body: JSON.stringify({ commandId: newCommandId(), specs }) }),
  dismissGovernor: (governorId) =>
    call(`/governors/${governorId}`, { method: 'DELETE', body: JSON.stringify({ commandId: newCommandId() }) }),
  auditGovernor: (governorId) =>
    call(`/governors/${governorId}/audit`, { method: 'POST', body: JSON.stringify({ commandId: newCommandId() }) }),
  alliance: () => call('/alliance'),
  createAlliance: (name, tag) =>
    call('/alliance', { method: 'POST', body: JSON.stringify({ commandId: newCommandId(), name, tag }) }),
  proposeTreaty: (args) =>
    call('/treaties', { method: 'POST', body: JSON.stringify({ commandId: newCommandId(), ...args }) }),
  acceptTreaty: (treatyId) =>
    call(`/treaties/${treatyId}/accept`, { method: 'POST', body: JSON.stringify({ commandId: newCommandId() }) }),
  breakTreaty: (treatyId) =>
    call(`/treaties/${treatyId}/break`, { method: 'POST', body: JSON.stringify({ commandId: newCommandId() }) }),
  leaderboards: (board) => call(`/leaderboards${board ? `?board=${encodeURIComponent(board)}` : ''}`),
  threat: () => call('/threat'),
  messages: (box) => call(`/messages${box ? `?box=${box}` : ''}`),
  sendMessage: (args) =>
    call('/messages', { method: 'POST', body: JSON.stringify({ commandId: newCommandId(), ...args }) }),
  readMessage: (id) =>
    call(`/messages/${id}/read`, { method: 'POST', body: JSON.stringify({ commandId: newCommandId() }) }),
  archiveMessage: (id) =>
    call(`/messages/${id}/archive`, { method: 'POST', body: JSON.stringify({ commandId: newCommandId() }) }),
  threads: (scope) => call(`/threads?scope=${scope}`),
  thread: (id) => call(`/threads/${id}`),
  openThread: (args) =>
    call('/threads', { method: 'POST', body: JSON.stringify({ commandId: newCommandId(), ...args }) }),
  reply: (threadId, body) =>
    call(`/threads/${threadId}/posts`, { method: 'POST', body: JSON.stringify({ commandId: newCommandId(), body }) }),
};

export const api: Api = isLocalMode() ? localApi : remoteApi;
export const runningLocally = isLocalMode();
