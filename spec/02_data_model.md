# 02 — Data Model

Postgres 16. All tables carry `shard_id` from the outset (see `01_architecture.md` §3).
Resource amounts, XP, and veterancy ratings are `NUMERIC(40,0)` in the database and
`bigint` in TypeScript — these values legitimately exceed 2^53.

## Conventions

- Primary keys are UUIDv7 (time-ordered, index-friendly).
- Every mutable table has `created_at`, `updated_at`, and `version` (optimistic locking).
- Soft deletes only where history matters (settlements become ruins; they are never deleted).
- Timestamps are `BIGINT` epoch milliseconds UTC, never `timestamptz`, so that simulation
  time arithmetic is exact and timezone-free.

---

## 1. Identity and player

```sql
-- A human account. One per person; multi-accounting is detected, not modelled.
CREATE TABLE account (
  id            UUID PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  created_at    BIGINT NOT NULL,
  -- Linked-account detection feeds this. Used by transfer caps, Heaven's Envy
  -- leaderboards, and Empire Weight aggregation. See 04_game_systems.md §11.
  link_group_id UUID
);

-- A dynasty is the permanent identity that survives defeat and refounding.
-- Prestige, traditions, and the Hall of Ascendance attach here, not to the player's
-- current empire. See GDD v2 §11.4.
CREATE TABLE dynasty (
  id            UUID PRIMARY KEY,
  account_id    UUID NOT NULL REFERENCES account(id),
  name          TEXT NOT NULL,
  heraldry      JSONB NOT NULL,
  prestige      NUMERIC(40,0) NOT NULL DEFAULT 0,
  traditions    JSONB NOT NULL DEFAULT '[]',   -- earned account-level perks
  founded_at    BIGINT NOT NULL
);

-- The active empire. A dynasty may have had several across epochs.
CREATE TABLE player (
  id               UUID PRIMARY KEY,
  dynasty_id       UUID NOT NULL REFERENCES dynasty(id),
  world_id         UUID NOT NULL,
  era              SMALLINT NOT NULL DEFAULT 1,     -- 1..7
  alliance_id      UUID,
  reputation       INTEGER NOT NULL DEFAULT 0,
  -- Rolling 30-day average. Drives the veterancy XP requirement multiplier.
  -- Averaged precisely so shedding holdings before a war does not work.
  -- See 04_game_systems.md §5 and workbook sheet Empire_Weight_Multiplier.
  empire_weight_avg NUMERIC(12,2) NOT NULL DEFAULT 0,
  cultivation_grade SMALLINT NOT NULL DEFAULT 1,    -- 1..42
  qi               NUMERIC(40,0) NOT NULL DEFAULT 0,
  temporal_debt    SMALLINT NOT NULL DEFAULT 0,     -- 0..5, Chrono Shard karma
  created_at       BIGINT NOT NULL
);

-- Five proficiency tracks, player-level and never affected by empire weight.
CREATE TABLE proficiency (
  player_id  UUID NOT NULL REFERENCES player(id),
  track      TEXT NOT NULL,   -- construction|technology|warfare|commerce|exploration
  rank       SMALLINT NOT NULL DEFAULT 0,
  xp         NUMERIC(40,0) NOT NULL DEFAULT 0,
  xp_today   NUMERIC(40,0) NOT NULL DEFAULT 0,  -- daily soft cap enforcement
  PRIMARY KEY (player_id, track)
);
```

---

## 2. World and map

```sql
-- A holding. Everything from an Outpost to a Galactic Throne is one of these.
-- Isolation invariant: this row owns its own resources, queues, and population.
CREATE TABLE settlement (
  id             UUID PRIMARY KEY,
  shard_id       UUID NOT NULL,
  world_id       UUID NOT NULL,
  owner_id       UUID REFERENCES player(id),       -- NULL = NPC or ruin
  holding_type   TEXT NOT NULL,                    -- see Holdings_Hierarchy sheet
  name           TEXT NOT NULL,
  layer          TEXT NOT NULL,                    -- province|continent|planet|orbit|system|galaxy
  parent_id      UUID REFERENCES settlement(id),   -- containing body, if any
  coord_x        DOUBLE PRECISION NOT NULL,
  coord_y        DOUBLE PRECISION NOT NULL,
  terrain        JSONB NOT NULL,                   -- yield tiles, hazards, adjacency inputs
  plots_total    SMALLINT NOT NULL,
  population     INTEGER NOT NULL DEFAULT 0,
  happiness      SMALLINT NOT NULL DEFAULT 100,
  health         SMALLINT NOT NULL DEFAULT 100,    -- era IV+
  loyalty        SMALLINT NOT NULL DEFAULT 100,    -- 0 = flips to the attacker
  -- Decay state for abandoned holdings: 100 = intact, 50 = NPC successor, 0 = ruin.
  -- Drives the archaeology system. See GDD v2 §5.3.
  integrity      SMALLINT NOT NULL DEFAULT 100,
  governor_id    UUID,                             -- NULL = player-managed
  created_at     BIGINT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ON settlement (shard_id, owner_id);
CREATE INDEX ON settlement USING GIST (point(coord_x, coord_y));

-- One row per building instance. A settlement holds many; plots constrain how many.
CREATE TABLE building (
  id            UUID PRIMARY KEY,
  settlement_id UUID NOT NULL REFERENCES settlement(id),
  building_key  TEXT NOT NULL,        -- matches Buildings_Master sheet, e.g. 'chieftains_hall'
  level         INTEGER NOT NULL DEFAULT 0,     -- 0..1337
  damage        INTEGER NOT NULL DEFAULT 0,     -- levels of siege damage to repair
  plot_index    SMALLINT NOT NULL,              -- position, for adjacency calculation
  staffed_pct   SMALLINT NOT NULL DEFAULT 100,  -- output scales linearly with this
  UNIQUE (settlement_id, building_key)
);

-- Per-settlement stockpile. There is no empire treasury; this is the only place
-- resources exist. See invariant §2.4.
CREATE TABLE stockpile (
  settlement_id UUID NOT NULL REFERENCES settlement(id),
  resource_key  TEXT NOT NULL,            -- one of the ~40 in the Resources sheets
  amount        NUMERIC(40,0) NOT NULL DEFAULT 0,
  capacity      NUMERIC(40,0) NOT NULL,   -- overflow above this is LOST, not stored
  PRIMARY KEY (settlement_id, resource_key)
);
```

---

## 3. Queues and production

```sql
-- Construction and research queue. One row per queued item.
-- `finishes_at` is computed ONCE at enqueue and never recomputed downward except by
-- an audited Seize or Chrono Shard spend. See invariant §2.8.
CREATE TABLE queue_item (
  id            UUID PRIMARY KEY,
  settlement_id UUID NOT NULL REFERENCES settlement(id),
  kind          TEXT NOT NULL,        -- building|research|training|repair|tier_up
  target_key    TEXT NOT NULL,
  target_level  INTEGER,
  quantity      INTEGER DEFAULT 1,
  slot_kind     TEXT NOT NULL,        -- personal|governor
  started_at    BIGINT NOT NULL,
  finishes_at   BIGINT NOT NULL,
  -- 1.0 for player-initiated, 2.0 for governor-initiated. The entire governor
  -- system is this one number. See 04_game_systems.md §6.
  time_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  shards_spent  NUMERIC(40,0) NOT NULL DEFAULT 0,
  position      SMALLINT NOT NULL
);
CREATE INDEX ON queue_item (settlement_id, position);
```

---

## 4. Military

```sql
-- A named stack of one unit type in one settlement. Veterancy attaches HERE,
-- not to individual soldiers and not to the player. This is what players name,
-- grow attached to, and see in the World Atlas.
CREATE TABLE formation (
  id             UUID PRIMARY KEY,
  settlement_id  UUID NOT NULL REFERENCES settlement(id),
  owner_id       UUID NOT NULL REFERENCES player(id),
  name           TEXT NOT NULL,              -- player-chosen, e.g. 'The Ninth Pike'
  unit_key       TEXT NOT NULL,              -- matches Units_Master sheet
  count          INTEGER NOT NULL,
  -- Two independent veterancy tracks. Attacking feeds one, defending the other.
  atk_tier       SMALLINT NOT NULL DEFAULT 1,   -- 1..24 (Copper..Eternal)
  atk_level      INTEGER  NOT NULL DEFAULT 0,   -- 0..1337
  atk_xp         NUMERIC(40,0) NOT NULL DEFAULT 0,
  def_tier       SMALLINT NOT NULL DEFAULT 1,
  def_level      INTEGER  NOT NULL DEFAULT 0,
  def_xp         NUMERIC(40,0) NOT NULL DEFAULT 0,
  equipment      JSONB NOT NULL DEFAULT '{}',    -- weapon/protection/utility slots
  commander_id   UUID,
  created_at     BIGINT NOT NULL
);
CREATE INDEX ON formation (owner_id);
CREATE INDEX ON formation (settlement_id);

-- An army or fleet in transit. Arrival is a scheduled event, never a poll.
CREATE TABLE movement (
  id             UUID PRIMARY KEY,
  shard_id       UUID NOT NULL,
  owner_id       UUID NOT NULL REFERENCES player(id),
  origin_id      UUID NOT NULL REFERENCES settlement(id),
  target_id      UUID NOT NULL REFERENCES settlement(id),
  mission        TEXT NOT NULL,      -- attack|raid|reinforce|scout|haul|settle|conquer
  formations     JSONB NOT NULL,     -- [{formationId, count}] — partial stacks allowed
  cargo          JSONB,              -- for haul missions
  departs_at     BIGINT NOT NULL,
  arrives_at     BIGINT NOT NULL,
  -- Visible to the defender only within their warning radius. See 04 §8.
  revealed_to    JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX ON movement (arrives_at);
CREATE INDEX ON movement (target_id);
```

---

## 5. Battles and attribution

```sql
-- One row per resolved engagement. Immutable.
CREATE TABLE battle (
  id            UUID PRIMARY KEY,
  shard_id      UUID NOT NULL,
  settlement_id UUID NOT NULL,
  attacker_id   UUID,
  defender_id   UUID,
  resolved_at   BIGINT NOT NULL,
  seed          BIGINT NOT NULL,      -- the PRNG seed; makes the battle replayable
  -- Full phase-by-phase arithmetic. This is shown to BOTH sides in its entirety.
  -- Every multiplier that touched the result must appear here. See invariant §2.7.
  report        JSONB NOT NULL
);
CREATE INDEX ON battle (settlement_id, resolved_at DESC);

-- XP credited per unit type per battle. Written asynchronously after resolution
-- so it never sits on the critical path. ~20-60 rows per side per battle.
-- See 03_simulation_engine.md §7 and workbook sheet XP_Attribution.
CREATE TABLE battle_attribution (
  battle_id      UUID NOT NULL REFERENCES battle(id),
  formation_id   UUID NOT NULL REFERENCES formation(id),
  track          TEXT NOT NULL,            -- atk|def
  kills_credited JSONB NOT NULL,           -- {victimUnitKey: count}
  raw_value      NUMERIC(40,0) NOT NULL,   -- sum of UPV before factors
  role_factor    NUMERIC(8,4) NOT NULL,
  relative_factor NUMERIC(8,4) NOT NULL,
  fatigue        NUMERIC(12,8) NOT NULL,
  repetition     NUMERIC(4,2) NOT NULL,
  xp_awarded     NUMERIC(40,0) NOT NULL,
  PRIMARY KEY (battle_id, formation_id, track)
);
```

---

## 6. Social systems

```sql
CREATE TABLE alliance (
  id          UUID PRIMARY KEY,
  world_id    UUID NOT NULL,
  name        TEXT NOT NULL,
  tag         TEXT NOT NULL,
  treasury    JSONB NOT NULL DEFAULT '{}',
  founded_at  BIGINT NOT NULL
);

CREATE TABLE alliance_member (
  alliance_id UUID NOT NULL REFERENCES alliance(id),
  player_id   UUID NOT NULL REFERENCES player(id),
  role        TEXT NOT NULL,      -- leader|diplomat|ops|quartermaster|banker|member
  permissions JSONB NOT NULL,
  joined_at   BIGINT NOT NULL,
  PRIMARY KEY (alliance_id, player_id)
);

-- Treaties have mechanical teeth: NAP attacks are UI-blocked, breaches carry
-- reputation and debuff consequences. See 04_game_systems.md §7.
CREATE TABLE treaty (
  id          UUID PRIMARY KEY,
  kind        TEXT NOT NULL,      -- nap|trade|defensive|tribute|border|war|armistice
  party_a     UUID NOT NULL,
  party_b     UUID NOT NULL,
  terms       JSONB NOT NULL,
  signed_at   BIGINT NOT NULL,
  expires_at  BIGINT,
  broken_at   BIGINT
);

-- A governor executes spec sheets over an area at 2x time cost.
CREATE TABLE governor (
  id            UUID PRIMARY KEY,
  player_id     UUID NOT NULL REFERENCES player(id),
  commander_id  UUID NOT NULL,
  tier          TEXT NOT NULL,     -- bailiff|planetary|system|sector
  area_ref      JSONB NOT NULL,    -- which province/planet/system/arm
  specs         JSONB NOT NULL,    -- the six spec sheets; see 04 §6
  -- Set when an enemy spymaster turns this governor. Corrupted specs are followed
  -- silently; only an audit reveals it. See 04_game_systems.md §9.
  subverted_by  UUID,
  appointed_at  BIGINT NOT NULL
);
```

---

## 7. Event log

```sql
-- Append-only, partitioned monthly, never deleted. Powers replay, archaeology,
-- the World Atlas, and dispute resolution. Old partitions detach to cold storage.
CREATE TABLE event_log (
  id          UUID NOT NULL,
  world_id    UUID NOT NULL,
  shard_id    UUID NOT NULL,
  occurred_at BIGINT NOT NULL,
  kind        TEXT NOT NULL,
  actor_id    UUID,
  subject_id  UUID,
  payload     JSONB NOT NULL
) PARTITION BY RANGE (occurred_at);

CREATE INDEX ON event_log (world_id, occurred_at DESC);
CREATE INDEX ON event_log (subject_id, occurred_at DESC);

-- Scheduled future events. The timer wheel mirrors this in Redis.
CREATE TABLE scheduled_event (
  id          UUID PRIMARY KEY,
  shard_id    UUID NOT NULL,
  execute_at  BIGINT NOT NULL,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  claimed_by  TEXT,
  claimed_at  BIGINT
);
CREATE INDEX ON scheduled_event (shard_id, execute_at) WHERE claimed_by IS NULL;
```

---

## 8. Balance data (generated, read-only)

Balance tables are **generated from the workbook at build time**, not hand-edited.
The importer (`packages/tools/import-workbook.ts`) reads each sheet and emits both a
TypeScript constants module and a seed SQL file.

| Table | Source sheet |
|---|---|
| `ref_building` | `Buildings_Master`, `Specs_EraI` |
| `ref_building_level` | `Building_Levels` |
| `ref_unit` | `Units_Master`, `Archetypes`, `Unit_Grades`, `Unit_Paths` |
| `ref_counter_matrix` | `Counter_Matrix` |
| `ref_research` | `Research_Disciplines` |
| `ref_equipment` | `Equipment_Catalog` |
| `ref_grade` | `Grades_Realms` |
| `ref_veterancy_tier` | `Veterancy_Tiers` |
| `ref_holding_type` | `Holdings_Hierarchy` |
| `ref_celestial_site` | `Celestial_Sites` |
| `ref_constants` | `Veterancy_XP`, `Chrono_Shards`, `Empire_Weight_Multiplier`, `Heavens_Envy` |
