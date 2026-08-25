/**
 * Loop demo host.
 *
 * Composition only — this file wires a source to a store to a surface, and owns
 * no domain logic. Which use cases appear on screen is the `children` of
 * MapSurface, which is the whole argument for the map being a horizontal
 * capability.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, BackHandler, StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '@design';
import { EntityStore } from '@geo/kernel/EntityStore';
import { DEFAULT_KERNEL_CONFIG } from '@geo/kernel/types';
import type { BBox } from '@geo/kernel/types';
import { useEntityFrames } from '@geo/render/useEntityFrames';
import { MapSurface } from '@geo/surface/MapSurface';
import { registerSource, resolveSource, setSourceOverride } from '@geo/sources/registry';
import { MOCK_SOURCE_ID, createMockSource, DEFAULT_MOCK_OPTIONS } from '@geo/sources/MockSource';
import {
  NATIVE_SOURCE_ID,
  createNativeTurboSource,
  isNativeSourceAvailable,
} from '@geo/sources/NativeTurboSource';
import {
  LiveEntitiesLayers,
  type SelectedFeature,
} from '@kits/live-entities/LiveEntitiesLayers';
import {
  SELF_ENTITY_ID,
  createDeviceLocationSource,
} from '@geo/sources/DeviceLocationSource';
import {
  loadSnapshot,
  saveSnapshot,
  startBackgroundTracking,
  stopBackgroundTracking,
  subscribeToMemoryPressure,
} from '@geo/sources/NativeTurboSource';
import {
  BIB_BY_NAME,
  SCENARIO_CENTER,
  SCENARIO_ENTITY_COUNT,
  SCENARIO_GROUPS,
  SCENARIO_ZOOM,
} from '@kits/live-entities/scenario';
import { VenueZonesLayers } from '@kits/venue-zones/VenueZonesLayers';
import { EntitySheet } from './src/ui/EntitySheet';
import { MapSearchBar } from './src/ui/MapSearchBar';
import {
  FriendsScreen,
  type FriendFilterMode,
  type FriendRosterEntry,
} from './src/ui/FriendsScreen';

/**
 * Provider registration.
 *
 * In a packaged build this happens inside each provider package's own
 * ReactPackage (Android) or `+load` shim (iOS), so adding or removing a source
 * is an install/uninstall with no JS diff. Doing it here keeps the demo in one
 * readable file while using the identical registry path.
 */
/**
 * Entity count is module-scoped because source factories read it at
 * construction time, and the registry constructs lazily on resolve.
 */
let demoEntityCount = SCENARIO_ENTITY_COUNT;
/**
 * Scenario mode = a realistic group walking real streets. Stress mode = a large
 * synthetic population for throughput measurement. Two different artefacts, and
 * conflating them makes the product demo look like a benchmark.
 */
let demoScenario = true;

let providersRegistered = false;

/**
 * Registration runs on first render, NOT at module evaluation.
 *
 * Asking the TurboModuleRegistry during module eval races with native module
 * registration under bridgeless — the provider would be reported missing on
 * some launches and present on others, which is exactly the kind of
 * intermittent failure that is miserable to diagnose later.
 */
function registerProviders(): void {
  if (providersRegistered) {
    return;
  }
  providersRegistered = true;

  registerSource(MOCK_SOURCE_ID, 10, () =>
    createMockSource(
      demoScenario
        ? {
            groups: SCENARIO_GROUPS,
            centerLng: SCENARIO_CENTER[0],
            centerLat: SCENARIO_CENTER[1],
          }
        : { entityCount: demoEntityCount },
    ),
  );

  // The native provider registers only when it is actually linked. If it is
  // not, resolution falls back to the JS source by priority and nothing else
  // in the app is aware anything changed — which is the whole contract.
  if (isNativeSourceAvailable()) {
    // The native provider receives the IDENTICAL scenario the JS provider gets.
    // Without this the swap changed what was on screen (anonymous dots wandering
    // outside every venue) rather than how it got there, which proved nothing.
    registerSource(NATIVE_SOURCE_ID, 20, () =>
      createNativeTurboSource(
        demoScenario
          ? {
              groups: SCENARIO_GROUPS as never,
              centerLng: SCENARIO_CENTER[0],
              centerLat: SCENARIO_CENTER[1],
            }
          : { wanderCount: demoEntityCount },
      ),
    );
  }
}

function Demo() {
  const store = useMemo(() => new EntityStore(DEFAULT_KERNEL_CONFIG), []);
  /**
   * The demo only ever asks for the native bridge source. The JS source stays
   * registered — the registry's whole point (`sources/registry.ts`) is that a
   * swap costs nothing beyond this constant — but the app no longer exposes a
   * choice, since it was demo chrome and never something a real user would
   * touch. If the native module isn't linked, resolution falls back to
   * whatever else is registered on its own (§ports/Source.ts resolution
   * policy); nothing here needs to know that happened.
   */
  const preferredSource = NATIVE_SOURCE_ID;

  /*
   * Fixed configuration.
   *
   * These were toggles while the design was being explored; each one is now a
   * settled decision, so they are constants rather than chrome. The demo's job
   * is to show the three implementation strategies, not to expose every knob
   * that was useful during development.
   */
  /*
   * Trails stay on in every mode.
   *
   * Both providers emit at the same 1Hz cadence, so trail data is equally
   * fresh either way: the trail head is the last FIX, with the pin
   * interpolating ahead of it.
   */
  const showTracks = true;
  const showZones = true;    // venue context; also proves module composition
  const updateHz = 30;       // indistinguishable from 60 for map pins
  const scenarioMode = true; // realistic group, never the synthetic stress set
  const cullEnabled = true;  // serialise only what is on screen
  const clusterEnabled = false; // wrong default for a friends map — HLD 8.11
  const entityCount = SCENARIO_ENTITY_COUNT;
  /** The app has exactly two screens; a state flag is the whole router. */
  const [screen, setScreen] = useState<'map' | 'friends'>('map');

  /**
   * Hardware/gesture back on Android must return to the map, not exit the
   * app. A hand-rolled screen flag gets this for free with a real navigator
   * (it owns the back stack); here it has to be wired explicitly, or the
   * Friends screen becomes a dead end that only a second app-switch escapes.
   */
  useEffect(() => {
    if (screen !== 'friends') {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setScreen('map');
      return true;
    });
    return () => sub.remove();
  }, [screen]);

  const [selected, setSelected] = useState<SelectedFeature | null>(null);
  /** Own position, kept in a ref for the distance readout without re-rendering. */
  const selfPosRef = useRef<{ lng: number; lat: number } | null>(null);
  const [selfPos, setSelfPos] = useState<{ lng: number; lat: number } | null>(null);
  const [, setBackgroundOk] = useState<boolean | null>(null);

  /**
   * Friends roster, built incrementally as fixes name entities the app hasn't
   * seen yet, rather than read from the scenario file directly — the panel is
   * meant to describe whatever the active source is actually producing, JS
   * mock or native, not assume it knows the roster in advance.
   *
   * Written to a ref on the hot path and only flushed to state on the same
   * 1Hz sweep everything else below uses, so a new name doesn't force a
   * render on every batch.
   */
  const rosterRef = useRef<Map<string, FriendRosterEntry>>(new Map());
  const rosterDirtyRef = useRef(false);
  const [roster, setRoster] = useState<FriendRosterEntry[]>([]);

  /**
   * "All" means everyone, including whoever the source names next — it is
   * not a snapshot of the roster at the moment it was chosen. Unchecking one
   * friend out of "all" has to materialise the roster as it stands right
   * then and drop into explicit selection, since there is no other way to
   * mean "everyone except this person" for a roster that is still growing.
   */
  const [friendMode, setFriendMode] = useState<FriendFilterMode>('all');
  const [selectedFriendIds, setSelectedFriendIds] = useState<Set<string>>(new Set());
  const toggleFriend = useCallback((id: string) => {
    setFriendMode(prevMode => {
      if (prevMode === 'all') {
        const next = new Set(rosterRef.current.keys());
        next.delete(id);
        setSelectedFriendIds(next);
        return 'any';
      }
      setSelectedFriendIds(prev => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      return prevMode;
    });
  }, []);
  const toggleAllFriends = useCallback(() => {
    setFriendMode(prev => (prev === 'all' ? 'any' : 'all'));
    setSelectedFriendIds(new Set());
  }, []);
  const visibleFriendIds = friendMode === 'all' ? ('all' as const) : selectedFriendIds;

  /**
   * Live viewport, held in a ref because it updates on every frame of a pan.
   * Routing it through state would re-render the tree throughout the gesture.
   */
  const viewportRef = useRef<{ bounds: BBox; zoom: number } | null>(null);
  const handleViewport = useCallback((bounds: BBox, zoom: number) => {
    viewportRef.current = { bounds, zoom };
  }, []);

  useEffect(() => {
    // Resolution happens entirely inside the registry. Nothing downstream —
    // not the store, not the render loop, not a single layer or kit — knows
    // or cares which implementation came back.
    registerProviders();
    // Re-register so the factories pick up the current entity count.
    providersRegistered = false;
    demoEntityCount = entityCount;
    demoScenario = scenarioMode;
    registerProviders();

    setSourceOverride(preferredSource);
    const source = resolveSource();
    store.clear();
    rosterRef.current.clear();
    rosterDirtyRef.current = false;
    setRoster([]);
    setFriendMode('all');
    setSelectedFriendIds(new Set());

    /*
     * Resume, do not restart.
     *
     * Last-known positions are restored before the first live fix arrives, so a
     * cold start after the OS reclaimed the process shows friends where they
     * were last seen — ageing visibly through the normal freshness sweep —
     * rather than an empty map. The restart, not the crash, is what costs the
     * user's confidence.
     *
     * `restoreSnapshot`, not `upsert`: a restored position can be arbitrarily
     * old, so it needs to be flagged and snapped past on the first live fix
     * rather than tweened into — see EntityStore for what goes wrong without
     * that distinction.
     */
    const restored = loadSnapshot();
    if (restored.length > 0) {
      store.restoreSnapshot(restored);
    }

    // The sink is the ONLY thing connecting a source to the kernel. Any source
    // — websocket, MQTT, native TurboModule — implements the same three calls.
    const sink = {
      emit: (fixes: readonly import('@geo/kernel/types').EntityFix[]) => {
        store.upsert(fixes);
        // One scan covers both: the local user's position for the distance
        // readout, and any entity the roster hasn't named yet.
        for (let i = 0; i < fixes.length; i++) {
          const f = fixes[i];
          if (!f) {
            continue;
          }
          if (f.id === SELF_ENTITY_ID) {
            selfPosRef.current = { lng: f.lng, lat: f.lat };
            continue;
          }
          if (!rosterRef.current.has(f.id)) {
            rosterRef.current.set(f.id, {
              id: f.id,
              label: String(f.attributes?.label ?? f.id),
              participation: String(f.attributes?.participation ?? 'supporter'),
              variant: Number(f.attributes?.variant ?? 0),
            });
            rosterDirtyRef.current = true;
          }
        }
      },
      remove: (ids: readonly string[]) => store.remove(ids),
      error: (err: { code: string; message: string }) =>
        console.warn(`[${source.id}] ${err.code}: ${err.message}`),
    };

    source.start({ scopeId: 'demo', accuracyProfile: 'auto', viewportOnly: false }, sink);

    // The device's own position runs as a SECOND source into the same store.
    // The registry resolves which implementation fills a role; it was never
    // meant to cap the app at one active producer. An app shows you AND others.
    store.setSelfId(SELF_ENTITY_ID);
    const deviceSource = createDeviceLocationSource({ attributes: { label: 'You' } });
    void deviceSource.start(
      { scopeId: 'demo', accuracyProfile: 'auto', viewportOnly: false },
      { ...sink, error: err => console.warn(`[device] ${err.code}: ${err.message}`) },
    );

    // Freshness is a function of wall-clock age, so it is swept on a slow timer
    // rather than recomputed per frame. The roster flush rides the same timer
    // so a new name doesn't force a render on every batch.
    const sweep = setInterval(() => {
      store.sweep();
      setSelfPos(selfPosRef.current);
      if (rosterDirtyRef.current) {
        rosterDirtyRef.current = false;
        setRoster(Array.from(rosterRef.current.values()));
      }
    }, 1000);

    return () => {
      source.stop();
      deviceSource.stop();
      clearInterval(sweep);
      store.clear();
    };
  }, [store, preferredSource, entityCount, scenarioMode]);

  /*
   * Backgrounding: persist, shed proactively, promote to a foreground service.
   *
   * This trigger is deliberate and opportunistic, not a stand-in for real
   * memory-pressure detection — the OS is more likely to reclaim a backgrounded
   * process than a foregrounded one, so it is a reasonable moment to shed what
   * can be afforded (track history, pooled caches) before that happens. The
   * platform's own pressure signal is handled separately below.
   */
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (next === 'background' || next === 'inactive') {
        // Persist first, then shed: the snapshot must reflect live state, and
        // shedding discards the caches that would otherwise be written.
        saveSnapshot(store.snapshot());
        store.shedMemory('moderate');
        // Android suspends location for backgrounded processes. Promoting to a
        // foreground service is what keeps an events app working once the phone
        // goes into a pocket.
        setBackgroundOk(
          startBackgroundTracking('Sharing location', 'Your position is visible to your group'),
        );
      } else if (next === 'active') {
        stopBackgroundTracking();
      }
    });
    return () => {
      sub.remove();
      // Leaving the service running past teardown would keep the notification
      // alive with nothing behind it.
      stopBackgroundTracking();
    };
  }, [store]);

  /*
   * Memory pressure: the platform's own signal, not a backgrounding proxy.
   *
   * `Application.onTrimMemory` fires while the app is still fully in the
   * foreground, under genuine pressure — the exact case the backgrounding
   * listener above cannot see, since nothing about foreground state changes.
   * The two triggers are complementary: one is opportunistic and coarse, this
   * one is reactive and precise, and both call the same `shedMemory`, which is
   * itself scaled by the level Android actually reports.
   */
  useEffect(() => {
    return subscribeToMemoryPressure(level => {
      store.shedMemory(level);
    });
  }, [store]);

  // Recording and rendering are separate concerns — turning the layer off must
  // also stop the store retaining history, or the cost is paid for nothing.
  useEffect(() => {
    store.setTracksEnabled(showTracks);
  }, [store, showTracks]);

  const { points, tracks } = useEntityFrames(store, {
    updateHz,
    trackEveryNFrames: 15,
    // Passing undefined disables culling entirely, so the demo can show the
    // before/after rather than assert it.
    // Always supplied: culling and clustering are independent consumers of it.
    viewportRef,
    cullEnabled,
    // Opt-in only. See the note on clusterEnabled above.
    clusterRadiusPx: clusterEnabled ? 56 : 0,
    clusterMaxZoom: 16,
  });

  if (screen === 'friends') {
    return (
      <FriendsScreen
        roster={roster}
        mode={friendMode}
        selectedIds={selectedFriendIds}
        onToggleAll={toggleAllFriends}
        onToggle={toggleFriend}
        onClose={() => setScreen('map')}
      />
    );
  }

  return (
    <View style={styles.root}>
      <MapSurface
        centerCoordinate={
          scenarioMode
            ? [SCENARIO_CENTER[0], SCENARIO_CENTER[1]]
            : [DEFAULT_MOCK_OPTIONS.centerLng, DEFAULT_MOCK_OPTIONS.centerLat]
        }
        zoomLevel={scenarioMode ? SCENARIO_ZOOM : 12}
        // Remount the camera on mode change so the new framing is applied —
        // initialViewState is only read at mount.
        cameraKey={scenarioMode ? 'scenario' : 'stress'}
        onViewportChange={handleViewport}
      >
        {/*
          Two independent use-case modules composed onto one surface. Order here
          is slot order: zones occupy 'fill' (lowest), live entities occupy
          'line' and 'symbol' above it. Neither module imports the other, and
          neither knows the other is mounted.
        */}
        {showZones ? <VenueZonesLayers /> : null}
        <LiveEntitiesLayers
          points={points}
          tracks={tracks}
          showTracks={showTracks}
          selectedId={selected?.label ?? null}
          onSelect={setSelected}
          visibleIds={visibleFriendIds}
        />
      </MapSurface>

      <MapSearchBar
        roster={roster}
        visibleCount={friendMode === 'all' ? roster.length : selectedFriendIds.size}
        onPress={() => setScreen('friends')}
      />

      <EntitySheet
        entity={selected}
        selfPosition={selfPos}
        bib={selected ? BIB_BY_NAME[selected.label] ?? null : null}
        onClose={() => setSelected(null)}
      />
    </View>
  );
}


export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <StatusBar barStyle="default" />
        <Demo />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
