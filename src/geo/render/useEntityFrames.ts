/**
 * Tier 1 — the render loop.
 *
 * Bridges two clocks that must not be coupled:
 *   source clock   ~1Hz   when new observations arrive
 *   display clock  60-120Hz  when the screen refreshes
 *
 * Interpolation fills the gap. The source is never asked for more data to make
 * motion smoother — that would be the battery-destroying mistake this whole
 * design exists to avoid.
 *
 * HONEST ACCOUNTING OF WHAT IS FAST HERE
 *
 * Interpolation itself is trivial: ~200 lerps per frame, microseconds. The real
 * cost is handing the resulting FeatureCollection to the native map, which
 * serialises the geometry across the JS/native boundary. That cost scales with
 * entity count and update rate, and it is the actual ceiling.
 *
 * So we decouple GEOMETRY UPDATE RATE from display rate. Pins look continuous
 * at ~30Hz because they move slowly in screen space; the UI thread stays free
 * at full refresh. The HUD reports both numbers separately rather than
 * conflating them into one flattering "fps".
 *
 * Removing the ceiling entirely means never crossing the boundary at all —
 * a native source writing straight into a native map view. That is the
 * TurboModule path, and this is precisely the measurement that justifies it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntityStore } from '../kernel/EntityStore';
import type { BBox } from '../kernel/types';

export interface FrameStats {
  /** Frames the JS thread completed in the last second. */
  jsFps: number;
  /** Geometry pushes to the map in the last second. */
  geometryHz: number;
  /** Milliseconds spent building geometry, averaged over the last second. */
  buildMs: number;
}

export interface EntityFrameOptions {
  /**
   * Geometry pushes per second. 30 is the default because it is
   * indistinguishable from 60 for map pins while halving boundary cost.
   * Exposed so the demo can show the tradeoff rather than assert it.
   */
  updateHz?: number;
  /**
   * Live viewport for culling, passed as a REF rather than a value.
   *
   * The camera changes on every frame of a pan. Holding it in React state would
   * re-render the tree and restart this loop dozens of times per gesture; a ref
   * lets the loop read the latest bounds with zero renders and zero identity
   * churn in the callback dependency list.
   */
  viewportRef?: { readonly current: { bounds: BBox; zoom: number } | null };
  /** Cull to the viewport. Independent of clustering — both read the same ref. */
  cullEnabled?: boolean;
  /**
   * Cluster cell size in screen pixels, or 0 to disable. DEFAULT IS DISABLED.
   *
   * Aggregation is a scaling technique for use cases whose cardinality is
   * genuinely large — a city of couriers, a fleet, a heatmap. It is the WRONG
   * default for "show me where my friends are": a user cannot meet someone at
   * the gate if the map has replaced them with a bubble labelled 104.
   *
   * A use case opts in when its own requirements call for it. Performance work
   * must not quietly redefine the product.
   *
   * When enabled it aggregates BEFORE serialisation, which is the whole point —
   * MapLibre's own `cluster: true` aggregates after the data has crossed the
   * boundary, cutting draw cost but not the allocation that exhausts the heap.
   */
  clusterRadiusPx?: number;
  /** Above this zoom every entity is drawn individually. */
  clusterMaxZoom?: number;
  /** Rebuild trail geometry every N geometry pushes. Trails change at source rate. */
  trackEveryNFrames?: number;
  paused?: boolean;
}

/** Stable wrapper identity forces the source component to accept new geometry. */
interface Collection {
  type: 'FeatureCollection';
  features: unknown[];
}

export function useEntityFrames(store: EntityStore, options: EntityFrameOptions = {}) {
  const {
    updateHz = 30,
    viewportRef,
    trackEveryNFrames = 15,
    paused = false,
    cullEnabled = true,
    clusterRadiusPx = 0,
    clusterMaxZoom = 16,
  } = options;

  const [points, setPoints] = useState<Collection>(EMPTY_COLLECTION);
  const [tracks, setTracks] = useState<Collection>(EMPTY_COLLECTION);
  const [stats, setStats] = useState<FrameStats>({ jsFps: 0, geometryHz: 0, buildMs: 0 });

  const rafRef = useRef<number | null>(null);
  const lastPushRef = useRef(0);
  const frameCountRef = useRef(0);
  const pushCountRef = useRef(0);
  const buildAccumRef = useRef(0);
  const windowStartRef = useRef(0);
  const trackCounterRef = useRef(0);

  const tick = useCallback(() => {
    const now = Date.now();
    frameCountRef.current++;

    if (windowStartRef.current === 0) {
      windowStartRef.current = now;
      lastPushRef.current = now;
    }

    // Half-frame tolerance. Without it, a 30Hz target (33.33ms) sits a hair
    // above the two-frame gap at 60Hz (33.34ms), so ordinary timer jitter
    // intermittently spills a push into a third frame — measured output lands
    // near 24Hz instead of 30. Subtracting half a frame makes the two-frame
    // gap qualify reliably without ever letting a push happen early.
    const pushInterval = 1000 / updateHz - HALF_FRAME_MS;
    if (now - lastPushRef.current >= pushInterval) {
      lastPushRef.current = now;

      const buildStart = Date.now();

      // Mutated in place by the store; we only allocate the wrapper so React
      // sees a new identity. One small object per push, not one per entity.
      const vp = viewportRef?.current ?? null;

      // Web Mercator: 360 degrees spans 512 * 2^zoom pixels at the equator.
      // Converting a pixel radius into degrees keeps cluster cells a constant
      // size on screen rather than a constant size on the ground.
      const cellDeg =
        clusterRadiusPx > 0 && vp && vp.zoom < clusterMaxZoom
          ? (clusterRadiusPx * 360) / (512 * Math.pow(2, vp.zoom))
          : 0;

      // Culling and clustering are separate concerns that happen to share the
      // viewport ref. Coupling them meant turning culling off silently disabled
      // clustering too — a bug that only shows up as "why is nothing grouping".
      const fc = store.interpolatedFeatures(now, cullEnabled ? vp?.bounds : undefined, cellDeg);
      setPoints({ type: 'FeatureCollection', features: fc.features });

      trackCounterRef.current++;
      if (trackCounterRef.current >= trackEveryNFrames) {
        trackCounterRef.current = 0;
        const tc = store.trackFeatures();
        setTracks({ type: 'FeatureCollection', features: tc.features });
      }

      buildAccumRef.current += Date.now() - buildStart;
      pushCountRef.current++;
    }

    // Roll the measurement window once per second.
    const elapsed = now - windowStartRef.current;
    if (elapsed >= 1000) {
      const pushes = pushCountRef.current;
      setStats({
        jsFps: Math.round((frameCountRef.current * 1000) / elapsed),
        geometryHz: Math.round((pushes * 1000) / elapsed),
        buildMs: pushes > 0 ? Number((buildAccumRef.current / pushes).toFixed(2)) : 0,
      });
      frameCountRef.current = 0;
      pushCountRef.current = 0;
      buildAccumRef.current = 0;
      windowStartRef.current = now;
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [
    store,
    updateHz,
    viewportRef,
    trackEveryNFrames,
    cullEnabled,
    clusterRadiusPx,
    clusterMaxZoom,
  ]);

  useEffect(() => {
    if (paused) {
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Reset the window so resuming does not report a bogus first sample.
      windowStartRef.current = 0;
    };
  }, [tick, paused]);

  return { points, tracks, stats };
}

const EMPTY_COLLECTION: Collection = { type: 'FeatureCollection', features: [] };

/** Half a frame at 60Hz. Scheduling tolerance, not a magic fudge factor. */
const HALF_FRAME_MS = 8;
