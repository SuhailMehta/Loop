/**
 * Tier: design (leaf — depends on nothing).
 *
 * PRIMITIVE tokens: raw values with no meaning attached.
 * Feature code must never import these directly — `semantic.ts` is the public
 * surface. The indirection is what lets us re-theme without touching consumers.
 *
 * Values are renderer-agnostic on purpose: plain hex strings and numbers, so
 * the same token can be handed to a React Native StyleSheet or serialised into
 * a MapLibre paint spec without conversion.
 */

/** Ramps are 50 (lightest) → 900 (darkest), matching common design-system convention. */
export const palette = {
  neutral: {
    0: '#FFFFFF',
    50: '#F6F7F9',
    100: '#ECEEF2',
    200: '#D8DCE4',
    300: '#B9C0CC',
    400: '#8E97A6',
    500: '#6B7484',
    600: '#4E5665',
    700: '#363D49',
    800: '#21262F',
    900: '#12151A',
    1000: '#08090C',
  },
  /** Live / active / self. The "something is happening" colour. */
  blue: {
    100: '#D6E8FF',
    300: '#7FB4FF',
    500: '#2F80FF',
    700: '#1B54B8',
    900: '#0F2E66',
  },
  /** Fresh data, healthy state. */
  green: {
    100: '#D3F5E3',
    300: '#7BD9A6',
    500: '#21A45B',
    700: '#15703E',
  },
  /** Stale data. Deliberately readable against both light and dark basemaps. */
  amber: {
    100: '#FDF0D5',
    300: '#F5CE76',
    500: '#E8A317',
    700: '#A2710C',
  },
  /** Dead / error / destructive. */
  red: {
    100: '#FBDDDB',
    300: '#F29A94',
    500: '#E2453C',
    700: '#9E2A24',
  },
  /** Zones and polygons — distinct from entity colours so the two layers never read as one. */
  violet: {
    100: '#E8E2FF',
    300: '#BFAEFF',
    500: '#7A5AF8',
    700: '#4F35B8',
  },
} as const;

/** 4pt base grid. Index = multiplier, so `space[4]` is 16pt. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
} as const;

export const radius = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

export const typography = {
  size: { xs: 11, sm: 13, md: 15, lg: 18, xl: 22, xxl: 28 },
  weight: { regular: '400', medium: '500', semibold: '600', bold: '700' },
  /** Unitless multipliers — callers compute `size * lineHeight`. */
  lineHeight: { tight: 1.2, normal: 1.4, relaxed: 1.6 },
  /** Monospace is used by the perf HUD so digits don't jitter as values change. */
  mono: 'monospace',
} as const;

/**
 * Motion. `interpolationMs` is load-bearing, not decorative: it is the assumed
 * gap between position fixes that the Interpolator tweens across. Keep it in
 * sync with the mock source's emit interval and the real source's batch window.
 */
export const motion = {
  duration: { instant: 0, fast: 120, normal: 220, slow: 400 },
  interpolationMs: 1000,
  /** Never extrapolate beyond this multiple of interpolationMs — pins would walk into the sea. */
  maxExtrapolationFactor: 2,
} as const;

/** Sizes for map-rendered marks, in points. */
export const mark = {
  pinRadius: 7,
  pinRadiusSelf: 9,
  pinStrokeWidth: 2,
  trailWidth: 3,
  zoneStrokeWidth: 1.5,
} as const;

/** Opacity steps, shared by both renderers. */
export const opacity = {
  full: 1,
  strong: 0.85,
  medium: 0.55,
  soft: 0.3,
  faint: 0.15,
} as const;

export type Palette = typeof palette;
export type Space = keyof typeof space;
export type Radius = keyof typeof radius;
