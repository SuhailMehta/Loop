/**
 * Tier 0 — kernel types. The frozen vocabulary of the framework.
 *
 * ARCHITECTURAL RULE: nothing in this file, or anywhere under src/geo, may
 * reference a domain concept. There are no friends, events, venues, drivers or
 * trails here — only entities, tracks, sources and layers. Domain meaning is
 * carried in the opaque `attributes` bag and resolved by style expressions at
 * render time. A CI vocabulary check enforces this; see scripts/check-tiers.
 *
 * This is what makes "live location sharing" and "delivery fleet" and "venue
 * zones" the same problem to the kernel.
 */

/**
 * [longitude, latitude] — GeoJSON order, NOT the [lat, lng] order used by most
 * location APIs. Every platform bug in this area traces back to this line, so
 * the kernel commits to GeoJSON order internally and converts at the edges.
 */
export type Position = readonly [lng: number, lat: number];

export type Geometry =
  | { readonly type: 'Point'; readonly coordinates: Position }
  | { readonly type: 'LineString'; readonly coordinates: readonly Position[] }
  | { readonly type: 'Polygon'; readonly coordinates: readonly (readonly Position[])[] };

/**
 * Domain payload. Deliberately flat and primitive-valued: these become GeoJSON
 * feature properties, and MapLibre style expressions can only read flat
 * primitives. The constraint is the renderer's, and it usefully prevents
 * consumers smuggling behaviour in here.
 */
export type Attributes = Readonly<Record<string, string | number | boolean>>;

/**
 * How often a source's data changes. This — not geometry type — is what drives
 * storage and GPU upload strategy.
 *
 * A wildfire perimeter is a kinetic polygon; a parked scooter is a static
 * point. Keying off geometry would get both wrong.
 */
export type Volatility =
  /** Interpolated every frame, partial updates, coalesced ingest. */
  | 'kinetic'
  /** Changes occasionally; diffed and re-uploaded on change. */
  | 'mutable'
  /** Uploaded once, never mutated. Pre-tiled if large. */
  | 'static';

/**
 * Recency state, stamped by the store's sweep and read by style expressions.
 * Rendering it is a data concern, not a code concern — see the design adapter.
 */
export type Freshness = 'self' | 'fresh' | 'stale' | 'dead';

/**
 * A raw observation from a Source. This is the ONLY thing a source produces;
 * everything else (freshness, interpolation, tracks) is derived by the kernel,
 * so every source inherits those behaviours for free.
 */
export interface EntityFix {
  readonly id: string;
  readonly lng: number;
  readonly lat: number;
  /** Degrees clockwise from north. Derived from consecutive fixes when absent. */
  readonly bearing?: number;
  /** Metres per second. Used for dead reckoning and implausible-jump rejection. */
  readonly speed?: number;
  /** Horizontal accuracy in metres. Fixes worse than the gate are dropped. */
  readonly accuracy?: number;
  /** Epoch millis. Non-monotonic fixes per entity are rejected as out-of-order. */
  readonly timestamp: number;
  readonly attributes?: Attributes;
}

/** An entity as the store holds it: last known truth plus derived state. */
export interface Entity {
  readonly id: string;
  readonly lng: number;
  readonly lat: number;
  readonly bearing: number;
  readonly speed: number;
  readonly accuracy: number;
  readonly timestamp: number;
  readonly freshness: Freshness;
  readonly attributes: Attributes;
}

/**
 * Interpolation endpoints for one entity.
 *
 * The store keeps previous and target so the render loop can tween between
 * them without allocating. `arrivalMs` is when the target should be reached;
 * past it, the interpolator extrapolates — but only up to
 * `motion.maxExtrapolationFactor`, after which the pin holds position rather
 * than confidently walking into the sea.
 */
export interface Kinematics {
  readonly fromLng: number;
  readonly fromLat: number;
  readonly toLng: number;
  readonly toLat: number;
  readonly departedMs: number;
  readonly arrivalMs: number;
}

/** A time-ordered position history. Rendered as a trail, but the kernel does not call it that. */
export interface Track {
  readonly id: string;
  readonly points: readonly Position[];
}

/** Axis-aligned bounds in GeoJSON order. Used for viewport culling and camera intents. */
export interface BBox {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/** Tunables the kernel reads. Surfaced in one place so the LLD can quote them as budgets. */
export interface KernelConfig {
  /** Older than this -> 'stale'. */
  readonly staleAfterMs: number;
  /** Older than this -> 'dead', then evicted. */
  readonly deadAfterMs: number;
  /** Reject fixes with accuracy worse than this many metres. */
  readonly accuracyGateM: number;
  /** Reject fixes implying a speed above this (m/s) as GPS teleports. */
  readonly maxPlausibleSpeedMps: number;
  /** Track retention window. */
  readonly trackWindowMs: number;
  /** Hard cap on retained points per track, post-decimation. */
  readonly trackMaxPoints: number;
  /** Ramer-Douglas-Peucker tolerance in degrees. */
  readonly trackSimplifyTolerance: number;
}

export const DEFAULT_KERNEL_CONFIG: KernelConfig = {
  staleAfterMs: 15_000,
  deadAfterMs: 120_000,
  accuracyGateM: 100,
  // ~250 km/h. Above this on a consumer device it is a fix error, not a car.
  maxPlausibleSpeedMps: 70,
  trackWindowMs: 5 * 60_000,
  trackMaxPoints: 60,
  // ~1.1m at the equator. Below the visual resolution of a trail at city zoom.
  trackSimplifyTolerance: 0.00001,
};
