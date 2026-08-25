/**
 * Tier 1 — synthetic entity source.
 *
 * The brief explicitly permits "a synthetic/randomiser function instead of
 * relying on sockets/server events". This is that — but built as a first-class
 * Source plugin rather than a `Math.random()` in a `useEffect`, so the same
 * code path, the same registry and the same kernel serve it and a real
 * transport. Swapping between them is a registration change with no JS diff at
 * the call site, which is the property the whole architecture exists to have.
 *
 * TWO MOVEMENT MODELS
 *
 * 1. ROUTE FOLLOWING (when `routes` is supplied) — agents walk polylines, with
 *    speed variance, occasional dwell, and turn-arounds at the ends. This is
 *    what makes a demo read as *people on streets*. Free wandering produces
 *    entities standing in lakes and walking through buildings, which destroys
 *    the credibility of everything else on screen.
 *
 * 2. FREE WANDER (no routes) — waypoint steering with momentum. Retained for
 *    load testing, where the point is entity count rather than plausibility.
 *
 * The framework does not know whether a route is a road, a marathon course or a
 * delivery circuit. Routes are just polylines; meaning lives in the kit.
 *
 * It also injects two kinds of bad data on purpose:
 *   - accuracy noise, occasionally beyond the kernel's accuracy gate
 *   - rare GPS "teleports" beyond the plausible-speed gate
 * so the HUD's rejected-fix counter demonstrates the validation actually works
 * rather than being asserted in a document.
 */

import { METRES_PER_DEGREE_LAT, bearingDeg, distanceM, metresPerDegreeLng } from '../kernel/geodesy';
import type { EntityFix, Position } from '../kernel/types';
import type {
  AccuracyProfile,
  Source,
  SourceCapabilities,
  SourceConfig,
  SourceSink,
} from '../ports/Source';

export const MOCK_SOURCE_ID = 'mock-synthetic';

/** Speed personas in m/s. Mixed populations make the map look alive. */
const PERSONAS = [
  { kind: 'walking', speed: 1.4, wanderM: 300 },
  { kind: 'jogging', speed: 3.1, wanderM: 700 },
  { kind: 'cycling', speed: 6.0, wanderM: 1500 },
  { kind: 'driving', speed: 12.5, wanderM: 3000 },
  // ~3.6 m/s is a 4:38/km pace — a credible mid-pack race runner.
  { kind: 'running', speed: 3.6, wanderM: 1000 },
] as const;

/**
 * A cohort sharing a set of routes, a persona and a set of attributes.
 *
 * Groups exist because a realistic scene is heterogeneous: runners on a course
 * move differently from spectators circulating a venue, and a single global
 * persona pool cannot express that. Still domain-free — the framework does not
 * know one group is a race and the other a crowd.
 */
export interface AgentGroup {
  count: number;
  routes: readonly (readonly Position[])[];
  /** Index into the persona table above. */
  persona: number;
  labels?: readonly string[];
  /** Opaque attributes stamped on every fix from this cohort. */
  attributes?: Readonly<Record<string, string | number | boolean>>;
}

const TEAMS = ['red', 'blue', 'green', 'amber'];

/** A polyline with cumulative distances precomputed, so lookups are O(segments). */
interface PreparedRoute {
  points: readonly Position[];
  /** cum[i] = metres from route start to points[i]. */
  cum: number[];
  totalM: number;
  /**
   * True when the polyline closes on itself.
   *
   * Closed routes WRAP; open routes reverse at the ends. Getting this wrong is
   * visible immediately: runners on a lap would bounce back down the course
   * into oncoming traffic, and a crowd circulating a venue would oscillate
   * instead of circulating.
   */
  closed: boolean;
}

interface Agent {
  id: string;
  lng: number;
  lat: number;
  bearing: number;
  speed: number;
  personaIndex: number;
  team: string;
  label: string;
  /** Extra opaque attributes contributed by this agent's group. */
  extra: Readonly<Record<string, string | number | boolean>>;
  /** Stable index used by kits to differentiate entities visually. */
  variant: number;
  /** Raw spawn index — the seed for every deterministic quantity. */
  index: number;
  /** Personal speed multiplier, derived from index so it never varies per run. */
  speedMul: number;
  /** Distance along the route at simulation time zero. */
  startS: number;
  /** Direction at simulation time zero. */
  dir0: 1 | -1;

  /** Free-wander target. Unused when following a route. */
  targetLng: number;
  targetLat: number;

  /** Route following. null = free wander. */
  route: PreparedRoute | null;
  /** Metres travelled from the route start. */
  s: number;
  direction: 1 | -1;
  /** Seconds remaining of a deliberate pause. */
  dwellSec: number;
}

export interface MockSourceOptions {
  entityCount: number;
  centerLng: number;
  centerLat: number;
  radiusM: number;
  intervalMs: number;
  teleportRate: number;
  badAccuracyRate: number;
  /** Polylines for agents to follow. Domain-free. */
  routes?: readonly (readonly Position[])[];
  /** Per-entity labels, surfaced as an opaque attribute for style expressions. */
  labels?: readonly string[];
  /** Probability per second that a route-following agent pauses. */
  dwellRate: number;
  /** Persona indices to draw from. Lets a scenario be all pedestrians. */
  personaPool?: readonly number[];
  /**
   * Heterogeneous cohorts. When present, overrides entityCount/routes/labels —
   * the scene is described as groups rather than one uniform population.
   */
  groups?: readonly AgentGroup[];
}

export const DEFAULT_MOCK_OPTIONS: MockSourceOptions = {
  entityCount: 200,
  // Bengaluru — dense street grid makes trails legible at demo zoom.
  centerLng: 77.5946,
  centerLat: 12.9716,
  radiusM: 2500,
  intervalMs: 1000,
  teleportRate: 0.002,
  badAccuracyRate: 0.01,
  dwellRate: 0.02,
};

/**
 * Deterministic offset along a route for entity `n`.
 *
 * The golden-ratio conjugate produces a low-discrepancy sequence: successive
 * indices land far apart, so a cohort spreads evenly along its course without
 * the clumping a hash would give. Identical arithmetic exists in the Kotlin
 * provider — any divergence would show up instantly as friends jumping when the
 * provider is swapped.
 */
export function routeOffset(n: number, totalM: number): number {
  const frac = (n + 1) * GOLDEN_CONJUGATE;
  return (frac - Math.floor(frac)) * totalM;
}

const GOLDEN_CONJUGATE = 0.618033988749895;

/** Deterministic per-agent jitter in [0,1). Same formula in Kotlin. */
export function agentNoise(n: number, salt: number): number {
  const frac = (n + 1) * GOLDEN_CONJUGATE + salt * 0.7548776662466927;
  return frac - Math.floor(frac);
}

/** Dwell cycle: every agent pauses DWELL_S out of every CYCLE_S, phase-offset by index. */
const CYCLE_S = 40;
const DWELL_S = 5;
const MOVING_S = CYCLE_S - DWELL_S;

/**
 * Seconds actually spent MOVING by time `tSec`.
 *
 * Computed in closed form rather than integrated. That is the whole point: a
 * position derived by accumulating `speed * dt` depends on the exact sequence
 * of frame deltas, so restarting a provider — or running the same simulation on
 * another thread in another language — produces a different answer and every
 * friend visibly jumps.
 *
 * As a pure function of absolute time, both providers agree exactly and a
 * provider swap transfers no state at all.
 */
export function movingSeconds(n: number, tSec: number): number {
  const phase = agentNoise(n, 3) * CYCLE_S;
  const shifted = tSec + phase;
  const cycles = Math.floor(shifted / CYCLE_S);
  const rem = shifted - cycles * CYCLE_S;
  const active = cycles * MOVING_S + Math.min(rem, MOVING_S);
  const activeAtZero =
    Math.floor(phase / CYCLE_S) * MOVING_S + Math.min(phase - Math.floor(phase / CYCLE_S) * CYCLE_S, MOVING_S);
  return active - activeAtZero;
}

/** Position along a closed/open route at absolute simulation time. */
export function routeDistanceAt(
  n: number,
  speed: number,
  totalM: number,
  startS: number,
  direction: number,
  tSec: number,
): { s: number; direction: number } {
  const travelled = speed * movingSeconds(n, tSec);
  let s = startS + direction * travelled;
  if (totalM <= 0) {
    return { s: 0, direction };
  }
  // Closed routes wrap; open routes reflect back and forth.
  const span = totalM;
  let dir = direction;
  if (s < 0 || s > span) {
    const period = span * 2;
    let m = ((s % period) + period) % period;
    if (m > span) {
      m = period - m;
      dir = -direction;
    }
    s = m;
  }
  return { s, direction: dir };
}

function prepareRoute(points: readonly Position[]): PreparedRoute {
  const cum: number[] = [0];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Position;
    const b = points[i] as Position;
    total += distanceM(a[0], a[1], b[0], b[1]);
    cum.push(total);
  }
  const first = points[0] as Position;
  const last = points[points.length - 1] as Position;
  const closed =
    Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9;

  return { points, cum, totalM: total, closed };
}

/** Position at `s` metres along the route, clamped to its ends. */
function positionAt(route: PreparedRoute, s: number): Position {
  const clamped = s < 0 ? 0 : s > route.totalM ? route.totalM : s;

  // Routes here are a handful of segments; a linear scan beats binary search
  // overhead and keeps the code obvious.
  let i = 1;
  while (i < route.cum.length && (route.cum[i] as number) < clamped) {
    i++;
  }
  const prev = Math.max(0, i - 1);
  const a = route.points[prev] as Position;
  const b = (route.points[i] ?? route.points[prev]) as Position;

  const segStart = route.cum[prev] as number;
  const segLen = (route.cum[i] ?? segStart) - segStart;
  const t = segLen > 0 ? (clamped - segStart) / segLen : 0;

  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function createMockSource(options: Partial<MockSourceOptions> = {}): Source {
  const opts: MockSourceOptions = { ...DEFAULT_MOCK_OPTIONS, ...options };
  const routes = (opts.routes ?? []).filter(r => r.length >= 2).map(prepareRoute);
  const usingRoutes = routes.length > 0;

  let agents: Agent[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let profile: AccuracyProfile = 'auto';
  let lastTickMs = 0;

  /** Builds one agent on a prepared route, spread randomly along it. */
  function makeRouteAgent(
    id: string,
    route: PreparedRoute,
    personaIndex: number,
    label: string,
    extra: Readonly<Record<string, string | number | boolean>>,
    teamIndex: number,
    indexForSpread: number = teamIndex,
  ): Agent {
    const persona = PERSONAS[personaIndex] as (typeof PERSONAS)[number];
    // DETERMINISTIC placement, shared byte-for-byte with the native provider.
    //
    // Random spawn made switching providers teleport everyone, which both looks
    // broken and destroys the comparison: the two sides must differ only in HOW
    // the data reaches the map, never in where anyone is. The golden-ratio
    // sequence spreads agents evenly without clustering, and depends on nothing
    // but the index.
    const s = routeOffset(indexForSpread, route.totalM);
    const p = positionAt(route, s);
    return {
      id,
      lng: p[0],
      lat: p[1],
      bearing: 0,
      speed: persona.speed,
      personaIndex,
      team: TEAMS[teamIndex % TEAMS.length] as string,
      label,
      extra,
      // Unique per entity, not wrapped to a small palette size — identity
      // colour has to be generated with room for as many people as the
      // roster actually has, or it starts repeating well before 32.
      variant: teamIndex,
      targetLng: p[0],
      targetLat: p[1],
      route,
      s,
      // Closed courses are run in one direction; open paths may start either way.
      // Direction is deterministic too, for the same reason.
      direction: route.closed ? 1 : indexForSpread % 2 === 0 ? 1 : -1,
      dwellSec: 0,
      index: indexForSpread,
      speedMul: 0.85 + agentNoise(indexForSpread, 1) * 0.3,
      startS: s,
      dir0: route.closed ? 1 : indexForSpread % 2 === 0 ? 1 : -1,
    };
  }

  function spawnGroups(groups: readonly AgentGroup[]): Agent[] {
    const out: Agent[] = [];
    let n = 0;
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g] as AgentGroup;
      const prepared = group.routes.filter(r => r.length >= 2).map(prepareRoute);
      if (prepared.length === 0) {
        continue;
      }
      for (let i = 0; i < group.count; i++) {
        const route = prepared[i % prepared.length] as PreparedRoute;
        out.push(
          makeRouteAgent(
            `e-${n.toString().padStart(4, '0')}`,
            route,
            group.persona,
            group.labels?.[i % (group.labels.length || 1)] ?? `#${i + 1}`,
            group.attributes ?? {},
            n,
            n,
          ),
        );
        n++;
      }
    }
    return out;
  }

  function spawn(): Agent[] {
    if (opts.groups && opts.groups.length > 0) {
      return spawnGroups(opts.groups);
    }

    const out: Agent[] = [];
    const mPerLng = metresPerDegreeLng(opts.centerLat);
    const pool = opts.personaPool ?? [0, 1, 2, 3];

    for (let i = 0; i < opts.entityCount; i++) {
      const personaIndex = pool[i % pool.length] as number;
      const persona = PERSONAS[personaIndex] as (typeof PERSONAS)[number];

      let lng: number;
      let lat: number;
      let route: PreparedRoute | null = null;
      let s = 0;

      if (usingRoutes) {
        route = routes[i % routes.length] as PreparedRoute;
        // Spread agents along the route rather than bunching them at the start.
        s = Math.random() * route.totalM;
        const p = positionAt(route, s);
        lng = p[0];
        lat = p[1];
      } else {
        // Uniform-area disc sampling: sqrt keeps the population from clumping at
        // the centre the way naive uniform-radius sampling does.
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.sqrt(Math.random()) * opts.radiusM;
        lng = opts.centerLng + (Math.cos(angle) * distance) / mPerLng;
        lat = opts.centerLat + (Math.sin(angle) * distance) / METRES_PER_DEGREE_LAT;
      }

      const agent: Agent = {
        id: `e-${i.toString().padStart(4, '0')}`,
        lng,
        lat,
        bearing: Math.random() * 360,
        speed: persona.speed,
        personaIndex,
        team: TEAMS[i % TEAMS.length] as string,
        label: opts.labels?.[i] ?? `#${i + 1}`,
        extra: {},
        variant: i,
        targetLng: lng,
        targetLat: lat,
        route,
        s,
        direction: Math.random() < 0.5 ? -1 : 1,
        dwellSec: 0,
        index: i,
        speedMul: 1,
        startS: s,
        dir0: 1,
      };

      if (!usingRoutes) {
        pickWaypoint(agent);
      }
      out.push(agent);
    }
    return out;
  }

  function pickWaypoint(agent: Agent): void {
    const persona = PERSONAS[agent.personaIndex] as (typeof PERSONAS)[number];
    const mPerLng = metresPerDegreeLng(agent.lat);
    const angle = Math.random() * Math.PI * 2;
    const distance = persona.wanderM * (0.4 + Math.random() * 0.6);

    agent.targetLng = agent.lng + (Math.cos(angle) * distance) / mPerLng;
    agent.targetLat = agent.lat + (Math.sin(angle) * distance) / METRES_PER_DEGREE_LAT;
  }

  /**
   * Evaluate the agent's position at absolute wall-clock time.
   *
   * NOT an integration. Deriving position by accumulating `speed * dt` makes it
   * depend on the exact sequence of frame deltas, so restarting a provider —
   * or running the same simulation on another thread in another language —
   * lands somewhere else and every friend visibly jumps.
   *
   * Keyed off wall-clock rather than a session epoch, so the two providers need
   * to agree on nothing at all: same clock, same formula, same answer.
   */
  function evalRoute(agent: Agent, nowMs: number): void {
    const route = agent.route as PreparedRoute;
    const persona = PERSONAS[agent.personaIndex] as (typeof PERSONAS)[number];
    const speed = persona.speed * agent.speedMul;
    const tSec = nowMs / 1000;

    const at = routeDistanceAt(agent.index, speed, route.totalM, agent.startS, agent.dir0, tSec);
    const p = positionAt(route, at.s);

    // Heading from a short lookback, so arrows point along the road without
    // needing any retained state.
    const back = routeDistanceAt(agent.index, speed, route.totalM, agent.startS, agent.dir0, tSec - 1);
    const bp = positionAt(route, back.s);

    agent.s = at.s;
    agent.direction = at.direction as 1 | -1;
    agent.lng = p[0];
    agent.lat = p[1];
    if (distanceM(bp[0], bp[1], p[0], p[1]) > 0.5) {
      agent.bearing = bearingDeg(bp[0], bp[1], p[0], p[1]);
    }
    // Dwelling shows as zero speed, which the kit renders via the `moving` attr.
    agent.speed =
      movingSeconds(agent.index, tSec) - movingSeconds(agent.index, tSec - 1) > 0.5 ? speed : 0;
  }

  function stepWander(agent: Agent, dtSec: number): void {
    const mPerLng = metresPerDegreeLng(agent.lat);
    const dLng = (agent.targetLng - agent.lng) * mPerLng;
    const dLat = (agent.targetLat - agent.lat) * METRES_PER_DEGREE_LAT;

    if (Math.hypot(dLng, dLat) < 15) {
      pickWaypoint(agent);
      return;
    }

    // Steer gradually toward the waypoint instead of snapping heading — this is
    // what produces curved, plausible trails rather than polylines with corners.
    const desired = (Math.atan2(dLng, dLat) * 180) / Math.PI;
    let delta = ((desired - agent.bearing + 540) % 360) - 180;
    const maxTurn = 45 * dtSec;
    if (delta > maxTurn) {
      delta = maxTurn;
    } else if (delta < -maxTurn) {
      delta = -maxTurn;
    }
    agent.bearing = (agent.bearing + delta + 360) % 360;

    const persona = PERSONAS[agent.personaIndex] as (typeof PERSONAS)[number];
    agent.speed = persona.speed * (0.85 + Math.random() * 0.3);

    const travel = agent.speed * dtSec;
    const rad = (agent.bearing * Math.PI) / 180;
    agent.lng += (Math.sin(rad) * travel) / mPerLng;
    agent.lat += (Math.cos(rad) * travel) / METRES_PER_DEGREE_LAT;
  }

  return {
    id: MOCK_SOURCE_ID,
    volatility: 'kinetic',

    capabilities(): SourceCapabilities {
      return {
        sourceId: MOCK_SOURCE_ID,
        backgroundTracking: false,
        activityRecognition: false,
        deferredUpdates: false,
        maxEntities:
          opts.groups?.reduce((n, g) => n + g.count, 0) ?? opts.entityCount,
        producesTracks: false,
      };
    },

    start(_config: SourceConfig, sink: SourceSink): void {
      agents = spawn();
      lastTickMs = Date.now();

      // Emit an immediate first batch so the map is populated before the first
      // interval elapses — otherwise the demo opens on an empty screen.
      // Evaluate before the first emit so agents appear at their true
      // wall-clock position rather than at their t=0 seed.
      const t0 = Date.now();
      for (const a of agents) {
        if (a.route) {
          evalRoute(a, t0);
        }
      }
      sink.emit(agents.map(a => toFix(a, t0, opts)));

      timer = setInterval(() => {
        const now = Date.now();
        const dtSec = Math.min((now - lastTickMs) / 1000, 5);
        lastTickMs = now;

        const batch: EntityFix[] = new Array(agents.length);
        for (let i = 0; i < agents.length; i++) {
          const agent = agents[i] as Agent;
          if (agent.route) {
            evalRoute(agent, now);
          } else {
            stepWander(agent, dtSec);
          }
          batch[i] = toFix(agent, now, opts);
        }

        // One batched emit per tick, never one call per entity — matching how a
        // real transport delivers, and keeping the crossing cost O(1) in entities.
        sink.emit(batch);
      }, opts.intervalMs);
    },

    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      agents = [];
    },

    setAccuracyProfile(next: AccuracyProfile): void {
      // A synthetic source has no radio to throttle, so this only records intent.
      // Honouring it is what a real source does differently — and precisely the
      // difference the capability flags exist to describe.
      profile = next;
      void profile;
    },
  };
}

function toFix(agent: Agent, now: number, opts: MockSourceOptions): EntityFix {
  const teleport = Math.random() < opts.teleportRate;
  const badAccuracy = Math.random() < opts.badAccuracyRate;

  return {
    id: agent.id,
    // A teleport throws the fix ~5km sideways; the kernel's speed gate should
    // reject it and increment the HUD's rejected counter.
    lng: teleport ? agent.lng + 0.05 : agent.lng,
    lat: agent.lat,
    bearing: agent.bearing,
    speed: agent.speed,
    accuracy: badAccuracy ? 250 : 5 + Math.random() * 10,
    timestamp: now,
    attributes: {
      ...agent.extra,
      // A stable per-entity discriminator. Deliberately NOT called `colour`:
      // the framework assigns an arbitrary index and has no opinion about how
      // a kit renders it. The live-entities kit maps it onto the identity
      // palette; a different kit could map it to an icon or a shape.
      variant: agent.variant,
      team: agent.team,
      label: agent.label,
      persona: (PERSONAS[agent.personaIndex] as (typeof PERSONAS)[number]).kind,
      moving: agent.speed > 0.2,
    },
  };
}
