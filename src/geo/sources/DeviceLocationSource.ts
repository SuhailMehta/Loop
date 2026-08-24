/**
 * Tier 1 — the device's own position, as a Source.
 *
 * WHY THIS IS A SOURCE AND NOT A SPECIAL CASE
 *
 * The HLD claims that "my own location" is just another entity producer. This
 * file is the test of that claim, and it passes: the device's GPS emits a
 * single `EntityFix` through the same `SourceSink` a websocket would use, and
 * every downstream behaviour — interpolation, freshness, trails, culling,
 * validation gates — is inherited without a line of special-casing.
 *
 * If own-position had needed its own path through the kernel, the abstraction
 * would have been wrong. It didn't.
 *
 * COMPOSITION NOTE
 *
 * This runs ALONGSIDE the entity source rather than instead of it: an app shows
 * you *and* your friends. The registry resolves which implementation fills a
 * role; it was never meant to cap the app at one active source. Both write into
 * the same store, and the store keys by entity id, so they compose for free.
 *
 * BATTERY
 *
 * `setMinDisplacement` is the single most important call here — it pushes the
 * distance filter down to the platform, so the OS suppresses updates below the
 * threshold instead of waking JS to discard them. Adaptive accuracy profiles
 * (stationary / walking / driving) are the next step and are specified in the
 * HLD; this implementation honours the profile only as a displacement change.
 */

import { LocationManager, type GeolocationPosition } from '@maplibre/maplibre-react-native';
import type { EntityFix } from '../kernel/types';
import type {
  AccuracyProfile,
  Source,
  SourceCapabilities,
  SourceConfig,
  SourceSink,
} from '../ports/Source';

export const DEVICE_SOURCE_ID = 'device-location';

/** The reserved id for the local user. `EntityStore.setSelfId` matches on it. */
export const SELF_ENTITY_ID = 'self';

/**
 * Minimum movement (metres) before the platform reports a new fix.
 *
 * These are the battery lever. A stationary user should cost almost nothing;
 * someone driving needs finer granularity to keep their trail smooth.
 */
const DISPLACEMENT_BY_PROFILE: Record<AccuracyProfile, number> = {
  auto: 5,
  stationary: 25,
  walking: 5,
  driving: 2,
};

export interface DeviceLocationOptions {
  /** Attributes stamped on the self entity, e.g. a display name. */
  attributes?: Readonly<Record<string, string | number | boolean>>;
}

export function createDeviceLocationSource(options: DeviceLocationOptions = {}): Source {
  let listener: ((position: GeolocationPosition) => void) | null = null;
  let started = false;

  return {
    id: DEVICE_SOURCE_ID,
    volatility: 'kinetic',

    capabilities(): SourceCapabilities {
      return {
        sourceId: DEVICE_SOURCE_ID,
        // Foreground only as built. Background tracking needs a foreground
        // service on Android and the `Always` escalation on iOS — specified in
        // the HLD, deliberately not implemented here.
        backgroundTracking: false,
        activityRecognition: false,
        deferredUpdates: false,
        maxEntities: 1,
        producesTracks: false,
      };
    },

    async start(config: SourceConfig, sink: SourceSink): Promise<void> {
      try {
        const granted = await LocationManager.requestPermissions();
        if (!granted) {
          // A denied permission is a STATE, not a crash. The app degrades to
          // viewer-only: you still see everyone else, you just do not broadcast.
          sink.error({
            code: 'permission-denied',
            message: 'Location permission denied — continuing in viewer-only mode.',
            recoverable: true,
          });
          return;
        }
      } catch (err) {
        sink.error({
          code: 'internal',
          message: `Location permission request failed: ${String(err)}`,
          recoverable: true,
        });
        return;
      }

      LocationManager.setMinDisplacement(
        DISPLACEMENT_BY_PROFILE[config.accuracyProfile] ?? DISPLACEMENT_BY_PROFILE.auto,
      );

      listener = (position: GeolocationPosition) => {
        const c = position.coords;
        const fix: EntityFix = {
          id: SELF_ENTITY_ID,
          lng: c.longitude,
          lat: c.latitude,
          // The platform reports heading/speed only when moving; the kernel
          // derives both from consecutive fixes when they are absent, so we
          // pass through rather than inventing zeros.
          bearing: c.heading ?? undefined,
          speed: c.speed ?? undefined,
          accuracy: c.accuracy,
          timestamp: position.timestamp,
          attributes: { ...options.attributes, role: 'self' },
        };
        // Batched API, batch of one. Uniformity beats a special-case signature.
        sink.emit([fix]);
      };

      LocationManager.addListener(listener);
      LocationManager.start();
      started = true;

      // Seed immediately so the self marker appears without waiting for the
      // first movement-triggered update.
      try {
        const current = await LocationManager.getCurrentPosition();
        if (current && listener) {
          listener(current);
        }
      } catch {
        // Non-fatal: the listener will deliver the first real fix shortly.
      }
    },

    stop(): void {
      if (listener) {
        LocationManager.removeListener(listener);
        listener = null;
      }
      if (started) {
        LocationManager.stop();
        started = false;
      }
    },

    setAccuracyProfile(profile: AccuracyProfile): void {
      LocationManager.setMinDisplacement(
        DISPLACEMENT_BY_PROFILE[profile] ?? DISPLACEMENT_BY_PROFILE.auto,
      );
    },
  };
}
