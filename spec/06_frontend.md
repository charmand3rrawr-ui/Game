# 06 — Frontend

## 1. Stack

React 18 + TypeScript + Vite. PixiJS for the map. Zustand for ephemeral UI state,
TanStack Query for server state invalidated by WebSocket pushes. Capacitor wraps the same
build for iOS and Android — there is no separate mobile codebase.

**Design constraint that shapes everything:** every meaningful action must be completable
in a ten-minute mobile session. Deep planning tools may reward a desktop, but nothing
important may *require* one.

## 2. Screens

| Screen | Purpose | Notes |
|---|---|---|
| **Attention Dashboard** | Everything needing the player, sorted by urgency | The home screen. Build first. |
| Map | Seamless zoom plot → province → continent → planet → system → galaxy | PixiJS, see §4 |
| Settlement | Plots, queues, buildings, stockpile, staffing | Drag-to-plan upgrade paths |
| Command Centre | All movements and timers in one sortable stream | One-tap response actions |
| Formations | Veterancy standing, requirement breakdown, equipment, naming | Where players get attached |
| Battle Report | Full phase arithmetic and XP attribution | Links to the simulator |
| Simulator | Battle calculator, pre-loadable from any report | Same code as the server resolver |
| Design Bureau | Modular ship and vehicle templates | Era IV+ |
| Governor | Area assignment and the six spec sheets | Spec editing is a real UI, not a form |
| Alliance Hub | Chat, forums, treasury, projects, operations planner | |
| Dynasty Hall | Permanent history, prestige, traditions | Reads the World Atlas |
| Codex | In-world documents, guides, tutorials | Written diegetically |

## 3. The Attention Dashboard — build this first

With full production isolation and no cap on holdings, this is where players will live. If
it is bad, nothing else matters.

It is a single sortable, filterable stream of actionable items:

- Idle build or training queues, by settlement
- Stalled governor specs, with the reason (usually a resource shortfall)
- Warehouses at capacity and actively losing output
- Understaffed buildings dragging output
- Incoming hostile movements, with countdown and estimated composition
- Governor escalation alerts
- Unpaid upkeep and Brownout warnings
- Formations eligible for promotion

Requirements:
- Each row carries a **one-tap resolution** where one exists (re-queue, haul from a
  neighbour, restaff, seize).
- **Multi-select** to issue the same order across many settlements. Every order still
  executes locally at local cost — this is faster clicking, not automation.
- User-tunable notification thresholds ("only wake me for incoming conquest units", digest
  mode).
- Virtualised list. A player may have thousands of holdings; render only the viewport.

## 4. Map rendering

Six layers with consistent iconography and seamless zoom. Implementation notes:

- **PixiJS with a sprite atlas per era and category.** A DOM or SVG map will not survive
  galaxy scale.
- **Viewport culling and LOD.** Beyond a zoom threshold, settlements render as aggregate
  cluster markers, not individual sprites.
- **The server sends deltas, not snapshots.** Subscribe to `map:{shard}:{bbox}` and patch.
- **Visual tiers.** Each building has 12 authored visual tiers mapped to level bands (see
  `Visual_Tiers` sheet), multiplied by seven shared overlay axes (era retrofit, culture,
  cultivation aura, damage, activity, biome, heraldry). Composite these at runtime from the
  shared libraries rather than shipping pre-composited art.
- **Two overlays carry gameplay information and must stay legible at a glance:** damage
  state persists visibly until repaired, and the Overdriven activity state (shard-accelerated
  construction: temporal shimmer, blurred workers) is deliberately conspicuous, because
  Heaven's Envy is meant to be seen.

## 5. State and reconciliation

- Server state is the truth. The client may show optimistic hints (a queue item appearing
  immediately) but must reconcile against the server response and visibly correct if it
  differs.
- **Never compute game outcomes client-side** except in the Simulator, which is explicitly
  a what-if tool and labelled as such.
- Timers render from server-provided absolute timestamps and the client's clock offset,
  measured at connect and re-measured periodically. Display both server and local time
  everywhere a time appears — players coordinate attacks across time zones constantly.

## 6. Accessibility and clarity

- All combat maths is shown, not summarised. A player should be able to reconstruct any
  result by hand from the report.
- Colour is never the only carrier of meaning (ownership, alliance standing, damage state).
- Numbers are formatted with locale-aware grouping and abbreviated at scale (2.3T), with
  the exact value on hover or long-press.
