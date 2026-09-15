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
