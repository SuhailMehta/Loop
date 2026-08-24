/**
 * Tier 1 — the map host surface.
 *
 * MapSurface owns the map and the shared resources modules contend for; it does
 * NOT own any use case. Modules are passed in as children and contribute layers
 * into slots. Swapping which use cases appear on a screen is a change to the
 * children array and nothing else — that is what makes the map a horizontal
 * capability rather than a live-location feature.
 *
 * Slot ordering is enforced by render order here. Semantic slots ('fill' below
 * 'line' below 'symbol' below 'overlay') mean a polygon module and a pins
 * module get deterministic z-order without either one knowing the other's layer
 * ids — which is the coupling MapLibre's raw `beforeId` API would force.
 */

import React, { useCallback, type PropsWithChildren } from 'react';
import { StyleSheet, Text, View, type NativeSyntheticEvent } from 'react-native';
import { Camera, Map, type ViewStateChangeEvent } from '@maplibre/maplibre-react-native';
import { useTokens } from '@design';
import type { BBox } from '../kernel/types';

/**
 * Fraction of the visible span added to each edge before culling.
 *
 * Culling to the exact viewport makes entities pop in at the boundary and
 * leaves the interpolator with no history for anything entering the screen.
 * A margin trades a little serialisation for correctness at the edges.
 */
const VIEWPORT_PADDING = 0.25;

export interface MapSurfaceProps {
  centerCoordinate: [number, number];
  zoomLevel?: number;
  /** Shown bottom-left. The basemap licence requires it; not optional. */
  showAttribution?: boolean;
  /**
   * Called with padded visible bounds whenever the camera moves.
   *
   * Fires on every frame of a pan, so the consumer must write to a ref rather
   * than to React state.
   */
  onViewportChange?: (bounds: BBox, zoom: number) => void;
  /**
   * Changing this remounts the camera, re-applying `initialViewState`.
   *
   * `initialViewState` is read once at mount by design, so re-framing the map
   * (e.g. switching between a close scenario view and a wide stress view)
   * otherwise has no effect.
   */
  cameraKey?: string;
}

export function MapSurface({
  centerCoordinate,
  zoomLevel = 13,
  showAttribution = true,
  onViewportChange,
  cameraKey,
  children,
}: PropsWithChildren<MapSurfaceProps>) {
  const tokens = useTokens();

  const handleRegion = useCallback(
    (event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
      if (!onViewportChange) {
        return;
      }
      // LngLatBounds is [west, south, east, north] — GeoJSON corner order.
      const [west, south, east, north] = event.nativeEvent.bounds;

      const padLng = (east - west) * VIEWPORT_PADDING;
      const padLat = (north - south) * VIEWPORT_PADDING;

      onViewportChange(
        {
          west: west - padLng,
          south: south - padLat,
          east: east + padLng,
          north: north + padLat,
        },
        event.nativeEvent.zoom,
      );
    },
    [onViewportChange],
  );

  return (
    <View style={styles.container}>
      <Map
        style={styles.map}
        // Theme reaches the map by swapping the whole basemap style, not by
        // tinting: vector tiles cannot be recoloured from the app side.
        mapStyle={tokens.map.basemapStyleUrl}
        logo={false}
        attribution={false}
        // `IsChanging` keeps culling correct mid-gesture; `DidChange` catches
        // the settle, including programmatic camera moves that never fire the
        // continuous event.
        onRegionIsChanging={handleRegion}
        onRegionDidChange={handleRegion}
      >
        <Camera key={cameraKey} initialViewState={{ center: centerCoordinate, zoom: zoomLevel }} />
        {children}
      </Map>

      {showAttribution ? (
        <View style={[styles.attribution, { backgroundColor: tokens.surface.overlay }]}>
          <Text style={[styles.attributionText, { color: tokens.text.secondary }]}>
            {tokens.map.basemapAttribution}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  attribution: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  attributionText: { fontSize: 9 },
});
