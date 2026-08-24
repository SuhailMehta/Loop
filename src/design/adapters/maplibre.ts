/**
 * Tier: design (leaf).
 *
 * Token -> MapLibre adapter.
 *
 * The map is the design system's SECOND renderer. React Native consumes tokens
 * as JS objects via StyleSheet; MapLibre consumes them as declarative
 * paint/layout JSON evaluated on the GPU. Same tokens, two serialisations.
 *
 * Everything here is a pure function of the theme, called once at layer-build
 * time — never per frame. Domain meaning lives in feature PROPERTIES and is
 * resolved by style expressions, so this file (and the whole geo framework)
 * never learns what a "friend" or a "venue" is.
 *
 * Feature property contract (written by the kernel, read by these expressions):
 *   freshness: "self" | "fresh" | "stale" | "dead"
 *   bearing:   number, degrees clockwise from north
 *   zoneKind:  string, opaque to the framework
 *   selected:  boolean
 */

import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import type {
  CircleLayerSpecification,
  FillLayerSpecification,
  LineLayerSpecification,
  SymbolLayerSpecification,
} from '@maplibre/maplibre-react-native';
import { scale } from '../tokens/semantic';
import type { SemanticTokens } from '../tokens/semantic';

type CirclePaint = CircleLayerSpecification['paint'];
type LinePaint = LineLayerSpecification['paint'];
type FillPaint = FillLayerSpecification['paint'];
type SymbolLayout = SymbolLayerSpecification['layout'];

/**
 * Style-spec expressions are structurally typed as deep recursive unions, which
 * TypeScript cannot narrow from an array literal. This is the single, explicit
 * place where we assert an expression is well-formed; keeping it to one helper
 * means the casts are auditable rather than scattered.
 */
const expr = (e: unknown[]): ExpressionSpecification => e as unknown as ExpressionSpecification;

/**
 * One colour for every friend. Who's who is answered by the Friends list, not
 * by hue — a legend of thirty swatches asks more of the eye than a name does.
 *
 * Self still overrides it: "which one is me" is a real distinction worth its
 * own colour, "which friend is this" is answered by tapping or reading the
 * list instead.
 */
function pinColour(t: SemanticTokens): ExpressionSpecification {
  return expr(['case', ['==', ['get', 'freshness'], 'self'], t.map.entity.self, t.map.entity.fresh]);
}

/**
 * Freshness moved to OPACITY when colour became identity.
 *
 * Two signals cannot share one channel. Hue answers "who is this"; opacity
 * answers "how current is it". A stale friend keeps their colour — otherwise
 * they would appear to become a different person as their signal aged.
 */
function freshnessOpacity(): ExpressionSpecification {
  return expr([
    'match',
    ['get', 'freshness'],
    'stale',
    scale.opacity.medium,
    'dead',
    scale.opacity.soft,
    scale.opacity.full,
  ]);
}

/** Stale pins also take a warning outline — opacity alone is easy to miss. */
function freshnessStroke(t: SemanticTokens): ExpressionSpecification {
  return expr([
    'match',
    ['get', 'freshness'],
    'stale',
    t.map.staleStroke,
    'dead',
    t.map.staleStroke,
    t.map.entity.stroke,
  ]);
}

/**
 * Entity pins.
 *
 * Circle layer rather than symbol layer on purpose: no sprite sheet to load, no
 * per-icon texture binding, and radius/colour are cheap data-driven properties.
 * Icons become a symbol layer in the `symbol` slot above this one when a use
 * case actually needs them.
 */
export function entityCirclePaint(t: SemanticTokens): CirclePaint {
  return {
    'circle-color': pinColour(t),
    'circle-opacity': freshnessOpacity(),
    'circle-stroke-color': freshnessStroke(t),
    'circle-stroke-width': scale.mark.pinStrokeWidth,
    // Radius interpolates with zoom so pins stay tappable when zoomed out
    // without becoming blobs when zoomed in.
    'circle-radius': expr([
      'interpolate',
      ['linear'],
      ['zoom'],
      10,
      scale.mark.pinRadius * 0.7,
      14,
      scale.mark.pinRadius,
      18,
      scale.mark.pinRadius * 1.4,
    ]),
    'circle-pitch-alignment': 'map',
  };
}

/**
 * Aggregated cells. Opt-in only — see the note in useEntityFrames on why
 * aggregation is wrong as a default for a friends map.
 *
 * Radius steps with count rather than scaling linearly: perceived weight goes
 * with area, so a linear radius makes a 50-entity cluster look ten times
 * heavier than a 5-entity one.
 */
export function clusterCirclePaint(t: SemanticTokens): CirclePaint {
  return {
    'circle-color': t.map.entity.fresh,
    'circle-opacity': scale.opacity.strong,
    'circle-stroke-color': t.map.entity.stroke,
    'circle-stroke-width': scale.mark.pinStrokeWidth,
    'circle-radius': expr(['step', ['get', 'count'], 12, 10, 16, 50, 21, 200, 27]),
  };
}

export function clusterCountLayout(): SymbolLayout {
  return {
    'text-field': expr(['to-string', ['get', 'count']]),
    'text-size': 12,
    'text-allow-overlap': true,
    'text-ignore-placement': true,
  };
}

export function clusterCountPaint(t: SemanticTokens): SymbolLayerSpecification['paint'] {
  return { 'text-color': t.text.inverse };
}

/**
 * Name label for the selected entity.
 *
 * Offset above the pin with a halo so it stays legible over both basemaps
 * without a background plate — a plate would occlude the map being read.
 */
export function entityLabelLayout(): SymbolLayout {
  return {
    'text-field': expr(['get', 'label']),
    'text-size': 13,
    'text-offset': [0, -1.6],
    'text-anchor': 'bottom',
    // Only one entity matches this layer's filter, so collision logic would
    // spend budget deciding whether a single label may draw.
    'text-allow-overlap': true,
    'text-ignore-placement': true,
  };
}

export function entityLabelPaint(t: SemanticTokens): SymbolLayerSpecification['paint'] {
  return {
    'text-color': t.text.primary,
    'text-halo-color': t.surface.base,
    'text-halo-width': 1.5,
  };
}

/** The user's own position, drawn larger and above the crowd. */
export function selfCirclePaint(t: SemanticTokens): CirclePaint {
  return {
    'circle-color': t.map.entity.self,
    'circle-stroke-color': t.map.entity.stroke,
    'circle-stroke-width': scale.mark.pinStrokeWidth,
    'circle-radius': scale.mark.pinRadiusSelf,
  };
}

/**
 * Direction-of-travel arrows.
 *
 * `icon-rotate` reads the bearing the kernel already computes for dead
 * reckoning, so heading costs nothing extra to display.
 */
export function bearingSymbolLayout(): SymbolLayout {
  return {
    'icon-image': 'geokit-bearing',
    'icon-rotate': expr(['get', 'bearing']),
    'icon-rotation-alignment': 'map',
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
    'icon-size': 0.6,
  };
}

/**
 * Movement trails.
 *
 * `line-gradient` fades tail -> head so recency is readable without a legend.
 * Requires `lineMetrics: true` on the GeoJSONSource; without it MapLibre
 * silently drops the gradient, which is a genuinely annoying hour to debug.
 */
export function trailLinePaint(t: SemanticTokens): LinePaint {
  return {
    'line-width': scale.mark.trailWidth,
    'line-opacity': scale.opacity.strong,
    'line-gradient': expr([
      'interpolate',
      ['linear'],
      ['line-progress'],
      0,
      t.map.trail.tail,
      1,
      t.map.trail.head,
    ]),
  };
}

/** Trail geometry looks better with round joins at the low point-counts RDP leaves us. */
export const trailLineLayout: LineLayerSpecification['layout'] = {
  'line-cap': 'round',
  'line-join': 'round',
};

/**
 * Polygon zones.
 *
 * Styled by an opaque `zoneKind` property the framework never interprets —
 * this is the extension point that lets a zones module ship without a single
 * change inside src/geo.
 */
export function zoneFillPaint(t: SemanticTokens): FillPaint {
  return {
    'fill-color': expr([
      'case',
      ['boolean', ['get', 'selected'], false],
      t.map.zone.selectedFill,
      t.map.zone.fill,
    ]),
    'fill-opacity': t.map.zone.fillOpacity,
  };
}

export function zoneLinePaint(t: SemanticTokens): LinePaint {
  return {
    'line-color': t.map.zone.stroke,
    'line-width': scale.mark.zoneStrokeWidth,
    'line-opacity': scale.opacity.strong,
  };
}

/** Selection ring drawn in the `overlay` slot, above every module's own layers. */
export function highlightPaint(t: SemanticTokens): CirclePaint {
  return {
    'circle-color': 'transparent',
    'circle-stroke-color': t.map.highlight,
    'circle-stroke-width': 2,
    'circle-radius': scale.mark.pinRadius * 2,
  };
}
