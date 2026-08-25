/**
 * Map screen — pure view.
 *
 * Every value here comes from `vm`; nothing in this file calls useState,
 * useEffect, or touches a `Source`. That split is the whole point: this
 * component can be reasoned about (and snapshot-tested) as a function of
 * its props, and the state machine in `useMapViewModel` can be tested
 * without rendering a map at all.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { MapSurface } from '@geo/surface/MapSurface';
import { LiveEntitiesLayers } from '@kits/live-entities/LiveEntitiesLayers';
import { VenueZonesLayers } from '@kits/venue-zones/VenueZonesLayers';
import { EntitySheet } from '../ui/EntitySheet';
import { MapSearchBar } from '../ui/MapSearchBar';
import type { MapViewModel } from './useMapViewModel';

export function MapScreen({ vm }: { vm: MapViewModel }) {
  return (
    <View style={styles.root}>
      <MapSurface
        centerCoordinate={vm.centerCoordinate}
        zoomLevel={vm.zoomLevel}
        // Remount the camera on mode change so the new framing is applied —
        // initialViewState is only read at mount.
        cameraKey={vm.cameraKey}
        onViewportChange={vm.onViewportChange}
      >
        {/*
          Two independent use-case modules composed onto one surface. Order
          here is slot order: zones occupy 'fill' (lowest), live entities
          occupy 'line' and 'symbol' above it. Neither module imports the
          other, and neither knows the other is mounted.
        */}
        {vm.showZones ? <VenueZonesLayers /> : null}
        <LiveEntitiesLayers
          points={vm.points}
          tracks={vm.tracks}
          showTracks={vm.showTracks}
          selectedId={vm.selected?.label ?? null}
          onSelect={vm.selectEntity}
          visibleIds={vm.visibleFriendIds}
        />
      </MapSurface>

      <MapSearchBar
        roster={vm.roster}
        visibleCount={vm.visibleFriendCount}
        onPress={vm.openFriends}
      />

      <EntitySheet
        entity={vm.selected}
        selfPosition={vm.selfPos}
        bib={vm.selectedBib}
        onClose={vm.closeEntity}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
