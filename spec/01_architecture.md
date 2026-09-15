# 01 — System Architecture

## 1. The shape of the problem

Before choosing tools, be clear about the workload, because it is unusual:

- **Write-heavy, low-concurrency-per-entity.** Thousands of independent settlements each
  mutating their own small state. Contention is rare; volume is high.
- **Scheduled, not real-time.** Almost every state change is known in advance: a building
  completes at a timestamp, an army arrives at a timestamp. This is a scheduling problem
  wearing a simulation costume.
- **Read-heavy on the map.** Many players watching regions they do not own.
- **Bursty combat.** Coordinated alliance operations land dozens of battles in the same
  second, deliberately.
- **Permanent history.** The world never resets, so the event log grows forever and must
  remain queryable for archaeology, the World Atlas, and dispute resolution.

The architecture below follows from those five facts.

## 2. Recommended stack

| Layer | Choice | Why this and not the obvious alternative |
|---|---|---|
| Language | TypeScript (Node 22 LTS) | One language across client, server and shared game math means the combat formula that runs on the server is literally the same code that powers the client-side battle simulator. That guarantee is worth more here than raw throughput. |
| API | Fastify | Lower overhead than Express, first-class schema validation, good TS types. |
| Realtime | uWebSockets.js | Attack warnings must arrive in under a second. uWS handles far more concurrent sockets per node than Socket.IO with less memory. |
| Database | PostgreSQL 16 | Strong transactional guarantees for conquest and trade, excellent partitioning for the permanent event log, and `SKIP LOCKED` gives a clean job-claiming pattern for the scheduler. |
| Event log | Postgres, declaratively partitioned by month | The log is append-only and enormous. Monthly partitions let old epochs be detached to cold storage without deleting them — archaeology needs them forever. |
| Hot state / locks | Redis 7 | Sorted sets are an ideal timer wheel; also carries session state, rate limits, and the map delta fan-out. |
| Migrations | Drizzle ORM + drizzle-kit | Type-safe schema that generates TS types shared with the client. Avoid heavyweight ORMs; this domain wants explicit SQL for hot paths. |
| Client | React 18 + Vite + TypeScript | Standard, fast, well-understood. |
| Map rendering | PixiJS (WebGL) | The map is 2D with tens of thousands of sprites and needs smooth zoom across six layers. A DOM/SVG map will not survive galaxy scale. |
| Client state | Zustand + TanStack Query | Zustand for ephemeral UI state, TanStack Query for server state with WebSocket-driven invalidation. |
| Mobile | Capacitor wrapper over the web client | One codebase. The game is asynchronous and does not need native performance. |
| Observability | OpenTelemetry → Grafana/Tempo/Loki | Distributed tracing matters because a single battle touches scheduler, resolver, XP, and push. |

### A deliberate deviation worth understanding

The instinct for a tick server is to reach for Go or Rust. **Start in TypeScript anyway**,
but isolate the simulation core behind a narrow interface (`packages/server/src/sim/`)
with no framework imports and no I/O. If profiling at scale shows the resolver is the
bottleneck, that one package can be ported to Rust and called over a native addon or gRPC
without touching anything else. Do not pay the cost of a polyglot codebase before the
profiler says to. The invariant that makes this safe is §2.5 in `00_README_FIRST.md`:
the sim core is pure functions over explicit inputs.

## 3. Service topology

```
                    ┌────────────────┐
   Web / Mobile ───▶│  Gateway (API) │  Fastify — auth, REST, rate limiting
                    │   + WS server  │  uWS   — push: alerts, chat, map deltas
                    └───────┬────────┘
                            │  commands (validated, queued)
                            ▼
                    ┌────────────────┐
                    │  Command Bus   │  Redis streams, one stream per region shard
                    └───────┬────────┘
                            ▼
        ┌───────────────────────────────────────┐
        │      Simulation Workers (N)           │  one or more per region shard
        │  ┌─────────────┐  ┌────────────────┐  │
        │  │  Scheduler  │  │  Resolvers     │  │  combat, production, movement,
        │  │ (timer wheel│  │  (pure sim)    │  │  XP attribution, conquest
        │  └─────────────┘  └────────────────┘  │
        └───────────────────┬───────────────────┘
                            ▼
     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
     │  PostgreSQL  │  │    Redis     │  │  Event Log   │
     │ authoritative│  │ hot/timers   │  │ (partitioned)│
     └──────────────┘  └──────────────┘  └──────────────┘
```

### Region sharding

The universe is partitioned into **region shards** (a continent, a planet, a star system,
or a galactic arm depending on density). A shard owns its settlements exclusively, so the
common case — a settlement mutating itself — needs no cross-shard coordination.

Cross-shard interactions are rare and explicit:
- An army crossing a shard boundary is handed off as a message, not a shared lock.
- Trade between shards is a two-phase transfer through the event log.
- A new shard is spun up when a region's settlement count crosses a threshold, which is
  how the map grows indefinitely.

**Implementation note:** make the shard identifier part of every entity's primary key
path from day one. Retrofitting sharding is painful; carrying an unused shard column is
free.

## 4. The scheduler — the heart of the system

This is the single most important component. Get it right before anything else.

Every future state change is a **scheduled event**: a row with an execution timestamp, an
event type, a payload, and a shard. Nothing polls; nothing iterates idle entities.

```
schedule(event)  →  INSERT into scheduled_events
                    ZADD redis timer wheel  (score = execute_at_ms)

worker loop:
  1. ZRANGEBYSCORE the wheel for due events (batch of N)
  2. Claim them in Postgres with SELECT ... FOR UPDATE SKIP LOCKED
  3. Execute each inside a transaction: mutate state, append to event log,
     schedule any follow-on events
  4. Publish resulting deltas to the WS fan-out
```

Properties this gives you:
- **Zero cost for idle.** Ten thousand quiet settlements schedule nothing and cost nothing.
- **Natural back-pressure.** A burst of simultaneous battles becomes a deeper queue and a
  few hundred milliseconds of delay, not a collapse.
- **Exact timing.** Coordinated attack waves landing seconds apart work because arrival is
  a scheduled event with a precise timestamp, not a polling artefact.
- **Replayability.** The event log plus the seed reproduces the world exactly.

See `03_simulation_engine.md` for the full implementation and
`reference/scheduler.ts` for annotated code.

## 5. Deployment

**Early (pre-launch through beta):** a single region, containerised, on Fly.io or Railway.
Managed Postgres (Neon or RDS), managed Redis (Upstash or ElastiCache). Optimise for
iteration speed, not for scale you do not yet have.

**At launch:** Kubernetes with the gateway horizontally scaled behind a load balancer, and
simulation workers scaled per region shard with a stable identity (StatefulSet), because a
shard should be owned by one worker at a time.

**Data:** Postgres primary with read replicas for map queries and the World Atlas. The event
log partitions detach monthly to S3-backed cold storage with a query API for archaeology.

**Targets to design against:** 50,000 concurrent players, 10,000 battles resolved per day
initially and an order of magnitude beyond that at maturity, sub-second attack warnings,
and a p99 command-to-acknowledgement under 200 ms.

## 6. What to build first

Do not build the full topology. Build a single-process version that contains the scheduler,
the resolvers, and an HTTP server, backed by one Postgres and one Redis. The interfaces
above exist so that splitting it later is mechanical. A distributed system built before the
game logic is a distributed system you will debug instead of building a game.
