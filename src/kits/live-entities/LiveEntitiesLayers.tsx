/**
 * Tier 3 — use-case kit: live entities on a map.
 *
 * This is the "share your live location with friends" use case. Note how little
 * there is: two sources and a handful of layers, all styling delegated to design
 * tokens. Every hard part — interpolation, tracks, staleness, validation,
 * culling, aggregation — lives in the framework and is inherited.
 *
 * The word "friend" appears nowhere below, and that is deliberate. To this kit
 * they are entities with `role` and `label` attributes; the same file would
 * serve delivery riders or race participants by changing only the expressions.
 *
 * LAYER ORDER (bottom to top) is slot order:
 *   trail      'line'    movement history
 *   cluster    'symbol'  aggregated cells, when a use case opts in
 *   pin        'symbol'  ordinary participants
 *   runner     'symbol'  the second cohort
 *   self       'symbol'  the local user, always above the crowd
 *   highlight  'overlay' selection ring
 */

import React, { useCallback } from 'react';
import type { NativeSyntheticEvent } from 'react-native';
import {
  GeoJSONSource,
  Layer,
  type PressEventWithFeatures,
} from '@maplibre/maplibre-react-native';
import { mapStyles, useTokens } from '@design';

export interface SelectedFeature {
  id: string;
  lng: number;
  lat: number;
  label: string;
  /** Grounded in event registration, not an arbitrary cohort tag. */
  participation: string;
  /** Opaque identity discriminator assigned by the source. */
  variant: number;
  isSelf: boolean;
  persona: string;
  freshness: string;
}

export interface LiveEntitiesLayersProps {
  points: unknown;
  tracks: unknown;
  showTracks?: boolean;
  selectedId?: string | null;
  onSelect?: (entity: SelectedFeature | null) => void;
  /**
   * Which entities may draw, by feature id. 'all' skips the filter entirely
   * rather than building a no-op one — the common case pays nothing extra.
   * The local user is never subject to this: filtering your friends should
   * never be able to hide you from yourself.
   */
  visibleIds?: 'all' | ReadonlySet<string>;
}

export const SOURCE_POINTS = 'live-entities/points';
export const SOURCE_TRACKS = 'live-entities/tracks';

export function LiveEntitiesLayers({
  points,
  tracks,
  showTracks = true,
  selectedId = null,
  onSelect,
  visibleIds = 'all',
}: LiveEntitiesLayersProps) {
  const tokens = useTokens();

  // Appended to a layer's own filter, never replacing it. Omitted entirely
  // for 'all' so the common case is the same filter MapLibre always ran.
  const visibilityTerm: unknown[] | null =
    visibleIds === 'all' ? null : ['in', ['id'], ['literal', Array.from(visibleIds)]];

  const handlePress = useCallback(
    (event: NativeSyntheticEvent<PressEventWithFeatures>) => {
      if (!onSelect) {
        return;
      }
      const feature = event.nativeEvent.features?.[0];
      const geometry = feature?.geometry;

      if (!feature || !geometry || geometry.type !== 'Point') {
        onSelect(null);
        return;
      }

      const props = (feature.properties ?? {}) as Record<string, unknown>;
      // Tapping an aggregated cell selects nobody — there is no single person
      // behind it. Expanding to its bounds is the natural next affordance.
      if (props.cluster === true) {
        onSelect(null);
        return;
      }

      const [lng, lat] = geometry.coordinates as [number, number];
      onSelect({
        id: String(feature.id ?? props.label ?? 'unknown'),
        lng,
        lat,
        label: String(props.label ?? 'Unknown'),
        participation: String(props.participation ?? 'supporter'),
        variant: Number(props.variant ?? 0),
        isSelf: props.freshness === 'self',
        persona: String(props.persona ?? ''),
        freshness: String(props.freshness ?? 'fresh'),
      });
    },
    [onSelect],
  );

  return (
    <>
      {showTracks ? (
        <GeoJSONSource id={SOURCE_TRACKS} data={tracks as GeoJSON.FeatureCollection} lineMetrics>
          <Layer
            id="live-entities/trail"
            type="line"
            filter={visibilityTerm ? (visibilityTerm as never) : undefined}
            paint={mapStyles.trailLinePaint(tokens)}
            layout={mapStyles.trailLineLayout}
          />
        </GeoJSONSource>
      ) : null}

      <GeoJSONSource
        id={SOURCE_POINTS}
        data={points as GeoJSON.FeatureCollection}
        onPress={handlePress}
        // Fingers are imprecise and pins are ~14px across; without a hitbox the
        // user misses more often than they hit. 22pt each side gives roughly
        // the 44pt touch target both platforms' guidelines call for.
        hitbox={{ top: 22, right: 22, bottom: 22, left: 22 }}
      >
        <Layer
          id="live-entities/cluster"
          type="circle"
          filter={['==', ['get', 'cluster'], true]}
          paint={mapStyles.clusterCirclePaint(tokens)}
        />
        <Layer
          id="live-entities/cluster-count"
          type="symbol"
          filter={['==', ['get', 'cluster'], true]}
          layout={mapStyles.clusterCountLayout()}
          paint={mapStyles.clusterCountPaint(tokens)}
        />

        {/*
          Cohorts separated by style-spec filters on opaque attributes. The
          kernel stores one homogeneous entity set and knows nothing about
          runners or selves; the kit decides what those tags mean visually.
        */}
        {/*
          ONE layer for every friend, one uniform colour.

          Who's who is answered by the Friends list, not by hue — a colour
          scheme runs out of distinguishable steps long before a name does.
          Whether someone is racing is answered in words on tap, same as
          before.
        */}
        <Layer
          id="live-entities/pin"
          type="circle"
          filter={
            [
              'all',
              ['!=', ['get', 'cluster'], true],
              ['!=', ['get', 'freshness'], 'self'],
              ...(visibilityTerm ? [visibilityTerm] : []),
            ] as never
          }
          paint={mapStyles.entityCirclePaint(tokens)}
        />

        {/*
          The local user, drawn last so it is never hidden under the crowd.

          Identified by the kernel's own `freshness: 'self'` stamp (set via
          EntityStore.setSelfId) rather than a duplicate attribute — one source
          of truth for "this is me", and it cannot drift out of sync.
        */}
        <Layer
          id="live-entities/self"
          type="circle"
          filter={['==', ['get', 'freshness'], 'self']}
          paint={mapStyles.selfCirclePaint(tokens)}
        />

        {/* Selection ring — 'overlay' slot, above every data layer. */}
        {selectedId ? (
          <Layer
            id="live-entities/highlight"
            type="circle"
            filter={['==', ['get', 'label'], selectedId]}
            paint={mapStyles.highlightPaint(tokens)}
          />
        ) : null}

        {/*
          Names, shown only for the selected entity. Labelling every pin at once
          turns a busy map into unreadable soup, and MapLibre would spend the
          frame budget on label collision for text nobody asked for.
        */}
        {selectedId ? (
          <Layer
            id="live-entities/label"
            type="symbol"
            filter={['==', ['get', 'label'], selectedId]}
            layout={mapStyles.entityLabelLayout()}
            paint={mapStyles.entityLabelPaint(tokens)}
          />
        ) : null}
      </GeoJSONSource>
    </>
  );
}
