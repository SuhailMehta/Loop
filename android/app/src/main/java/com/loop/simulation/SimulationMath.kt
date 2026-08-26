package com.loop.simulation

import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

/**
 * Every formula here is mirrored, term for term, in MockSource.ts. A
 * divergence in any one of them is not a rounding error — it is a friend
 * visibly jumping the instant the provider switches from JS to native.
 */
internal object SimulationMath {
    const val TAU = 2.0 * Math.PI
    const val METRES_PER_DEG_LAT = 110_574.0

    const val GOLDEN_CONJUGATE = 0.618033988749895
    const val CYCLE_S = 40.0
    const val DWELL_S = 5.0
    const val MOVING_S = CYCLE_S - DWELL_S
    const val DWELL_RATE = 0.02

    val PERSONA_SPEEDS = doubleArrayOf(1.4, 3.1, 6.0, 12.5, 3.6)
    val PERSONA_WANDER = doubleArrayOf(300.0, 700.0, 1500.0, 3000.0, 1000.0)
    val PERSONA_KINDS = arrayOf("walking", "jogging", "cycling", "driving", "running")

    /** Mirrors routeOffset() in MockSource.ts exactly. */
    fun routeOffset(n: Int, totalM: Double): Double {
        val frac = (n + 1) * GOLDEN_CONJUGATE
        return (frac - floor(frac)) * totalM
    }

    /** Mirrors agentNoise() in MockSource.ts exactly. */
    fun agentNoise(n: Int, salt: Int): Double {
        val frac = (n + 1) * GOLDEN_CONJUGATE + salt * 0.7548776662466927
        return frac - floor(frac)
    }

    /** Mirrors movingSeconds() in MockSource.ts exactly. */
    fun movingSeconds(n: Int, tSec: Double): Double {
        val phase = agentNoise(n, 3) * CYCLE_S
        val shifted = tSec + phase
        val cycles = floor(shifted / CYCLE_S)
        val rem = shifted - cycles * CYCLE_S
        val active = cycles * MOVING_S + min(rem, MOVING_S)
        val zeroCycles = floor(phase / CYCLE_S)
        val activeAtZero =
            zeroCycles * MOVING_S +
                min(phase - zeroCycles * CYCLE_S, MOVING_S)
        return active - activeAtZero
    }

    /** Mirrors routeDistanceAt() in MockSource.ts exactly. Returns (s, direction). */
    fun routeDistanceAt(
        n: Int,
        speed: Double,
        totalM: Double,
        startS: Double,
        direction: Int,
        tSec: Double,
    ): Pair<Double, Int> {
        if (totalM <= 0) return Pair(0.0, direction)
        val travelled = speed * movingSeconds(n, tSec)
        var s = startS + direction * travelled
        var dir = direction
        if (s < 0 || s > totalM) {
            val period = totalM * 2
            var m = ((s % period) + period) % period
            if (m > totalM) {
                m = period - m
                dir = -direction
            }
            s = m
        }
        return Pair(s, dir)
    }

    fun metresPerDegreeLng(lat: Double): Double =
        111_320.0 * cos(Math.toRadians(lat))

    fun haversine(lng1: Double, lat1: Double, lng2: Double, lat2: Double): Double {
        val r = 6_371_008.8
        val dLat = Math.toRadians(lat2 - lat1)
        val dLng = Math.toRadians(lng2 - lng1)
        val a = sin(dLat / 2) * sin(dLat / 2) +
            cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) *
            sin(dLng / 2) * sin(dLng / 2)
        return 2 * r * asin(sqrt(a))
    }

    fun bearingDeg(lng1: Double, lat1: Double, lng2: Double, lat2: Double): Double {
        val phi1 = Math.toRadians(lat1)
        val phi2 = Math.toRadians(lat2)
        val dLambda = Math.toRadians(lng2 - lng1)
        val y = sin(dLambda) * cos(phi2)
        val x = cos(phi1) * sin(phi2) - sin(phi1) * cos(phi2) * cos(dLambda)
        return (Math.toDegrees(atan2(y, x)) + 360.0) % 360.0
    }

    /** Picks a new random wander target near the agent's current position. */
    fun pickWaypoint(agent: Agent) {
        val mPerLng = metresPerDegreeLng(agent.lat)
        val angle = Random.nextDouble() * TAU
        val dist = PERSONA_WANDER[agent.personaIndex % PERSONA_WANDER.size] *
            (0.4 + Random.nextDouble() * 0.6)
        agent.targetLng = agent.lng + (cos(angle) * dist) / mPerLng
        agent.targetLat = agent.lat + (sin(angle) * dist) / METRES_PER_DEG_LAT
    }
}
