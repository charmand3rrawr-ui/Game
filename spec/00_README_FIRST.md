# Ascendance — Specification Set

**Read this file completely before writing any code.**

This directory is the authoritative implementation specification for Ascendance, a
persistent massively-multiplayer strategy game. It is written to be consumed by an
AI coding agent working through the system in order.

---

## 1. What each file is for

| File | Contents | Read when |
|---|---|---|
| `00_README_FIRST.md` | This file. Conventions, invariants, build order. | Always, first |
| `01_architecture.md` | Stack choice, services, deployment, why each piece | Before scaffolding |
| `02_data_model.md` | Every entity, field, index, and relationship | Before migrations |
| `03_simulation_engine.md` | Event scheduler, tick model, determinism, combat resolver | Before game logic |
| `04_game_systems.md` | Each game system mapped to a module, with its rules | While implementing features |
| `05_api_contract.md` | REST endpoints and WebSocket events | Before client work |
| `06_frontend.md` | Client architecture, screens, rendering, state | Before UI work |
| `07_balance_constants.md` | Every tunable number and where it lives | Continuously |
| `08_build_order.md` | Milestone sequence with acceptance criteria | For planning |

Companion artefacts **outside** this directory:

- `Ascendance_Master_Tables.xlsx` — the single source of truth for all balance data
  (483 buildings, 2,268 units, counter matrix, veterancy curves, XP model, equipment,
  celestial sites). **Never hardcode a balance number. Import from this workbook.**
- `reference/` — annotated TypeScript reference implementations of the formulas that
  are easy to get wrong. Copy these into the codebase and extend them; do not rewrite
  them from the prose.
- The design documents (`Ascendance_GDD_v2_Expanded.docx`, `..._v3_Addendum.docx`,
  `..._Building_Systems_Bible.docx`, `..._Holdings_and_Management.docx`) contain design
  intent and rationale. Consult them when a spec decision seems arbitrary — the reason
  is usually recorded there. They are **not** implementation specs.

---

## 2. Non-negotiable invariants

These hold everywhere. A change that violates one is a bug, not a feature.

1. **The server is authoritative for everything.** The client never computes an outcome
   it then reports. It requests; the server decides. There is no client-side game logic
   beyond presentation and optimistic UI hints that are reconciled on the next push.

2. **Simulation is deterministic and replayable.** Given the same event log and the same
   seed, a world replays identically. All randomness comes from a seeded PRNG keyed by
   `(worldId, eventId)`. Never call `Math.random()` in simulation code.

3. **Idle objects cost nothing.** The simulation is event-driven. A settlement with an
   empty queue must consume zero CPU. Never iterate all entities on a timer.

4. **Production is isolated per holding.** No empire-wide resource pool, no shared queue,
   no cross-settlement production. Resources exist where produced and move only as
   interceptable convoys. The single exception is player-level progression (research,
   proficiency, cultivation, dynasty traditions), which is global by design.

5. **Balance numbers come from the workbook.** Import at build time into a generated
   constants module. A magic number in game logic is a defect.

6. **Money never buys power.** Chrono Shards accelerate time within an earned ceiling and
   obey a prohibition list. Nothing purchasable may change the outcome of a contest
   between two equally skilled free players. See `04_game_systems.md` §Monetization.

7. **Every combat outcome is explainable.** Battle reports expose the full arithmetic —
   every multiplier, every phase, every XP attribution row. If a number cannot be shown
   to the player with its derivation, it should not exist.

8. **Time cannot be created.** Build, research, and training durations are computed once
   at initiation and stored as absolute timestamps. Nothing recomputes a completion time
   downward except an explicit, audited action (Seize, Chrono Shard spend).

---

## 3. Code conventions

- **Language**: TypeScript, `strict: true`, no `any` in domain code.
- **Monorepo** with pnpm workspaces: `packages/shared` (types + formulas),
  `packages/server`, `packages/client`, `packages/tools`.
- **Domain types live in `packages/shared`** and are imported by both sides so the client
  can never disagree with the server about a shape.
- **Pure functions for all game math.** Every formula is a pure function taking explicit
  inputs and returning a value — no I/O, no clock reads, no globals. This is what makes
  the engine testable and the balance team able to run simulations.
- **Comment the *why*.** Formula implementations must carry a comment block stating what
  the formula is, what design goal it serves, and which spec section and workbook sheet it
  comes from. See `reference/` for the expected style.
- **Integers for currency and resources.** Use `bigint` for resource amounts and XP —
  values legitimately exceed `Number.MAX_SAFE_INTEGER` (XP requirements reach 1.88e12,
  resource costs reach 2.3e14, and veterancy raw ratings are larger still). Floating point
  is acceptable only for multipliers and intermediate combat math, never for stored balances.
- **Timestamps are UTC epoch milliseconds** as `bigint`. Never store local time.
- **Naming**: `snake_case` in the database, `camelCase` in TypeScript, `SCREAMING_SNAKE`
  for generated balance constants.

---

## 4. Build order

Implement in this sequence. Each step depends on the previous.

1. Monorepo scaffold, shared types, workbook importer (`08_build_order.md` M0)
2. Persistence layer and migrations (`02_data_model.md`)
3. Event scheduler and deterministic clock (`03_simulation_engine.md` §1–3)
4. Settlement, buildings, resource production (`04_game_systems.md` §1–3)
5. Units, formations, training (`04_game_systems.md` §4)
6. Movement and combat resolution (`03_simulation_engine.md` §4–6)
7. XP attribution and veterancy (`03_simulation_engine.md` §7)
8. API and WebSocket layer (`05_api_contract.md`)
9. Client: map, settlement view, command centre (`06_frontend.md`)
10. Alliances, governors, diplomacy, espionage (`04_game_systems.md` §6–9)
11. Monetization, Heaven's Envy, Chrono Shards (`04_game_systems.md` §11)
12. Live-ops tooling, telemetry, balance dashboards

**Do not skip ahead.** Combat cannot be implemented correctly before the event scheduler
exists, and the client cannot be built before the API contract is stable.

---

## 5. When the spec is ambiguous

1. Check the design documents for intent.
2. Check the workbook for a number that answers it.
3. If still ambiguous, choose the option that preserves the invariants in §2, and record
   the decision in `DECISIONS.md` at the repo root with your reasoning.

Never silently invent a balance number. If one is missing, add it to the workbook's
appropriate sheet with a clear `[ASSUMED]` marker so the balance owner can correct it.
