# Loop — Live Location Sharing

**A case study in real-time map rendering on React Native.**

This document explains the design in plain terms. [HLD.md](./HLD.md) and
[LLD.md](./LLD.md) hold the detail.

---

## The problem

A user wants to see where their friends are, live, on a map — with a short trail
behind each one showing which way they went.

It must not drain the battery, and it must not stutter when many people are on
screen at once.

---

## The core principle

The whole design follows from one sentence:

> **Moving data between JavaScript and the phone's native code is expensive.
> Do it rarely, and in large batches.**

The analogy is passing notes in a classroom. One note carrying 200 names travels
fast. Two hundred separate notes travel slowly, even though the information is
identical.

Most map applications become slow because they pass 200 notes, 60 times a second.

---

## How the system works

Three clocks run at different speeds. Keeping them independent is the central
technique.

```
Phone GPS ──1 per second──► Store ──30 per second──► Map
                              │
                              └──1 per second──► housekeeping
```

**The GPS reports slowly — once per second.**
This is deliberate. Requesting more would drain the battery while adding almost
no information: a walking person covers roughly one step in that time.

**The screen redraws quickly — 60 times per second.**
Moving pins only once per second would make them advance like a slideshow.

**The gap is filled by prediction.**
Given a previous position and a current one, the pin slides smoothly between
them. This is *interpolation* — the same estimation a person performs when
catching a ball, moving to where it will be rather than where it was last seen.

**A fourth job runs slowly in the background — once per second.**

This is the *housekeeping* pass in the diagram. It does not draw anything. It
keeps the data honest:

- **Ages positions.** A reading older than 15 seconds is marked *stale*; older
  than two minutes, *dead*.
- **Removes people who have gone.** Someone who stopped sharing, or whose phone
  died, is eventually dropped rather than left on the map.
- **Releases memory** when the system asks for it.

**Why once per second rather than every frame?** Because the answer only changes
with the clock. "How old is this position" gives the same result whether it is
asked 1 time or 60 times per second — the extra 59 are wasted work.

**Why it matters at all:** without it, a friend whose phone died would sit on the
map indefinitely, looking perfectly live. The map would be *confidently wrong*,
which is worse than being visibly out of date. Ageing is shown by fading, so a
position that can no longer be trusted stops looking like one that can.

**This is the battery answer.** Smooth motion comes from predicting better, not
from polling the GPS more often.

---

## Design decisions

Each decision is stated as: the approach, the reason, and the consequence of
choosing otherwise.

### Pins are one layer, not many objects

**Approach:** every friend is drawn inside a single shape layer rather than as
32 individual markers.

**Reason:** each marker is a separate crossing into native code. Thirty-two
markers at 30 updates per second is 960 crossings per second.

**Otherwise:** the app is smooth at 10 friends and unusable at 50. This is the
most common cause of poor performance in map applications.

### Positions are held outside React

**Approach:** friend positions live in a plain mutable object, not in component
state.

**Reason:** React re-renders when state changes. Routing every GPS update
through state rebuilds the interface once per second.

**Otherwise:** visible flicker across the whole screen, as static overlays
rebuild at the update rate alongside the data that actually changed.

### Objects are reused, not recreated

**Approach:** pin objects are allocated once; only their coordinates change.

**Reason:** allocating 200 objects 30 times per second hands the garbage
collector 6,000 objects per second to reclaim, and that reclamation stalls
frames.

**Otherwise:** sawtooth frame drops that are difficult to diagnose later.

### Bad GPS data is rejected

Phone GPS is unreliable. Three checks run, cheapest first:

| Check | Rejects |
|---|---|
| Accuracy | "Within 500m" — not a usable position |
| Time order | Readings arriving out of sequence |
| Plausible speed | A jump implying 900 km/h — signal reflecting off buildings |

This is observable rather than asserted: the demonstration injects invalid data
deliberately, and an on-screen counter records each rejection.

### Stuck entities can re-acquire

**Defect:** the first reading for a person is accepted unconditionally, because
there is nothing to compare it against. If that reading is wrong, the person is
anchored kilometres away, and every subsequent *correct* reading then looks
implausible and is rejected. The entity never recovers.

**Resolution:** after three consecutive rejections, treat the stored position as
the faulty value rather than the incoming data. Move the entity to the new
position and discard its trail.

The movement is a jump, not a slide, by design. Sliding would draw a smooth path
through streets the person never travelled — a more convincing falsehood than an
obvious jump.

### Trails are bounded twice

Retention is the last 5 minutes **and** at most 60 points.

**Reason for both:** a time limit alone is insufficient. A device reporting ten
times per second would accumulate 3,000 points within that window. The point cap
makes memory a function of *how many people are tracked*, never of *how often
their devices report*.

The line is also simplified: roughly 300 points reduce to 40 with no visible
difference, because the discarded points fall on the same pixels.

### Only visible entities are drawn

**Approach:** entities outside the visible map area are never sent to the
renderer.

**Result:** when zoomed in, 200 tracked friends reduced to **4** actually drawn.

**Limitation:** this helps only when zoomed in. Zoomed out, everyone is on screen
and the technique does nothing — which is precisely the case that needs it most.

### At low zoom, entities are grouped

At city zoom, 2,000 points render as roughly 60 counted bubbles.

**Result:** the application moved from crashing to a stable 60 frames per second.

**The counter-intuitive part:** grouping made JavaScript work *harder*
(2.9ms → 6.0ms per frame) while the application ran *faster* (49 → 59 fps).

That result validates the core principle. If JavaScript computation were the
bottleneck, additional computation would cost frames. Instead, more computation
was traded for fewer native crossings, and performance improved.

**Grouping is disabled by default.** The requirement is to display a user's
friends. A bubble labelled "104" does not help someone meet a specific person at
a gate. Aggregation suits maps carrying thousands of items — a delivery fleet,
not a friend group.

> A principle worth stating explicitly: **performance work must not silently
> change product behaviour.** If a technique alters the answer the user receives,
> it is a product decision requiring product justification, not an optimisation.

---

## Colour carries meaning

Each friend has an individual colour, so a specific person can be found at a
glance.

This created a conflict: colour already indicated whether a position was current
or stale. Two meanings competing for one visual channel.

**Resolution:** colour indicates *identity*; fading indicates *recency*. A friend
whose signal goes stale keeps their colour and fades, rather than appearing to
become a different person.

An on-screen legend explains the scheme, because a colour code that cannot be
decoded is decoration rather than information.

---

## Layered structure

```
Application screens       ← understands "friends", "races", "venues"
──────────────────────────────────────────
Map engine                ← understands only "things that move"
```

**The rule:** the lower layer may never reference the concept of a "friend".

**Purpose:** the same engine can track delivery riders, buses or race
participants without modification.

**Verification:** a venue-zones feature was added — different geometry,
different update behaviour, different purpose — and required **zero changes** to
the engine.

**Enforcement:** a build script fails if domain vocabulary appears in the engine.
Architecture diagrams do not prevent this kind of leak; a failing build does.

---

## Measured results

Pixel 9, release build.

| Scenario | Result |
|---|---|
| 32 friends | 60 fps, 0.4ms of work per frame |
| Frame budget | 16.7ms available — roughly 3% consumed |
| Zoomed in | 200 tracked → 4 drawn |
| Zoomed out, grouped | 2,000 tracked → 60 bubbles, 60 fps |
| 2,000 tracked, ungrouped | Crash: native heap exhausted |
| Battery, active use | **2.5% per hour** (screen on); 1.8% of that is the app's own work |

---

## The complete native path

The strongest form of this architecture is a native map component: a Fabric view
that owns its own `MapView`, fed directly by a native entity store.

**What it does.** Entities are generated, validated, interpolated and drawn
entirely in native code. **No coordinate ever enters JavaScript.** JavaScript
supplies configuration and commands — style, camera, selection — and nothing
else. The component's contract carries no geometry at all, which is what makes
the guarantee structural rather than a matter of discipline.

**Why it is the strongest option:**

- **Motion is tied to the screen, not to the app.** Drawing is driven by the
  display's own frame callback rather than a JavaScript timer, so pins advance
  with the refresh rate.
- **A busy interface cannot stall the map.** Collection and rendering both live
  outside the JavaScript thread, so heavy work elsewhere in the app — a large
  list, a big parse — cannot interrupt tracking or drawing.
- **The per-frame cost of moving geometry disappears.** That is what raises the
  ceiling on how many people can be tracked at once, and it is the reason to
  reach for this design when scale demands it.
- **Trails, grouping and selection stay native too**, so the map never renders
  two views of the world that disagree.

**Status.** Specified in [LLD §13](./LLD.md) with the component contract, an
implementation plan with risk ratings, and acceptance criteria — ready to build.

It is a **scale decision, not a correctness one**. At the cardinality this
product targets — a few dozen friends — the current path renders at 60 fps using
roughly 3% of the frame budget. The component is held ready for the point where
entity counts make the bridge path the constraint.

## When native code is justified

Three findings, which do not all point the same direction:

1. **A native data source provides reliability, not speed.** With JavaScript
   deliberately blocked for three seconds, the native source continued producing
   data while the JavaScript source stopped entirely. Throughput is equivalent in
   normal operation; the difference is resilience under load.

2. **A native renderer raises the ceiling.** Keeping geometry out of JavaScript
   entirely is what allows entity counts beyond what the bridge path can carry,
   which is why it is specified and held ready.

3. **The inexpensive techniques delivered the largest gains.** Visibility culling
   and aggregation produced the biggest improvements, and both are ordinary
   TypeScript requiring no native code.

> **Threshold:** adopt a native renderer when the map library's data API is
> itself the bottleneck, or when frame-by-frame native drawing is required.
> Below that threshold, cheaper techniques are sufficient — as they were here.

---

## Running in the background

An events product is used with the phone in a pocket. Android suspends location
delivery for a backgrounded process, so without further work the map stops
updating exactly when it matters most.

**Foreground service.** Tracking is promoted to a typed location foreground
service when the app leaves the foreground, and demoted when it returns.

The persistent notification is not an inconvenience to minimise — it is the
contract. The platform grants continued location access in exchange for telling
the user, visibly and continuously, that it is happening. For a product handling
location, that trade is correct on privacy grounds independent of what the
platform requires.

**Notification permission is treated as a real outcome.** On Android 13+ the
service cannot show its notification without permission. If it is refused, the
call reports failure and the app surfaces a degraded state rather than appearing
to track and then silently stopping at the lock screen.

---

## Surviving being killed

The operating system reclaims memory by terminating applications. The condition
to design against is not the crash but the **restart** — an app that recovers yet
returns to a blank map has still lost the user's confidence.

**Last-known positions are persisted outside the JavaScript heap**, in platform
storage. The heap does not survive process termination, and termination is the
case this exists for.

On a cold start, positions are restored *before* the first live fix arrives.
Friends appear where they were last seen and age visibly through the normal
freshness rules, rather than the map opening empty.

**Memory pressure is handled by shedding, not clearing.** When the system signals
pressure, the order of sacrifice is deliberate:

1. trail history — positions still render without it
2. cached object pools — rebuilt on demand
3. long-dead entities — already invisible to the user

Live positions are never discarded. An application that clears the map to save
memory has already failed at its purpose.

## Battery

Measured on device with tracking active, screen on, and the map rendering
continuously.

| | |
|---|---|
| Whole app, screen on | **2.5% per hour** |
| The app's own computation | 1.8% per hour |
| The rest | screen illumination, which any foreground app pays |

The design target was under 4% per hour.

**Why it lands there.** The GPS is polled once per second, not per frame — the
single largest saving, because radio duty cycle dominates location power. The
distance filter is pushed down to the platform, so the operating system
suppresses updates below the threshold rather than waking the app to discard
them. Everything else is arithmetic: predicting positions between fixes costs
CPU, and CPU is far cheaper than radio.

**What would break it.** Polling the GPS at frame rate to smooth motion. It is
the obvious way to make pins glide, it is what prediction exists to avoid, and it
would multiply the sensor cost by sixty.

### Two separate costs

Battery divides into two independent halves, and a user may pay only one:

| Cost | When it applies |
|---|---|
| **Sending** — GPS plus uplink | Only while the user is sharing their own position |
| **Receiving** — network only | Whenever friends are being watched |

**A user who watches without sharing pays only the second half.** No GPS runs at
all. This is a real product state, not a theoretical one: when location
permission is refused, the app continues in viewer-only mode rather than failing,
and that mode costs a fraction of full participation because the most expensive
component is simply never started.

### One connection, not repeated requests

**Approach:** friends' positions arrive over a single long-lived connection, not
by asking a server repeatedly.

**Reason:** the expense is the radio, not the data. After any transmission a
mobile radio stays in a high-power state for several seconds before stepping back
down. Asking every few seconds keeps it pinned in that state permanently — the
radio never gets to sleep, regardless of how little data moved.

A persistent connection wakes the radio only when something actually arrives, and
its keep-alive can be spaced minutes apart.

**Otherwise:** a fresh handshake — name lookup, connection, encryption — for a
few hundred bytes each time, plus a radio held awake continuously. The cost is
far larger than the payload suggests, which is what makes repeated requests a
worse choice than they appear.

**Batching compounds the saving.** Outgoing positions are grouped every few
seconds rather than sent per reading. Incoming updates are combined by the server
and limited to the visible area. Fewer, larger messages mean fewer radio
wake-ups, and radio wake-ups are what the battery notices.

---

## Scope

Built and measured on Android. The map engine, the `Source` contract and the
native module specification are platform-neutral by construction — the iOS
provider is a registration shim against the same contract rather than a second
implementation.

A real transport replaces the synthetic source by implementing three methods.
Nothing downstream — store, rendering, culling, aggregation, trails — is aware
of the difference.

The consent model (who may see a user, for how long, and how sharing stops) is
specified in [HLD §9](./HLD.md) as design work rather than client rendering work.

---

## Summary

The design rests on one measured claim: **cost lives at the boundary between
JavaScript and native code, not inside JavaScript.** Every technique here follows
from it — batching crossings, predicting between GPS fixes, drawing one layer
instead of many, reusing objects, sending only what is visible, and grouping when
zoomed out.

The strongest evidence is the counter-intuitive one: grouping made JavaScript do
*more* work per frame and the application ran *faster*, because the saving was in
crossings rather than computation.

The same principle sets out where native code helps most. A complete native
renderer keeps geometry out of JavaScript entirely, and drives drawing from the
display's own frame callback — which is what lifts the ceiling on how many people
can be tracked at once. It is specified and held ready for that scale rather than
built for this one.
