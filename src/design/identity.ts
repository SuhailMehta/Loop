/**
 * Tier: design (leaf).
 *
 * Plain-JS counterpart to the identity colour used on the map. The map's
 * `entityCirclePaint`/`entityHaloPaint` build GPU style expressions from this
 * same function; this is the version RN components call directly (the
 * Friends list avatar, the entity sheet's dot) so a name reads as the same
 * colour everywhere it appears, without a separate legend explaining the
 * key — the Friends list itself, name and colour together, is the key.
 *
 * GENERATED, NOT LOOKED UP
 *
 * A fixed palette repeats once the roster outgrows it — with 8 colours and
 * 32 people, four people share every hue. Hue is instead stepped by the
 * golden ratio conjugate, the same deterministic-spread technique
 * `routeOffset`/`agentNoise` already use for spawn placement (MockSource.ts,
 * mirrored in LoopSourceModule.kt): consecutive multiples of an irrational
 * fraction never land on the same value twice and stay well separated from
 * their neighbours, so any number of entities gets a hue no other entity in
 * a realistic roster also has, with no fixed ceiling to run past.
 */

import type { SemanticTokens } from './tokens/semantic';

const GOLDEN_CONJUGATE = 0.618033988749895;

function hslToHex(h: number, s: number, l: number): string {
  const sFrac = s / 100;
  const lFrac = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sFrac * Math.min(lFrac, 1 - lFrac);
  const f = (n: number) => lFrac - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (n: number) =>
    Math.round(f(n) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(0)}${toHex(8)}${toHex(4)}`;
}

export function identityColor(tokens: SemanticTokens, variant: number): string {
  const hue = (((variant + 1) * GOLDEN_CONJUGATE) % 1) * 360;
  // Dark surfaces need lighter, less saturated marks to stay legible and
  // avoid clipping against the theme's own near-black background.
  const isDark = tokens.name === 'dark';
  return hslToHex(hue, isDark ? 72 : 78, isDark ? 68 : 48);
}
