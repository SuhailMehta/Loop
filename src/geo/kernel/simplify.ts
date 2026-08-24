/**
 * Tier 0 — Ramer-Douglas-Peucker line simplification.
 *
 * WHY THIS EXISTS: a 5-minute trail at 1Hz is 300 points. At city zoom most of
 * those points land on the same handful of pixels, so we pay serialisation and
 * vertex cost for geometry nobody can see. RDP drops them while preserving the
 * shape a human actually perceives — typically 300 -> ~40 points with no
 * visible difference.
 *
 * NOTE: MapLibre also applies its own Douglas-Peucker at tile-build time (the
 * GeoJSONSource `tolerance` prop). That does not make this redundant — theirs
 * reduces what gets drawn, ours reduces what gets STORED and what crosses into
 * the renderer. We want both, for different reasons.
 *
 * Distances are computed in degree space rather than metres. Over a trail-sized
 * extent the error from ignoring latitude convergence is far below the visual
 * threshold, and it keeps this function allocation-free and trigonometry-free
 * on a path that runs on every track update.
 */

import type { Position } from './types';

/**
 * Squared perpendicular distance from `p` to segment `a`-`b`.
 * Squared to avoid a sqrt in the inner loop; the caller squares its tolerance
 * once to compensate.
 */
function perpendicularDistanceSq(p: Position, a: Position, b: Position): number {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;

  let dx = bx - ax;
  let dy = by - ay;

  // Degenerate segment: fall back to point-to-point distance.
  if (dx === 0 && dy === 0) {
    const ddx = px - ax;
    const ddy = py - ay;
    return ddx * ddx + ddy * ddy;
  }

  // Project p onto the segment, clamped to [0,1] so we measure to the segment
  // rather than to its infinite extension.
  const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;

  dx = ax + clamped * dx - px;
  dy = ay + clamped * dy - py;
  return dx * dx + dy * dy;
}

/**
 * Iterative RDP. Iterative rather than recursive because a pathological trail
 * (a long straight run) can recurse deeply enough to matter on Hermes, and this
 * runs on the ingest path.
 */
export function simplify(points: readonly Position[], tolerance: number): Position[] {
  if (points.length <= 2) {
    return points.slice();
  }

  const toleranceSq = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Explicit stack of [start, end] index pairs.
  const stack: number[] = [0, points.length - 1];

  while (stack.length > 0) {
    const end = stack.pop() as number;
    const start = stack.pop() as number;

    let maxDistSq = 0;
    let maxIndex = 0;

    const a = points[start] as Position;
    const b = points[end] as Position;

    for (let i = start + 1; i < end; i++) {
      const distSq = perpendicularDistanceSq(points[i] as Position, a, b);
      if (distSq > maxDistSq) {
        maxDistSq = distSq;
        maxIndex = i;
      }
    }

    if (maxDistSq > toleranceSq) {
      keep[maxIndex] = 1;
      stack.push(start, maxIndex, maxIndex, end);
    }
  }

  const out: Position[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i] === 1) {
      out.push(points[i] as Position);
    }
  }
  return out;
}
