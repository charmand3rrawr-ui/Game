# 04 — Game Systems

Each section maps a design system to a module, states its rules precisely, and points at
the workbook sheet holding its numbers. Implement in the order given in
`00_README_FIRST.md` §4.

---

## 1. Settlements and buildings
**Module:** `sim/settlement/` — **Sheets:** `Buildings_Master`, `Building_Levels`, `Specs_EraI`, `Building_Framework`, `Category_Chassis`

- **Plots.** 24 at founding, +2 per HQ grade, capped near 110. Buildings occupy 1–4 plots
  by size class. A settlement can never hold every building; this scarcity is the primary
  driver of specialization and must be enforced, not merely discouraged.
- **Level gating.** No building may exceed its settlement's HQ level. Enforce on enqueue.
- **Grades.** Every 32 levels is a grade boundary (42 grades across 0–1337). Crossing one
  requires a Grade-Up Project: a separate queue item, visible to nearby players, attackable
  while in progress.
- **Staffing.** Output scales linearly with staffed percentage, drawn from settlement
  population. Understaffing is the normal state of a growing settlement, not an error.
- **Upkeep.** Era II+ costs Coin; Era IV+ additionally draws Electricity. Insolvency
  triggers Brownout: output halves, and after 72h the building sheds a level per day.
- **Adjacency.** Compute from `plot_index` neighbours plus terrain. Cache the result on the
  settlement and invalidate on any building change.
- **Heritage.** Buildings from earlier eras never stop working. On era advance they gain
  Heritage status: full output plus Culture equal to 2% of level.
- **Specialization caps.** Maximum 3 buildings above grade 30 and 8 above grade 20 per
  settlement. This is a hard constraint — reject the enqueue, do not penalise.

**Cost and time curves** (from `Building_Levels`, calibrated so a full 0→1337 climb takes
exactly 500 years):

```
cost(L)   = base * (L+1)^2.4  * 1.004^L
time(L)   = K    * (L+1)^1.9  * 1.003^L     // K ≈ 0.000432 hours
output(L) = base * (L+1)^1.12
```

## 2. Resources and logistics
**Module:** `sim/economy/` — **Sheets:** resource tables in the GDD §6

Forty resources in three tiers: raw (extracted) → refined (processed) → components
(manufactured). Processing buildings are throughput-capped and idle without inputs
regardless of level, which is what makes supply-line interdiction meaningful.

**Isolation is absolute.** Resources exist in the settlement that produced them. Moving them
creates a `movement` row with `mission = 'haul'` that is visible on the map and
interceptable. There is no empire treasury and no instant transfer. Implement convoy
capacity by era: carts → wagons → convoys → rail → freighters → void haulers.

## 3. Research and culture
**Module:** `sim/research/` — **Sheet:** `Research_Disciplines`

Twenty-one disciplines (3 branches × 7 eras), each 0–1337 levels across 42 grades.
Research is **player-level and global** — the single exception to isolation, because
without it a wide empire would be unplayable. Grade boundaries carry the weight: fork
choices, unit-grade gates, edicts. Prerequisites: an era's disciplines require all
previous-era disciplines at grade 12+, and grade G requires all same-era disciplines at
G−1 plus cultivation realm ≥ G−1.

Culture is a soft-power output driving border pressure (high-culture settlements flip
adjacent low-culture plots over weeks), happiness, and from Era IV the three ideology axes.

## 4. Units, formations, equipment
**Module:** `sim/military/` — **Sheets:** `Units_Master`, `Archetypes`, `Unit_Grades`, `Unit_Paths`, `Counter_Matrix`, `Equipment_Catalog`

2,268 unit definitions generated combinatorially: 18 archetypes × 3 identity paths ×
6 grades × 7 eras. **Generate these at import time from the parameter sheets** rather than
storing 2,268 hand-maintained rows — the whole roster rebalances from a handful of
constants, and that property must survive into the codebase.

Training time = `baseUpkeep * trainConstant * gradeTrainMultiplier`, calibrated so a
Mythic Path Avatar takes exactly 6 months. Units spawn in their production settlement and
must physically travel.

Equipment: three slots (Weapon, Protection, Utility) × 9 tiers × 5 qualities. Crafted
in local armouries, hauled to be worn elsewhere, looted when an armoury falls. Relic
quality is never crafted — vaults, archaeology, and Tribulation Forging only.

## 5. Veterancy
**Module:** `sim/veterancy/` — **Sheets:** `Veterancy_Tiers`, `Veterancy_XP`, `Veterancy_Levels`, `XP_Attribution`, `Empire_Weight_Multiplier`

Twenty-four tiers (Copper → Eternal) of 1,337 levels, tracked separately for Attack and
Defence. **Tiers grant no stats** — they gate further levelling and cost resources. All
combat benefit comes from +1% per level, accumulating across tiers to 322× at the top.

Full formulas in `03_simulation_engine.md` §7–8. The three rules that hold it together:
green dilution on reinforcement, era gating (max tier = ceil(3.5 × era)), and promotion
requiring a recorded deed.

**The Champion economy** is an intended emergent consequence, not a bug: tier-up resource
costs ignore empire weight while XP requirements scale with it up to ten-millionfold, so a
small player can learn but not pay while a galactic power can pay but not learn. Large
empires therefore bankroll small allies' promotions. Do not "fix" this.

## 6. Governors
**Module:** `sim/governor/` — **Sheets:** `Governors`, `Governor_Specs`

There is **no cap on holdings and no administrative overload penalty**. The only limit on
empire size is the player's own attention. Governors are the relief valve, and the entire
system is one number:

> **Anything a governor initiates takes twice as long.**

No efficiency loss, no output tax. `queue_item.time_multiplier` is 1.0 for player-initiated
and 2.0 for governor-initiated. That field is the whole mechanic.

**Seize** lets a player take over an in-progress governor job: elapsed progress is kept and
the remainder recalculates at 1.0×. It requires a free **personal** queue slot, and that
scarcity is the only thing preventing a player from governing everything and instantly
seizing it all back. Personal slots come from the HQ; governor slots are separate and
parallel.

Six spec sheets define a governor's behaviour: Build Order, Training Standing Order,
Research Mandate, Resource Policy, Defence Posture, Escalation Rules. Governors have **no
judgement** — a build order that ignores a resource shortfall stalls the queue rather than
skipping ahead, and that stall must surface on the attention dashboard.

Governors can be assassinated (the area stops initiating until a replacement travels there)
and **subverted** (they silently follow corrupted specs until audited).

## 7. Alliances and diplomacy
**Module:** `sim/diplomacy/`

Alliances up to 60 members with granular role permissions, a treasury, shared projects, and
an operations planner with synchronized timers. Federations from Era III; a Galactic Concord
from Era VI.

Treaties carry mechanical consequences, not just text. A NAP **hard-blocks attacks in the
UI and on the server**; early exit requires 48h public notice. Breaches cost reputation and
apply a pact-breaker debuff. Reputation never blocks an action — betrayal is always
allowed and always priced.

## 8. Intel and espionage
**Module:** `sim/intel/`

All layers begin fogged. Vision from holdings, scouts, radar, arrays, agents, alliance
sharing. **Intel ages** — store a `observed_at` on every report and degrade confidence over
time rather than deleting it.

Agent operations: infiltrate, sabotage, steal tech or ship design, incite, false flag,
assassinate, deep cover. Counter-intelligence sweeps oppose them. Tech theft is capped at
never faster than the discoverer plus 20% of the original research time.

## 9. Conquest and territory
**Module:** `sim/conquest/`

Loyalty 0–100. Conquest-class units reduce it by 20–35 per successful attack, modified by
Statecraft on both sides; regeneration +1/hour. At zero the settlement flips with low
loyalty, inviting counter-conquest.

Captured settlements keep buildings at **−3 grades**. Cultivation and Special buildings
reset fully — they are bound to their builder. Vassalage is an alternative to occupation
with its own subversion gameplay for the vassal.

## 10. Cultivation
**Module:** `sim/cultivation/` — **Sheets:** `Cultivation`, `Grades_Realms`

The player avatar cultivates through the same 42 grades that structure buildings and
research, named as 14 realms × 3 stages. Qi from cultivation buildings, Spirit Vein tiles,
and idle meditation. Breakthroughs cost Qi and require passing a **Tribulation** — a live,
scheduled event, several of which are publicly visible and can be crashed by rivals.

Tri-cultivation (Body/Mind/Soul), techniques as slotted scrolls, pills with a toxicity
stacking cap, sects as formalized mentorship, spirit beasts, Dao comprehension, and karma
linking reputation to tribulation difficulty.

## 11. Monetization
**Module:** `sim/economy/shards/` — **Sheets:** `Chrono_Shards`, `Heavens_Envy`

**Chrono Shards** compress remaining time on a queue item. Earned from events and epochs,
and also purchasable.

Four guardrails, all of which must be enforced server-side:

1. **Absorption ceiling.** A player may never compress elapsed time by more than
   `2.0 + 0.30 * constructionRank + 0.50 * era`. Money buys you up to your earned ceiling,
   never past it. Excess shards are simply unspendable that day.
2. **Prohibited targets.** Zero shard application to: any queue in a settlement with hostile
   movement inbound or within 4h of impact; troop training during a declared war where the
   player is a belligerent; Ascension Projects; epoch victory projects; megastructures;
   cultivation breakthroughs; fortification repair under siege; anything targeting a player
   two or more eras below.
3. **Temporal Debt.** Spending accrues karma across six tiers, raising tribulation
   difficulty and suppressing Qi regeneration. Decays one tier per 30 days of abstention.
4. **Disclosure and throttle.** 30-day rolling spend is public on the profile. A hard
   monthly purchase cap applies per account.

**Heaven's Envy.** Three leaderboards rank shard-hours *purchased* in a rolling 24h window,
resolved at a fixed daily tick: universe top 10, quadrant top 10, alliance top 10. Each
carries −10% defensive strength for 24 hours, stacking to −30%. It applies to every unit's
defence pool and all fortification multipliers; it does not touch attack values. It cannot
be cleansed, offset, or dodged via vacation mode, which is blocked while marked.

Attacking a marked player carries **no reputation penalty** for the duration. Marked players
show a sigil on profile, settlements, fleets, and the map overlay.

Anti-gaming: linked accounts aggregate; each scope has a minimum spend floor (the median
player's 30-day *earned* shard income) so quiet scopes may return fewer than ten names;
home quadrant is evaluated on a 7-day lag; alliance is locked at window start.

## 12. Epochs
**Module:** `sim/epoch/`

The universe never resets. Rolling 2–4 month epochs carry published victory conditions,
live scoreboards, a closing ceremony, and a world-shaping transition event. Prestige is the
permanent score and never resets, decaying only 2% per epoch at the top ranks.
