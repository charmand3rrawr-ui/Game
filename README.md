# Ascendance

A persistent massively-multiplayer strategy game. Server-authoritative,
deterministic, and permanent — the universe never resets.

Built from the specification set in [`spec/`](spec/), which is the authority on
everything here. Where this code and that specification disagree, the
specification is right and this is a bug.

---

## Play it

A playable sandbox deploys to GitHub Pages from `main`. It hosts an
authoritative world **in your browser**, using the same engine a server would
run — possible because the simulation core is pure, does no I/O, and never
reads a clock. It is single-player, and it says so.

Locally:

```bash
pnpm install
pnpm run import                        # generate balance data from the workbook
pnpm --filter @ascendance/shared build
pnpm --filter @ascendance/engine build

# the sandbox, no server required
ASCENDANCE_LOCAL=1 pnpm dev:client

# or the real thing: a gateway plus a client that talks to it
pnpm dev:server                        # http://localhost:8787
pnpm dev:client                        # http://localhost:5173
```

## What is here

| Package | What it is |
|---|---|
| `packages/shared` | Domain types, the generated balance constants, and **all game math** as pure functions. Imported by both sides, so the client can never disagree with the server about a shape — or about a formula. |
| `packages/engine` | The authoritative simulation: the event scheduler, settlements, combat, veterancy, and every command. No framework imports, no I/O, no clock reads. |
| `packages/server` | Fastify gateway: REST commands, cold reads, WebSocket push, rate limiting, and the Postgres schema. |
| `packages/client` | React + Vite. Attention Dashboard, map, settlement (build and train), command centre, formations, research, cultivation, battle reports, simulator, codex. |
| `packages/tools` | The balance importer. Reads the workbook, fails the build when a number moves. |
| `data/` | `Ascendance_Master_Tables.xlsx` — the single source of truth for every number in the game. |
| `spec/` | The specification. Read `spec/00_README_FIRST.md` first. |
| `docs/` | The design documents, and the generated register of open balance assumptions. |

## The parts worth knowing about

### Nothing is hardcoded

Every balance number comes from `data/Ascendance_Master_Tables.xlsx`, imported
at build time into a generated module. `pnpm run import` reads 36 sheets and
emits typed constants, reference tables, and seed SQL — and **fails the build**
on a missing sheet, a renamed column, a value outside its declared range, or a
violated calibration anchor.

Every emitted constant records where it came from:

```ts
CONSTANT_META.BUILD_TIME_K
// { value: 0.000431977…, provenance: 'workbook', ref: 'Building_Levels!R2C9', … }
```

Constants the specification requires but neither the workbook nor the spec pins
down are marked `assumed`, printed on every import, listed in
[`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md), and shown to players in the Codex.
The build refuses to let a constant that defines the economy's shape be
assumed.

### Six calibration anchors, asserted every build

These are the fixed points the whole economy was tuned around. Moving one is a
design decision, not a tweak — so the importer fails if any of them drifts:

1. A full 0→1337 building climb takes **exactly 500 years** (4,383,000 hours).
2. A Mythic Path Avatar trains in **exactly 4,383 hours** — six months.
3. The complete 24-tier veterancy ladder is **321.88× total stat bonus**.
4. The joint non-doctrine bonus cap is **+40%** on any stat.
5. The strongest counter-matrix entry is **2.2×**.
6. Empire weight caps at **9,918,521×** XP requirement.

### The roster generates, it is not stored

2,268 units are 126 archetypes × 3 identity paths × 6 grades, generated at
load from the parameter sheets. The importer runs the same generator against
`Units_Master` and fails if a single stat disagrees — so "the whole roster
rebalances from a handful of constants" is a fact the build enforces rather
than a claim in a document.

Getting that to match exactly took reproducing the workbook's own rounding,
which is not uniform. See [`DECISIONS.md`](DECISIONS.md) D1.

### Research is the one thing that is not isolated

Everything else a settlement owns is its own: its stockpile, its queues, its
population. Research is the exception spec/04 §3 carves out, because without it
a wide empire would be unplayable — nobody will research the same discipline in
four hundred settlements.

But it is still **paid locally**. A level is queued at one settlement, from that
settlement's stockpile, in that settlement's build slot, competing directly with
raising a building there. The benefit is global; the cost is not. All three of
the spec's prerequisites are enforced: an era needs every previous-era
discipline at grade 12, a grade needs every same-era discipline one grade below
it, and it needs cultivation to have kept pace.

### Cultivation is where buying time is paid for

Chrono Shards cannot be spent on a breakthrough at all — it is on the
prohibition list. And the Temporal Debt they leave behind does two things here:
it suppresses Qi income, and it lowers the odds of passing a tribulation. The
one progression money cannot touch is also the one it actively damages.

A breakthrough is not a purchase, either. Qi is spent the moment you declare,
a window opens, and several trials are **publicly visible and crashable** — the
workbook marks the Lightning Tribulation "visible to nearby players
(crashable!)", and the importer fails the build if that ever stops parsing,
because spec/08 M9's acceptance test depends on it existing.

The odds are itemised before you commit — base, karma, debt, interference — for
the same reason battle reports show their arithmetic. A breakthrough lost for
reasons nobody can inspect is how players come to believe a game cheats.

### There is no game loop

Nothing polls. Nothing iterates idle entities. Every future state change is a
scheduled event with an exact timestamp, and workers execute what falls due.
Ten thousand quiet settlements schedule nothing and cost exactly zero CPU.

A handler receives the event's **scheduled** instant, never the wall clock,
even when running late — which is what lets a recorded event log replay into an
empty world and produce an identical one. That test is in
`packages/engine/src/engine.test.ts`, and it is the most valuable test in the
codebase.

### Every combat outcome is explainable

Battle reports carry the full phase-by-phase arithmetic: every multiplier, per
formation, with contribution shares, and both the capped and uncapped values
wherever the +40% joint cap engaged. A player should be able to reconstruct any
result by hand. A silent cap produces accusations of cheating.

The client's Simulator is not an approximation of the resolver. It imports
`resolveBattle` from `@ascendance/engine` — the same function the server runs.

### Money never buys power

Chrono Shards compress remaining time up to an **earned** ceiling of
`2.0 + 0.30 × constructionRank + 0.50 × era`. Past it, shards are unspendable.
They can never touch a settlement with hostile movement inbound, wartime
training, Ascension or epoch projects, megastructures, cultivation
breakthroughs, or repairs under siege. All four guardrails are enforced
server-side, and every spend is logged permanently.

## Build status

| Milestone | State |
|---|---|
| M0 Foundations — monorepo, importer, PRNG | done |
| M1 Scheduler and clock | done |
| M2 Settlements and buildings | done |
| M3 Units, formations, training | done |
| M4 Movement and combat | done |
| M5 XP, veterancy, empire weight | done |
| M6 API and realtime | done |
| M7 Client core | done |
| M8 Social and governors | done — governors, Seize and the 2× rule; the six spec sheets editable in the UI; alliances and treaties end to end, a signed NAP refused at dispatch on the server |
| M9 Espionage, conquest, cultivation | conquest, loyalty and cultivation done — a tribulation is a scheduled, publicly visible event rivals can crash; espionage is modelled in the schema only |
| M10 Monetization and integrity | Chrono Shard guardrails and Heaven's Envy done; linked-account detection is a field, not a detector |
| M11 Live ops | not started |

Every milestone marked done passes its acceptance test from
[`spec/08_build_order.md`](spec/08_build_order.md). The tests are named after
them.

One correction worth recording: M3 was marked done here while training was not
actually implemented — `enqueue` routed every queue kind down the building
path, so a training order failed with "unknown building". Unit tests passed
because none of them tried. The browser smoke test now walks the whole of M7's
loop, *"build, train, dispatch, resolve, read the report"*, precisely so a
missing verb cannot be reported as a finished milestone again.

## Development

```bash
pnpm run import      # regenerate balance data; fails if an anchor moved
pnpm -r run test     # 192 tests, including every milestone acceptance gate
pnpm -r run typecheck
pnpm --filter @ascendance/client run smoke   # play the game in a real browser
```

CI runs the import first, then checks the committed generated files still match
the workbook, then typechecks, tests, and walks the whole client in Chromium.

Conventions are in `spec/00_README_FIRST.md` §3. The ones that bite:

- `bigint` for resources, XP and veterancy — these exceed 2^53, and they cross
  the API as **strings**, never JSON numbers.
- Timestamps are `bigint` epoch milliseconds UTC. Never local time.
- All game math is pure functions over explicit inputs. No `Math.random()`
  anywhere in simulation code.
- Every formula carries a comment saying what it is, what design goal it
  serves, and which spec section and workbook sheet it came from.

## Not yet specified

`spec/10` records what blocks content completeness rather than implementation:
per-building specifications for Eras II–VII, per-building numeric tuning, the
full twelve-tier art briefs, unit-level design detail, tech tree diagrams, the
world-map generation algorithm, and the epoch objective calendar.

## Licence

MIT.
