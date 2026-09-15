# 07 — Balance Constants

**Never hardcode a balance number.** All of them live in `Ascendance_Master_Tables.xlsx`
and are imported at build time into a generated module.

## 1. The import pipeline

```
Ascendance_Master_Tables.xlsx
        │
        ▼  packages/tools/import-workbook.ts   (run in CI and on demand)
        │
        ├──▶ packages/shared/src/generated/constants.ts   // typed, frozen
        └──▶ packages/server/migrations/seed_ref_*.sql    // reference tables
```

The importer must:
- Read every sheet listed in `02_data_model.md` §8.
- **Fail the build** on a missing sheet, a renamed column, or a value outside its declared
  range. A silent default here becomes a balance bug nobody can find.
- Emit values as `bigint` literals where the domain requires it.
- Write a content hash of the workbook into the generated module so a running server can
  report exactly which balance revision it is using.

## 2. Core formulas and where they come from

| Formula | Expression | Sheet |
|---|---|---|
| Building cost | `base * (L+1)^2.4 * 1.004^L` | `Building_Levels` |
| Build/research time | `K * (L+1)^1.9 * 1.003^L`, K ≈ 0.000432 h | `Building_Levels` |
| Building output | `base * (L+1)^1.12` | `Building_Levels` |
| Admin upkeep | `k * N^1.35` | GDD Appendix A |
| Unit train time | `baseUpkeep * trainConst * gradeTrainMult` | `Archetypes`, `Unit_Grades` |
| Veterancy stat bonus | `1 + 0.01 * cumulativeLevels` (max 322×) | `Veterancy_Tiers` |
| Veterancy XP required | `100 * (L+1)^0.21 * 1.30^(T-1) * empireWeightMult` | `Veterancy_XP` |
| Experience fatigue | `1 / ((L+1)^0.21 * 1.25^(T-1))` | `Veterancy_XP` |
| Empire weight mult | `MIN(9_918_521, 1 + (W/100)^2.41)` | `Empire_Weight_Multiplier` |
| Tier-up cost | `50_000 * 2.75^(T-2)` | `Veterancy_Tiers` |
| Qi breakthrough | `100 * G^3.2 * 1.15^G` | `Grades_Realms` |
| Shard ceiling | `2.0 + 0.30*constructionRank + 0.50*era` | `Chrono_Shards` |
| Culture flip pressure | `(cultureDelta)^2 * k`, capped | GDD §8.4 |
| Morale | `clamp(0.5, 1.5)` by relative empire size | GDD Appendix A |

## 3. Calibration anchors — do not break these

These are the fixed points the whole economy was tuned around. If a change moves one of
them, it is a design decision, not a tweak, and it needs sign-off.

1. **A full 0→1337 building or research climb takes exactly 500 years.** Verification cells
   live on `Building_Levels` and `Level_Calculator`. The importer should assert this.
2. **A Mythic Path Avatar trains in exactly 6 months (4,383 h).** The entire training
   economy is calibrated to this anchor.
3. **The complete 24-tier veterancy ladder is 322× total stat bonus.** Comparable to the
   ~150× era spread, which is what keeps counters and terrain relevant.
4. **The joint non-doctrine bonus cap is +40%** on any stat. Proficiency, equipment,
   commanders, cultivation and veterancy all fold into this single clamp.
5. **The strongest counter-matrix entry is 2.2×.** Nothing else in the game may produce a
   larger single-source multiplier without deliberate review.
6. **Empire weight caps at 9,918,521× XP requirement**, the exact reciprocal of the
   0.00001% earn-side floor it replaced.

## 4. Runtime tuning

All constants are server-tunable without a client patch. Expose them through a versioned
config service with:

- An audit trail of every change (who, when, previous value).
- **Grandfathering:** a nerf to owned assets converts value rather than deleting it —
  partial refunds, refit credits. In a permanent world, trust in property is the product.
- **No change lands mid-operation for warring parties.** Changes take effect at a scheduled
  weekly maintenance window, with notes published 72 hours ahead.

## 5. Telemetry to drive tuning

| Metric | Answers |
|---|---|
| Win rate by unit role pairing | Is the counter matrix holding? |
| Win rate by doctrine and identity path | Is any build dominant? |
| Era progression funnel | Is pacing right per era? |
| Median empire weight over time | Is the weight multiplier freezing expansion? |
| Conquests per player per week | Same question, from the other side |
| Governor-initiated vs player-initiated job ratio | Is 2× priced correctly? Target ≈70/30 by count, inverse by value |
| Seize frequency and targets | Are personal slots too plentiful? |
| Retention of the middle 60% by shard-spend decile | Is monetization corroding the ecosystem? |
| Time-on-interface vs time-on-decisions | Is management crowding out strategy? |
