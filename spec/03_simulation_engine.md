# 03 — Simulation Engine

The engine is a **pure, deterministic, event-driven core** with no I/O. It lives in
`packages/server/src/sim/` and imports nothing from Fastify, Postgres, or Redis. Callers
load state, call a pure function, and persist the result. This is what makes it testable,
replayable, and portable to another language later if profiling demands it.

---

## 1. Time

There is no game loop. There is a clock and a queue of scheduled events.

- All times are `bigint` epoch milliseconds UTC.
- The simulation never reads the wall clock inside a resolver. The current time is passed
  in as an argument. A resolver that calls `Date.now()` is not replayable and is a defect.
- Durations are computed once at initiation and stored as absolute `finishes_at`
  timestamps. Nothing recomputes them downward except Seize or a Chrono Shard spend, both
  of which are audited actions that write to the event log.

## 2. Determinism

```ts
// Every random draw in the simulation comes from here. Never Math.random().
// Keying on (worldId, eventId) means the same event always produces the same
// draws, so a world replays identically from its event log — which is what makes
// archaeology, dispute resolution, and the World Atlas possible.
function prng(worldId: string, eventId: string): () => number
```

Use a small, fast, well-distributed generator (xoshiro128** or PCG32). Seed by hashing
`worldId:eventId`. Draw counts must be stable: never make the number of draws depend on
a floating-point comparison that could differ across platforms.

## 3. The scheduler

See `reference/scheduler.ts` for annotated code. The contract:

```ts
interface Scheduler {
  // Register a future state change. Writes to Postgres and the Redis timer wheel
  // in one transaction so a crash cannot lose an event or double-run it.
  schedule(e: ScheduledEvent): Promise<void>;

  // Cancel a pending event (e.g. an attack recalled before departure).
  cancel(eventId: string): Promise<boolean>;

  // Claim and execute due events. Called in a tight loop by each simulation worker.
  // Claiming uses SELECT ... FOR UPDATE SKIP LOCKED so multiple workers on the same
  // shard cannot double-execute.
  drain(now: bigint, batchSize: number): Promise<ExecutionResult[]>;
}
```

**Event kinds** (non-exhaustive): `BUILD_COMPLETE`, `RESEARCH_COMPLETE`,
`TRAINING_COMPLETE`, `MOVEMENT_ARRIVE`, `PRODUCTION_ACCRUE`, `CONVOY_ARRIVE`,
`REVOLT_CHECK`, `TRIBULATION_WINDOW`, `TIER_UP_COMPLETE`, `DECAY_TICK`,
`HEAVENS_ENVY_RESOLVE`, `EPOCH_TRANSITION`.

**Production is not a tick.** Do not accrue resources every second. Store
`last_accrued_at` and compute production lazily whenever a settlement is read or mutated:

```
accrued = rate_per_ms * (now - last_accrued_at), clamped to capacity
```

This is the difference between a server that handles ten thousand settlements and one that
handles ten million. Overflow above capacity is discarded, not carried — that loss is a
deliberate design pressure to spend, trade, or expand.

## 4. Movement

```
travelTimeMs = distance / (slowestUnitSpeed * layerModifier * roadModifier)
               * zoneOfControlPenalty        // 0.6x speed inside hostile fortification radius
```

On dispatch: validate, deduct units from the formation, create the `movement` row, and
schedule `MOVEMENT_ARRIVE` at the computed timestamp. Arrival precision is what makes
coordinated multi-wave attacks work, so never round the timestamp.

Supply: beyond a unit's supply range, schedule recurring `ATTRITION_TICK` events at 3% of
strength, escalating. This is what mechanically punishes overextension.

## 5. Combat resolution

A pure function. Same inputs, same seed, same result, always.

```ts
function resolveBattle(input: BattleInput, rng: () => number): BattleResult
```

Phases, in order. Each writes its arithmetic into the report.

1. **Intel & ambush** — scouting quality, terrain concealment, ambush chance.
2. **Ranged / siege exchange** — artillery, bombardment, alpha strike. Fortification
   damage is applied here.
3. **Main engagement** — the core exchange:

```
effectiveAttack = Σ over attacking unit types (
    unitAtk
  * count
  * techTier
  * equipmentMod          // ±5-15% per slot, see Equipment_Catalog
  * doctrineMod
  * commanderMod
  * veterancyMod          // 1 + 0.01 * cumulative levels; max 322x at Eternal L1337
  * morale                // clamp(0.5..1.5) by relative empire size; smaller fights harder
  * counterMatrix[attackerRole][defenderRole]
)

effectiveDefence = same shape, plus:
    fortificationMult     // (1 + 0.05 * wallGrade)
  + flatGarrisonHp
  * heavensEnvyDebuff     // 0.7 to 1.0; see 04_game_systems.md §11
```

**Joint cap:** the combined non-doctrine multiplier on any stat may not exceed +40%.
Apply this as a final clamp, and log both the uncapped and capped values in the report so
the player can see the cap engaged.

4. **Breakthrough / pursuit** — routing, casualty amplification on the losing side.
5. **Plunder or occupation** — loot within carrying capacity, hidden-cellar protection,
   loyalty damage from conquest-class units.
6. **Munitions drain** — Era IV+ only; sustained combat consumes the munitions pool on
   both sides. This is what makes industrial depth decisive in long wars.

**Layer limits are hard rules, not modifiers.** Orbital bombardment softens a planet but
cannot capture it. Blockades starve but cannot conquer. Only era-appropriate ground forces
occupy a settlement. Enforce these as preconditions, not as multipliers.

## 6. Casualties and formations

Casualties are applied to formations proportionally to their contribution share. A
formation reduced to zero is **destroyed and loses all accrued veterancy XP** — experience
is held by the formation, never banked by the player. Survivors carry their veterancy
forward.

**Green dilution** applies on reinforcement, not on loss:

```
newVeterancy = (oldVeterancy * oldCount + freshVeterancy * addedCount) / totalCount
```

Compute this on the cumulative-level scale, not the tier scale, so a Tier 12 formation of
100 merged with 900 recruits lands near Tier 1 correctly. This is the single most important
balancing rule in the veterancy system.

## 7. XP attribution

Runs asynchronously after resolution so it never sits on the critical path. See
`reference/xp.ts` for annotated code and workbook sheets `XP_Attribution` and
`XP_Worked_Example`.

```
For each unit type on each side:

  contributionShare = thisTypeAttackPool / totalFriendlyAttackPool   // per phase
  creditedKills     = phaseEnemyLosses * contributionShare

  For each victim type:
    UPV            = victimUpkeep * victimVeterancyMultiplier
    roleFactor     = 1 / counterMatrix[killerRole][victimRole]
    relativeFactor = clamp((victimUPV / killerUPV) ^ 0.5, 0.05, 4.0)
    value         += creditedKills * UPV * roleFactor * relativeFactor

  fatigue    = 1 / ((level + 1)^0.21 * 1.25^(tier - 1))
  repetition = [1.0, 0.6, 0.35, 0.2, 0.1][min(engagementsToday, 4)]
  xp         = value * fatigue * repetition
```

**Defence track adds a second component**, because screens get no kills:

```
absorptionXp = 0.5 * (damageAbsorbed / totalDamageDelivered)
             * Σ(attackerForceUPV) * fatigue
```

Without this, Guardian-path and screen archetypes could never advance and the whole
identity path would be a trap.

**Hard zero conditions — evaluate before awarding anything:**

- Victim UPV below 2% of killer UPV → zero, not reduced.
- NPC/barbarian kills cannot advance a formation past tier 4 (Steel).
- Attacks two or more eras down → zero.
- Linked-account targets → zero.
- Losing side still earns ~60% of the winning rate on the same attribution.

## 8. Levelling and the requirement stack

```
xpRequired = BASE                              // 100
           * (level + 1) ^ 0.21                // gentle level slope
           * 1.30 ^ (tier - 1)                 // gentle tier slope
           * empireWeightMultiplier            // MIN(9_918_521, 1 + (W/100)^2.41)
```

Empire Weight `W` is the rolling 30-day average of the sum of admin costs of all owned
holdings. Vassalized holdings are not owned and contribute nothing. The rolling average is
what stops a player shedding territory before a war to spike progression.

**Tier promotion requires all three:** level 1337 reached, the resource cost paid from the
formation's home settlement stockpile, and a qualifying deed recorded. Tier-up resource
cost is `50_000 * 2.75^(tier - 2)` and is deliberately **not** multiplied by empire weight —
that asymmetry is what produces the Champion economy described in `04_game_systems.md` §5.

## 9. Testing the engine

Because the core is pure, test it directly and hard:

- **Golden-file tests**: fixed inputs and seed, snapshot the full `BattleResult`.
- **Property tests**: attacker and defender totals conserve; casualties never exceed
  counts; the +40% joint cap is never breached; XP is never negative.
- **Replay test**: replay a recorded event log into a fresh database and assert the final
  world state hashes identically. This is the single most valuable test in the codebase —
  if it passes, determinism holds.
- **Balance simulation harness**: run ten thousand synthetic battles across the counter
  matrix and assert no unit type wins more than 60% against its intended counter.
