# Low-Level Design — Real Time Location Sharing

Companion to [HLD.md](./HLD.md). This one gets into requirements, class structure, module
boundaries, interfaces, threading, the algorithms, and the operational constraints that
shaped them along the way.

---

## Requirements

### Functional

1. Ingest position updates from a pluggable source — a JS simulation or native device/OS
   telemetry — behind one interface, so the source can be swapped without touching any
   consumer.
2. Render live entity positions and movement trails on a map, interpolated smoothly between
   updates rather than snapping.
3. Identify entities visually (colour, label) and support tap-to-select with a directions
   deep link.
4. Continue tracking and delivering updates while the app is backgrounded, via a foreground
   service with a persistent, visible notification.
5. Recover entity state after the hosting process is killed and relaunched.
6. Support multiple independent visual layers over the same location data — points and
   trails, static zone polygons — with neither layer aware the other exists.
7. Fail into a visible, working state when zero providers are registered, a fix gets
   rejected, or memory runs low. Never crash, never freeze silently.

### Non-functional

1. Sustain 60fps render with zero allocation on the per-frame path.
2. Bound memory independent of update rate (track ring buffer) and independent of viewport
   pan (culling), so a memory budget can be stated at all.
3. Bound the native→JS backlog under a busy JS thread. Batching alone isn't sufficient —
   emission has to be credit-gated.
4. Keep the core domain-free: the kernel and design tiers must not encode product
   vocabulary, enforced in CI instead of relying on convention.
5. Verify provider interchangeability with a shared conformance suite, not just a shared
   TypeScript interface.
6. Measure battery cost on-device instead of assuming it.

---

## Class Diagrams

Three small diagrams cover this better than one large one: the plugin seam, the kernel, and
how the tiers stack on top of each other.

**The Source seam** — the interface every provider implements, and what resolves which one
is active:

```
        ┌───────────────────────────┐
        │        «interface»        │
        │           Source          │
        ├───────────────────────────┤
        │ id, volatility             │
        │ capabilities()             │
        │ start(config, sink)        │
        │ stop()                     │
        └──────────────┬────────────┘
                        │ implements
             ┌──────────┴───────────┐
             │                      │
   ┌───────────────────┐   ┌────────────────────────┐
   │    MockSource      │   │   NativeTurboSource     │
   │    (pure JS)       │   │   (TurboModule bridge)  │
   └──────────┬─────────┘   └────────────┬────────────┘
              │                          │
              └────────────┬─────────────┘
                            │ registered with
                            ▼
              ┌───────────────────────────┐
              │       SourceRegistry       │
              │  priority-ordered lookup   │
              │  (0 providers → NoopSource)│
              └───────────────────────────┘
```

**The kernel** — what happens to a fix once a `Source` hands it off:

```
   ┌───────────────────┐   in    ┌───────────────────────────┐
   │     EntityFix      │ ─────► │        EntityStore         │
   │  id, lng, lat,      │        │  gates → interpolate →     │
   │  bearing, speed,    │        │  freshness → eviction      │
   │  timestamp, attrs   │        │                            │
   └───────────────────┘        │  upsert(fixes)             │
                                  │  interpolatedFeatures()    │
                                  │  shedMemory(level)         │
                                  │  snapshot()                │
                                  └─────────────┬──────────────┘
                                                 │ owns
                                                 ▼
                                  ┌───────────────────────────┐
                                  │        TrackBuffer          │
                                  │  ring buffer, time+point cap│
                                  │  RDP-simplified on read     │
                                  └───────────────────────────┘
```

**The tiers** — this is the same shape `scripts/check-tiers.sh` checks mechanically at CI
time (§6); the diagram and the lint rule are describing the same constraint two different
ways:

```
   ┌──────────────────────────────────────────┐
   │  kits/             Tier 3 — domain words   │
   │  live-entities/    live here, nowhere else │
   │  venue-zones/                              │
   └───────────────────┬────────────────────────┘
                        │ depends on ↓  (never the reverse)
   ┌───────────────────▼────────────────────────┐
   │  geo/               Tiers 0–2 — kernel,      │
   │  kernel/ ports/     ports, sources, render — │
   │  sources/ render/   no domain vocabulary      │
   └───────────────────┬────────────────────────┘
                        │ styled by
   ┌───────────────────▼────────────────────────┐
   │  design/            leaf tier — tokens only,  │
   │  tokens/ adapters/  imports nothing above it  │
   └──────────────────────────────────────────────┘
```

---

## Implementations

#### [Source port & registry](../src/geo/ports/Source.ts)
#### [EntityStore (kernel)](../src/geo/kernel/EntityStore.ts)
#### [TrackBuffer](../src/geo/kernel/TrackBuffer.ts)
#### [MockSource (JS provider)](../src/geo/sources/MockSource.ts)
#### [NativeTurboSource (bridge adapter)](../src/geo/sources/NativeTurboSource.ts)
#### [GeoKitSourceModule (native provider)](../android/app/src/main/java/com/geokit/source/GeoKitSourceModule.kt)
#### [TurboModule spec (frozen contract)](../src/specs/NativeGeoKitSource.ts)
#### [live-entities kit](../src/kits/live-entities/)
#### [venue-zones kit](../src/kits/venue-zones/)
#### [Design token → MapLibre adapter](../src/design/adapters/maplibre.ts)

---

## Classes, Interfaces and Enumerations

1. **Source** is the plugin seam. Anything that can produce `EntityFix` batches — JS
   simulation, native device telemetry, maybe a fused-location provider down the line —
   implements it the same way.
2. **MockSource** and **NativeTurboSource** are the two implementations that actually ship:
   pure JavaScript and a native TurboModule bridge. Both read the same scenario definition
   and produce the same motion, which is what makes swapping between them at runtime a fair
   comparison instead of a coincidence.
3. **SourceRegistry** picks the active provider by priority (or an explicit override) so no
   call site has to know the concrete type. Zero providers registered gets you a typed
   `NoopSource`, not a crash.
4. **EntityStore** is the kernel's one mutable store — ingest gates, per-frame interpolation,
   freshness tracking, eviction, and memory shedding under pressure all live here. It never
   looks inside domain-specific `attributes`.
5. **TrackBuffer** is a bounded ring buffer per entity, decimated with
   Ramer–Douglas–Peucker, holding enough recent history to draw a trail regardless of how
   fast updates are arriving.
6. **Volatility** (`kinetic | mutable | static`) and **Freshness** (`self | fresh | stale |
   dead`) are the two enums the kernel actually reasons about. Every entity and every layer
   gets expressed in terms of them, never in terms of what it represents in the real world.
7. **MapSurface** is the render host — camera, attribution, layer ordering — with no idea
   what's actually being drawn on it.
8. **LiveEntitiesKit** and **VenueZonesKit** sit at Tier 3, the only place domain vocabulary
   (people, routes, venues) is allowed to exist. Both are built entirely out of kernel
   primitives.
9. **GeoKitSourceModule** (Kotlin) is the native half of `NativeTurboSource`: a TurboModule
   with its own scheduler thread, emitting batched fixes across the JSI boundary under
   credit-gated backpressure.
10. The **token adapter** (`adapters/maplibre.ts`) is the second consumer of the design
    token tier — it turns the same semantic tokens RN styles use into MapLibre paint and
    layout expressions.

---

## Design Patterns Used

1. **Strategy** — `Source` is the algorithm shape; `MockSource` and `NativeTurboSource` are
   swappable implementations of it, picked at runtime rather than baked in at compile time.
2. **Registry + priority-based factory** — `sources/registry.ts` keeps "which provider is
   active" out of every call site. A third provider can be added without touching a single
   consumer.
3. **Adapter** — `adapters/maplibre.ts` turns design tokens into MapLibre's expression
   language, and `NativeTurboSource` turns the TurboModule's event-emitter shape into
   something that satisfies the `Source` port.
4. **Observer / pub-sub** — `onFixes` and `onMemoryPressure` are TurboModule `EventEmitter`s.
   `subscribeToMemoryPressure` and the frame loop's `rAF` consumers just watch state they
   don't own.
5. **State** — entity freshness (`Fresh → Stale → Dead`) and the sharing session (`Idle →
   Requested → Active/Denied → Paused/Expired/Stopped`) are both explicit state machines
   (§11) instead of a pile of booleans. Permission denied is a state, not a thrown error.
6. **Object pool** — feature objects on the per-frame path get reused and mutated in place
   instead of allocated fresh, since that path can run at up to 120Hz.
7. **Facade** — `MapSurface` hides camera, attribution, and layer-ordering wiring behind one
   component. Kits never touch MapLibre directly.
8. **Credit-based flow control** — not a textbook GoF pattern, but same family as a bounded
   buffer. `ackFixes()` caps in-flight native→JS emission at one, which trades away some
   throughput for a hard backlog bound when the consumer is busy (§8).

---

## 6. Module layout

```
src/
  design/                   Tier: design (LEAF — imports nothing from geo or kits)
    tokens/primitives.ts    palette, space, radius, type, motion, mark, opacity
    tokens/semantic.ts      SemanticTokens + light/dark, typed so themes cannot drift
    ThemeProvider.tsx       context + makeStyles (memoised per theme)
    adapters/maplibre.ts    tokens → paint/layout specs (the second renderer)

  geo/                      Tiers 0–2, strictly domain-free
    kernel/types.ts         Entity, EntityFix, Geometry, Volatility, Freshness, KernelConfig
    kernel/geodesy.ts       haversine, bearing, short-way angle lerp, deg↔m
    kernel/simplify.ts      iterative Ramer–Douglas–Peucker
    kernel/TrackBuffer.ts   bounded history: time window + point cap + decimation
    kernel/EntityStore.ts   ingest, gates, interpolation, freshness, feature pooling
    ports/Source.ts         Source, SourceCapabilities, SourceSink, NoopSource
    sources/registry.ts     provider registration + deterministic resolution
    sources/MockSource.ts   synthetic provider (JS)
    sources/NativeTurboSource.ts  adapter over the TurboModule
    render/useEntityFrames.ts     frame loop, throttling, fps/build instrumentation
    surface/MapSurface.tsx  map host, camera, attribution, slot ordering

  kits/                     Tier 3 — the ONLY tier permitted domain vocabulary
    live-entities/          points + trails
    venue-zones/            static polygons

  specs/NativeGeoKitSource.ts   TurboModule codegen spec (the frozen native contract)
  ui/Hud.tsx                    performance/diagnostic overlay

android/app/src/main/java/com/geokit/source/
  GeoKitSourceModule.kt     native synthetic source on a dedicated thread
  GeoKitSourcePackage.kt    BaseReactPackage — the swap mechanism

scripts/check-tiers.sh      CI enforcement of the rules above
```

### Enforced invariants

`npm run check` = `tsc --noEmit` + `scripts/check-tiers.sh`. The script fails the build on:

1. **Domain vocabulary** (`friend|buddy|marathon|concert|festival|attendee`) appearing in
   `src/geo` or `src/design`, excluding comment lines — the rule's own documentation has to
   use the banned words to describe them, so comments are excluded from the scan.
2. **Upward imports** — `src/geo` importing from `@kits/`.
3. **Design tier purity** — `src/design` importing from `@geo` or `@kits`.

Plus a warning for hex colours outside the token layer.

**Productionisation note:** these are folders with a lint rule, not npm workspaces. That was
a deliberate 4-day tradeoff — Metro + monorepo + native autolinking is a known time sink, and
`git diff src/geo/` proves the boundary just as well. Splitting into real workspaces later is
mechanical, not risky.

---

## 7. Core interfaces

### 7.1 Kernel vocabulary

```ts
/** [longitude, latitude] — GeoJSON order, NOT the [lat, lng] most location APIs use. */
export type Position = readonly [lng: number, lat: number];

export type Attributes = Readonly<Record<string, string | number | boolean>>;

export type Volatility = 'kinetic' | 'mutable' | 'static';
export type Freshness  = 'self' | 'fresh' | 'stale' | 'dead';

/** The ONLY thing a Source produces. Everything else is derived by the kernel. */
export interface EntityFix {
  readonly id: string;
  readonly lng: number;
  readonly lat: number;
  readonly bearing?: number;    // derived from consecutive fixes when absent
  readonly speed?: number;      // m/s
  readonly accuracy?: number;   // metres
  readonly timestamp: number;   // epoch ms, must be monotonic per entity
  readonly attributes?: Attributes;
}
```

`attributes` is the extension point. The kernel never inspects its keys — style expressions
read them on the GPU instead, which is the whole reason a fleet kit and a friends kit can be
the same code path underneath.

### 7.2 The Source port — the plugin seam

```ts
export interface SourceCapabilities {
  readonly sourceId: string;          // DIAGNOSTICS ONLY — branching on this is a review failure
  readonly backgroundTracking: boolean;
  readonly activityRecognition: boolean;
  readonly deferredUpdates: boolean;
  readonly maxEntities: number;       // 0 = unbounded/unknown
  readonly producesTracks: boolean;
}

export interface SourceSink {
  emit(fixes: readonly EntityFix[]): void;   // BATCHED, never per-entity
  remove(ids: readonly string[]): void;      // tombstone
  error(error: SourceError): void;
}

export interface Source {
  readonly id: string;
  readonly volatility: Volatility;
  capabilities(): SourceCapabilities;
  start(config: SourceConfig, sink: SourceSink): void | Promise<void>;
  stop(): void;
  setAccuracyProfile?(profile: AccuracyProfile): void;
}
```

Consumers branch on **capabilities**, never identity. Skip that rule and the first time two
providers genuinely differ, an `if (sourceId === 'fused')` shows up in feature code and the
abstraction is basically dead from that point on.

`emit` takes a batch because every real transport delivers batches; per-fix calls would
multiply boundary cost by entity count.

Satisfying the interface and behaving the same way turn out to be two different guarantees.
Two providers can both compile against `Source` cleanly while doing genuinely different
things — route-following added to the JS source is a clean example, since nothing about the
type system notices that the native source doesn't have it. That's the specific tax a plugin
architecture pays that a single hard-coded source never does: every capability one provider
gains becomes a debt the others quietly owe. Where possible that shared behaviour should
live in the kernel so no provider can diverge from it. Where it can't, it belongs in
`SourceCapabilities` so consumers degrade on purpose instead of drifting apart by accident.
The conformance suite in §15 is really checking for the second guarantee, not the first —
not that the shapes match, but that the behaviour does too.

### 7.3 Resolution policy

| Providers registered | Behaviour |
|---|---|
| 0 | `NoopSource` — typed error, **must not crash** |
| 1 | that one |
| 2+ | highest `priority`; explicit override wins over priority |

The zero case is easy to forget about, and if it's left unhandled a packaging mistake turns
into a launch crash instead of a quiet no-op.

### 7.4 TurboModule spec

```ts
export interface Spec extends TurboModule {
  start(scenarioJson: string, intervalMs: Int32): void;   // scenario is JSON; crosses once, at startup
  stop(): void;

  startBackgroundTracking(title: string, body: string): boolean;  // promotes to a foreground service
  stopBackgroundTracking(): void;

  saveSnapshot(json: string): void;   // durable, outside the JS heap — see §10.3
  loadSnapshot(): string;

  getCapabilities(): NativeCapabilities;            // sync JSI — pure struct read, no I/O

  readonly onFixes: EventEmitter<NativeFixBatch>;   // codegen emitter, bridgeless-safe
  ackFixes(): void;                                 // returns the single emission credit — see §8

  readonly onMemoryPressure: EventEmitter<MemoryPressureEvent>;  // forwarded from Application.onTrimMemory
}
```

What's missing from this is as deliberate as what's in it: no positions array parameter on
`start`, no polling method. Fixes only flow out through `onFixes`. In the production design
(§13) they wouldn't even reach JS — a native source would write straight into a native store
that a native map view reads directly. That version moves where the fixes travel without
touching this contract at all.

`start` takes the scenario as a JSON string rather than structured parameters — the one
place in the spec that's stringly-typed, because codegen can't express nested coordinate
arrays and this only crosses the boundary once, at startup, never on a repeating path.

Codegen emits `emitOnFixes(ReadableMap)` for the fix stream, `emitOnMemoryPressure(ReadableMap)`
for the pressure signal, and a blocking-synchronous `getCapabilities()`.

### 7.5 Native module lifecycle

`TurboModuleRegistry.get()` gets resolved lazily, on first use inside
`getNativeGeoKitSource()`, instead of at module-evaluation time. Under the bridgeless New
Architecture, native module registration and JS module evaluation aren't guaranteed to
happen in any particular order relative to each other. Resolving eagerly at import time can
race that registration, and if the miss got cached, the native source would simply be
unavailable for the rest of that launch. Resolving lazily means the check happens on first
real use, by which point registration has usually had time to finish — verified across
repeated cold launches.

---

## 8. Threading model

The diagram most often left out, and the one that actually explains why the motion feels
smooth.

```
  NATIVE SOURCE THREAD           JS THREAD                    NATIVE UI THREAD
  (geokit-native-source)                                      (render)
  ┌─────────────────────┐   ┌─────────────────────────┐   ┌──────────────────┐
  │ ScheduledExecutor   │   │ SourceSink.emit         │   │ MapLibre GL      │
  │ fixed rate, daemon  │   │        │                │   │ style expressions│
  │        │            │   │        v                │   │ evaluated on GPU │
  │        v            │   │ EntityStore.upsert      │   │                  │
  │ step() + maybeEmit ─┼──►│ gates, derive, track    │   │                  │
  │        ▲            │   │        │                │   │                  │
  │        │  ackFixes  │   │ rAF ───┤ 60-120Hz       │   │                  │
  │        └────────────┼───┤        v                │   │                  │
  │  batched event,     │   │ interpolatedFeatures()  │   │                  │
  │  marshalled         │   │ mutate in place ────────┼──►│                  │
  │                     │   │           GeoJSON ~30Hz │   │                  │
  │                     │   │                         │   │                  │
  │                     │   │ setInterval 1Hz         │   │                  │
  │                     │   │   sweep(): freshness,   │   │                  │
  │                     │   │   eviction              │   │                  │
  └─────────────────────┘   └─────────────────────────┘   └──────────────────┘
```

A few rules fall out of that picture:

- The source thread never blocks on JS — `emitOnFixes` just marshals, and the timer keeps
  going regardless of what JS is doing with the last batch.
- Freshness is derived from the wall clock, so it only gets swept at **1Hz**. Recomputing it
  120 times a second would give the same answer at 120x the cost, for nothing.
- Track geometry gets rebuilt every 15th push, not every push, since trails only need to
  change at source rate.
- Nothing on the frame path allocates. Feature objects are pooled and mutated in place; the
  only thing allocated per push is a small wrapper object, just enough to give React a new
  identity to diff against.

Batching alone doesn't solve backpressure, though it looks like it should. It bounds how
often the boundary gets crossed, but says nothing about how many crossings can pile up while
JS is busy. `emitOnFixes` is fire-and-forget — the native thread doesn't wait for JS to
consume anything — so without something extra, nothing stops the source from emitting again
before the previous batch has even been read, and RN's event queue will happily deliver every
one of those, in order, the moment JS is free. At this design's production rate of 1Hz, the
backlog that builds up during a stall is just stall duration times rate. It stays small
because the rate is low, not because anything actually bounds it.

The fix is a credit of exactly one. `step()`, which advances world state, keeps running on
schedule no matter what; `maybeEmitBatch()` is the part that gets withheld while a previous
batch is still unacknowledged. `EntityFrames`'s `onFixes` handler calls `ackFixes()`
immediately after `sink.emit`, handing the credit back. A 5-second timeout on the native
side self-heals if an ack ever gets lost — a JS exception between receipt and ack, or the
module getting torn down mid-flight — so one dropped ack can't stall the source forever.

End result: at most one batch is ever in flight. During a stall, `step()` keeps the
simulation current internally, but nothing actually gets sent until JS acknowledges the
batch already sitting in the queue. Whatever gets sent next carries the freshest state
available, instead of a pile of stale batches each getting discarded the instant a newer one
lands.

This part didn't get taken on faith. Native-side logging — instance id, and every
emit/ack/skipped-tick event — makes the credit mechanism something you can actually watch
happen, rather than something inferred from symptoms on the JS side. A synchronous
three-second JS stall was run twice against the finished mechanism: both trials logged
exactly two skipped ticks, queued zero batches beyond the one already in flight, and resumed
2.995s and 3.000s after the hold — close enough to the stall length to be within a tick.
Full trial data is in HLD §8.4. The logging stayed in the shipped build (`Log.d`, one line
per tick, negligible cost), because it's what made this verifiable instead of just argued
for.

---

## 9. Algorithms

### 9.1 Ingest gates (cheapest-first)

```
1. accuracy   fix.accuracy > accuracyGateM (100m)              → reject
2. monotonic  fix.timestamp <= stored.timestamp                → reject
3. speed      haversine(stored, fix) / dt > 70 m/s (~250 km/h) → reject, ++rejectStreak
4. re-acquire rejectStreak >= 3                                → trust stream, snap, drop track
```

Haversine, not equirectangular, because this feeds the teleport gate — an approximation that
drifts with latitude would reject legitimate fixes in Reykjavík and wave through bad ones in
Nairobi.

Gate 4 exists because the first fix for an entity has nothing to compare against, so it gets
accepted no matter what. If that anchor fix happens to be wrong, every correct fix after it
keeps failing the speed gate against a bad reference point, and the entity is stuck
indefinitely. Re-acquisition breaks that deadlock: after 3 rejections in a row, the stream
gets trusted again, the entity snaps to the new position, and its track gets dropped instead
of interpolated. Interpolating there would draw a smooth line through ground the entity
never actually covered — a more convincing wrong answer than an honest jump would be.

### 9.2 Interpolation

```
span = arrivalMs - departedMs
t    = clamp((now - departedMs) / span, 0, MAX_EXTRAPOLATION_FACTOR = 2)
lng  = fromLng + (toLng - fromLng) * t
bearing = lerpBearing(fromBearing, toBearing, min(t, 1))   // short way around the circle
```

Two details that aren't obvious from reading the formula:

- `from` is the last position actually **displayed**, not the last fix received. Updates
  never land on a perfectly even cadence, so anchoring to the last raw fix makes pins
  visibly snap backwards whenever one arrives a little late.
- Extrapolation caps out at 2 intervals. Past that point the position is really just a
  guess, and a confident pin sailing off into the sea is worse than one that pauses.

Bearing interpolates the short way around — 350° to 10° is +20°, not −340° — otherwise
markers whip backwards through a full circle every time they'd need to turn slightly.

### 9.3 Track decimation

The ring buffer is bounded on two axes at once:

- a time window (5 minutes), and
- a point cap (60 after RDP simplification, 4x that before it).

Neither one alone is enough. The time window by itself breaks down for a device emitting at
10Hz — it blows the point budget well inside the window. The cap is what makes memory a
function of entity count only, regardless of update rate, which is the only reason a memory
budget can be stated as a fixed number at all.

RDP runs iteratively rather than recursively (a long straight run recurses deep enough to
matter on Hermes), and only runs lazily, on read — a track that never gets rendered never
gets simplified either.

Recording is gated by the same flag that controls rendering (`setTracksEnabled`), so
appending to the ring buffer and running RDP cost nothing when trails aren't shown. At 2000
entities that's the difference between a 7.62ms and a 1.93ms per-frame build. Recording and
rendering are separate concerns in principle, but only one of them needs to actually run
when trails are off.

### 9.4 Rate decoupling

```
source ~1Hz  →  store  →  rAF 60-120Hz  →  push ~30Hz  →  GPU
```

The push interval carries an 8ms tolerance, roughly half a frame. `1000/30 = 33.33ms`, but
two 60Hz frames come out to `33.34ms` — close enough that ordinary timer jitter can spill a
push into a third frame under a naive comparison, which understates the achieved rate by a
frame in the count without the rate actually having changed. The tolerance absorbs that
jitter without loosening the target itself. Measured 29–31Hz once it was in place.

### 9.5 Viewport culling

Camera bounds get read from a ref (`viewportRef`), not React state, because bounds change on
every single frame of a pan gesture — putting them in state would re-render the tree and
restart the frame loop dozens of times per gesture. `useEntityFrames` just reads `.current`
inside the tick instead. Bounds get padded 25% per edge so entities don't visibly pop in at
the viewport boundary.

At high entity counts, unbounded serialisation and per-frame allocation eventually hit
`std::bad_alloc` / SIGABRT at the native JSI boundary — around 54k serialisations/sec at
2000 entities × ~27Hz — which is what makes culling load-bearing rather than a nice-to-have
optimisation. With it, a 200-entity zoomed-in view drops to 4 serialised entities, a 1.06ms
build, and 59fps.

Culling and clustering both read from `viewportRef`, and the ref gets supplied
unconditionally regardless of whether culling itself is switched on — otherwise toggling one
setting could silently break the other through a dependency neither one declared.

The boundary that's left: culling does nothing when `visible == entities`, which is exactly
the low-zoom, high-density case that drives memory pressure in the first place (HLD §8.7).
Clustering would be the answer there, but it isn't built yet (§16) — culling on its own
doesn't reach that regime.

### 9.6 Route following

A route-following entity advances a scalar arc-length `s` along a simplified polyline
(`routeDistanceAt`, closed-form against wall-clock time rather than integrated per tick, so
JS and native sources agree with no state shared between them). Closed routes — start and
end within 1e-9 of each other — wrap `s` modulo the route length. Open routes reverse
direction at each end instead.

That distinction isn't cosmetic. Reverse at the seam of a closed route and a runner on a lap
turns around into the oncoming field; a venue circuit oscillates instead of actually
circulating. Wrapping is also the only option that plays nicely with the speed gate in §9.1
— it's a continuous move through world space, so the gate never mistakes it for a teleport,
whereas resetting `s` to 0 on an open route would produce exactly the position jump the gate
is there to catch.

---

## 10. Background tracking & process lifecycle

### 10.1 Foreground service contract

Android throttles location delivery to a backgrounded process and eventually stops it
entirely. Sustained tracking needs a foreground service (`FOREGROUND_SERVICE_LOCATION`),
which in turn requires a persistent, visible notification for as long as tracking runs. That
notification isn't friction to be minimised — it's the actual deal being made: the platform
grants continued access in exchange for telling the user, visibly and continuously, that
it's happening. For a location product, that trade holds up on privacy grounds regardless of
what the platform technically requires.

`LocationForegroundService.onStartCommand` returns `START_REDELIVER_INTENT`, so if the
process gets killed under memory pressure, Android restarts the service with its original
intent instead of a null one — it comes back configured rather than inert.

### 10.2 Where the promotion can fail, and why the guard sits where it does

`startForegroundService()` only enqueues the start and returns right away. The actual
promotion happens later, asynchronously, inside the service's own `onStartCommand`, on a
different call stack entirely. A try/catch at the call site
(`GeoKitSourceModule.startBackgroundTracking`) can't see a failure that only shows up over
there — the boundary that matters is inside `onStartCommand`, around the `startForeground()`
call itself, not around whatever triggers it.

This isn't a theoretical ordering concern either. Android 12+ requires the app to be in a
recently-foregrounded "eligible" state before it'll promote a location-typed service, and a
call that reacts to the app's own transition out of the foreground — background, then start
tracking — can lose that race, since the eligible window may already be closed by the time
the OS actually delivers the start command. An uncaught `SecurityException` there takes down
the whole process, not just the tracking feature.

So `onStartCommand` wraps `startForeground()` directly, degrading through `stopSelf()` /
`START_NOT_STICKY` on failure instead of letting the exception propagate. That bounds the
damage to "background tracking didn't start" — confirmed on device against the same trigger
(screen idle, app backgrounds) with zero process crashes across repeated trials.

What this doesn't fix is the eligibility race itself. Starting the foreground service
reactively, right as the app leaves the foreground, is inherently late relative to that
window. The more robust pattern is to promote proactively, at the moment sharing actually
begins while still clearly in the foreground, and hold the service running instead of
toggling it at the background boundary. That's scoped as follow-up work (§16), not built
here.

### 10.3 Process-death recovery

`saveSnapshot`/`loadSnapshot` (§7.4) persist entity state outside the JS heap, so a process
killed under memory pressure restores from its last snapshot on relaunch instead of starting
from an empty map. `EntityStore.snapshot()` and the graduated `shedMemory(level)` release
(tracks, then pooled caches, then stale entities — live positions never get shed) are really
two ends of the same budget: shed early and gracefully under `onTrimMemory`, and persist
enough to recover fully if the process gets killed anyway.

---

## 11. State machines

### 11.1 Sharing session (designed, not implemented)

```
   start
     │
     v
   Idle ──user taps share──► Requested
                                 │
             permission granted  │  permission refused
             + scope accepted    │         │
                                 v         v
                              Active     Denied
                              │ │ │         │
    backgrounded without      │ │ │         v
    Always permission ────────┘ │ │      ViewerOnly
                     Paused ◄───┘ │      (still sees others,
                        │         │       does not broadcast)
       foregrounded ────┘         │
                                  ├── event end + grace ──► Expired ──► end
                                  └── user revokes ───────► Stopped ──► end
                                       (tombstone within one tick)
```

Degraded modes are states, not error conditions — permission denied lands you in
viewer-only, coarse-only accuracy lands you in reduced-precision sharing. The UI is never
supposed to dead-end.

### 11.2 Entity freshness

```
   start
     │ first accepted fix
     v
   Fresh ──── age > 15s ────► Stale ──── age > 120s ────► Dead ──► evicted
     ▲                          │
     └────── new fix ───────────┘

   Fresh ──── tombstone ────► removed immediately
```

This gets rendered entirely by a GPU style expression keyed on the `freshness` property — no
JS runs per entity per frame just to recolour a pin.

---

## 12. Wire schema (designed)

```
uplink   (device → server), batched every 3–5s, binary
  sessionId  u64      rotating pseudonym, not a stable user id
  seq        u32      gap detection
  fixes[]    { dLng:i24, dLat:i24, bearing:u8, speed:u8, acc:u8, dt:u16 }
```

Deltas against the batch's first fix, roughly 40 bytes per fix. Absolute coordinates only go
out on the first fix of a batch.

```
downlink (server → viewer), coalesced ≤4Hz, viewport-scoped
  resumeToken  opaque    reconnect delta rather than full snapshot
  upserts[]    as above
  tombstones[] sessionId
```

On reconnect, send the latest fix plus a decimated backfill — never the full queue. Nobody
actually needs a position from 8 minutes ago.

---

## 13. The complete native view

This is the strongest form the architecture takes: a Fabric component owning its own
`MapView`, fed by a native entity store, with generation, interpolation, and drawing all
resident in native code.

### The contract

`src/specs/LiveMapViewNativeComponent.ts` is written and frozen already. It carries no
geometry props at all — style URL, initial camera, identity palette, interpolation window,
trail flag, and that's it. Entities reach the view from the native store; JavaScript never
sends a coordinate.

That absence is the actual design. A contract with no geometry parameter physically can't be
used to send geometry, so the guarantee holds because the shape of the API makes it hold, not
because everyone remembers to follow a convention.

Anything imperative goes through commands, not props — `setCamera`, `setSelected`. Props
describe configuration; commands describe things that happen.

### What it provides

| Property | Consequence |
|---|---|
| Drawing on `Choreographer` frame callbacks | Motion follows display refresh, not a JS timer |
| Store and renderer both native | A blocked JS thread cannot interrupt tracking or drawing |
| No per-frame geometry transfer | Removes the cost that becomes the limit at scale (HLD §8.5) |
| Trails, grouping and selection native | One consistent view of the world, never two that disagree |
| Per-marker updates via annotation manager or a custom layer | Animation-rate updates without reloading a data source |

### Implementation plan

| # | Work | Risk |
|---|---|---|
| 1 | Codegen the component; confirm generated `LiveMapViewManagerDelegate` | low |
| 2 | `LiveMapViewManager : SimpleViewManager<LiveMapView>` wrapping `org.maplibre.android.maps.MapView` | low |
| 3 | Style and layer setup in Kotlin — circle layer, identity palette by `variant`, opacity by freshness | medium: mirrors the token adapter's output |
| 4 | `NativeEntityStore`: gates, ring buffers, freshness. `GeoKitSourceModule` writes into it rather than emitting | medium |
| 5 | Render on `Choreographer.FrameCallback`; per-marker updates through the annotation manager | **high — the core of the component** |
| 6 | Lifecycle: `onStart/onResume/onPause/onStop/onDestroy/onSaveInstanceState` forwarded from the ViewManager | **high** |
| 7 | Fabric view recycling: implement `prepareForRecycle` | **high** |
| 8 | Trails as a native line layer fed by the same store | medium |

Steps 5 through 7 carry most of the actual effort — call it 1 to 3 focused days.

### Acceptance criteria

- No geometry crosses into JavaScript on any per-frame path.
- Navigating away and back doesn't leak the map surface (verified by heap dump).
- Deterministic placement holds: switching providers moves no entity on screen.
- HUD `build` stays at 0ms and js fps stays ≥55 with the native view mounted.
- Trails, grouping and selection all render from the same native store as the pins.

### When to build it

| Trigger | Rationale |
|---|---|
| Entity counts exceed what the bridge path sustains | HLD §8.5 bounds it |
| Trails, grouping or selection must be native | one consistent view of the world |
| Per-frame native→render coupling required | sensor fusion, AR overlay — JS cannot be in the path |
| Map surface required that the RN wrapper does not expose | owning the component makes it reachable |

This is a scale call, not a correctness one. At the cardinality this product actually
targets, the JS-driven path renders at 60fps within 3% of the frame budget already. The
component is specified and sitting ready for whenever entity count makes the JS transfer the
actual bottleneck — it just hasn't gotten there yet.

---
