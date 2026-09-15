# 05 — API Contract

Two channels. **REST for commands and cold reads; WebSocket for pushed state.** The client
never polls for attack warnings.

All request and response bodies are defined as Zod schemas in `packages/shared/src/api/`
and imported by both server and client, so a contract change is a compile error rather
than a runtime surprise.

---

## 1. Conventions

- Base path `/v1`. Auth via short-lived JWT in `Authorization: Bearer`.
- All mutating endpoints are **idempotent by client-supplied `commandId`** (UUID). Retrying
  a command that already executed returns the original result rather than acting twice.
  This matters on mobile, where a dropped connection during an attack dispatch would
  otherwise double-send an army.
- Big integers are serialized as **strings**, never JSON numbers. Resource amounts and XP
  exceed IEEE-754 safe range.
- Errors use RFC 9457 problem details with a stable `type` URI per failure mode, so the
  client can react specifically (e.g. `insufficient-plots`, `nap-blocks-attack`).

## 2. Command endpoints

```
POST /v1/settlements/:id/queue
  Enqueue a building, research, training, or repair item.
  Body: { commandId, kind, targetKey, targetLevel?, quantity?, slotKind }
  Server computes cost and finishes_at; rejects if plots, HQ level, grade
  prerequisites, specialization caps, or resources fail. Returns the created item.

DELETE /v1/queue/:itemId
  Cancel. Refunds 80% of resources. Rejected if already complete.

POST /v1/queue/:itemId/seize
  Take a governor job into personal control. Requires a free personal slot.
  Keeps elapsed progress; recomputes the remainder at 1.0x. Audited.

POST /v1/queue/:itemId/shards
  Spend Chrono Shards. Server enforces the absorption ceiling and the prohibition
  list, and records Temporal Debt. Body: { commandId, shardHours }

POST /v1/movements
  Dispatch an army, fleet, convoy, or agent.
  Body: { commandId, originId, targetId, mission, formations[], cargo? }
  Server computes travel time and schedules MOVEMENT_ARRIVE. Returns arrival timestamp
  so the client can display an exact countdown.

DELETE /v1/movements/:id      Recall, if it has not yet arrived.

POST /v1/formations/:id/tier-up
  Attempt promotion. Requires level 1337, the resource cost in the home settlement,
  and a qualifying deed on record. Announced regionally on success.

POST /v1/governors
  Appoint a governor over an area with spec sheets.
  Body: { commandId, commanderId, tier, areaRef, specs }

PATCH /v1/governors/:id/specs   Update spec sheets. Takes effect on the next initiation.

POST /v1/treaties               Propose. Requires acceptance by the counterparty.
POST /v1/treaties/:id/break     Break. Applies reputation and debuff consequences.

POST /v1/trades                 Escrowed player-to-player trade offer.
POST /v1/market/orders          Place a market order on a local exchange.
```

## 3. Read endpoints

```
GET /v1/settlements/:id            Full detail for an owned settlement.
GET /v1/settlements/:id/public     What a scout would see; respects fog and intel age.
GET /v1/map?layer=&bbox=&zoom=     Map tiles for a viewport. Heavily cached; returns
                                   only what the requester's vision permits.
GET /v1/attention                  The attention dashboard feed: idle queues, stalled
                                   governor specs, full warehouses, understaffed
                                   buildings, incoming attacks, escalation alerts.
                                   THE most important endpoint in the game — see
                                   06_frontend.md §3.
GET /v1/battles/:id                Full battle report including every multiplier and
                                   the complete XP attribution table.
GET /v1/formations/:id             Veterancy standing, requirement breakdown, equipment.
GET /v1/atlas/...                  World Atlas: permanent history, archaeology, dynasties.
```

## 4. WebSocket events

Client subscribes to channels: `player:{id}`, `settlement:{id}`, `alliance:{id}`,
`map:{shard}:{bbox}`.

```
attack.incoming      { movementId, targetId, arrivesAt, estimatedSize?, flags[] }
                     Sent the moment the movement enters the defender's warning radius.
                     Latency budget: under one second. This is the single most
                     time-critical message in the system.

queue.completed      { settlementId, itemId, kind, targetKey, newLevel }
battle.resolved      { battleId, settlementId, outcome, summary }
movement.arrived     { movementId, result }
resource.overflow    { settlementId, resourceKey }   // warehouse full, output being lost
governor.stalled     { governorId, settlementId, reason }
treaty.proposed      { treatyId, from, kind, terms }
envy.marked          { playerId, scopes[], expiresAt }
map.delta            { shard, changes[] }            // ownership flips, new structures
epoch.progress       { conditionKey, leaders[], pct }
```

## 5. Rate limits and abuse

- Per-account command budget with a token bucket, generous for normal play and tight
  enough to make scripted mass-dispatch unattractive.
- Movement dispatch specifically: burst allowance sized to permit legitimate coordinated
  waves (which are a core skill) while rejecting machine-gun patterns.
- All limits return `429` with `Retry-After`, never a silent drop.
