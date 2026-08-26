package com.loop.simulation

import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import kotlin.random.Random

/**
 * Ticks the population forward and reports a snapshot ready to cross the JS
 * boundary. Owns no bridge concept — React Native types, JSON parsing and
 * scheduling all live one layer up, in `com.loop.source.bridge`. That split
 * is what makes this class testable with no `ReactApplicationContext` at all.
 */
internal class Simulation {
    private var agents: List<Agent> = emptyList()
    private var lastTickNanos: Long = 0L

    fun start(newAgents: List<Agent>) {
        agents = newAgents
        lastTickNanos = System.nanoTime()
    }

    fun stop() {
        agents = emptyList()
    }

    fun step() {
        val now = System.nanoTime()
        val dtSec = ((now - lastTickNanos) / 1_000_000_000.0).coerceAtMost(5.0)
        lastTickNanos = now

        for (agent in agents) {
            if (agent.route != null) evalRoute(agent, System.currentTimeMillis())
            else stepWander(agent, dtSec)
        }
    }

    /** One fix per agent, with the occasional deliberately-bad reading mixed in. */
    fun snapshot(): List<AgentFix> {
        val now = System.currentTimeMillis().toDouble()
        return agents.map { agent ->
            val teleport = Random.nextDouble() < TELEPORT_RATE
            val badAccuracy = Random.nextDouble() < BAD_ACCURACY_RATE
            AgentFix(
                id = agent.id,
                lng = if (teleport) agent.lng + 0.05 else agent.lng,
                lat = agent.lat,
                bearing = agent.bearing,
                speed = agent.speed,
                accuracy = if (badAccuracy) 250.0 else 5.0 + Random.nextDouble() * 10.0,
                timestamp = now,
                label = agent.label,
                variant = agent.variant,
                persona = SimulationMath.PERSONA_KINDS[agent.personaIndex % SimulationMath.PERSONA_KINDS.size],
                participation = agent.extra["participation"] ?: "supporter",
            )
        }
    }

    /**
     * Evaluate position at absolute wall-clock time — NOT an integration.
     *
     * Accumulating `speed * dt` makes position depend on the exact sequence of
     * tick deltas, so this thread and the JS provider would drift apart and
     * every friend would jump the moment the provider changed. Keyed off
     * wall-clock, the two agree without sharing any state or epoch.
     *
     * Mirrors evalRoute() in MockSource.ts exactly.
     */
    private fun evalRoute(agent: Agent, nowMs: Long) {
        val route = agent.route ?: return
        val speed =
            SimulationMath.PERSONA_SPEEDS[agent.personaIndex % SimulationMath.PERSONA_SPEEDS.size] * agent.speedMul
        val tSec = nowMs / 1000.0

        val at = SimulationMath.routeDistanceAt(agent.index, speed, route.totalM, agent.startS, agent.dir0, tSec)
        val p = route.positionAt(at.first)

        val back =
            SimulationMath.routeDistanceAt(agent.index, speed, route.totalM, agent.startS, agent.dir0, tSec - 1.0)
        val bp = route.positionAt(back.first)

        agent.s = at.first
        agent.direction = at.second
        agent.lng = p[0]
        agent.lat = p[1]
        if (SimulationMath.haversine(bp[0], bp[1], p[0], p[1]) > 0.5) {
            agent.bearing = SimulationMath.bearingDeg(bp[0], bp[1], p[0], p[1])
        }
        agent.speed =
            if (SimulationMath.movingSeconds(agent.index, tSec) -
                SimulationMath.movingSeconds(agent.index, tSec - 1.0) > 0.5
            ) {
                speed
            } else {
                0.0
            }
    }

    private fun stepWander(agent: Agent, dtSec: Double) {
        val mPerLng = SimulationMath.metresPerDegreeLng(agent.lat)
        val dLng = (agent.targetLng - agent.lng) * mPerLng
        val dLat = (agent.targetLat - agent.lat) * SimulationMath.METRES_PER_DEG_LAT
        if (hypot(dLng, dLat) < 15.0) {
            SimulationMath.pickWaypoint(agent)
            return
        }

        val desired = Math.toDegrees(atan2(dLng, dLat))
        var delta = ((desired - agent.bearing + 540.0) % 360.0) - 180.0
        val maxTurn = 45.0 * dtSec
        delta = delta.coerceIn(-maxTurn, maxTurn)
        agent.bearing = (agent.bearing + delta + 360.0) % 360.0

        agent.speed = SimulationMath.PERSONA_SPEEDS[agent.personaIndex % SimulationMath.PERSONA_SPEEDS.size] *
            (0.85 + Random.nextDouble() * 0.3)

        val travel = agent.speed * dtSec
        val rad = Math.toRadians(agent.bearing)
        agent.lng += (sin(rad) * travel) / mPerLng
        agent.lat += (cos(rad) * travel) / SimulationMath.METRES_PER_DEG_LAT
    }

    companion object {
        private const val TELEPORT_RATE = 0.002
        private const val BAD_ACCURACY_RATE = 0.01
    }
}
