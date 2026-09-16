/**
 * types.ts — the domain vocabulary
 *
 * These types live in `shared` and are imported by BOTH sides, so the client can
 * never disagree with the server about a shape (spec/00 §3). A contract change
 * is a compile error rather than a runtime surprise.
 *
 * CONVENTIONS (spec/00 §3)
 *   - `bigint` for resources, XP and veterancy ratings — these legitimately
 *     exceed 2^53, and floating point is not acceptable for a stored balance.
 *   - Timestamps are `bigint` epoch milliseconds UTC. Never local time.
 *   - camelCase here, snake_case in the database.
 */

export type Uuid = string;
/** Epoch milliseconds UTC. */
export type Millis = bigint;

export type Layer = 'province' | 'continent' | 'planet' | 'orbit' | 'system' | 'galaxy' | 'belt';
export type ProficiencyTrack = 'construction' | 'technology' | 'warfare' | 'commerce' | 'exploration';
export type QueueKind = 'building' | 'research' | 'training' | 'repair' | 'tier_up';
export type SlotKind = 'personal' | 'governor';
export type Mission = 'attack' | 'raid' | 'reinforce' | 'scout' | 'haul' | 'settle' | 'conquer';
export type VeterancyTrack = 'atk' | 'def';
export type TreatyKind = 'nap' | 'trade' | 'defensive' | 'tribute' | 'border' | 'war' | 'armistice';
export type GovernorTier = 'bailiff' | 'planetary' | 'system' | 'sector';
export type AllianceRole = 'leader' | 'diplomat' | 'ops' | 'quartermaster' | 'banker' | 'member';

// ----------------------------------------------------------------- identity

export interface Dynasty {
  id: Uuid;
  accountId: Uuid;
  name: string;
  heraldry: Heraldry;
  /** Permanent score. Never resets; decays only 2% per epoch at the top ranks. */
  prestige: bigint;
  traditions: string[];
  foundedAt: Millis;
}

export interface Heraldry {
  primary: string;
  secondary: string;
  charge: string;
}

export interface Player {
  id: Uuid;
  dynastyId: Uuid;
  worldId: Uuid;
  name: string;
  era: number;
  allianceId?: Uuid;
  reputation: number;
  /**
   * Rolling 30-day average of summed admin costs of OWNED holdings.
   * A live reading would let a player shed territory before a war to spike
   * progression; the rolling average makes that cost a month (spec/04 §5).
   */
  empireWeightAvg: number;
  /**
   * The live weight as at the last sample — the figure that HELD since then.
   *
   * Live weight only changes when holdings do, so it is piecewise-constant
   * between samples, and that is what lets a thirty-day average be kept without
   * storing thirty days of history.
   */
  empireWeightHeld?: number;
  /**
   * When `empireWeightAvg` was last advanced. Lazy, like every other accrual
   * in this engine — there is no tick that maintains it.
   */
  empireWeightSampledAt?: Millis;
  cultivationGrade: number;
  qi: bigint;
  /** 0..5 Chrono Shard karma. Raises tribulation difficulty, suppresses Qi regen. */
  temporalDebt: number;
  /** Lazy Qi accrual marker. Cultivation income never ticks (spec/03 §3). */
  lastQiAccruedAt?: Millis;
  /** Set while a failed tribulation's suspension is still in force. */
  cultivationStunnedUntil?: Millis;
  /** Heaven's Envy scopes currently marked: universe / quadrant / alliance. */
  envyScopes: string[];
  envyExpiresAt?: Millis;
  shardBalanceHours: number;
  /** 30-day rolling purchased shard-hours. PUBLIC on the profile (spec/04 §11). */
  shardHoursPurchased30d: number;
  /** Detected linked-account group; feeds transfer caps, envy scopes, XP zeroes. */
  linkGroupId?: Uuid;
  createdAt: Millis;
}

/**
 * One discipline's level for one player.
 *
 * Research is the SINGLE exception to production isolation (invariant §2.4):
 * the level is global to the player, even though the work is paid for and
 * queued in one settlement.
 */
export interface ResearchLevel {
  playerId: Uuid;
  researchKey: string;
  level: number;
}

export interface Proficiency {
  playerId: Uuid;
  track: ProficiencyTrack;
  rank: number;
  xp: bigint;
  xpToday: bigint;
}

// -------------------------------------------------------------------- world

export interface Settlement {
  id: Uuid;
  shardId: Uuid;
  worldId: Uuid;
  /** NULL for an NPC holding or a ruin. */
  ownerId?: Uuid;
  holdingType: string;
  name: string;
  layer: Layer;
  parentId?: Uuid;
  coordX: number;
  coordY: number;
  terrain: Terrain;
  plotsTotal: number;
  population: number;
  happiness: number;
  health: number;
  /** 0 flips the settlement to the attacker. */
  loyalty: number;
  /** 100 intact, 50 NPC successor, 0 ruin. Drives archaeology. */
  integrity: number;
  governorId?: Uuid;
  /** Lazy production accrual marker. Production is NEVER a tick (spec/03 §3). */
  lastAccruedAt: Millis;
  createdAt: Millis;
  version: number;
}

export interface Terrain {
  /** resourceKey -> richness multiplier on tiles of that type. */
  richness: Record<string, number>;
  hazards: string[];
  biome: string;
  /** Spirit Vein tiles triple Herb Garden yield and feed cultivation. */
  spiritVeins: number;
}

export interface Building {
  id: Uuid;
  settlementId: Uuid;
  buildingKey: string;
  level: number;
  /** Levels of siege damage awaiting repair. Visible on the map until fixed. */
  damage: number;
  plotIndex: number;
  /** Output scales LINEARLY with this. Understaffing is normal, not an error. */
  staffedPct: number;
  /** Era II+ Coin / Era IV+ Electricity insolvency state. */
  brownoutSince?: Millis;
}

export interface Stockpile {
  settlementId: Uuid;
  resourceKey: string;
  amount: bigint;
  /** Overflow above this is LOST, not stored — deliberate pressure to spend. */
  capacity: bigint;
}

export interface QueueItem {
  id: Uuid;
  settlementId: Uuid;
  kind: QueueKind;
  targetKey: string;
  targetLevel?: number;
  quantity: number;
  slotKind: SlotKind;
  startedAt: Millis;
  /** Computed ONCE at enqueue. Never recomputed downward except by an audited
   *  Seize or Chrono Shard spend (invariant §2.8). */
  finishesAt: Millis;
  /** 1.0 player-initiated, 2.0 governor-initiated. The whole governor system. */
  timeMultiplier: number;
  shardHoursSpent: number;
  compressedMs: Millis;
  position: number;
}

// ----------------------------------------------------------------- military

export interface Formation {
  id: Uuid;
  settlementId: Uuid;
  ownerId: Uuid;
  /** Player-chosen. This is what players name and grow attached to. */
  name: string;
  unitKey: string;
  count: number;
  /** Two independent tracks: attacking feeds one, defending the other. */
  atkTier: number;
  atkLevel: number;
  atkXp: bigint;
  defTier: number;
  defLevel: number;
  defXp: bigint;
  equipment: Equipment;
  commanderId?: Uuid;
  /** Qualifying deeds on record, required for tier promotion. */
  deeds: string[];
  createdAt: Millis;
}

export interface Equipment {
  weapon?: string;
  protection?: string;
  utility?: string;
}

export interface Movement {
  id: Uuid;
  shardId: Uuid;
  ownerId: Uuid;
  originId: Uuid;
  targetId: Uuid;
  mission: Mission;
  formations: MovementSlice[];
  cargo?: Record<string, bigint>;
  departsAt: Millis;
  arrivesAt: Millis;
  /** Visible to the defender only within their warning radius (spec/04 §8). */
  revealedTo: Uuid[];
}

export interface MovementSlice {
  formationId: string;
  count: number;
}

// ------------------------------------------------------------------ battles

export interface Battle {
  id: Uuid;
  shardId: Uuid;
  settlementId: Uuid;
  attackerId?: Uuid;
  defenderId?: Uuid;
  resolvedAt: Millis;
  /** Makes the battle replayable, byte for byte. */
  seed: bigint;
  report: BattleReport;
}

/**
 * The full phase-by-phase arithmetic, shown to BOTH sides in its entirety.
 *
 * INVARIANT §2.7: every combat outcome is explainable. If a number cannot be
 * shown to the player with its derivation, it should not exist.
 */
export interface BattleReport {
  outcome: 'attacker' | 'defender' | 'stalemate';
  settlementName: string;
  phases: BattlePhase[];
  attacker: SideSummary;
  defender: SideSummary;
  plunder?: Record<string, string>;
  loyaltyDamage?: number;
  captured: boolean;
  /** Preconditions that stopped an action, e.g. orbital bombardment cannot capture. */
  layerLimits: string[];
  attribution: AttributionSummary[];
}

export interface BattlePhase {
  name: 'intel' | 'ranged' | 'main' | 'breakthrough' | 'plunder' | 'munitions';
  note: string;
  attackerPower: PowerBreakdown;
  defenderPower: PowerBreakdown;
  attackerLosses: Record<string, number>;
  defenderLosses: Record<string, number>;
}

/**
 * Every multiplier that touched the result, uncapped AND capped.
 *
 * Logging both sides of the joint cap is not optional: a silent cap produces
 * accusations of cheating (spec/03 §5, formulas.applyJointCap).
 */
export interface PowerBreakdown {
  byUnit: UnitPowerRow[];
  base: number;
  techTier: number;
  equipment: number;
  doctrine: number;
  commander: number;
  veterancy: number;
  morale: number;
  counterMatrix: number;
  fortification?: number;
  flatGarrisonHp?: number;
  heavensEnvy?: number;
  uncapped: number;
  capped: number;
  jointCapEngaged: boolean;
  total: number;
}

export interface UnitPowerRow {
  formationId: Uuid;
  formationName: string;
  unitKey: string;
  unitName: string;
  role: string;
  count: number;
  perUnit: number;
  veterancyMultiplier: number;
  counterMultiplier: number;
  contribution: number;
  contributionShare: number;
}

export interface SideSummary {
  playerId?: Uuid;
  playerName: string;
  empireWeight: number;
  formations: { formationId: Uuid; name: string; unitKey: string; before: number; after: number }[];
  totalBefore: number;
  totalAfter: number;
}

export interface AttributionSummary {
  formationId: Uuid;
  formationName: string;
  track: VeterancyTrack;
  killsCredited: Record<string, number>;
  rawValue: number;
  roleFactorAvg: number;
  relativeFactorAvg: number;
  fatigue: number;
  repetition: number;
  absorptionXp: string;
  xpAwarded: string;
  zeroReason?: string;
  /** What the next level costs, and why it costs that. */
  requirement: XpRequirementBreakdown;
}

export interface XpRequirementBreakdown {
  base: number;
  levelFactor: number;
  tierFactor: number;
  empireWeightMultiplier: number;
  total: string;
}

// ------------------------------------------------------------------- social

export interface Alliance {
  id: Uuid;
  worldId: Uuid;
  name: string;
  tag: string;
  treasury: Record<string, bigint>;
  foundedAt: Millis;
}

export interface AllianceMember {
  allianceId: Uuid;
  playerId: Uuid;
  role: AllianceRole;
  permissions: string[];
  joinedAt: Millis;
}

export interface Treaty {
  id: Uuid;
  kind: TreatyKind;
  partyA: Uuid;
  partyB: Uuid;
  terms: Record<string, unknown>;
  signedAt: Millis;
  expiresAt?: Millis;
  brokenAt?: Millis;
}

/**
 * A governor executes spec sheets over an area at 2x time cost.
 *
 * Governors have NO JUDGEMENT: a build order that ignores a resource shortfall
 * stalls the queue rather than skipping ahead, and that stall must surface on
 * the attention dashboard (spec/04 §6).
 */
export interface Governor {
  id: Uuid;
  playerId: Uuid;
  commanderId: Uuid;
  tier: GovernorTier;
  areaRef: AreaRef;
  specs: GovernorSpecs;
  /** Set when an enemy spymaster turns this governor. Corrupted specs are
   *  followed SILENTLY; only an audit reveals it (spec/04 §9). */
  subvertedBy?: Uuid;
  appointedAt: Millis;
}

export interface AreaRef {
  layer: Layer;
  /** Settlement ids inside the area of authority. */
  settlementIds: Uuid[];
}

/** The six spec sheets that define a governor's behaviour (spec/04 §6). */
export interface GovernorSpecs {
  buildOrder: { buildingKey: string; toLevel: number }[];
  trainingStandingOrder: { unitKey: string; maintainCount: number }[];
  researchMandate: string[];
  resourcePolicy: { keepDays: number; haulSurplusTo?: Uuid };
  defencePosture: 'garrison' | 'mobile' | 'fortify';
  escalationRules: { alertOnIncoming: boolean; alertBelowLoyalty: number };
}

// ------------------------------------------------------------------- events

export interface ScheduledEvent {
  id: Uuid;
  shardId: Uuid;
  /** Epoch ms UTC. NEVER a relative duration. */
  executeAt: Millis;
  kind: EventKind;
  payload: Record<string, unknown>;
  claimedBy?: string;
  claimedAt?: Millis;
}

/**
 * A direct message between two players.
 *
 * Diplomacy in this genre happens in the inbox long before it happens on the
 * map: the treaty is the record of a conversation, not the conversation. So
 * messages are first-class state with a real read model, not a chat overlay.
 */
export interface Message {
  id: Uuid;
  worldId: Uuid;
  fromId: Uuid;
  toId: Uuid;
  subject: string;
  body: string;
  sentAt: Millis;
  /** Unset until the recipient opens it. Drives the unread badge. */
  readAt?: Millis;
  /** Set when the recipient files it away, so an inbox can be cleared. */
  archivedAt?: Millis;
}

/** Where a forum thread lives: the whole world, or one alliance's private board. */
export type BoardScope = 'world' | 'alliance';

/**
 * A forum thread.
 *
 * Kept deliberately plain — a title, a scope, and posts. The forum is where a
 * server argues about a war it has not declared yet, and that works better as
 * slow text than as anything cleverer.
 */
export interface Thread {
  id: Uuid;
  worldId: Uuid;
  scope: BoardScope;
  /** Set when the scope is `alliance`. */
  allianceId?: Uuid;
  title: string;
  authorId: Uuid;
  createdAt: Millis;
  /** Bumped by every reply, so a board sorts by life rather than by birth. */
  lastPostAt: Millis;
  postCount: number;
  /** Locked threads keep their history and stop taking replies. */
  lockedAt?: Millis;
}

export interface Post {
  id: Uuid;
  threadId: Uuid;
  authorId: Uuid;
  body: string;
  postedAt: Millis;
}

export type EventKind =
  | 'BUILD_COMPLETE'
  | 'RESEARCH_COMPLETE'
  | 'TRAINING_COMPLETE'
  | 'TIER_UP_COMPLETE'
  | 'MOVEMENT_ARRIVE'
  | 'CONVOY_ARRIVE'
  | 'PRODUCTION_ACCRUE'
  | 'ATTRITION_TICK'
  | 'REVOLT_CHECK'
  | 'TRIBULATION_WINDOW'
  | 'DECAY_TICK'
  | 'HEAVENS_ENVY_RESOLVE'
  | 'EPOCH_TRANSITION';

/**
 * A tribulation standing open.
 *
 * Several are publicly visible and can be crashed by rivals (spec/04 §10), so
 * this is a first-class row other players can see and act against — not a
 * private timer.
 */
export interface Tribulation {
  id: Uuid;
  playerId: Uuid;
  worldId: Uuid;
  shardId: Uuid;
  /** The grade being broken into. */
  grade: number;
  trialName: string;
  visible: boolean;
  crashable: boolean;
  qiSpent: bigint;
  /** Where the avatar is while it happens, so rivals know where to go. */
  settlementId: Uuid;
  openedAt: Millis;
  resolvesAt: Millis;
  /** Players who have interfered. Each one lowers the odds. */
  interferers: Uuid[];
}

export interface LoggedEvent {
  id: Uuid;
  worldId: Uuid;
  shardId: Uuid;
  occurredAt: Millis;
  kind: string;
  actorId?: Uuid;
  subjectId?: Uuid;
  payload: Record<string, unknown>;
}

// -------------------------------------------------------- attention feed

/**
 * One row of the Attention Dashboard — the home screen and, with no cap on
 * holdings, where players will live (spec/06 §3).
 */
export interface AttentionItem {
  id: string;
  kind:
    | 'idle_queue'
    | 'governor_stalled'
    | 'warehouse_full'
    | 'understaffed'
    | 'incoming_attack'
    | 'escalation'
    | 'brownout'
    | 'promotion_eligible';
  urgency: number;
  settlementId?: Uuid;
  settlementName?: string;
  title: string;
  detail: string;
  /** The one-tap resolution, where one exists. */
  action?: { label: string; command: string; params: Record<string, unknown> };
  /** For countdowns: the client renders from the absolute server timestamp. */
  deadline?: Millis;
}
