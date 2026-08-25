/**
 * View model for the app's two screens (map, friends).
 *
 * One hook, not two, because the screens share state that has to stay in
 * sync — the roster and the friend filter are read by both. Splitting them
 * into separate hooks would mean lifting that shared state back up into a
 * parent anyway; this just IS that parent, expressed as a hook instead of a
 * component, so the two `.tsx` files stay pure renderers of whatever this
 * returns. Everything below is store/effect wiring; nothing here is JSX.
 *
 * NO NAVIGATION LIBRARY
 *
 * There is exactly one transition in this app — map to Friends and back —
 * so `screen` is a plain state flag rather than a stack from a routing
 * library. A real navigator earns its keep once there is a back stack worth
 * managing, deep links to resolve, or more than two destinations; none of
 * that exists here, and reaching for one anyway would be dependency weight
 * with nothing behind it. `FriendSelection.ts` is where the actual state
 * machine lives, and it is plain data either way — swapping this hook's
 * `screen` flag for a real navigator later touches this file only.
 *
 * For this case study the `screen` flag and `openFriends`/`closeFriends` are
 * used directly by callers (`RootNavigator`) — there is no abstraction layer
 * in between. In a production app that direct usage would sit behind a thin
 * navigation wrapper (e.g. a `useNavigator()` hook or `NavigationService`)
 * so that adopting a real routing library, or changing how transitions work,
 * is a change in one centralized place rather than every call site that
 * currently reads `screen`/`openFriends`/`closeFriends`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, BackHandler } from 'react-native';
import { EntityStore, type StoreStats } from '@geo/kernel/EntityStore';
import { DEFAULT_KERNEL_CONFIG } from '@geo/kernel/types';
import type { BBox, EntityFix } from '@geo/kernel/types';
import { useEntityFrames } from '@geo/render/useEntityFrames';
import { resolveSource, setSourceOverride } from '@geo/sources/registry';
import { DEFAULT_MOCK_OPTIONS } from '@geo/sources/MockSource';
import { NATIVE_SOURCE_ID } from '@geo/sources/NativeTurboSource';
import {
  loadSnapshot,
  saveSnapshot,
  startBackgroundTracking,
  stopBackgroundTracking,
  subscribeToMemoryPressure,
} from '@geo/sources/NativeTurboSource';
import { SELF_ENTITY_ID, createDeviceLocationSource } from '@geo/sources/DeviceLocationSource';
import type { SelectedFeature } from '@kits/live-entities/LiveEntitiesLayers';
import {
  BIB_BY_NAME,
  SCENARIO_CENTER,
  SCENARIO_ENTITY_COUNT,
  SCENARIO_ZOOM,
} from '@kits/live-entities/scenario';
import type { FriendRosterEntry } from '../models/FriendSelection';
import {
  INITIAL_FRIEND_SELECTION,
  toggleAllFriends as applyToggleAll,
  toggleFriend as applyToggleFriend,
  visibleFriendCount,
  visibleFriendIds,
} from '../models/FriendSelection';
import { registerProviders } from '../bootstrap/RegisterProviders';

export type { FriendFilterMode, FriendRosterEntry } from '../models/FriendSelection';

/** Settled decisions, not chrome — see the note at each one's original site in git history. */
const CONFIG = {
  showTracks: true,
  showZones: true,
  updateHz: 30,
  scenarioMode: true,
  cullEnabled: true,
  clusterEnabled: false,
  entityCount: SCENARIO_ENTITY_COUNT,
} as const;

interface SelfPosition {
  lng: number;
  lat: number;
}

export function useMapViewModel() {
  const store = useMemo(() => new EntityStore(DEFAULT_KERNEL_CONFIG), []);

  const [screen, setScreen] = useState<'map' | 'friends'>('map');
  const openFriends = useCallback(() => setScreen('friends'), []);
  const closeFriends = useCallback(() => setScreen('map'), []);

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
  const closeEntity = useCallback(() => setSelected(null), []);

  const selfPosRef = useRef<SelfPosition | null>(null);
  const [selfPos, setSelfPos] = useState<SelfPosition | null>(null);

  const rosterRef = useRef<Map<string, FriendRosterEntry>>(new Map());
  const rosterDirtyRef = useRef(false);
  const [roster, setRoster] = useState<FriendRosterEntry[]>([]);

  const [friendSelection, setFriendSelection] = useState(INITIAL_FRIEND_SELECTION);
  const toggleFriend = useCallback((id: string) => {
    setFriendSelection(prev => applyToggleFriend(prev, id, rosterRef.current.keys()));
  }, []);
  const toggleAllFriends = useCallback(() => {
    setFriendSelection(prev => applyToggleAll(prev));
  }, []);

  const viewportRef = useRef<{ bounds: BBox; zoom: number } | null>(null);
  const onViewportChange = useCallback((bounds: BBox, zoom: number) => {
    viewportRef.current = { bounds, zoom };
  }, []);

  useEffect(() => {
    // Resolution happens entirely inside the registry. Nothing downstream —
    // not the store, not the render loop, not a single layer or kit — knows
    // or cares which implementation came back.
    registerProviders(CONFIG.entityCount, CONFIG.scenarioMode);
    setSourceOverride(NATIVE_SOURCE_ID);
    const source = resolveSource();

    store.clear();
    rosterRef.current.clear();
    rosterDirtyRef.current = false;
    setRoster([]);
    setFriendSelection(INITIAL_FRIEND_SELECTION);

    /*
     * Resume, do not restart.
     *
     * Last-known positions are restored before the first live fix arrives, so
     * a cold start after the OS reclaimed the process shows friends where
     * they were last seen — ageing visibly through the normal freshness
     * sweep — rather than an empty map. The restart, not the crash, is what
     * costs the user's confidence.
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

    // The sink is the ONLY thing connecting a source to the kernel. Any
    // source — websocket, MQTT, native TurboModule — implements the same
    // three calls.
    const sink = {
      emit: (fixes: readonly EntityFix[]) => {
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
    // meant to cap the app at one active producer. An app shows you AND
    // others.
    store.setSelfId(SELF_ENTITY_ID);
    const deviceSource = createDeviceLocationSource({ attributes: { label: 'You' } });
    void deviceSource.start(
      { scopeId: 'demo', accuracyProfile: 'auto', viewportOnly: false },
      { ...sink, error: err => console.warn(`[device] ${err.code}: ${err.message}`) },
    );

    // Freshness is a function of wall-clock age, so it is swept on a slow
    // timer rather than recomputed per frame. The roster flush rides the
    // same timer so a new name doesn't force a render on every batch.
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
  }, [store]);

  /*
   * Backgrounding: persist, shed proactively, promote to a foreground
   * service.
   *
   * This trigger is deliberate and opportunistic, not a stand-in for real
   * memory-pressure detection — the OS is more likely to reclaim a
   * backgrounded process than a foregrounded one, so it is a reasonable
   * moment to shed what can be afforded (track history, pooled caches)
   * before that happens. The platform's own pressure signal is handled
   * separately below.
   */
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (next === 'background' || next === 'inactive') {
        // Persist first, then shed: the snapshot must reflect live state,
        // and shedding discards the caches that would otherwise be written.
        saveSnapshot(store.snapshot());
        store.shedMemory('moderate');
        // Android suspends location for backgrounded processes. Promoting
        // to a foreground service is what keeps an events app working once
        // the phone goes into a pocket.
        startBackgroundTracking('Sharing location', 'Your position is visible to your group');
      } else if (next === 'active') {
        stopBackgroundTracking();
      }
    });
    return () => {
      sub.remove();
      // Leaving the service running past teardown would keep the
      // notification alive with nothing behind it.
      stopBackgroundTracking();
    };
  }, [store]);

  /*
   * Memory pressure: the platform's own signal, not a backgrounding proxy.
   *
   * `Application.onTrimMemory` fires while the app is still fully in the
   * foreground, under genuine pressure — the exact case the backgrounding
   * listener above cannot see, since nothing about foreground state
   * changes. The two triggers are complementary: one is opportunistic and
   * coarse, this one is reactive and precise, and both call the same
   * `shedMemory`, which is itself scaled by the level Android actually
   * reports.
   */
  useEffect(() => {
    return subscribeToMemoryPressure(level => {
      store.shedMemory(level);
    });
  }, [store]);

  // Recording and rendering are separate concerns — turning the layer off
  // must also stop the store retaining history, or the cost is paid for
  // nothing.
  useEffect(() => {
    store.setTracksEnabled(CONFIG.showTracks);
  }, [store]);

  const { points, tracks } = useEntityFrames(store, {
    updateHz: CONFIG.updateHz,
    trackEveryNFrames: 15,
    // Always supplied: culling and clustering are independent consumers of
    // it. Passing undefined would disable culling entirely.
    viewportRef,
    cullEnabled: CONFIG.cullEnabled,
    clusterRadiusPx: CONFIG.clusterEnabled ? 56 : 0,
    clusterMaxZoom: 16,
  });

  return {
    // navigation
    screen,
    openFriends,
    closeFriends,

    // map surface
    points,
    tracks,
    showTracks: CONFIG.showTracks,
    showZones: CONFIG.showZones,
    centerCoordinate: (CONFIG.scenarioMode
      ? [SCENARIO_CENTER[0], SCENARIO_CENTER[1]]
      : [DEFAULT_MOCK_OPTIONS.centerLng, DEFAULT_MOCK_OPTIONS.centerLat]) as [number, number],
    zoomLevel: CONFIG.scenarioMode ? SCENARIO_ZOOM : 12,
    cameraKey: CONFIG.scenarioMode ? 'scenario' : 'stress',
    onViewportChange,

    // entity selection
    selected,
    selectEntity: setSelected,
    closeEntity,
    selectedBib: selected ? BIB_BY_NAME[selected.label] ?? null : null,
    selfPos,

    // friends
    roster,
    friendMode: friendSelection.mode,
    selectedFriendIds: friendSelection.selectedIds,
    visibleFriendIds: visibleFriendIds(friendSelection),
    visibleFriendCount: visibleFriendCount(friendSelection, roster.length),
    toggleFriend,
    toggleAllFriends,
  };
}

export type MapViewModel = ReturnType<typeof useMapViewModel>;
export type { StoreStats };
