/**
 * Tier 3 — use-case kit: static venue zones.
 *
 * THE POINT OF THIS FILE IS HOW SMALL IT IS.
 *
 * This is a completely different use case from live entities — different
 * geometry (Polygon vs Point), different volatility (static vs kinetic),
 * different domain (venue operations vs social location sharing) — and adding
 * it required ZERO changes anywhere under src/geo. No kernel patch, no new
 * layer type, no polygon special case.
 *
 * That is the claim the architecture makes, and this file is the evidence.
 * `git diff src/geo/` across the commit that added this directory is empty.
 *
 * It renders in the 'fill' slot, below the 'line' slot used by trails and the
 * 'symbol' slot used by pins — so it composes with live entities on the same
 * surface without either module knowing the other exists.
 */

import React from 'react';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { mapStyles, useTokens } from '@design';
import { VENUE_ZONES } from './zones';

export const SOURCE_ZONES = 'venue-zones/polygons';

export function VenueZonesLayers() {
  const tokens = useTokens();

  return (
    <GeoJSONSource id={SOURCE_ZONES} data={VENUE_ZONES as GeoJSON.FeatureCollection}>
      <Layer
        id="venue-zones/fill"
        type="fill"
        // Slot: 'fill' — the lowest data slot, so pins and trails draw over it.
        paint={mapStyles.zoneFillPaint(tokens)}
      />
      <Layer id="venue-zones/outline" type="line" paint={mapStyles.zoneLinePaint(tokens)} />
    </GeoJSONSource>
  );
}
