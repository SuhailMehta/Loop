/**
 * Tier 0 — bounded position history per entity.
 *
 * "Trail of recent movement" from the brief, generalised. The kernel calls it a
 * Track; rendering it as a fading line is a use-case decision made in a style
 * expression, not here.
 *
 * TWO BOUNDS, both required:
 *   - time window: drop points older than `windowMs`
 *   - point cap:   never retain more than `maxPoints` after decimation
 *
 * The time window alone is not enough. A device emitting at 10Hz because a user
 * is driving would blow past the point budget inside the window, so the cap is
 * the backstop that makes memory a function of entity count only — never of
 * update rate. That property is what lets us state a memory budget in the LLD.
 */

import { simplify } from './simplify';
import type { Position } from './types';

interface TrackEntry {
  /** Raw appended points, pre-decimation. Bounded by prune(). */
  points: Position[];
  timestamps: number[];
  /** Decimated output, rebuilt lazily. */
  cache: Position[] | null;
}

export class TrackBuffer {
  private readonly tracks = new Map<string, TrackEntry>();

  constructor(
    private readonly windowMs: number,
    private readonly maxPoints: number,
    private readonly tolerance: number,
  ) {}

  /**
   * Append one observation.
   *
   * Deliberately does not decimate here: RDP is O(n log n) and appending is the
   * hot path. We invalidate the cache and let the reader pay, so a track that
   * is never rendered is never simplified.
   */
  append(id: string, position: Position, timestamp: number): void {
    let entry = this.tracks.get(id);
    if (!entry) {
      entry = { points: [], timestamps: [], cache: null };
      this.tracks.set(id, entry);
    }

    entry.points.push(position);
    entry.timestamps.push(timestamp);
    entry.cache = null;

    this.prune(entry, timestamp);
  }

  /**
   * Decimated track, computed on demand and memoised until the next append.
   *
   * Returns an empty array rather than null for unknown ids so callers can map
   * over it without a branch.
   */
  get(id: string): readonly Position[] {
    const entry = this.tracks.get(id);
    if (!entry) {
      return EMPTY;
    }
    if (entry.cache === null) {
      const decimated = simplify(entry.points, this.tolerance);
      // Decimation usually satisfies the cap on its own. When it does not (a
      // genuinely wiggly path), keep the most recent points — recency is what
      // the trail is communicating.
      entry.cache =
        decimated.length > this.maxPoints ? decimated.slice(decimated.length - this.maxPoints) : decimated;
    }
    return entry.cache;
  }

  /** Called on tombstone/eviction. Leaking tracks for departed entities is the obvious slow leak here. */
  drop(id: string): void {
    this.tracks.delete(id);
  }

  clear(): void {
    this.tracks.clear();
  }

  /** Diagnostics for the perf HUD: total retained points across all tracks. */
  stats(): { trackCount: number; rawPoints: number } {
    let rawPoints = 0;
    for (const entry of this.tracks.values()) {
      rawPoints += entry.points.length;
    }
    return { trackCount: this.tracks.size, rawPoints };
  }

  /**
   * Drop points outside the time window, then hard-cap the raw buffer.
   *
   * The raw cap is generous (4x the output cap) because RDP needs enough input
   * to find the shape; capping raw too aggressively produces visibly angular
   * trails.
   */
  private prune(entry: TrackEntry, now: number): void {
    const cutoff = now - this.windowMs;

    let drop = 0;
    while (drop < entry.timestamps.length && (entry.timestamps[drop] as number) < cutoff) {
      drop++;
    }
    if (drop > 0) {
      entry.points.splice(0, drop);
      entry.timestamps.splice(0, drop);
    }

    const rawCap = this.maxPoints * 4;
    if (entry.points.length > rawCap) {
      const excess = entry.points.length - rawCap;
      entry.points.splice(0, excess);
      entry.timestamps.splice(0, excess);
    }
  }
}

const EMPTY: readonly Position[] = Object.freeze([]);
