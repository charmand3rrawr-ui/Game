# Sprites

Authored art goes here, at the exact paths `assets/manifest.jsonl` names.

Nothing in this directory is required. Until a sprite exists, the renderer draws
that building procedurally from the workbook's twelve visual tiers
(`DECISIONS.md` D8), so art can land **one file at a time** with nothing
breaking in between and no code change when it arrives.

```
sprites/buildings/<building key>/t<tier>.png    256x256
sprites/units/<archetype slug>.png              128x128
sprites/research/<discipline key>.png            96x96
```

- `pnpm run brief <asset-id>` prints the full prompt for one asset.
- `assets/BRIEF.md` carries the rules every sprite obeys.
- `pnpm run assets` rebuilds the ledger from what is actually on disk.
- `pnpm run verify:sprites` proves a dropped-in file reaches the canvas.

Do not commit placeholder art. A stand-in here is indistinguishable from
finished work once it is in the repository, and it makes the ledger claim an
asset is done when nobody has drawn it.
