/**
 * Tier 1 — adapter wrapping the native TurboModule as a `Source`.
 *
 * THIS FILE IS THE SEAM.
 *
 * Everything above it — EntityStore, TrackBuffer, the interpolator, the render
 * loop, every layer, every kit — is identical whether fixes come from here or
 * from MockSource. The two implementations share no code and run on different
 * threads in different languages, and the consumer cannot tell them apart
 * because both satisfy `Source`.
 *
 * That is what "swap the provider with no JS change at the call site" means in
 * practice, and `git diff src/geo/kernel src/kits` across the swap is empty.
 */

import { getNativeLoopSource } from '../../specs/NativeLoopSource';
import type { EntityFix } from '../kernel/types';
import type { Source, SourceCapabilities, SourceConfig, SourceSink } from '../ports/Source';

export const NATIVE_SOURCE_ID = 'native-turbo';

/** True when the native provider is linked into this build. */
export function isNativeSourceAvailable(): boolean {
  return getNativeLoopSource() != null;
}

export interface NativeSourceOptions {
  /** Cohorts with routes/labels/attributes — the SAME data the JS source gets. */
  groups?: readonly {
    count: number;
    persona: number;
    labels?: readonly string[];
    attributes?: Readonly<Record<string, string | number | boolean>>;
    routes: readonly (readonly (readonly [number, number])[])[];
  }[];
  /** Free-wander population for throughput testing. */
  wanderCount: number;
  intervalMs: number;
  centerLng: number;
  centerLat: number;
  radiusM: number;
}

export const DEFAULT_NATIVE_OPTIONS: NativeSourceOptions = {
  wanderCount: 0,
  intervalMs: 1000,
  centerLng: 77.5946,
  centerLat: 12.9716,
  radiusM: 2500,
};

/**
 * Continue tracking while the app is not in the foreground.
 *
 * Returns false when the platform refused — notification permission missing on
 * Android 13+ — so the caller can show a degraded state instead of the app
 * appearing to track and silently stopping at the lock screen.
 */
export function startBackgroundTracking(title: string, body: string): boolean {
  try {
    return getNativeLoopSource()?.startBackgroundTracking(title, body) ?? false;
  } catch {
    return false;
  }
}

export function stopBackgroundTracking(): void {
  try {
    getNativeLoopSource()?.stopBackgroundTracking();
  } catch {
    // Already stopped, or the module is gone.
  }
}

/** Persist last-known positions outside the JS heap. */
export function saveSnapshot(fixes: readonly EntityFix[]): void {
  try {
    getNativeLoopSource()?.saveSnapshot(JSON.stringify(fixes));
  } catch {
    // Persistence is best-effort; failing to save must never break tracking.
  }
}

export function loadSnapshot(): EntityFix[] {
  try {
    const raw = getNativeLoopSource()?.loadSnapshot() ?? '';
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as EntityFix[]) : [];
  } catch {
    // A corrupt snapshot must not prevent startup; an empty map is recoverable,
    // a crash loop is not.
    return [];
  }
}

/** What `EntityStore.shedMemory` accepts — kept in sync with the kernel's own type. */
export type MemoryPressureLevel = 'moderate' | 'critical';

/**
 * Subscribe to the platform's own memory-pressure signal.
 *
 * This is the real fix for backgrounding being used as a memory-pressure proxy:
 * `Application.onTrimMemory` fires while the app is still fully in the
 * foreground, under genuine pressure — the case a background/foreground
 * transition cannot detect at all, since nothing about foreground state
 * changed.
 *
 * Returns a no-op unsubscribe when the native module is absent (iOS, or a
 * build without the provider linked), so callers do not need to branch on
 * platform availability.
 */
export function subscribeToMemoryPressure(
  onPressure: (level: MemoryPressureLevel) => void,
): () => void {
  const native = getNativeLoopSource();
  if (!native) {
    return () => {};
  }

  const subscription = native.onMemoryPressure(event => {
    // Native emits a plain string; narrowed here rather than trusted, since the
    // event crosses a JSON-shaped boundary and a future native change should
    // fail closed, not forward an unrecognised level to the kernel.
    if (event.level === 'moderate' || event.level === 'critical') {
      onPressure(event.level);
    }
  });

  return () => subscription.remove();
}

export function createNativeTurboSource(options: Partial<NativeSourceOptions> = {}): Source {
  const opts: NativeSourceOptions = { ...DEFAULT_NATIVE_OPTIONS, ...options };
  let subscription: { remove(): void } | null = null;

  return {
    id: NATIVE_SOURCE_ID,
    volatility: 'kinetic',

    capabilities(): SourceCapabilities {
      const native = getNativeLoopSource();
      if (!native) {
        return {
          sourceId: NATIVE_SOURCE_ID,
          backgroundTracking: false,
          activityRecognition: false,
          deferredUpdates: false,
          maxEntities: 0,
          producesTracks: false,
        };
      }

      // Synchronous JSI read — no serialisation, no promise, no bridge hop.
      const caps = native.getCapabilities();
      return {
        sourceId: caps.sourceId,
        backgroundTracking: caps.backgroundTracking,
        activityRecognition: caps.activityRecognition,
        deferredUpdates: caps.deferredUpdates,
        maxEntities: caps.maxEntities,
        producesTracks: caps.producesTracks,
      };
    },

    start(_config: SourceConfig, sink: SourceSink): void {
      const native = getNativeLoopSource();
      if (!native) {
        sink.error({
          code: 'unsupported',
          message:
            'NativeLoopSource is not linked into this build. Add LoopSourcePackage, or fall back to the JS source.',
          recoverable: false,
        });
        return;
      }

      // Subscribe BEFORE start(): the native side emits an immediate first
      // batch, and subscribing after would drop it and leave the map empty for
      // a full interval.
      subscription = native.onFixes(batch => {
        // The batch arrives already shaped as EntityFix — the spec's field
        // names were chosen to match the kernel's so no per-fix mapping runs
        // on the JS thread at 200 items a tick.
        // Rebuild the attribute bag the kernel expects. The fields arrived
        // typed and flat; assembling them here keeps `EntityFix` uniform across
        // every provider so nothing downstream can tell them apart.
        const fixes: EntityFix[] = batch.fixes.map(f => ({
          id: f.id,
          lng: f.lng,
          lat: f.lat,
          bearing: f.bearing,
          speed: f.speed,
          accuracy: f.accuracy,
          timestamp: f.timestamp,
          attributes: {
            label: f.label,
            variant: f.variant,
            persona: f.persona,
            participation: f.participation,
          },
        }));
        sink.emit(fixes);

        // Backpressure credit, returned. Native withholds its next emission
        // until this call lands, so at most one batch is ever in flight —
        // without it, a source ticking faster than JS can drain would queue an
        // unbounded run of batches during any stall, each one immediately
        // superseded by the next and processed only to be discarded.
        native.ackFixes();
      });

      // Crosses the boundary ONCE, at startup. Handing the native side the same
      // scenario is what makes the provider swap a controlled comparison rather
      // than a change of subject: same routes, same names, same participation.
      const scenario = JSON.stringify({
        center: [opts.centerLng, opts.centerLat],
        radiusM: opts.radiusM,
        wanderCount: opts.wanderCount,
        groups: (opts.groups ?? []).map(g => ({
          count: g.count,
          persona: g.persona,
          labels: g.labels ?? [],
          attributes: g.attributes ?? {},
          routes: g.routes,
        })),
      });

      native.start(scenario, opts.intervalMs);
    },

    stop(): void {
      getNativeLoopSource()?.stop();
      subscription?.remove();
      subscription = null;
    },
  };
}
