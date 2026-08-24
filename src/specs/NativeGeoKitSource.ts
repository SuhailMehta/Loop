/**
 * TurboModule spec — the frozen contract between JS and a native entity source.
 *
 * THIS FILE IS THE POINT OF THE WHOLE PLUGIN ARCHITECTURE.
 *
 * Codegen turns it into a C++/Kotlin/ObjC++ interface at build time. Any native
 * implementation that satisfies the generated spec is interchangeable, and JS
 * at the call site never changes — it talks to `Source`, and the adapter that
 * wraps this module satisfies `Source` like every other provider.
 *
 * NOTE WHAT IS ABSENT FROM `start()`: there is no positions array parameter and
 * no polling method. Fixes flow OUT through an event emitter, and in the
 * production design they would not cross into JS at all — a native source would
 * write straight into a native store read by a native map view. This module
 * emits to JS because the map is currently a JS-driven MapLibre view; the
 * boundary moves, the contract does not.
 */

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';
import type { Double, Int32, EventEmitter } from 'react-native/Libraries/Types/CodegenTypes';

/**
 * One observation. Flat and primitive-valued because codegen cannot express
 * nested unions or index signatures — the same constraint that shaped
 * `Attributes` in the kernel.
 */
export type NativeFix = {
  id: string;
  lng: Double;
  lat: Double;
  bearing: Double;
  speed: Double;
  accuracy: Double;
  timestamp: Double;
  /*
   * Attribute fields are declared FLAT and explicitly rather than as a nested
   * map or a JSON string. Codegen cannot express an open record, and a
   * per-fix JSON parse would put string decoding on the hot path. The
   * attribute contract is known at build time, so it may as well be typed.
   */
  label: string;
  variant: Int32;
  persona: string;
  participation: string;
};

/**
 * Fixes arrive batched, never one event per entity. At 200 entities the
 * difference is 1 boundary crossing per tick versus 200 — this is the single
 * most important shape decision in the spec.
 */
export type NativeFixBatch = {
  fixes: NativeFix[];
  /**
   * Native-side generation counter. Diagnostic only — nothing currently reads
   * it. Batch loss itself is prevented structurally by `ackFixes` (at most one
   * batch is ever in flight, so none are dropped to make room for another);
   * this would only be useful for logging how often the ack timeout fires.
   */
  sequence: Int32;
};

/**
 * Capability descriptor. Consumers branch on THESE, never on `sourceId` —
 * see the SourceCapabilities doc in src/geo/ports/Source.ts.
 */
export type NativeCapabilities = {
  sourceId: string;
  backgroundTracking: boolean;
  activityRecognition: boolean;
  deferredUpdates: boolean;
  maxEntities: Int32;
  producesTracks: boolean;
};

/**
 * Android's own low-memory signal, forwarded from `Application.onTrimMemory`.
 *
 * This is distinct from — and the actual fix for — the earlier gap where memory
 * shedding was triggered only by the app leaving the foreground (an `AppState`
 * change in JS). Backgrounding is a proxy that happens to correlate with memory
 * pressure sometimes; `onTrimMemory` is the platform telling the process it is
 * a reclamation candidate, and it fires while still foregrounded under real
 * pressure — which the proxy cannot detect at all.
 *
 * `level` carries a normalised value rather than Android's raw integer
 * constants, so the mapping from platform detail to shedding severity lives in
 * one place (the native emitter) instead of being re-derived in JS:
 *   'moderate' — TRIM_MEMORY_RUNNING_LOW / UI_HIDDEN / BACKGROUND
 *   'critical' — TRIM_MEMORY_RUNNING_CRITICAL / COMPLETE
 */
export type MemoryPressureEvent = {
  level: string;
};

export interface Spec extends TurboModule {
  /**
   * Begin producing fixes on a native timer.
   *
   * The scenario arrives as a JSON string rather than structured parameters.
   * That is a deliberate trade: codegen cannot express nested arrays of
   * coordinate pairs, and the alternative — a flattened parallel-array encoding
   * with offset tables — would be far harder to read on both sides for data
   * that crosses ONCE at startup. The hot path stays typed; only this
   * configuration call is stringly-typed.
   *
   * Shape:
   *   { intervalMs, center: [lng,lat], radiusM, wanderCount,
   *     groups: [{ count, persona, labels[], attributes{}, routes[[[lng,lat]]] }] }
   */
  start(scenarioJson: string, intervalMs: Int32): void;

  stop(): void;

  /**
   * Promote tracking to a foreground service so Android does not suspend
   * location updates when the app leaves the foreground.
   *
   * Returns false when the notification permission required on Android 13+ has
   * not been granted, so the caller can surface a degraded state rather than
   * silently stopping at the lock screen.
   */
  startBackgroundTracking(title: string, body: string): boolean;
  stopBackgroundTracking(): void;

  /**
   * Durable snapshot, written to SharedPreferences.
   *
   * Persisted outside the JS heap on purpose: the heap is gone when the OS
   * reclaims the process, and reclaiming is the case this exists for. On the
   * next cold start the map repaints last-known positions immediately instead
   * of showing an empty screen while the first fix arrives.
   */
  saveSnapshot(json: string): void;
  loadSnapshot(): string;

  /** Synchronous JSI call — a struct read with no I/O, so blocking JS is safe. */
  getCapabilities(): NativeCapabilities;

  /**
   * Codegen-generated event emitter (RN 0.76+). Preferred over
   * NativeEventEmitter/RCTDeviceEventEmitter: it is typed end to end and works
   * under bridgeless without the addListener/removeListeners boilerplate.
   */
  readonly onFixes: EventEmitter<NativeFixBatch>;

  /**
   * Acknowledge that the most recent batch has been applied.
   *
   * BACKPRESSURE, credit-based with a credit of one. `emitOnFixes` is a
   * fire-and-forget call into the JS event queue — nothing in the platform
   * stops native from emitting again before JS has drained the previous call.
   * Left unguarded, a source ticking faster than JS can consume (a long
   * synchronous block, a slow device, a higher production rate than the 1Hz
   * used today) queues an unbounded run of stale batches: JS would burn CPU
   * applying and immediately discarding every batch but the last, since only
   * the final one is still current by the time any of them render.
   *
   * The native side withholds the next emission until this is called, so at
   * most one batch is ever in flight. Production keeps advancing internally
   * regardless — nothing is lost, only sending is paused — so the moment JS
   * catches up, the very next tick emits the freshest state rather than a
   * backlog of ones that are already stale.
   */
  ackFixes(): void;

  /**
   * Fires on the platform's own memory-pressure signal, independent of which
   * `Source` is currently generating entities — this is a capability of the
   * native module itself, not of any one provider.
   */
  readonly onMemoryPressure: EventEmitter<MemoryPressureEvent>;
}

/**
 * Resolved LAZILY, on first use — never at module-evaluation time.
 *
 * Two reasons, both learned the hard way:
 *
 * 1. `get` rather than `getEnforcing`, so a missing native provider degrades to
 *    the Noop source with a typed error instead of throwing. That is the
 *    0-registered-providers case in the registry's resolution policy;
 *    getEnforcing would turn a packaging mistake into a launch crash.
 *
 * 2. Resolving at import time races with native module registration under
 *    bridgeless. Capturing the result in a module-scope constant made provider
 *    availability nondeterministic across launches — the module was present,
 *    but we had asked too early and cached the miss forever.
 */
let cached: Spec | null | undefined;

export function getNativeGeoKitSource(): Spec | null {
  // `undefined` = not yet asked; `null` = asked and genuinely absent.
  if (cached === undefined) {
    cached = TurboModuleRegistry.get<Spec>('NativeGeoKitSource') ?? null;
  }
  return cached;
}
