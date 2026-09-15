-- 0001_schema.sql — the authoritative schema (spec/02_data_model.md)
--
-- Postgres 16. Every table carries shard_id from the outset: retrofitting
-- sharding is painful, and carrying an unused shard column is free
-- (spec/01 §3).
--
-- CONVENTIONS
--   - Primary keys are UUIDv7: time-ordered and index-friendly.
--   - Resource amounts, XP and veterancy ratings are NUMERIC(40,0). These
--     values legitimately exceed 2^53 — XP requirements reach 1.88e12 and
--     resource costs 2.3e14 — so they are never floats.
--   - Timestamps are BIGINT epoch milliseconds UTC, never timestamptz, so that
--     simulation arithmetic is exact and timezone-free.
--   - Soft deletes only where history matters: settlements become ruins, they
--     are never deleted.
--
-- The engine runs against a Store interface (DECISIONS.md D4). This file is
-- what the Postgres driver targets, and what packages/tools seeds.

BEGIN;

-- ===========================================================================
-- 1. Identity and player
-- ===========================================================================

-- A human account. One per person; multi-accounting is detected, not modelled.
CREATE TABLE IF NOT EXISTS account (
  id            UUID PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  created_at    BIGINT NOT NULL,
  -- Linked-account detection feeds this. Used by transfer caps, Heaven's Envy
  -- leaderboards, and Empire Weight aggregation (spec/04 §11).
  link_group_id UUID
);

-- A dynasty is the permanent identity that survives defeat and refounding.
-- Prestige, traditions and the Hall of Ascendance attach HERE, not to the
-- player's current empire.
CREATE TABLE IF NOT EXISTS dynasty (
  id            UUID PRIMARY KEY,
  account_id    UUID NOT NULL REFERENCES account(id),
  name          TEXT NOT NULL,
  heraldry      JSONB NOT NULL,
  prestige      NUMERIC(40,0) NOT NULL DEFAULT 0,
  traditions    JSONB NOT NULL DEFAULT '[]',
  founded_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS player (
  id                UUID PRIMARY KEY,
  dynasty_id        UUID NOT NULL REFERENCES dynasty(id),
  world_id          UUID NOT NULL,
  name              TEXT NOT NULL,
  era               SMALLINT NOT NULL DEFAULT 1 CHECK (era BETWEEN 1 AND 7),
  alliance_id       UUID,
  reputation        INTEGER NOT NULL DEFAULT 0,
  -- Rolling 30-day average, averaged precisely so shedding holdings before a
  -- war does not work. Drives the veterancy XP requirement multiplier.
  empire_weight_avg NUMERIC(12,2) NOT NULL DEFAULT 0,
  cultivation_grade SMALLINT NOT NULL DEFAULT 1 CHECK (cultivation_grade BETWEEN 1 AND 42),
  qi                NUMERIC(40,0) NOT NULL DEFAULT 0,
  -- Chrono Shard karma. Raises tribulation difficulty, suppresses Qi regen.
  temporal_debt     SMALLINT NOT NULL DEFAULT 0 CHECK (temporal_debt BETWEEN 0 AND 6),
  envy_scopes       JSONB NOT NULL DEFAULT '[]',
  envy_expires_at   BIGINT,
  shard_balance_hours      NUMERIC(20,4) NOT NULL DEFAULT 0,
  -- PUBLIC on the profile (spec/04 §11 guardrail 4).
  shard_hours_purchased_30d NUMERIC(20,4) NOT NULL DEFAULT 0,
  link_group_id     UUID,
  created_at        BIGINT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS player_world_idx ON player (world_id);

-- Five proficiency tracks, player-level and never affected by empire weight.
CREATE TABLE IF NOT EXISTS proficiency (
  player_id  UUID NOT NULL REFERENCES player(id),
  track      TEXT NOT NULL CHECK (track IN ('construction','technology','warfare','commerce','exploration')),
  rank       SMALLINT NOT NULL DEFAULT 0,
  xp         NUMERIC(40,0) NOT NULL DEFAULT 0,
  xp_today   NUMERIC(40,0) NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, track)
);

-- ===========================================================================
-- 2. World and map
-- ===========================================================================

-- A holding. Everything from an Outpost to a Galactic Throne is one of these.
-- ISOLATION INVARIANT (§2.4): this row owns its own resources, queues and
-- population. There is no empire treasury.
CREATE TABLE IF NOT EXISTS settlement (
  id             UUID PRIMARY KEY,
  shard_id       UUID NOT NULL,
  world_id       UUID NOT NULL,
  owner_id       UUID REFERENCES player(id),       -- NULL = NPC or ruin
  holding_type   TEXT NOT NULL,
  name           TEXT NOT NULL,
  layer          TEXT NOT NULL,
  parent_id      UUID REFERENCES settlement(id),
  coord_x        DOUBLE PRECISION NOT NULL,
  coord_y        DOUBLE PRECISION NOT NULL,
  terrain        JSONB NOT NULL,
  plots_total    SMALLINT NOT NULL,
  population     INTEGER NOT NULL DEFAULT 0,
  happiness      SMALLINT NOT NULL DEFAULT 100,
  health         SMALLINT NOT NULL DEFAULT 100,    -- era IV+
  loyalty        SMALLINT NOT NULL DEFAULT 100,    -- 0 flips to the attacker
  -- 100 intact, 50 NPC successor, 0 ruin. Drives the archaeology system.
  integrity      SMALLINT NOT NULL DEFAULT 100,
  governor_id    UUID,
  -- Production is NEVER a tick. Accrual is computed from this on read.
  last_accrued_at BIGINT NOT NULL,
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL DEFAULT 0,
  version        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS settlement_shard_owner_idx ON settlement (shard_id, owner_id);
CREATE INDEX IF NOT EXISTS settlement_point_idx ON settlement USING GIST (point(coord_x, coord_y));

CREATE TABLE IF NOT EXISTS building (
  id            UUID PRIMARY KEY,
  settlement_id UUID NOT NULL REFERENCES settlement(id),
  building_key  TEXT NOT NULL,
  level         INTEGER NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 1337),
  damage        INTEGER NOT NULL DEFAULT 0,       -- levels of siege damage
  plot_index    SMALLINT NOT NULL,                -- position, for adjacency
  staffed_pct   SMALLINT NOT NULL DEFAULT 100,    -- output scales LINEARLY
  brownout_since BIGINT,
  UNIQUE (settlement_id, building_key)
);

-- Per-settlement stockpile. The ONLY place resources exist (§2.4).
CREATE TABLE IF NOT EXISTS stockpile (
  settlement_id UUID NOT NULL REFERENCES settlement(id),
  resource_key  TEXT NOT NULL,
  amount        NUMERIC(40,0) NOT NULL DEFAULT 0,
  -- Overflow above this is LOST, not stored. That loss is deliberate design
  -- pressure to spend, trade, or expand.
  capacity      NUMERIC(40,0) NOT NULL,
  PRIMARY KEY (settlement_id, resource_key)
);

-- ===========================================================================
-- 3. Queues and production
-- ===========================================================================

CREATE TABLE IF NOT EXISTS queue_item (
  id            UUID PRIMARY KEY,
  settlement_id UUID NOT NULL REFERENCES settlement(id),
  kind          TEXT NOT NULL CHECK (kind IN ('building','research','training','repair','tier_up')),
  target_key    TEXT NOT NULL,
  target_level  INTEGER,
  quantity      INTEGER NOT NULL DEFAULT 1,
  slot_kind     TEXT NOT NULL CHECK (slot_kind IN ('personal','governor')),
  started_at    BIGINT NOT NULL,
  -- Computed ONCE at enqueue. Never recomputed downward except by an audited
  -- Seize or Chrono Shard spend (invariant §2.8).
  finishes_at   BIGINT NOT NULL,
  -- 1.0 player-initiated, 2.0 governor-initiated. The entire governor system
  -- is this one number.
  time_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  shard_hours_spent NUMERIC(20,4) NOT NULL DEFAULT 0,
  compressed_ms  BIGINT NOT NULL DEFAULT 0,
  position      SMALLINT NOT NULL
);
CREATE INDEX IF NOT EXISTS queue_item_settlement_idx ON queue_item (settlement_id, position);
CREATE INDEX IF NOT EXISTS queue_item_finishes_idx ON queue_item (finishes_at);

-- ===========================================================================
-- 4. Military
-- ===========================================================================

-- Veterancy attaches HERE — not to individual soldiers, and not to the player.
-- This is what players name, grow attached to, and see in the World Atlas.
CREATE TABLE IF NOT EXISTS formation (
  id             UUID PRIMARY KEY,
  settlement_id  UUID NOT NULL REFERENCES settlement(id),
  owner_id       UUID NOT NULL REFERENCES player(id),
  name           TEXT NOT NULL,              -- player-chosen, e.g. 'The Ninth Pike'
  unit_key       TEXT NOT NULL,
  count          INTEGER NOT NULL,
  -- Two independent tracks: attacking feeds one, defending the other.
  atk_tier       SMALLINT NOT NULL DEFAULT 1 CHECK (atk_tier BETWEEN 1 AND 24),
  atk_level      INTEGER  NOT NULL DEFAULT 0 CHECK (atk_level BETWEEN 0 AND 1337),
  atk_xp         NUMERIC(40,0) NOT NULL DEFAULT 0,
  def_tier       SMALLINT NOT NULL DEFAULT 1 CHECK (def_tier BETWEEN 1 AND 24),
  def_level      INTEGER  NOT NULL DEFAULT 0 CHECK (def_level BETWEEN 0 AND 1337),
  def_xp         NUMERIC(40,0) NOT NULL DEFAULT 0,
  equipment      JSONB NOT NULL DEFAULT '{}',
  commander_id   UUID,
  -- Qualifying deeds on record. The third promotion requirement (spec/03 §8).
  deeds          JSONB NOT NULL DEFAULT '[]',
  created_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS formation_owner_idx ON formation (owner_id);
CREATE INDEX IF NOT EXISTS formation_settlement_idx ON formation (settlement_id);

-- An army or fleet in transit. Arrival is a scheduled event, never a poll.
CREATE TABLE IF NOT EXISTS movement (
  id             UUID PRIMARY KEY,
  shard_id       UUID NOT NULL,
  owner_id       UUID NOT NULL REFERENCES player(id),
  origin_id      UUID NOT NULL REFERENCES settlement(id),
  target_id      UUID NOT NULL REFERENCES settlement(id),
  mission        TEXT NOT NULL CHECK (mission IN ('attack','raid','reinforce','scout','haul','settle','conquer')),
  formations     JSONB NOT NULL,     -- [{formationId, count}] — partial stacks allowed
  cargo          JSONB,
  departs_at     BIGINT NOT NULL,
  arrives_at     BIGINT NOT NULL,
  -- Visible to the defender only within their warning radius (spec/04 §8).
  revealed_to    JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS movement_arrives_idx ON movement (arrives_at);
CREATE INDEX IF NOT EXISTS movement_target_idx ON movement (target_id);

-- ===========================================================================
-- 5. Battles and attribution
-- ===========================================================================

CREATE TABLE IF NOT EXISTS battle (
  id            UUID PRIMARY KEY,
  shard_id      UUID NOT NULL,
  settlement_id UUID NOT NULL,
  attacker_id   UUID,
  defender_id   UUID,
  resolved_at   BIGINT NOT NULL,
  -- The PRNG seed. This alone makes the battle replayable, which is what
  -- dispute resolution and the client-side Simulator both rest on.
  seed          NUMERIC(40,0) NOT NULL,
  -- Full phase-by-phase arithmetic, shown to BOTH sides in its entirety.
  -- Every multiplier that touched the result appears here (invariant §2.7).
  report        JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS battle_settlement_idx ON battle (settlement_id, resolved_at DESC);

-- XP credited per formation per battle. Written ASYNCHRONOUSLY after
-- resolution so it never sits on the critical path.
CREATE TABLE IF NOT EXISTS battle_attribution (
  battle_id       UUID NOT NULL REFERENCES battle(id),
  formation_id    UUID NOT NULL REFERENCES formation(id),
  track           TEXT NOT NULL CHECK (track IN ('atk','def')),
  kills_credited  JSONB NOT NULL,
  raw_value       NUMERIC(40,0) NOT NULL,
  role_factor     NUMERIC(8,4) NOT NULL,
  relative_factor NUMERIC(8,4) NOT NULL,
  fatigue         NUMERIC(12,8) NOT NULL,
  repetition      NUMERIC(4,2) NOT NULL,
  absorption_xp   NUMERIC(40,0) NOT NULL DEFAULT 0,
  xp_awarded      NUMERIC(40,0) NOT NULL,
  zero_reason     TEXT,
  PRIMARY KEY (battle_id, formation_id, track)
);

-- ===========================================================================
-- 6. Social systems
-- ===========================================================================

CREATE TABLE IF NOT EXISTS alliance (
  id          UUID PRIMARY KEY,
  world_id    UUID NOT NULL,
  name        TEXT NOT NULL,
  tag         TEXT NOT NULL,
  treasury    JSONB NOT NULL DEFAULT '{}',
  founded_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS alliance_member (
  alliance_id UUID NOT NULL REFERENCES alliance(id),
  player_id   UUID NOT NULL REFERENCES player(id),
  role        TEXT NOT NULL CHECK (role IN ('leader','diplomat','ops','quartermaster','banker','member')),
  permissions JSONB NOT NULL DEFAULT '[]',
  joined_at   BIGINT NOT NULL,
  PRIMARY KEY (alliance_id, player_id)
);

-- Treaties have mechanical teeth: a NAP hard-blocks attacks in the UI AND on
-- the server. Breaches cost reputation and apply a pact-breaker debuff.
-- Reputation never BLOCKS an action — betrayal is always allowed and always
-- priced (spec/04 §7).
CREATE TABLE IF NOT EXISTS treaty (
  id          UUID PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('nap','trade','defensive','tribute','border','war','armistice')),
  party_a     UUID NOT NULL,
  party_b     UUID NOT NULL,
  terms       JSONB NOT NULL DEFAULT '{}',
  signed_at   BIGINT NOT NULL,
  expires_at  BIGINT,
  broken_at   BIGINT
);
CREATE INDEX IF NOT EXISTS treaty_parties_idx ON treaty (party_a, party_b) WHERE broken_at IS NULL;

CREATE TABLE IF NOT EXISTS governor (
  id            UUID PRIMARY KEY,
  player_id     UUID NOT NULL REFERENCES player(id),
  commander_id  UUID NOT NULL,
  tier          TEXT NOT NULL CHECK (tier IN ('bailiff','planetary','system','sector')),
  area_ref      JSONB NOT NULL,
  -- The six spec sheets. Governors have NO JUDGEMENT: a build order that hits
  -- a resource shortfall stalls rather than skipping ahead.
  specs         JSONB NOT NULL,
  -- Set when an enemy spymaster turns this governor. Corrupted specs are
  -- followed SILENTLY; only an audit reveals it (spec/04 §9).
  subverted_by  UUID,
  appointed_at  BIGINT NOT NULL
);

-- ===========================================================================
-- 7. Event log — append-only, partitioned monthly, NEVER deleted
-- ===========================================================================

-- Powers replay, archaeology, the World Atlas and dispute resolution. Old
-- partitions detach to cold storage; they are never dropped, because
-- archaeology needs them forever (spec/02 §7).
CREATE TABLE IF NOT EXISTS event_log (
  id          UUID NOT NULL,
  world_id    UUID NOT NULL,
  shard_id    UUID NOT NULL,
  occurred_at BIGINT NOT NULL,
  kind        TEXT NOT NULL,
  actor_id    UUID,
  subject_id  UUID,
  payload     JSONB NOT NULL
) PARTITION BY RANGE (occurred_at);

CREATE INDEX IF NOT EXISTS event_log_world_idx ON event_log (world_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS event_log_subject_idx ON event_log (subject_id, occurred_at DESC);

-- Scheduled future events. The Redis timer wheel mirrors this; if Redis is
-- lost the wheel is rebuilt from here, because THIS is the truth.
CREATE TABLE IF NOT EXISTS scheduled_event (
  id          UUID PRIMARY KEY,
  shard_id    UUID NOT NULL,
  execute_at  BIGINT NOT NULL,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  claimed_by  TEXT,
  claimed_at  BIGINT
);
-- The partial index is what makes SELECT ... FOR UPDATE SKIP LOCKED cheap:
-- claimed rows are not in it at all.
CREATE INDEX IF NOT EXISTS scheduled_event_due_idx ON scheduled_event (shard_id, execute_at) WHERE claimed_by IS NULL;

-- Idempotency ledger. Replaying a command with the same id returns the
-- original result rather than acting twice (spec/05 §1).
CREATE TABLE IF NOT EXISTS command_log (
  command_id  UUID PRIMARY KEY,
  player_id   UUID,
  executed_at BIGINT NOT NULL,
  result      JSONB NOT NULL
);

-- ===========================================================================
-- 8. Balance data — GENERATED from the workbook, never hand-edited
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ref_building (
  building_key  TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  era           SMALLINT NOT NULL,
  category      TEXT NOT NULL,
  function_text TEXT NOT NULL,
  base_timber   NUMERIC(20,4) NOT NULL,
  base_stone    NUMERIC(20,4) NOT NULL,
  base_special  NUMERIC(20,4) NOT NULL,
  size_class    SMALLINT NOT NULL
);

CREATE TABLE IF NOT EXISTS ref_holding_type (
  holding_key       TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  era               TEXT NOT NULL,
  layer             TEXT NOT NULL,
  plots_at_founding SMALLINT NOT NULL,
  max_plots         SMALLINT NOT NULL,
  admin_cost        SMALLINT NOT NULL
);

CREATE TABLE IF NOT EXISTS ref_research (
  research_key TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  era          SMALLINT NOT NULL,
  branch       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ref_veterancy_tier (
  tier              SMALLINT PRIMARY KEY,
  name              TEXT NOT NULL,
  cumulative_levels INTEGER NOT NULL,
  total_stat_bonus  NUMERIC(10,2) NOT NULL,
  tier_up_cost      NUMERIC(40,0) NOT NULL
);

CREATE TABLE IF NOT EXISTS ref_grade (
  grade       SMALLINT PRIMARY KEY,
  realm_stage TEXT NOT NULL,
  min_level   INTEGER NOT NULL,
  max_level   INTEGER NOT NULL,
  qi_cost     NUMERIC(40,0) NOT NULL
);

-- Which balance revision the reference tables were generated from, so a
-- running server can always say which numbers it is using (spec/07 §1).
CREATE TABLE IF NOT EXISTS ref_balance_revision (
  revision    TEXT PRIMARY KEY,
  imported_at BIGINT NOT NULL
);

COMMIT;
