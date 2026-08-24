/**
 * Tier 0 — the entity store. The single source of truth for "where is everything".
 *
 * DESIGN CONTRACT
 *
 * 1. Sources write here. The renderer reads here. They are never coupled, so a
 *    chatty or stalled source cannot affect frame rate.
 *
 * 2. Writes happen at source rate (~1Hz). Reads happen at frame rate (60-120Hz).
 *    The gap between them is bridged by interpolation, NOT by asking the source
 *    for more data — which is the entire battery argument in one sentence.
 *
 * 3. Feature objects are allocated once and mutated in place. Rebuilding a
 *    200-feature FeatureCollection every frame would allocate ~12k objects/sec
 *    and hand Hermes' GC a sawtooth that shows up as dropped frames. This is
 *    the single most important performance decision in the file.
 *
 * 4. No domain vocabulary. See src/geo/kernel/types.ts.
 */

import { TrackBuffer } from './TrackBuffer';
import { bearingDeg, distanceM, lerpBearing } from './geodesy';
import type { Attributes, BBox, EntityFix, Freshness, KernelConfig, Position } from './types';

/** Internal mutable record. Never leaves the store — `Entity` is the read model. */
interface Slot {
  id: string;
  /** Last accepted fix. */
  lng: number;
  lat: number;
  bearing: number;
  speed: number;
  accuracy: number;
  timestamp: number;
  /** Interpolation endpoints. `from` is the last DISPLAYED position, not the last fix. */
  fromLng: number;
  fromLat: number;
  fromBearing: number;
  departedMs: number;
  arrivalMs: number;
  freshness: Freshness;
  attributes: Attributes;
  /** Reused GeoJSON feature. Index into `featureList`. */
  featureIndex: number;
  /**
   * Consecutive fixes rejected by the speed gate.
   *
   * Guards against cold-start poisoning: an entity's FIRST fix is accepted
   * unconditionally (there is nothing to compare it against), so a bad first
   * fix anchors the entity in the wrong place and every subsequent real fix
   * then looks like a teleport. Without a way out, the entity stays stuck until
   * elapsed time drags the implied speed back under the threshold — and the
   * fix that finally lands draws a kilometres-long line across the trail.
   */
  rejectStreak: number;
  /**
   * True for a slot whose current position came from `restoreSnapshot`, not
   * a live fix. A restored position can be arbitrarily old — the process may
   * have been killed minutes before relaunch — so the elapsed time back to
   * it is huge, which makes the speed gate's distance/time check pass almost
   * anything as "plausible". The first live fix for a restored slot is
   * therefore trusted unconditionally and snapped to, exactly like
   * `reacquire`, rather than tweened: interpolating across however far the
   * entity moved during the gap, inside the capped interpolation window,
   * is what previously showed up as every pin flying across the map at once
   * on cold start.
   */
  restored: boolean;
}

/** GeoJSON shapes, typed loosely because we mutate them in place. */
interface MutableFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, string | number | boolean>;
}

/** Aggregated cell. Reused like point features to keep the frame path allocation-free. */
interface MutableClusterFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { cluster: true; count: number };
}

interface MutableLineFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'LineString'; coordinates: Position[] };
  properties: Record<string, string | number | boolean>;
}

export interface StoreStats {
  entities: number;
  visible: number;
  accepted: number;
  rejected: number;
  tracks: number;
  trackPoints: number;
}

export interface UpsertResult {
  accepted: number;
  rejected: number;
}

const EMPTY_ATTRS: Attributes = Object.freeze({});

export class EntityStore {
  private readonly slots = new Map<string, Slot>();
  private readonly tracks: TrackBuffer;

  /** Parallel arrays: featureList[i] belongs to the slot holding featureIndex === i. */
  private readonly featureList: MutableFeature[] = [];
  private readonly featureCollection = {
    type: 'FeatureCollection' as const,
    features: [] as MutableFeature[],
  };

  /** Cluster feature pool + the accumulator used to bucket entities per frame. */
  private readonly clusterFeatureList: MutableClusterFeature[] = [];
  private readonly clusterBuckets = new Map<
    number,
    { count: number; sumLng: number; sumLat: number; soleIndex: number }
  >();

  private readonly trackFeatureList: MutableLineFeature[] = [];
  private readonly trackCollection = {
    type: 'FeatureCollection' as const,
    features: [] as MutableLineFeature[],
  };

  /** Ids whose slot was released, so new entities reuse feature objects instead of growing the pool. */
  private readonly freeIndices: number[] = [];

  private selfId: string | null = null;
  /**
   * When false, no track history is retained at all.
   *
   * Rendering and RECORDING are separate concerns: hiding the trail layer while
   * still appending points and running RDP over every track burns the cost
   * without the benefit. Track work is O(entities x points) and dominated the
   * frame budget at 2000 entities, so this has to be a real off switch.
   */
  private tracksEnabled = true;
  private acceptedCount = 0;
  private rejectedCount = 0;
  private lastVisibleCount = 0;

  constructor(private readonly config: KernelConfig) {
    this.tracks = new TrackBuffer(
      config.trackWindowMs,
      config.trackMaxPoints,
      config.trackSimplifyTolerance,
    );
  }

  /** Marks one entity as the local user, which only affects its `freshness` styling. */
  setSelfId(id: string | null): void {
    this.selfId = id;
  }

  /**
   * Shed memory under pressure without losing the app's purpose.
   *
   * ORDER OF SACRIFICE MATTERS. Under pressure we give up, in order:
   *   1. track history      — nice to have; positions still render
   *   2. recycled pools     — pure cache, rebuilt on demand
   *   3. dead entities      — already invisible to the user
   * and NEVER live entity positions, because losing those is losing the
   * feature. An app that clears the map to save memory has already failed.
   *
   * This is deliberately not `clear()`: dropping everything and re-acquiring is
   * exactly the "tracking restarts" behaviour that makes an app feel broken
   * when the OS reclaims memory.
   */
  shedMemory(level: 'moderate' | 'critical' = 'moderate'): void {
    this.tracks.clear();
    this.trackCollection.features.length = 0;
    this.trackFeatureList.length = 0;

    // The feature pool is a cache; releasing spare slots costs one allocation
    // each when those entities next appear.
    this.freeIndices.length = 0;

    if (level === 'critical') {
      const now = Date.now();
      const doomed: Slot[] = [];
      for (const slot of this.slots.values()) {
        if (now - slot.timestamp > this.config.staleAfterMs) {
          doomed.push(slot);
        }
      }
      for (let i = 0; i < doomed.length; i++) {
        this.releaseSlot(doomed[i] as Slot);
      }
    }
  }

  /**
   * Last-known state, for persisting across process death.
   *
   * Positions only — no trails, no interpolation endpoints. On restore the
   * entities reappear where they were last seen and the freshness sweep ages
   * them normally, so the user sees a truthful "this is where everyone was"
   * rather than an empty map or a stale map pretending to be live.
   */
  snapshot(): EntityFix[] {
    const out: EntityFix[] = [];
    for (const slot of this.slots.values()) {
      out.push({
        id: slot.id,
        lng: slot.lng,
        lat: slot.lat,
        bearing: slot.bearing,
        speed: slot.speed,
        accuracy: slot.accuracy,
        timestamp: slot.timestamp,
        attributes: slot.attributes,
      });
    }
    return out;
  }

  /** Turning tracking off releases all retained history immediately. */
  setTracksEnabled(enabled: boolean): void {
    if (this.tracksEnabled === enabled) {
      return;
    }
    this.tracksEnabled = enabled;
    if (!enabled) {
      this.tracks.clear();
      this.trackCollection.features.length = 0;
    }
  }

  /**
   * Ingest a batch of observations.
   *
   * Validation order is cheapest-first: accuracy gate, then monotonicity, then
   * the haversine speed gate. The trig only runs on fixes that already passed
   * the two integer comparisons.
   */
  upsert(fixes: readonly EntityFix[], now: number = Date.now()): UpsertResult {
    let accepted = 0;
    let rejected = 0;

    for (let i = 0; i < fixes.length; i++) {
      const fix = fixes[i] as EntityFix;

      // Gate 1: accuracy. A 500m-accurate fix is noise, not a position.
      if (fix.accuracy !== undefined && fix.accuracy > this.config.accuracyGateM) {
        rejected++;
        continue;
      }

      const existing = this.slots.get(fix.id);

      if (existing) {
        if (existing.restored) {
          // First live confirmation of a slot painted from a snapshot. Snap
          // rather than tween — see the `restored` field on Slot for why.
          this.reacquire(existing, fix, now);
          existing.restored = false;
          accepted++;
          continue;
        }

        // Gate 2: monotonicity. Out-of-order delivery would otherwise make pins
        // jitter backwards in time.
        if (fix.timestamp <= existing.timestamp) {
          rejected++;
          continue;
        }

        // Gate 3: implausible jump. GPS in urban canyons teleports across
        // blocks; without this, trails grow spikes and speed goes to infinity.
        const metres = distanceM(existing.lng, existing.lat, fix.lng, fix.lat);
        const dtSec = (fix.timestamp - existing.timestamp) / 1000;
        if (dtSec > 0 && metres / dtSec > this.config.maxPlausibleSpeedMps) {
          existing.rejectStreak++;

          // Re-acquisition. If we reject this many in a row, the stored
          // position — not the incoming stream — is what is wrong. Trust the
          // new fix, teleport the entity there without interpolating, and drop
          // the track so no phantom line is drawn across the gap.
          if (existing.rejectStreak >= REACQUIRE_AFTER_REJECTS) {
            this.reacquire(existing, fix, now);
            rejected++;
            continue;
          }

          rejected++;
          continue;
        }

        existing.rejectStreak = 0;
        this.applyFix(existing, fix, now, metres, dtSec);
        accepted++;
      } else {
        this.createSlot(fix, now);
        accepted++;
      }
    }

    this.acceptedCount += accepted;
    this.rejectedCount += rejected;
    return { accepted, rejected };
  }

  /**
   * Tombstone. Explicit removal beats waiting for staleness, because "stopped
   * sharing" must clear the pin immediately rather than fading over two minutes.
   */
  remove(ids: readonly string[]): void {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as string;
      const slot = this.slots.get(id);
      if (!slot) {
        continue;
      }
      this.releaseSlot(slot);
    }
  }

  /**
   * Recompute freshness and evict the long-dead.
   *
   * Runs on a low-frequency timer (~1Hz), never per frame: freshness is a
   * property of wall-clock age, and re-deriving it 120 times a second would
   * burn CPU to produce the same answer.
   */
  sweep(now: number = Date.now()): void {
    const evictions: Slot[] = [];

    for (const slot of this.slots.values()) {
      const age = now - slot.timestamp;

      if (age > this.config.deadAfterMs) {
        evictions.push(slot);
        continue;
      }

      const next: Freshness =
        slot.id === this.selfId ? 'self' : age > this.config.staleAfterMs ? 'stale' : 'fresh';

      if (next !== slot.freshness) {
        slot.freshness = next;
        const feature = this.featureList[slot.featureIndex];
        if (feature) {
          feature.properties.freshness = next;
        }
      }
    }

    for (let i = 0; i < evictions.length; i++) {
      this.releaseSlot(evictions[i] as Slot);
    }
  }

  /**
   * Interpolated point features for the current frame.
   *
   * Returns the SAME object every call, mutated in place. Callers must treat it
   * as a live view and not retain it across frames.
   *
   * `viewport` culls off-screen entities from the collection. Culling here
   * rather than in the renderer means off-screen entities cost zero
   * serialisation, which is what makes the entity budget scale with what is
   * visible rather than what exists.
   */
  interpolatedFeatures(now: number, viewport?: BBox, cellDeg = 0) {
    const features = this.featureCollection.features;
    features.length = 0;

    const clustering = cellDeg > 0;
    if (clustering) {
      this.clusterBuckets.clear();
    }
    let clusterCursor = 0;

    for (const slot of this.slots.values()) {
      const feature = this.featureList[slot.featureIndex];
      if (!feature) {
        continue;
      }

      const { lng, lat, bearing } = this.positionAt(slot, now);

      if (viewport && !withinBBox(lng, lat, viewport)) {
        continue;
      }

      const coords = feature.geometry.coordinates;
      coords[0] = lng;
      coords[1] = lat;
      feature.properties.bearing = bearing;

      if (!clustering) {
        features.push(feature);
        continue;
      }

      // Bucket into a lat/lng grid. A numeric key beats a template string here:
      // this runs per entity per push, and string keys would allocate garbage
      // proportional to entity count on the hot path.
      const ix = Math.floor(lng / cellDeg);
      const iy = Math.floor(lat / cellDeg);
      const key = ix * GRID_KEY_STRIDE + iy;

      const bucket = this.clusterBuckets.get(key);
      if (bucket) {
        bucket.count++;
        bucket.sumLng += lng;
        bucket.sumLat += lat;
        bucket.soleIndex = -1;
      } else {
        this.clusterBuckets.set(key, {
          count: 1,
          sumLng: lng,
          sumLat: lat,
          soleIndex: slot.featureIndex,
        });
      }
    }

    if (clustering) {
      for (const bucket of this.clusterBuckets.values()) {
        // A lone entity renders as itself. Bubbles reading "1" are noise, and
        // the individual pin still carries its attributes for styling.
        if (bucket.count === 1 && bucket.soleIndex >= 0) {
          const solo = this.featureList[bucket.soleIndex];
          if (solo) {
            features.push(solo);
          }
          continue;
        }

        let cf = this.clusterFeatureList[clusterCursor];
        if (!cf) {
          cf = {
            type: 'Feature',
            id: `c-${clusterCursor}`,
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties: { cluster: true, count: 0 },
          };
          this.clusterFeatureList.push(cf);
        }
        cf.geometry.coordinates[0] = bucket.sumLng / bucket.count;
        cf.geometry.coordinates[1] = bucket.sumLat / bucket.count;
        cf.properties.count = bucket.count;

        features.push(cf as unknown as MutableFeature);
        clusterCursor++;
      }
    }

    this.lastVisibleCount = features.length;
    return this.featureCollection;
  }

  /**
   * Decimated track lines. Rebuilt on demand, not per frame — trails change at
   * source rate, so recomputing them at 120Hz would be pure waste.
   */
  trackFeatures() {
    const features = this.trackCollection.features;
    features.length = 0;

    // Short-circuit: no simplify pass, no iteration over slots.
    if (!this.tracksEnabled) {
      return this.trackCollection;
    }

    let cursor = 0;
    for (const slot of this.slots.values()) {
      const points = this.tracks.get(slot.id);
      if (points.length < 2) {
        continue;
      }

      let feature = this.trackFeatureList[cursor];
      if (!feature) {
        feature = {
          type: 'Feature',
          id: slot.id,
          geometry: { type: 'LineString', coordinates: [] },
          properties: {},
        };
        this.trackFeatureList.push(feature);
      }

      feature.id = slot.id;
      feature.geometry.coordinates = points as Position[];
      feature.properties.freshness = slot.freshness;

      features.push(feature);
      cursor++;
    }

    return this.trackCollection;
  }

  stats(): StoreStats {
    const trackStats = this.tracks.stats();
    return {
      entities: this.slots.size,
      visible: this.lastVisibleCount,
      accepted: this.acceptedCount,
      rejected: this.rejectedCount,
      tracks: trackStats.trackCount,
      trackPoints: trackStats.rawPoints,
    };
  }

  clear(): void {
    this.slots.clear();
    this.tracks.clear();
    this.freeIndices.length = 0;
    this.featureList.length = 0;
    this.featureCollection.features.length = 0;
    this.acceptedCount = 0;
    this.rejectedCount = 0;
  }

  /**
   * Dead-reckoned position for a slot at time `now`.
   *
   * `t` runs past 1 to keep pins moving between fixes, but is capped at
   * `maxExtrapolationFactor` — beyond that we are guessing, and a confidently
   * wrong pin sailing into the sea is worse than one that pauses.
   */
  private positionAt(slot: Slot, now: number): { lng: number; lat: number; bearing: number } {
    const span = slot.arrivalMs - slot.departedMs;
    if (span <= 0) {
      return { lng: slot.lng, lat: slot.lat, bearing: slot.bearing };
    }

    let t = (now - slot.departedMs) / span;
    if (t < 0) {
      t = 0;
    } else if (t > MAX_EXTRAPOLATION_FACTOR) {
      t = MAX_EXTRAPOLATION_FACTOR;
    }

    return {
      lng: slot.fromLng + (slot.lng - slot.fromLng) * t,
      lat: slot.fromLat + (slot.lat - slot.fromLat) * t,
      bearing: lerpBearing(slot.fromBearing, slot.bearing, t < 1 ? t : 1),
    };
  }

  private createSlot(fix: EntityFix, now: number, restored = false): void {
    const featureIndex = this.acquireFeatureIndex(fix.id);

    const slot: Slot = {
      id: fix.id,
      lng: fix.lng,
      lat: fix.lat,
      bearing: fix.bearing ?? 0,
      speed: fix.speed ?? 0,
      accuracy: fix.accuracy ?? 0,
      timestamp: fix.timestamp,
      // A brand-new entity has nowhere to come from, so it appears in place
      // rather than sliding in from a meaningless origin.
      fromLng: fix.lng,
      fromLat: fix.lat,
      fromBearing: fix.bearing ?? 0,
      departedMs: now,
      arrivalMs: now,
      freshness: fix.id === this.selfId ? 'self' : 'fresh',
      attributes: fix.attributes ?? EMPTY_ATTRS,
      featureIndex,
      rejectStreak: 0,
      restored,
    };

    this.slots.set(fix.id, slot);
    this.writeFeature(slot);
    if (this.tracksEnabled) {
      this.tracks.append(fix.id, [fix.lng, fix.lat], fix.timestamp);
    }
  }

  /**
   * Cold-start recovery: paints last-known positions immediately so the map
   * is not empty while the live source spins up, and flags each slot
   * `restored` so its first live fix snaps onto it instead of tweening —
   * see `Slot.restored` for why that distinction matters. Deliberately not
   * just `upsert`: a restore is not an observation, and must not be treated
   * like one everywhere `upsert` is.
   */
  restoreSnapshot(fixes: readonly EntityFix[], now: number = Date.now()): void {
    for (let i = 0; i < fixes.length; i++) {
      const fix = fixes[i] as EntityFix;
      if (!this.slots.has(fix.id)) {
        this.createSlot(fix, now, true);
      }
    }
  }

  /**
   * Snap an entity to a new position, abandoning its history.
   *
   * Used when the stored position is judged wrong rather than the incoming fix.
   * Deliberately does NOT interpolate: sliding a pin across the gap would draw
   * a smooth line through territory the entity never occupied, which is a more
   * convincing lie than an honest jump.
   */
  private reacquire(slot: Slot, fix: EntityFix, now: number): void {
    slot.lng = fix.lng;
    slot.lat = fix.lat;
    slot.fromLng = fix.lng;
    slot.fromLat = fix.lat;
    slot.bearing = fix.bearing ?? slot.bearing;
    slot.fromBearing = slot.bearing;
    slot.speed = fix.speed ?? 0;
    slot.accuracy = fix.accuracy ?? slot.accuracy;
    slot.timestamp = fix.timestamp;
    slot.departedMs = now;
    slot.arrivalMs = now;
    slot.rejectStreak = 0;

    if (this.tracksEnabled) {
      this.tracks.drop(slot.id);
      this.tracks.append(slot.id, [fix.lng, fix.lat], fix.timestamp);
    }
    this.writeFeature(slot);
  }

  private applyFix(slot: Slot, fix: EntityFix, now: number, metres: number, dtSec: number): void {
    // CRITICAL: interpolate FROM where the pin is currently drawn, not from the
    // previous fix. Updates never arrive on a perfect cadence, so anchoring to
    // the last fix makes pins visibly snap backwards whenever a fix is late.
    const current = this.positionAt(slot, now);
    slot.fromLng = current.lng;
    slot.fromLat = current.lat;
    slot.fromBearing = current.bearing;

    slot.lng = fix.lng;
    slot.lat = fix.lat;
    slot.accuracy = fix.accuracy ?? slot.accuracy;
    slot.timestamp = fix.timestamp;

    // Derive heading and speed when the source does not supply them, so every
    // source gets arrows and dead reckoning regardless of its sophistication.
    slot.bearing = fix.bearing ?? (metres > 0.5 ? bearingDeg(current.lng, current.lat, fix.lng, fix.lat) : slot.bearing);
    slot.speed = fix.speed ?? (dtSec > 0 ? metres / dtSec : slot.speed);

    if (fix.attributes) {
      slot.attributes = fix.attributes;
    }

    // Tween across the interval we actually observed, so a source that slows
    // down produces slower pins rather than stuttering ones.
    const observedMs = dtSec > 0 ? dtSec * 1000 : DEFAULT_INTERPOLATION_MS;
    slot.departedMs = now;
    slot.arrivalMs = now + Math.min(observedMs, MAX_INTERPOLATION_MS);

    slot.freshness = slot.id === this.selfId ? 'self' : 'fresh';
    this.writeFeature(slot);
    if (this.tracksEnabled) {
      this.tracks.append(fix.id, [fix.lng, fix.lat], fix.timestamp);
    }
  }

  /** Copies slot state into its reused feature. Called on write, not per frame. */
  private writeFeature(slot: Slot): void {
    const feature = this.featureList[slot.featureIndex];
    if (!feature) {
      return;
    }
    feature.id = slot.id;
    feature.properties.freshness = slot.freshness;
    feature.properties.bearing = slot.bearing;
    feature.properties.speed = slot.speed;

    // Domain attributes are copied onto the feature so style expressions can
    // read them. The framework never inspects the keys.
    const attrs = slot.attributes;
    for (const key in attrs) {
      const value = attrs[key];
      if (value !== undefined) {
        feature.properties[key] = value;
      }
    }
  }

  private acquireFeatureIndex(id: string): number {
    const recycled = this.freeIndices.pop();
    if (recycled !== undefined) {
      const feature = this.featureList[recycled];
      if (feature) {
        feature.id = id;
        // Reset properties so a recycled feature cannot inherit stale domain
        // attributes from whichever entity used to occupy this slot.
        feature.properties = {};
      }
      return recycled;
    }

    this.featureList.push({
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: {},
    });
    return this.featureList.length - 1;
  }

  private releaseSlot(slot: Slot): void {
    this.slots.delete(slot.id);
    this.tracks.drop(slot.id);
    this.freeIndices.push(slot.featureIndex);
  }
}

function withinBBox(lng: number, lat: number, b: BBox): boolean {
  return lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north;
}

/** Mirrors design/tokens/primitives motion.maxExtrapolationFactor; duplicated to keep Tier 0 dependency-free. */
const MAX_EXTRAPOLATION_FACTOR = 2;
const DEFAULT_INTERPOLATION_MS = 1000;
/**
 * Consecutive speed-gate rejections before we conclude the stored position is
 * the wrong one and re-acquire. Low enough that a poisoned entity recovers in
 * seconds; high enough that a genuine one-off GPS spike is still filtered.
 */
const REACQUIRE_AFTER_REJECTS = 3;
/**
 * Stride for packing a 2D grid cell into one number key.
 *
 * Large enough that no realistic latitude index collides with a longitude
 * index, while keeping the key a Smi rather than a heap-allocated string.
 */
const GRID_KEY_STRIDE = 1e6;
/** Cap the tween so a source that pauses for 30s does not produce a 30s crawl. */
const MAX_INTERPOLATION_MS = 3000;
