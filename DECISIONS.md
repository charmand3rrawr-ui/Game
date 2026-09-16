# Decisions

Per `spec/00_README_FIRST.md` §5: where the specification is ambiguous, the option
that preserves the eight invariants is chosen and the reasoning recorded here.

---

## D1 — The roster's rounding model is reproduced, not approximated

**Question.** `Units_Master` publishes 2,268 units to one decimal (HP to zero).
Which rounding reproduces it exactly?

**Finding.** No single rule does. Comparing all 13,608 published values:

| Model | Disagreements |
|---|---|
| Binary product, binary scale-and-round | 18 |
| Exact decimal product, half away from zero | 27 |
| **Hybrid (below)** | **0** |

- **Atk / Def / Speed / Upkeep / Train** — multiply the published decimals
  *exactly*, then round half away from zero. Rounding in binary publishes
  `4.06 × 2.5` as 10.1 where the sheet says 10.2, because `10.15 × 10` is
  `101.49999999999999`.
- **HP** — multiply as binary floats, then round that result in decimal. The
  sheet publishes `50 × 1.15` as 57 (the binary product sits just below 57.5)
  and `50 × 1.35` as 68 (just above 67.5). Exact-decimal arithmetic makes both
  ties and gets 27 units wrong.
- **Training time** derives from the already-rounded published `Base Train (h)`
  column, not from `upkeep × TRAIN_CONST`.

**Decision.** Implement the hybrid in `packages/shared/src/units.ts`, with the
decision documented at each field. The importer runs the *same* generator
against `Units_Master` and fails the build if one stat disagrees, so this cannot
silently drift. Rounding is done in integer arithmetic, so the roster is
byte-identical on every platform — which invariant §2.2 requires anyway.

## D2 — "Beneath notice" is measured against the engagement, not one victim type

**Question.** `XP_Attribution` says a victim whose UPV is below 2% of the
killer's awards zero XP. `spec/08` M5 says the worked example must yield exactly
211 XP. These conflict: in `XP_Worked_Example` the crossbowmen sit at **1.87%**
of the Ninth Musket's UPV, so a per-victim-type floor excludes them and yields
185 XP, not 211.

**Decision.** Evaluate the floor against the headcount-weighted average UPV of
the force destroyed in the phase. This:

- satisfies the M5 acceptance test exactly (211 XP);
- serves the rule's stated intent — "elite formations gain literally nothing
  from slaughtering peasants" — because an all-peasant engagement still pays
  zero;
- is *stronger* anti-farming than the per-type reading, which would let a player
  salt a peasant stack with a handful of real units so the peasants become
  payable. The force average stays beneath notice.

The other three hard zeroes (NPC ceiling, escalation, linked account) are
unaffected. See `packages/shared/src/xp.ts`.

## D3 — Constants carry provenance, and assumptions are marked

Invariant §2.5 forbids hardcoded balance numbers, and §5 forbids silently
inventing one. Not every number the spec requires exists in the workbook: some
are stated in the specification's prose (exponents, clamps, caps), and a few are
stated nowhere.

**Decision.** `packages/tools/src/import-workbook.ts` emits every constant with a
`provenance` of `workbook` | `spec` | `derived` | `assumed` plus the exact cell
or section it came from, into `CONSTANT_META`. Assumed constants are listed in
`ASSUMED_CONSTANTS`, printed by the importer on every run, and asserted by a test
to stay a small minority. Current assumptions, all awaiting the balance owner:

| Constant | Value | Why it is assumed |
|---|---|---|
| `MORALE_EXP` | 0.25 | GDD Appendix A gives the 0.5–1.5 clamp but not the exponent |
| `CULTURE_PRESSURE_K` | 0.0004 | GDD §8.4 gives the shape, not `k` |
| `CULTURE_PRESSURE_CAP` | 12 | GDD §8.4 states a cap exists, not its value |
| `ATTRITION_ESCALATION` | 0.5 | spec/03 §4 says attrition escalates, not how fast |
| `TEMPORAL_DEBT_HOURS_PER_TIER` | 168 | spec/04 §11 defines six karma tiers, not the spend per tier |
| `STATECRAFT_PER_POINT` | 0.02 | spec/04 §9 says Statecraft modifies loyalty damage, not by how much |

Building size classes are a seventh assumption, recorded in the importer:
`Building_Framework` states buildings occupy 1–4 plots by size class but carries
no per-building column, so category defaults are used. `spec §10` already lists
per-building tuning as an open content task.

## D4 — Persistence is an interface; the default store is in-memory

`spec/01` specifies Postgres 16 + Redis 7, and `spec/01 §6` says to build a
single-process version first because "a distributed system built before the game
logic is a distributed system you will debug instead of building a game".

**Decision.** The simulation and all command handling live in
`packages/engine`, behind a `Store` interface, with the schema and migrations
written for Postgres as specified. The shipped store is in-memory, which:

- runs the full game with no infrastructure, including in CI and in a browser;
- keeps the sim core free of I/O, as invariant §2 and `spec/03` require;
- makes the Postgres store a driver swap rather than a rewrite.

`packages/server/migrations/` carries the real DDL, and the importer emits the
reference-table seed SQL against it.

## D5 — The map renders on Canvas 2D rather than PixiJS

`spec/06 §4` specifies PixiJS/WebGL, for the right reason: a DOM or SVG map will
not survive galaxy scale.

**Decision.** The renderer is a single `<canvas>` with an immediate-mode 2D
draw loop that implements the properties the spec actually asks for — viewport
culling, level-of-detail cluster markers beyond a zoom threshold, delta patching
rather than snapshots, and the two gameplay-carrying overlays (damage,
Overdriven). This keeps the client dependency-free enough to deploy as a static
site, and the renderer is isolated in `packages/client/src/map/` so swapping in
PixiJS is a contained change if sprite counts demand it.

## D6 — A commander's level is read off the player's most veteran formation

`Governors` gates each tier on a commander level — Bailiff 5, Planetary 15,
System 25, Sector 40 — but the workbook ships **no Commanders sheet**, and
nothing in the spec set says where a commander's level comes from. The API
contract (`spec/05 §2`) passes a `commanderId` and no level, so the server has
to decide.

**Decision.** The level is the highest veterancy level among the player's own
formations, and `POST /v1/governors` never reads one from the request.

Two things pinned it there. First, invariant §2.1: the tiers gate on this
number, so a client that could state it could appoint a Sector Governor on its
first day. Second, the four numbers place themselves — 5 through 40 is nowhere
on the 1–42 cultivation ladder (a Bailiff would cost most of Era II, a Sector
Governor would be endgame) and sits near the bottom of the 0–1337 level ladder
that veterancy, formations and `Grades_Realms` all share.

The consequences match the workbook's own notes column. A new player has
nobody — every starting formation is green at level 0 — so delegation is earned
by fighting; measured against the published XP curve, level 5 is roughly a dozen
real engagements ("most players appoint their first by mid Era II") and level 40
wants a genuinely veteran officer ("Era VI+. Rare.").

This is a derivation rule rather than a balance constant, so it is recorded here
rather than in `docs/ASSUMPTIONS.md` — that file is generated from the workbook
readers and carries only missing *numbers*. `World.commanderLevelOf` is the
single function to replace when a Commanders sheet arrives.

## D7 — Transactions roll back by undo journal, not by snapshot

`MemoryStore.transaction()` originally took a copy of all seventeen tables up
front and restored it on failure. Correct, and priced badly: **every command
paid a full copy of the world before doing any work**, while a typical command
touches a handful of rows. Measured on a 300-holding world, an empty
transaction cost 0.309 ms — more than reading a settlement.

**Decision.** Each write records the row it is about to overwrite, and a
rollback replays those entries backwards. Same guarantee, priced by what the
transaction actually touched: the same empty transaction now costs 0.0002 ms
and no longer grows with world size at all.

Replaying **backwards** is what makes repeated writes to one row correct — the
earliest entry for a row holds its pre-transaction value. `packages/engine/src/store.test.ts`
pins the contract rather than the mechanism, including that case and the one
where a rolled-back command must not stay recorded; those tests were checked
against a deliberately broken implementation to confirm they can fail.

**Known remaining cost.** Reading one settlement still scans the buildings,
queue and stockpile tables, so it grows with world size (0.06 ms at 300
holdings). A secondary index would fix it, but it would have to be unwound by
the journal too, and the path already handles roughly 16,000 commands a second.
Postgres indexes this properly; the in-memory store is deliberately the simple
one (D4).
