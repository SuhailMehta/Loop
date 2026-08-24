# High-Level Design — Real-Time Location Sharing

**GeoKit** — a horizontal geospatial runtime for React Native, of which **Loop**, "share
your live location during an event", is the first consumer.

---

## 1. Problem and scope

Display the real-time positions of a user's friends on a map during events (concerts,
marathons, travel), with a trail of recent movement, while minimising battery drain and
performance degradation as the number of people on the map grows.

**In scope and implemented:** client architecture, rendering pipeline, battery
strategy, the boundary at which native optimisation becomes necessary, a structure
that supports future use cases, and device-side lifecycle — background tracking,
memory pressure and process-death recovery (§8b).

**Documented but not implemented:** server topology, sharing permissions
(scoped grants, revocation), and offline reconnect protocol. The brief permits a
synthetic source in place of a real transport; each of these areas is specified
here and stubbed behind an interface, so none of them is a rewrite.

---

## 2. Design thesis

> Position data must not cross an expensive boundary once per entity per frame.

Everything else follows from that one sentence.

- The source clock (~1Hz) and the display clock (60–120Hz) are **decoupled by
  interpolation**, never by asking the source for more data. That is the battery argument.
- Entity state lives in a **mutable store outside React**. A moving pin does not re-render
  a component tree.
- Geometry reaches the GPU as **one GeoJSON payload per push**, not as N marker components.
- The remaining cost — serialising that payload across JS→native — is the real ceiling,
  and §8 shows the measurement that proves it.

This thesis is falsifiable, and §8 records where it held and where it broke.

---

## 3. Context

```
  MOBILE DEVICE                            BACKEND (designed, not built)
  ┌───────────────────────────┐            ┌────────────────────────────────┐
  │                           │            │                                │
  │  Location provider        │            │  Ingest   (WebSocket / MQTT)   │
  │  (Fused / CoreLocation)   │            │              │                 │
  │          │                │  batched   │              v                 │
  │          │ fixes          │  uplink    │  Presence + last known         │
  │          v                │  3-5s      │  (Redis, short TTL)            │
  │      Loop app    ─────────┼───────────►│              │                 │
  │          │       ▲        │            │              v                 │
  │          │       └────────┼────────────┤  Fan-out                       │
  │          │  viewport-scoped delta      │  (partitioned by circle)       │
  │          │ GeoJSON        │            │                                │
  │          v                │            └────────────────────────────────┘
  │      Native map view      │
  │      (MapLibre)           │
  └───────────────────────────┘
```

---

## 4. Component architecture

Four tiers. **Dependencies point downward only**, enforced in CI by
`scripts/check-tiers.sh`, which also bans domain vocabulary below Tier 3.

```
  ┌──────────────────────────────────────────────────────────────┐
  │ Tier 3   use-case kits          live-entities, venue-zones   │
  │          domain lives here                                   │
  └──────────────────────────────────────────────────────────────┘
                            │ depends on
                            v
  ┌──────────────────────────────────────────────────────────────┐
  │ Tier 2   capability packages    sources + registry,          │
  │          domain-free            render loop, MapSurface      │
  └──────────────────────────────────────────────────────────────┘
                            │
                            v
  ┌──────────────────────────────────────────────────────────────┐
  │ Tier 1   ports                  Source, MapEngine            │
  └──────────────────────────────────────────────────────────────┘
                            │
                            v
  ┌──────────────────────────────────────────────────────────────┐
  │ Tier 0   kernel                 EntityStore, TrackBuffer,    │
  │                                 geodesy, simplify            │
  └──────────────────────────────────────────────────────────────┘

  design tokens (leaf)  — used by Tiers 2 and 3, depends on nothing

  Dependencies point downward only. Enforced by scripts/check-tiers.sh.
```

### Why the tiers are shaped this way

The map is a **horizontal capability**, not a location-sharing feature. Nothing below
Tier 3 contains the words *friend*, *event*, or *venue*. The kernel's vocabulary is
**entities, tracks, sources, layers** — so live location sharing, fleet tracking, race
telemetry and venue zoning are the same problem to it.

Domain meaning travels in an opaque `attributes` bag and is resolved at render time by
**style expressions evaluated on the GPU**. That is the extension mechanism: a new use case
supplies data and a style expression, never a kernel change.

**Evidence this is real:** `venue-zones` is a different geometry (Polygon), a different
volatility (static), and a different domain (venue ops) from `live-entities`. Adding it
required **zero changes under `src/geo/`**.

### The classification that matters

Storage and upload strategy key off **volatility**, not geometry type:

| Class | Meaning | Strategy |
|---|---|---|
| `kinetic` | changes every tick | interpolated, coalesced ingest, partial updates |
| `mutable` | changes occasionally | diffed, re-uploaded on change |
| `static` | never changes | uploaded once, pre-tiled if large |

Keying off geometry would misclassify both a wildfire perimeter (kinetic polygon) and a
parked scooter (static point).

---

## 5. Data flow

```
  Source           EntityStore         Render loop        MapLibre
  (any impl)       (Tier 0)                               (native)
     │                  │                   │                 │
     │ emit(batch) ~1Hz │                   │                 │
     ├─────────────────►│                   │                 │
     │                  │ gates: accuracy → monotonic → speed │
     │                  │ derive bearing/speed, append track   │
     │                  │                   │                 │
     │                  │  interpolated     │  every frame    │
     │                  │◄─ Features(now) ──┤  (60-120Hz)     │
     │                  │  lerp from→to,    │                 │
     │                  │  mutate in place  │                 │
     │                  │                   │  GeoJSON ~30Hz  │
     │                  │                   ├────────────────►│
     │                  │                   │                 │
     │                  │◄─ sweep() ────────┤  every 1s       │
     │                  │  freshness,       │                 │
     │                  │  eviction         │                 │
```

Three separate clocks, deliberately: **source rate**, **geometry push rate**, and **sweep
rate**. Conflating any two of them is how these systems end up burning battery to produce
frames nobody can perceive.

---

## 6. Technology choices

| Decision | Chosen | Alternatives and why not |
|---|---|---|
| Map renderer | **MapLibre RN 11** (GeoJSON source + style layers) | `react-native-maps` renders each `<Marker>` as a native view — a per-marker commit per update, unusable past ~30 moving pins. Mapbox GL is equivalent but needs a token and billing. MapLibre needs neither. |
| Marker layer | **Circle layer** | Symbol layers need a sprite sheet and per-icon texture binding. Circles get data-driven colour and radius for free. |
| Movement smoothing | **Kernel interpolation** | Asking the source for 60Hz fixes would destroy battery for zero perceptual gain. |
| Entity state | **Mutable store outside React** | React state per entity re-renders the tree at source rate. |
| Native seam | **TurboModule + codegen** | Codegen freezes the contract at build time and generates the JSI bindings; hand-written bridges drift. |
| Trail decimation | **RDP at ingest + MapLibre `tolerance` at tile build** | Both, for different reasons: the kernel pass bounds what is *stored*, MapLibre's bounds what is *drawn*. |
| Theming | **Semantic tokens with two adapters** | The map is a second renderer consuming declarative JSON, not CSS. One token set, two serialisations. |
| JS engine / shrinker | **Hermes (HBC) + R8** | Hermes cuts startup parse cost; R8 cuts dex size (107MB → 99MB). Independent concerns, both enabled. |

---

## 6b. Three implementation strategies

The same feature is built three ways. Each one moves more of the work into native
code. Understanding the difference means understanding what the pipeline is made of.

### The pipeline has four stages

| Stage | What happens |
|---|---|
| **Produce** | A position reading is created — by GPS, a server, or a simulator |
| **Store** | The reading is validated, aged, and appended to a trail |
| **Interpolate** | Positions between readings are calculated so motion is smooth |
| **Draw** | Geometry is handed to the map and rendered |

The three strategies differ only in **where the boundary sits** — which stages run
in JavaScript and which run in native code.

```
                    Produce    Store   Interpolate   Draw
                    ───────────────────────────────────────
  1. JavaScript       JS        JS        JS          JS ──► map
                                                       ▲
                                          boundary ────┘

  2. Native bridge   NATIVE  │  JS        JS          JS ──► map
                             ▲
                  boundary ──┘

  3. Full native     NATIVE   NATIVE   NATIVE      NATIVE ──► map
                                                             ▲
                                             boundary ───────┘
                                             (config only)
```

### 1. JavaScript — the baseline

**How it works.** Everything runs in JavaScript. A timer produces readings, the
kernel validates and stores them, a frame loop interpolates positions, and the
resulting geometry is handed to the map as one payload roughly 30 times a second.

**What crosses the boundary.** One geometry payload per push. Not one per friend —
that distinction is the difference between smooth and unusable.

**What it costs.** 0.4–0.7ms of JavaScript work per frame at 32 friends.

**Its weakness.** Everything shares the JavaScript thread. If the app is busy —
a long list, a large parse — production and drawing both stop.

### 2. Native bridge — a TurboModule source

**How it works.** Production moves to Kotlin, running on its own dedicated thread.
Readings are batched and handed to JavaScript as a single event per tick. Storage,
interpolation and drawing stay in JavaScript exactly as before.

**How it is built.** A TurboModule, with its interface generated from a typed
specification at build time. The provider registers itself, and the app resolves
whichever provider is present — so swapping between strategy 1 and 2 changes a
registration, not any calling code.

**What crosses the boundary.** One batched event per tick carrying every reading,
then the same geometry payload as before.

**What it buys.** *Independence from the JavaScript thread.* With JavaScript
deliberately blocked for three seconds, this source continued producing while the
JavaScript source stopped entirely. Speed is equivalent in normal use.

**Its limit.** Geometry still travels through JavaScript on every draw, so the
drawing cost is unchanged from strategy 1.

### 3. Full native — a Fabric map component

**How it works.** All four stages run in native code. The component owns its own
map view and a native store. Drawing is triggered by the display's own frame
callback rather than a JavaScript timer.

**How it is built.** A Fabric component whose contract carries style, camera,
palette and flags — **and no geometry at all**. JavaScript sends configuration and
commands such as "move the camera" or "select this person".

**What crosses the boundary.** Configuration at mount, commands on user action.
**No coordinate, ever.**

**What it buys.** The per-frame cost of moving geometry disappears entirely. That
is what lifts the ceiling on how many people can be tracked at once, and it keeps
trails, grouping and selection consistent because all of them read the same native
store.

**What it costs.** A Kotlin rendering stack the team owns permanently. Specified in
[LLD §13](./LLD.md); warranted by entity count rather than correctness.

### Choosing between them

| | Strategy 1 | Strategy 2 | Strategy 3 |
|---|---|---|---|
| Production survives a busy app | no | **yes** | **yes** |
| Drawing survives a busy app | no | no | **yes** |
| Geometry crosses per frame | yes | yes | **no** |
| Code to own | least | moderate | most |

**At the scale this product targets — a few dozen friends — strategy 1 already
renders at 60 fps within 3% of the frame budget.** Strategy 2 is implemented
because resilience is worth having cheaply. Strategy 3 is specified and held ready
for entity counts that make geometry transfer the constraint.

---

## 7. Non-functional budgets

Targets committed to, and what was actually measured on a **Pixel 9, release build,
R8 + Hermes enabled**.

| Metric | Budget | Measured | Status |
|---|---|---|---|
| Frame budget | 16.7ms | 0.53–0.84ms geometry build @200 | ✅ large headroom |
| js fps @200 entities | ≥55 | 59–60 | ✅ |
| Geometry push rate | 30Hz | 29–31Hz | ✅ |
| Entities @60fps | 200 | 200 | ✅ |
| Entities @2000 | — | 25–29 fps | ⚠️ degraded |
| Entities @2000, sustained | — | **native heap OOM** | ❌ see §8.5 |
| Culled serialisation | scale with screen | 200 entities → 4 visible | ✅ see §8.7 |
| Aggregated @2000, low zoom | stable | 59 fps, 29 features serialised | ✅ see §8.8 |
| Source cadence | 1Hz batched | 1Hz, one event per batch | ✅ |
| Trail retention | 5 min / ≤60 pts post-RDP | enforced, plus 4× raw cap | ✅ |
| Staleness | fade >15s, drop >120s | implemented, GPU-resolved | ✅ |
| Battery, sharing | <4%/hr foreground | **2.5%/hr** total, screen on; 1.8%/hr app compute | ✅ |
| Battery, viewer-only | lower — no GPS | transport only; the sensor is never started | ✅ by construction |

---

## 8. Performance validation

All figures below are measured on a Pixel 9, release build, R8 and Hermes enabled —
not projected. Each subsection states a system property, the measurement that
supports it, and the design mechanism behind it.

### 8.1 Input validation is observable, not asserted

The ingest gates (accuracy, time-order, plausible speed) are exercised continuously:
the synthetic source injects invalid data at a fixed rate — roughly 1% of fixes
beyond the accuracy threshold, 0.2% GPS position jumps. The store's rejection
counter, visible on the HUD, climbs at the expected rate (≈35 per 1,000 fixes).
Validation is therefore demonstrable on screen rather than only in code.

### 8.2 Entities recover from an unreliable first reading

A newly observed entity has no prior position to validate its first reading
against, so that reading is accepted unconditionally. If it happens to be wrong,
every subsequent — correct — reading then appears implausible relative to it and
is rejected in turn, leaving the entity stranded.

The store resolves this with a re-acquisition threshold: after three consecutive
rejections, the incoming stream is trusted over the stored position. The entity is
moved directly to the new reading rather than interpolated toward it, and its
trail is discarded. A direct move is used deliberately — sliding would draw a
path through territory the entity never occupied, which is a more convincing
error than a discontinuity.

### 8.3 Geometry push rate holds inside a half-frame tolerance

The target push rate is 30Hz. Because two frames at 60Hz complete in 33.34ms
against a 33.33ms target period, a naive interval comparison sits close enough to
the boundary that ordinary timer jitter pushes some cycles into a third frame,
measuring as 24Hz rather than 30Hz. The comparison carries a half-frame tolerance
to absorb that jitter. Measured output holds at 29–31Hz.

### 8.4 A native data source is independent of JavaScript thread load

With the JavaScript thread deliberately blocked for three seconds, throughput was
compared between the JavaScript-timer source and the native (Kotlin) source over
the same six-second window:

| | JS source | Native TurboModule |
|---|---|---|
| batches produced | +5 | **+7** |
| rejections recorded | +13 | **+208** |

Production on the native source continues independent of JavaScript thread
state; the JavaScript source loses roughly two seconds of output outright. The
rejection spike on the JS source is consistent with catch-up interval ticks
firing within the same millisecond after the block clears, so consecutive
timestamps collide and the monotonicity gate rejects the duplicate batch —
correct behaviour, and a failure mode the native source does not exhibit.

**This measurement predates a since-added flow-control mechanism, and the "+7"
figure does not reproduce today.** At the time of this test, every native tick
emitted unconditionally: production continuing during a stall meant every one
of those ticks queued a batch for JavaScript to drain once free, each
superseding the last before any of them rendered. A credit-based limit was
added afterward — the native side withholds emission until JavaScript
acknowledges the previous batch, so at most one is ever in flight — and the
same three-second stall was re-run against the corrected implementation, twice,
with native-side logging recording the exact sequence of events rather than
inferring it from JavaScript-side counters:

| | Trial 1 | Trial 2 |
|---|---|---|
| Batch in flight when the stall began | seq 51 | seq 213 |
| Ticks that fired and withheld emission | 2 | 2 |
| Time from the held batch to the acknowledgement | 2.55s | 2.02s |
| Time from the held batch to the next emission | 2.995s | 3.000s |
| Batches queued during the stall beyond the one already in flight | **0** | **0** |

In both trials, the native scheduler ticked on time throughout the stall and logged
"tick skipped — awaiting ack" exactly twice before JavaScript recovered — world
state kept advancing, but nothing beyond the single already-sent batch was ever
queued. The batch that resumed the stream on JavaScript's recovery carried the
current position, not a backlog of superseded ones. No crash, and no ack-timeout
fallback was triggered in either trial (the fallback threshold is five seconds;
both stalls resolved within three).

The resilience property this section demonstrates is unchanged: production
continues independent of JavaScript thread state. What the fix changes is that
continuing to produce no longer implies continuing to queue.

### 8.5 The transfer boundary is the scaling limit

At 2,000 entities pushing at approximately 27Hz — roughly 54,000 feature
serialisations per second — the application terminates:

```
W libc     : malloc(128) failed: returning null pointer
F libc     : Fatal signal 6 (SIGABRT)
E libc++abi: terminating due to uncaught exception of type std::bad_alloc
I lowmemorykiller: low watermark is breached and swap is low
```

The failure is native heap exhaustion, not a JavaScript heap limit — the
allocation volume from continuous serialisation exceeds what the map renderer's
allocator sustains. This result is the empirical basis for §11: the constraint
at scale is data transfer across the JavaScript–native boundary, not
computation on either side.

### 8.6 Trail recording cost is independent of trail visibility

Recording and rendering are separate operations: with the trail layer hidden,
the store continued appending points and running line-simplification on every
update, since visibility and retention were not coupled. Retention is now gated
on the same flag as visibility, so hiding trails stops the recording cost as
well as the draw cost.

Effect at 2,000 entities, trails disabled, same process:

| | Before gating | After gating |
|---|---|---|
| js fps | 25 | **29** |
| geometry Hz | 25 | **27** |
| build time | 3.64ms | **1.93ms** |

### 8.7 Viewport culling scales serialisation with what is visible

Camera bounds are supplied to the entity store as a live reference, updated on
every map movement callback, and padded 25% per edge so that entities do not
appear abruptly at the viewport boundary. Only entities inside the padded
bounds are serialised to the renderer.

At 200 tracked entities, zoomed to street level:

| entities tracked | entities serialised | build time | js fps |
|---|---|---|---|
| 200 | **4** | 1.06ms | 59 |

Serialisation cost scales with what is on screen, a roughly 98% reduction at
this zoom level. The technique is bounded, however: at a zoom level where the
full population is visible, culling serialises the same count as without it —
which is the regime in which §8.5's scaling limit applies. Culling reduces
transfer cost proportional to *visible* area; it does not reduce cost at low
zoom, where aggregation (§8.9) applies instead.

### 8.8 Aggregation removes the boundary cost at low zoom

At low zoom, nearby entities are merged into a single aggregated feature before
serialisation, using a spatial grid sized in screen pixels so that cell size is
constant on screen regardless of zoom level. Aggregation is disabled above a
configurable zoom threshold, where individual positions are preferred.

Same-session comparison, 2,000 entities, identical viewport:

| | Aggregation on | Aggregation off |
|---|---|---|
| js fps | **59** | 49 |
| geometry Hz | **30** | 27 |
| features serialised | **29** | 2,000 |
| geometry build time | 6.03ms | 2.89ms |

Serialised feature count falls by roughly 69×, and the configuration that
previously exhausted the native heap (§8.5) runs stably. The build-time row is
the notable result: aggregation costs *more* JavaScript computation, and frame
rate improves regardless — confirming that computation was never the
constraint, transfer volume was. A library-level clustering option was not
used for this because such options aggregate for drawing only, after the data
has already crossed the boundary; the saving here requires aggregating
*before* the transfer.

**Aggregation is implemented as an opt-in capability, not a default.** The
product requirement is to display a user's specific friends; replacing an
individual with a count does not serve that requirement, and is appropriate
only for populations at a scale this product does not target — fleet tracking,
city-wide coverage. The default for the live-entities use case is therefore
individual rendering, measured at 60fps and 0.5ms build time for the
cardinality this brief describes (tens of participants), with aggregation
available as a capability for use cases that need it.

### 8.9 The transfer boundary, not computation, sets the ceiling

The native render path (§11) confirms §8.5 directly: removing per-frame
geometry transfer from JavaScript is what raises the entity count the system
can sustain, independent of how much computation either side performs. Full
detail, contract and implementation plan are in LLD §13.

---

## 8b. Lifecycle: background, memory pressure, and process death

An events product runs for hours with the phone in a pocket. Three platform
behaviours would otherwise break it.

### Background execution

Android throttles and then stops location delivery for a backgrounded process.
Tracking is therefore promoted to a **typed location foreground service**
(`foregroundServiceType="location"`) when the app leaves the foreground, and
demoted when it returns.

`START_REDELIVER_INTENT` is used so that a service killed under memory pressure
restarts with its original intent rather than a null one — it resumes configured
rather than returning inert.

The ongoing notification is the contract, not an inconvenience: the platform
grants continued location access in exchange for informing the user visibly and
continuously. For a location product that trade is correct on privacy grounds
regardless of the platform requirement.

**Notification permission is a real outcome.** On Android 13+ the service cannot
display its notification without `POST_NOTIFICATIONS`. When refused,
`startBackgroundTracking` returns false and the caller surfaces a degraded
state — rather than the app appearing to track and silently stopping at the lock
screen.

### Memory pressure

`EntityStore.shedMemory()` releases capacity in a deliberate order:

1. trail history — positions still render without it
2. pooled feature caches — rebuilt on demand
3. entities already past the stale threshold — invisible to the user

**Live positions are never released.** An application that clears the map to
save memory has already failed at its purpose. This is deliberately not
`clear()`: discarding everything and re-acquiring is precisely the "tracking
restarted" behaviour that makes an app feel broken.

### Process death

State is persisted to platform storage — not the JavaScript heap, which does not
survive termination, and termination is the case being handled.

| Persisted | Purpose |
|---|---|
| last-known positions | repaint before the first live fix arrives |
| entity attributes | names and roles survive the restart |
| timestamps | restored entities age correctly through the freshness sweep |

On cold start the snapshot is restored *before* the source starts. Friends appear
where they were last seen, ageing visibly, rather than the map opening empty.

> The condition to design against is not the crash but the **restart**. An
> application that recovers yet returns to a blank map has still lost the user's
> confidence.

## 9. Privacy and consent posture

The verb in the brief is **share**. That implies consent machinery, which the architecture
must not treat as an afterthought.

- **Scoped, expiring grants.** Sharing is bound to a *circle* — the specific people who
  granted each other visibility — for the duration of an event, never global and never
  indefinite. A circle is not the event: a marathon with 100,000 runners contains thousands
  of independent circles of a few dozen each, and none of them needs to know another exists.
  Auto-expiry at event end plus grace, because a user forgetting that sharing is still
  active is this category's reputational failure mode.
- **Instant revocation** propagates as a tombstone within one tick, so viewers drop the pin
  rather than showing a frozen ghost.
- **Precision control** — exact vs approximate (~500m snap) for users who want to be
  findable but not followed.
- **Ephemeral by default.** The server holds a short ring buffer, not a history table.
  Trails are client-side only. Retention is measured in minutes.
- **Rotating per-session pseudonyms** on the wire rather than stable user ids.

---

## 10. Server-side design (not implemented)

```
                  Devices
                     │  batched binary uplink
                     v
          ┌────────────────────────┐
          │ Ingest    WS / MQTT    │
          └───────────┬────────────┘
                      v
          ┌────────────────────────┐
          │ Validate + rate limit  │
          └───────────┬────────────┘
                      v
          ┌────────────────────────┐
          │ Presence + last known  │
          │ Redis, short TTL       │
          └───────────┬────────────┘
                      v
     ┌──────────────────────────────────────┐
     │ Fan-out                              │
     │ friend-graph ∩ session ∩ viewport    │
     └───────────┬──────────────────────────┘
                 │  coalesced ≤4Hz
                 v
                  Viewers
```

- **Persistent connection, not polling.** The dominant mobile cost is radio state, not
  payload size: after any transmission the radio holds a high-power state for seconds
  before stepping down, so repeated short requests keep it awake permanently. One long-lived
  connection wakes the radio only when data arrives, with keep-alives spaced minutes apart.
- **Batching serves the same end.** Uplink grouped every 3–5s rather than per fix; downlink
  coalesced server-side to ≤4Hz and scoped to the viewport. The saving is in the *number of
  radio wake-ups*, not in bytes.
- **Partitioned by sharing circle, not by geography or by event.** Consent is scoped to a
  circle (§9): viewers subscribe to the feed of each person who granted them visibility, not
  to a venue channel or a geohash cell. Partitioning by event breaks down exactly where it
  matters most — a large marathon or festival — because event size and circle size are
  different numbers, and only circle size bounds per-shard cost. Geographic sharding suits a
  continuous, ungrouped world map; it is the wrong shape here regardless of crowd size.
- **Server-side coalescing** so one chatty device cannot amplify into N viewers' downlinks.
- **Last-known cache with TTL** for cold joins.

**Per-circle fan-out stays flat regardless of event size; total connection and delivery
load scales with total concurrent participants.** Each sharer fans out to their own circle
only — bounded at the 10–40 people used throughout this design, independent of how many
other circles share the same venue. A gathering of a few hundred people is single-process
territory. A marathon with 100,000 runners, each in their own ~40-person circle, is not:
that is 100,000 concurrent connections and on the order of 100,000 × 40 × 4Hz ≈ 16 million
coalesced deliveries per second in aggregate, which requires horizontally scaled ingest
nodes and a sharded pub/sub backbone — standard infrastructure for bounded-fan-out
presence systems (the same shape as a chat platform's channel fan-out), sharded by sharer
identity rather than by any property of the crowd. The design decision this section
commits to is the shard *key* — sharing circle, always — not a claim that no event this
product targets will ever need that infrastructure.

---

## 11. When native implementation is warranted

Three measurements bound this decision, and together they set a threshold rather
than a blanket recommendation.

**A native data source improves resilience, not throughput.** Under a deliberate
three-second block of the JavaScript thread, the native source continued
producing while the JavaScript source stopped (§8.4). At the entity counts this
product targets, the two render identically at 60fps — the argument for a
native source is that data collection survives contention on the JavaScript
thread, not that it runs faster under normal load.

**A native renderer raises the ceiling on entity count.** The scaling limit
measured in §8.5 is transfer volume across the JavaScript–native boundary, not
computation. A renderer that keeps geometry out of JavaScript entirely removes
that transfer cost, which is the mechanism by which entity counts beyond what
the bridge path sustains become viable (§8.9).

**Software-level techniques resolve the constraint at this scale.** Viewport
culling reduced serialised entities from 200 to 4 at street-level zoom (§8.7);
aggregation reduced 2,000 entities to 29 serialised features and improved frame
rate from 49 to 59fps (§8.8). Neither required native code.

The threshold, stated as a rule:

> A native render component is warranted when entity counts exceed what a native
> data source over a bridge sustains, when trails and selection must also run
> natively so the map presents one consistent view, or when per-frame
> native-to-render coupling is required — sensor fusion, an AR overlay. Below
> that threshold, culling, aggregation and clock decoupling are lower-cost and
> sufficient.

At the cardinality this product targets — tens of participants per session —
the software-level techniques are sufficient on their own. The native render
component is specified and held ready for the point at which entity count
makes the transfer cost the binding constraint.