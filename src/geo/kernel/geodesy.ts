/**
 * Tier 0 — the minimum spherical maths the kernel needs.
 *
 * Deliberately not a geodesy library. We need three things: distance for the
 * implausible-jump gate, bearing for dead reckoning and heading arrows, and a
 * cheap metres<->degrees conversion for interpolation. Everything else is the
 * renderer's problem.
 */

const EARTH_RADIUS_M = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than the cheaper equirectangular approximation because this
 * feeds the teleport gate: an approximation that drifts at high latitudes would
 * start rejecting legitimate fixes in Reykjavik and accepting bad ones in Nairobi.
 */
export function distanceM(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLng = (lng2 - lng1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial bearing in degrees clockwise from north, normalised to [0, 360). */
export function bearingDeg(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;
  const dLambda = (lng2 - lng1) * DEG_TO_RAD;

  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);

  return (Math.atan2(y, x) * RAD_TO_DEG + 360) % 360;
}

/**
 * Shortest signed angular difference, in [-180, 180].
 *
 * Needed so a heading crossing north interpolates 350deg -> 10deg the short way
 * (+20) instead of spinning the long way round (-340). Rotating markers that
 * whip backwards through a full circle is an instantly recognisable bug.
 */
export function shortestAngleDelta(from: number, to: number): number {
  let delta = ((to - from + 540) % 360) - 180;
  // JS modulo can yield -180; normalise so the range is closed consistently.
  if (delta === -180) {
    delta = 180;
  }
  return delta;
}

/** Interpolate a heading the short way around the circle. */
export function lerpBearing(from: number, to: number, t: number): number {
  return (from + shortestAngleDelta(from, to) * t + 360) % 360;
}

/**
 * Metres per degree of longitude at a given latitude.
 *
 * Longitude degrees converge toward the poles; latitude degrees do not. Used to
 * project a speed in m/s into a per-axis degree delta for extrapolation.
 */
export function metresPerDegreeLng(lat: number): number {
  return 111_320 * Math.cos(lat * DEG_TO_RAD);
}

export const METRES_PER_DEGREE_LAT = 110_574;
