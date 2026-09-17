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

## D8 — Buildings are drawn procedurally from the workbook's tier data

`spec/06 §4` and the `Visual_Tiers` sheet describe a real art programme: twelve
authored tiers per building, each with a silhouette instruction, multiplied by
seven overlay axes, with each of the 483 buildings carrying its own `art`
description and a named "Signature" element. That is an art budget, not a
coding task, and none of it existed as data in the build — the importer was not
reading either visual sheet.

**Decision.** Import both sheets, and render buildings as procedural isometric
geometry composited from exactly that data: `visual.ts` turns a level into a
tier and a tier into geometry, and the canvas only executes it.

This buys the thing the tier system exists for. Crossing level 24 into 25
visibly rebuilds a building, because `Visual_Tiers` says tier 2 "doubles in
height; regular geometry" — so the upgrade a player just paid for is something
they can see, and the sheet decided that, not the renderer.

The importer refuses a workbook whose tier bands leave a gap, because a level
with no tier is a building that draws as nothing.

**What this is not.** It is not the authored art. Swapping in a sprite atlas
later is a change to the canvas, not to the model, because everything that
DECIDES what a building looks like is already separated into pure functions
tested against the workbook (`visual.test.ts`), and the Codex's tier reference
is drawn by the same renderer rather than illustrated separately — so it cannot
drift from what the game shows.

Two overlays are treated as information rather than decoration, as `spec/06 §4`
requires: damage persists visibly until repaired, and Overdriven is the loudest
thing on the canvas by design, because Heaven's Envy is meant to be seen.

## D9 — The text layer is one section, and it is genuinely text

`spec/06 §2` lists an Alliance Hub, a Dynasty Hall and a Codex alongside the
map and settlement screens. The game proper is graphical — the map and the
settlement are where decisions get made — and everything around it is reading
and writing: rankings, an inbox, a board, and answers to the questions the
game raises.

**Decision.** One `Hall` tab with four sections (rankings, messages, forum,
help) rather than four more tabs. The tab bar is already at what a phone can
carry, and these belong together: they are all "the world, other than what I
am building right now".

They stay text on purpose. A leaderboard is a table and a message is prose;
dressing either up would make them slower to read without making them say more.

Two rules are enforced in the engine rather than the client:

- **A leaderboard is derived on every read, never stored.** A stored rank
  eventually disagrees with the thing it ranks. `boardSubjects` assembles the
  whole shard in one pass per table so that stays affordable.
- **A private board is private on the server.** The alliance board refuses a
  non-member's read outright, rather than the client not rendering a tab —
  otherwise "private" means "private from the UI".

Chrono Shard spend is a board like any other, because `spec/04 §11` makes the
30-day purchase total public on the profile. It is not a wall of shame and not
a ranking to win; it is simply not private, which is the whole integrity
mechanic.

The help section answers the things players will otherwise file as bugs — a
governor that stalled, a breakthrough a rival crashed, an XP award of zero —
and each answer says why the design is that way rather than only that it is
intended.

## D10 — Empire weight is charged as the rolling average it was always specified to be

`spec/03 §8`: "Empire Weight `W` is the rolling 30-day average of the sum of
admin costs of all owned holdings... The rolling average is what stops a player
shedding territory before a war to spike progression."

The formula was right — its parameter is named `weight30dAvg` — but the callers
passed a LIVE reading, and the `empireWeightAvg` field the data model defines
for this was written once at genesis and never maintained. So the safeguard did
not exist: a player could drop three provinces, fight at a lower XP
requirement, and take them back the next day. Found while building the empire
weight leaderboard, which showed zero for everyone.

**Decision.** Keep the average lazily, the way everything else in this engine
accrues — no tick.

Live weight is piecewise-constant between ownership changes, so a thirty-day
average needs no history: each player stores the average, the weight HELD since
the last sample, and when that sample was taken. Advancing blends the average
toward the held figure in proportion to how much of the window elapsed.

Blending toward the weight held over the period, rather than toward the current
one, is the whole safeguard, and getting that wrong was the first attempt: with
the current figure the average collapses onto it as soon as a window has passed
since the last sample, which hands the dodge straight back. Four tests cover it,
including that conquest is not instantly taxed either — the delay cuts both
ways — and that the average is a function of elapsed time rather than of how
many steps the world was advanced in.

## D11 — The art programme is a work order, not a generated asset

`Visual_Tiers`, `Visual_Overlays`, `ArtBrief_Exemplars` and every building's own
`art` column describe a real art programme: 483 buildings across twelve tiers,
127 unit archetypes and 24 research icons, each with a written appearance and
often a named "Signature" element. None of that can be produced by writing code,
and no image-generation capability exists in this toolchain.

**Decision.** Build everything around the art instead, so that it can land one
file at a time over months without a migration or a broken build:

- `assets/manifest.jsonl` — all 5,943 assets, each with its path, dimensions and
  the fields unique to it. `pnpm run brief <id>` composes the full prompt from
  the workbook on demand; `assets/BRIEF.md` carries the rules that apply to
  every sprite. Nothing in a brief is invented here — this only arranges what
  the workbook already says.
- `sprites.ts` — asks for a sprite, returns one if it has been drawn and nothing
  if it has not, never blocking a frame and never treating a 404 as an error.
  A miss is the normal case 5,943 times over, so misses are remembered; without
  that, a full settlement re-requests every undrawn sprite every frame.
- The overlays are drawn by one shared function on both paths. If an authored
  building lost its damage state or its Overdriven shimmer, art landing would
  quietly remove information the player acts on, one building at a time — the
  hardest kind of regression to notice.

**The ledger derives its status from the filesystem.** An asset is integrated
when the file exists where the loader looks, because that is when the renderer
uses it. A ledger somebody has to remember to tick is wrong within a week, and
both failure modes cost real work: drawing something twice because the log said
it was missing, or shipping a hole because the log said it was done. Each entry
also records the hash of the brief it was drawn against, so a brief revised
after the fact marks the art **stale** rather than done.

**No placeholder art is committed.** A stand-in is indistinguishable from
finished work once it is in the repository, and it would make the ledger claim
an asset was done when nobody had drawn it. The pipeline is proved instead by
`pnpm run verify:sprites`, which generates a marker sprite, confirms its pixels
reach the canvas, and removes it again.

That test also corrected itself: its first version decoded the screenshot PNG by
hand without reversing the per-row filters, so every reading was noise that
happened to look plausible — it reported a sprite as drawn before one existed.
It now reads the canvas's own pixels, which measures the thing in question
rather than a re-encoding of it.

## D12 — The image model is a pluggable provider, and the key is yours

Claude has no image generation. Neither this process nor a subagent can draw a
sprite; both are language models. The art programme therefore has to be handed
to a model that can, which means an external API and a key.

**Decision.** `pnpm run sprites` is a provider-agnostic connector: it takes an
entry from the work order, composes the prompt, calls the API, post-processes
the result to the manifest's dimensions, writes it where the renderer looks,
and records the brief hash. Three providers ship — OpenAI `gpt-image-1`,
Stability, and Replicate — behind one small interface, so adding a fourth is a
few lines.

**No key is stored or assumed.** Without one the tool prints which environment
variable it wants and exits non-zero. It never reports success it did not have,
which matters more here than usual: a silently empty run against a 5,943-item
work order would look exactly like progress.

Three things the tool is opinionated about, each for a concrete reason:

- **Transparency is a correctness property, not a preference.** A sprite with a
  painted background cannot sit on the settlement ground. Where the provider
  renders real alpha it is asked for directly; where it does not, the prompt
  demands a flat key colour and the background is cut afterwards.
- **It refuses to redraw.** Work is picked from what is pending, and pending
  means no file exists at the path, so the tool is resumable by construction.
  A silent re-draw is both a wasted spend and a lost revision.
- **A batch over ten needs saying twice.** Every call is billed and the full
  programme is nearly six thousand images.

Results are downscaled to the manifest size in a headless browser rather than
with a native image library: one is already a dependency for the smoke tests,
and 1024px originals across 5,943 assets would be tens of gigabytes of detail
no player can see at the size these are drawn.

---

## D13 — The barbarians answer the players, not the calendar

**Context.** The specification treats NPCs as scenery. It says exactly two
things about them: that kills against them cannot carry a formation past Steel
(spec/03 §7), and that an abandoned holding decays to an "NPC successor"
(spec/02 §3). Everything else about what barbarians *do* is new design, so it
is recorded here rather than inferred from a sheet that does not exist.

**Decision.** A barbarian band is an actor with a row, a doctrine, and a rung on
an eight-step ladder. What moves it up that ladder is **world pressure**, and
pressure has three terms: the age of the world, the largest player empire on
the shard, and how much ground is in player hands. The first is deliberately
small — time alone takes about three years to reach the tier at which
barbarians take cities. The other two dominate any world where anything is
happening.

That ratio is the whole design. A world nobody is winning stays a nuisance for
months. A world with a runaway empire in it produces hordes that can take that
empire's cities, and it produces them *because* of the empire. An escalation
curve driven by the clock would have been far easier to build and would have
been a timer wearing a costume.

**Four consequences worth stating, because each was a choice:**

- **The ladder adds, it never replaces.** A horde that conquers cities still
  raids farms. Escalation should feel like a world getting worse, not a world
  switching modes.

- **Menace falls.** A band beaten in the field loses a rung. Without this the
  ladder is a clock again, and fighting the barbarians would be pointless.

- **Doctrine changes the rate, never the ceiling.** A raider escalates faster
  than a warlord and a warlord keeps what it takes; both can reach the top. A
  doctrine that capped a band would have made three quarters of the bands in
  any world permanently irrelevant.

- **A dormant band costs nothing.** Invariant §2.3 says idle objects cost
  nothing, and an AI is the easiest place in a codebase to violate it. There is
  no tick and no scan. A band below its threshold schedules ONE event, at a time
  computed in closed form from how fast pressure rises with time alone; it wakes,
  looks, and either acts or sleeps again. Ten thousand quiet bands cost what ten
  thousand quiet settlements cost, which is nothing.

**The asymmetry is published.** Barbarians can do four things players cannot:
raise troops straight from plunder and from the ground they hold with no
building and no queue; hold territory without paying empire weight; land
several columns in the same instant from different distances; and, as a last
resort, build a doomsday engine. All four are listed in `NPC_PRIVILEGES`, shown
verbatim on the Wilds screen, and returned by `/v1/threat` alongside the
pressure and its derivation.

This is the part that is easy to get wrong. An AI with hidden advantages reads
to a player as a broken game — and they are right to read it that way, because
they have no way to tell the difference. The same AI with the same advantages,
stated plainly, reads as a faction with a different nature. Nothing changes
except whether they were told.

**The doomsday engine is a consequence, not an event.** A band builds one only
at the top rung, only once, and only when it has lost half the holdings it once
held. A band that is winning never builds one however old the world is. Work is
announced publicly the moment it starts — a post on the world board naming the
camp, the target and the date — and taking the band's seat inside that window
kills the engine on the slipway. Without the announcement it would be an
unanswerable punishment; with it, it is a deadline, which is a mechanic.

When it lands it razes six grades of buildings and kills 45% of the garrison,
then the ordinary assault follows one millisecond behind. Both figures are
written to the event log with their arithmetic. Invariant §2.7 is about
battles, but a weapon that removes six grades of somebody's city without showing
its working would be the least explicable number in the game.

**Bands rebuild.** A beaten band with territory left raises men from it. This
was added after a trace showed bands emptying themselves, reaching strength
zero, and then taking thousands of turns to decide they could do nothing — a
world went permanently quiet the first time a player won properly, which is the
opposite of what the system is for.

**One thing the model DOES allow that is worth knowing:** a player can hold the
wilds down by staying small. That is a legitimate strategy and the screen says
so plainly, because a player should be able to make that trade on purpose
rather than discover it afterwards.
