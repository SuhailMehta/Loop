/**
 * Tier 1 — the Source port.
 *
 * A Source is anything that produces entity observations: a websocket, an MQTT
 * client, the device's own GPS, a synthetic generator, a native TurboModule.
 * The kernel cannot tell them apart, which is the entire point — swapping the
 * implementation is a registration change, never a JS change at the call site.
 *
 * NOTE ON THE HOT PATH: a Source emits into a sink that writes to the
 * EntityStore. It does NOT drive rendering. The render loop reads the store on
 * its own tick. This decoupling is what stops a chatty source (or a slow one)
 * from affecting frame rate, and it means every source inherits coalescing,
 * interpolation and track-building without implementing any of them.
 */

import type { EntityFix, Volatility } from '../kernel/types';

/**
 * What a source can do. Consumers branch on CAPABILITIES, never on identity —
 * `sourceId` exists for telemetry and debug HUDs only.
 *
 * Without this, the first time two sources genuinely differ, a
 * `if (sourceId === 'fused')` appears in feature code and the abstraction is
 * dead. With it, callers ask "can you track in background?" and degrade
 * honestly.
 */
export interface SourceCapabilities {
  /** Diagnostics only. Branching on this in feature code is a review failure. */
  readonly sourceId: string;
  readonly backgroundTracking: boolean;
  readonly activityRecognition: boolean;
  readonly deferredUpdates: boolean;
  /** 0 = unbounded/unknown. Lets the surface warn before it blows its budget. */
  readonly maxEntities: number;
  /** True when the source emits its own history; false means the kernel builds tracks. */
  readonly producesTracks: boolean;
}

/** Sampling aggressiveness. The battery lever, expressed as intent rather than Hz. */
export type AccuracyProfile = 'auto' | 'stationary' | 'walking' | 'driving';

export interface SourceConfig {
  /** Opaque scope token. The framework passes it through without interpreting it. */
  readonly scopeId: string;
  readonly accuracyProfile: AccuracyProfile;
  /** Sources that support it should restrict emission to this viewport. */
  readonly viewportOnly: boolean;
}

export type SourceErrorCode =
  | 'permission-denied'
  | 'permission-revoked'
  | 'location-disabled'
  | 'transport-lost'
  | 'rate-limited'
  | 'unsupported'
  | 'internal';

export interface SourceError {
  readonly code: SourceErrorCode;
  readonly message: string;
  /** Whether the surface should attempt restart, or surface a terminal state to the user. */
  readonly recoverable: boolean;
}

/**
 * Where a source writes. Implemented by the kernel, never by a source.
 *
 * `emit` accepts a BATCH because every real transport delivers batches, and
 * forcing per-fix calls would multiply the crossing cost by entity count.
 */
export interface SourceSink {
  emit(fixes: readonly EntityFix[]): void;
  /** Explicit removal — a tombstone, so viewers drop the pin instead of showing a ghost. */
  remove(ids: readonly string[]): void;
  error(error: SourceError): void;
}

export interface Source {
  readonly id: string;
  readonly volatility: Volatility;
  capabilities(): SourceCapabilities;
  start(config: SourceConfig, sink: SourceSink): void | Promise<void>;
  stop(): void;
  /** Optional: sources without adaptive sampling simply omit it. */
  setAccuracyProfile?(profile: AccuracyProfile): void;
}

/** Factory form, so the registry can defer construction until resolution. */
export type SourceFactory = () => Source;

/**
 * Fallback used when zero providers are registered.
 *
 * The 0-provider case is the one people forget, and crashing on it turns a
 * packaging mistake into a launch crash. This reports a clean, typed error
 * instead and lets the app render an empty map.
 */
export const NOOP_SOURCE_ID = 'noop';

export function createNoopSource(): Source {
  return {
    id: NOOP_SOURCE_ID,
    volatility: 'static',
    capabilities: () => ({
      sourceId: NOOP_SOURCE_ID,
      backgroundTracking: false,
      activityRecognition: false,
      deferredUpdates: false,
      maxEntities: 0,
      producesTracks: false,
    }),
    start(_config, sink) {
      sink.error({
        code: 'unsupported',
        message:
          'No entity source is registered. Link a source package, or register one before mounting MapSurface.',
        recoverable: false,
      });
    },
    stop() {},
  };
}
