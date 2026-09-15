# 08 — Build Order

Each milestone has an explicit acceptance test. Do not advance until it passes.

---

## M0 — Foundations (1–2 weeks)
- pnpm monorepo: `shared`, `server`, `client`, `tools`.
- Workbook importer producing `generated/constants.ts` and seed SQL.
- Drizzle schema and migrations for `02_data_model.md` §1–3.
- Seeded PRNG in `shared`.

**Accept:** `pnpm build` fails if the workbook is missing a sheet or a calibration anchor
from `07_balance_constants.md` §3 is violated.

## M1 — Scheduler and clock (1–2 weeks)
- `scheduled_event` table, Redis timer wheel, claim-with-SKIP-LOCKED worker loop.
- Event log with monthly partitioning.
- Lazy production accrual (`last_accrued_at`), not a tick.

**Accept:** 100,000 scheduled events execute within 50 ms of their timestamps under load,
and a crash mid-drain neither loses nor double-runs an event.

## M2 — Settlements and buildings (2–3 weeks)
- Plots, size classes, level gating, grades, staffing, upkeep, adjacency, Heritage,
  specialization caps.
- Build queue with personal and governor slot kinds.

**Accept:** a settlement can climb a building to level 300, the cost and time match the
workbook to the last digit, and all six framework constraints reject correctly.

## M3 — Units, formations, training (2 weeks)
- Combinatorial unit generation from parameter sheets at import time.
- Formations with dual veterancy tracks; training queues; equipment slots.

**Accept:** 2,268 unit definitions generate from the parameter sheets and match
`Units_Master` exactly; a Mythic Path Avatar trains in 4,383 hours.

## M4 — Movement and combat (3–4 weeks)
- Travel time, zones of control, supply attrition.
- Six-phase resolver with full report emission.
- Layer limits enforced as preconditions.

**Accept:** golden-file tests pass; the +40% joint cap never breaches; a fixed seed
reproduces a battle byte-identically across runs and machines.

## M5 — XP, veterancy, empire weight (2 weeks)
- Contribution-share attribution, UPV, role and relative factors, fatigue, repetition.
- Absorption XP for the defence track.
- All hard-zero anti-farming conditions.
- Rolling 30-day empire weight and the requirement multiplier.

**Accept:** the `XP_Worked_Example` sheet reproduces exactly in code — 2,000 Elite
Musketeers at Ruby earn 211 XP from that engagement.

## M6 — API and realtime (2 weeks)
- REST commands with idempotency by `commandId`.
- WebSocket channels and the full event list.

**Accept:** `attack.incoming` delivers in under one second at 10,000 concurrent sockets;
replaying a command with the same `commandId` does not double-execute.

## M7 — Client core (4–5 weeks)
- Attention Dashboard first, then Map, Settlement, Command Centre, Battle Report.

**Accept:** a full play loop — build, train, dispatch, resolve, read the report — is
completable on a phone in under ten minutes.

## M8 — Social and governors (3 weeks)
- Alliances, roles, treasury, treaties with mechanical enforcement.
- Governors, the six spec sheets, the 2× rule, Seize, subversion, audit.

**Accept:** a governor executes a build order at exactly 2× time; seizing keeps elapsed
progress and recomputes the remainder at 1×; seizing without a free personal slot is
rejected.

## M9 — Espionage, conquest, cultivation (3 weeks)
- Agent operations and counter-intel; loyalty and vassalage; realms, Qi, tribulations.

**Accept:** a tribulation is a scheduled, publicly visible event that rivals can interfere
with.

## M10 — Monetization and integrity (2 weeks)
- Chrono Shards with all four guardrails enforced server-side.
- Heaven's Envy with its three leaderboards and anti-gaming rules.
- Linked-account detection feeding transfer caps, envy scopes, and empire weight.

**Accept:** every prohibited shard target is rejected; the absorption ceiling cannot be
exceeded by any purchase; a marked player's defence is reduced by exactly the stacked
amount and cannot enter vacation mode.

## M11 — Live ops (ongoing)
- Telemetry dashboards per `07_balance_constants.md` §5.
- Runtime config with audit trail and grandfathering.
- World Atlas and archaeology over the cold-storage event log.

**Accept:** a balance constant can be changed at runtime, the change is audited, and no
warring party's in-flight operation is affected.

---

## The single most valuable test in the codebase

Write it at M1 and keep it green forever:

> Replay a recorded event log into an empty database and assert the resulting world state
> hashes identically to the original.

If that passes, determinism holds — and determinism is what makes archaeology, the World
Atlas, dispute resolution, and every balance simulation possible.
