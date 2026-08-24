/**
 * Tier: design (leaf).
 *
 * SEMANTIC tokens: the public surface. Named by ROLE, never by colour, so a
 * theme swap is a data change rather than a code change.
 *
 * `SemanticTokens` is declared once and both themes are typed against it, so
 * adding a token to light without adding it to dark is a compile error. That
 * single constraint is what stops themes drifting apart over a project's life.
 */

import { identityPalette, mark, motion, opacity, palette, radius, space, typography } from './primitives';

export type ThemeName = 'light' | 'dark';

export interface SemanticTokens {
  name: ThemeName;

  /** Chrome — sheets, cards, HUD, controls. */
  surface: {
    base: string;
    elevated: string;
    sunken: string;
    /** Translucent scrim for panels floating over the map. */
    overlay: string;
    border: string;
  };

  text: {
    primary: string;
    secondary: string;
    /** For use on top of `accent.base`. */
    inverse: string;
  };

  accent: {
    base: string;
    muted: string;
    strong: string;
  };

  status: {
    ok: string;
    warn: string;
    danger: string;
  };

  /**
   * Map-specific roles. These are consumed by the MapLibre adapter, not by
   * StyleSheet — but they live here so the map and the chrome are provably
   * the same design system rather than two palettes that happen to coexist.
   */
  map: {
    /**
     * Basemap style URL. Swapping this is how dark mode reaches the map —
     * colour tokens alone cannot re-tint vector tiles.
     */
    basemapStyleUrl: string;
    /** Attribution string the basemap licence requires us to display. */
    basemapAttribution: string;

    /** Entity freshness ramp. Drives the staleness rendering states. */
    entity: {
      fresh: string;
      stale: string;
      dead: string;
      self: string;
      /** Outline keeps pins legible against busy tiles at any zoom. */
      stroke: string;
    };

    /**
     * Per-person identity colours, indexed by an opaque `hue` attribute.
     *
     * Identity is the thing a user actually tracks on this map. Freshness moves
     * to opacity so the two signals occupy different channels and never
     * compete — hue answers "who", opacity answers "how current".
     */
    identity: readonly string[];
    /** Outline for a stale pin, so age reads even where opacity is subtle. */
    staleStroke: string;

    /** Movement trails. Head is the newest point, tail the oldest. */
    trail: {
      head: string;
      tail: string;
    };

    /** Polygon layers — zones, geofences, coverage. */
    zone: {
      fill: string;
      stroke: string;
      fillOpacity: number;
      selectedFill: string;
    };

    /** Selection + focus affordances drawn above everything else. */
    highlight: string;
  };
}

/** Primitives re-exported so consumers need exactly one import for scales. */
export const scale = { space, radius, typography, motion, mark, opacity } as const;

/**
 * CARTO's public basemaps give us a matched light/dark vector pair with no API
 * key, which keeps the demo runnable on any machine. A keyed provider
 * (MapTiler, Stadia, self-hosted tiles) drops in by changing this one token —
 * that swappability is the reason it is a token and not a constant.
 */
const BASEMAP_LIGHT = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const BASEMAP_DARK = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const BASEMAP_ATTRIBUTION = '© OpenStreetMap contributors © CARTO';

export const lightTheme: SemanticTokens = {
  name: 'light',
  surface: {
    base: palette.neutral[0],
    elevated: palette.neutral[0],
    sunken: palette.neutral[50],
    overlay: 'rgba(255,255,255,0.86)',
    border: palette.neutral[200],
  },
  text: {
    primary: palette.neutral[900],
    secondary: palette.neutral[500],
    inverse: palette.neutral[0],
  },
  accent: {
    base: palette.blue[500],
    muted: palette.blue[100],
    strong: palette.blue[700],
  },
  status: {
    ok: palette.green[500],
    warn: palette.amber[500],
    danger: palette.red[500],
  },
  map: {
    basemapStyleUrl: BASEMAP_LIGHT,
    basemapAttribution: BASEMAP_ATTRIBUTION,
    entity: {
      fresh: palette.blue[500],
      stale: palette.amber[500],
      dead: palette.neutral[400],
      self: palette.green[500],
      // White outline on a light basemap: the pin fill carries the contrast,
      // the stroke separates overlapping pins from each other.
      stroke: palette.neutral[0],
    },
    identity: identityPalette.light,
    staleStroke: palette.amber[500],
    trail: {
      head: palette.blue[500],
      tail: palette.blue[100],
    },
    zone: {
      fill: palette.violet[500],
      stroke: palette.violet[700],
      fillOpacity: opacity.faint,
      selectedFill: palette.violet[300],
    },
    highlight: palette.neutral[900],
  },
};

export const darkTheme: SemanticTokens = {
  name: 'dark',
  surface: {
    base: palette.neutral[1000],
    elevated: palette.neutral[900],
    sunken: palette.neutral[1000],
    overlay: 'rgba(8,9,12,0.86)',
    border: palette.neutral[800],
  },
  text: {
    primary: palette.neutral[50],
    secondary: palette.neutral[400],
    inverse: palette.neutral[1000],
  },
  accent: {
    base: palette.blue[300],
    muted: palette.blue[900],
    strong: palette.blue[100],
  },
  status: {
    ok: palette.green[300],
    warn: palette.amber[300],
    danger: palette.red[300],
  },
  map: {
    basemapStyleUrl: BASEMAP_DARK,
    basemapAttribution: BASEMAP_ATTRIBUTION,
    entity: {
      // Lighter ramp steps on dark tiles — the 500s used in light mode go muddy
      // against dark-matter's near-black landmass.
      fresh: palette.blue[300],
      stale: palette.amber[300],
      dead: palette.neutral[600],
      self: palette.green[300],
      stroke: palette.neutral[1000],
    },
    identity: identityPalette.dark,
    staleStroke: palette.amber[300],
    trail: {
      head: palette.blue[300],
      tail: palette.blue[900],
    },
    zone: {
      fill: palette.violet[300],
      stroke: palette.violet[100],
      fillOpacity: opacity.soft,
      selectedFill: palette.violet[500],
    },
    highlight: palette.neutral[0],
  },
};

export const themes: Record<ThemeName, SemanticTokens> = {
  light: lightTheme,
  dark: darkTheme,
};
