package com.loop.simulation

import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random
import org.json.JSONArray
import org.json.JSONObject

/**
 * Turns the scenario JSON handed to `start()` into the population this
 * simulation walks. Runs once, at startup — never on a per-tick path.
 */
internal object ScenarioParser {

    fun parse(scenarioJson: String): List<Agent> = buildAgents(JSONObject(scenarioJson))

    private fun buildAgents(cfg: JSONObject): List<Agent> {
        val out = ArrayList<Agent>()
        var n = 0

        val groups = cfg.optJSONArray("groups")
        if (groups != null) {
            for (g in 0 until groups.length()) {
                val group = groups.getJSONObject(g)
                val routes = parseRoutes(group.optJSONArray("routes"))
                if (routes.isEmpty()) continue

                val count = group.optInt("count", 0)
                val persona = group.optInt("persona", 0)
                val labels = group.optJSONArray("labels")
                val extra = parseAttributes(group.optJSONObject("attributes"))

                for (i in 0 until count) {
                    val route = routes[i % routes.size]
                    // Byte-for-byte the same placement the JS provider computes.
                    // See routeOffset() in MockSource.ts — a divergence here
                    // would make friends jump the instant the provider changes.
                    val s = SimulationMath.routeOffset(n, route.totalM)
                    val p = route.positionAt(s)
                    val label =
                        if (labels != null && labels.length() > 0) labels.optString(i % labels.length())
                        else "#${i + 1}"

                    out.add(
                        Agent(
                            id = "e-%04d".format(n),
                            label = label,
                            // Unique per entity — see MockSource.ts's identical fix.
                            variant = n,
                            personaIndex = persona,
                            extra = extra,
                            route = route,
                            lng = p[0],
                            lat = p[1],
                            s = s,
                            // A closed course is run one way; open paths may start either.
                            direction = if (route.closed) 1 else if (n % 2 == 0) 1 else -1,
                            bearing = 0.0,
                            speed = SimulationMath.PERSONA_SPEEDS[persona % SimulationMath.PERSONA_SPEEDS.size],
                            dwellSec = 0.0,
                            targetLng = p[0],
                            targetLat = p[1],
                            index = n,
                            speedMul = 0.85 + SimulationMath.agentNoise(n, 1) * 0.3,
                            startS = s,
                            dir0 = if (route.closed) 1 else if (n % 2 == 0) 1 else -1,
                        ),
                    )
                    n++
                }
            }
        }

        // Fallback: a free-wandering population for throughput testing, where
        // plausibility is not the point.
        val wander = cfg.optInt("wanderCount", 0)
        if (wander > 0) {
            val center = cfg.optJSONArray("center")
            val cLng = center?.optDouble(0) ?: 77.5946
            val cLat = center?.optDouble(1) ?: 12.9716
            val radius = cfg.optDouble("radiusM", 2500.0)
            val mPerLng = SimulationMath.metresPerDegreeLng(cLat)

            for (i in 0 until wander) {
                val angle = Random.nextDouble() * SimulationMath.TAU
                val dist = sqrt(Random.nextDouble()) * radius
                val lng = cLng + (cos(angle) * dist) / mPerLng
                val lat = cLat + (sin(angle) * dist) / SimulationMath.METRES_PER_DEG_LAT
                val persona = i % SimulationMath.PERSONA_SPEEDS.size
                val agent =
                    Agent(
                        id = "e-%04d".format(n),
                        label = "#${i + 1}",
                        variant = n,
                        personaIndex = persona,
                        extra = emptyMap(),
                        route = null,
                        lng = lng,
                        lat = lat,
                        s = 0.0,
                        direction = 1,
                        bearing = Random.nextDouble() * 360.0,
                        speed = SimulationMath.PERSONA_SPEEDS[persona],
                        dwellSec = 0.0,
                        targetLng = lng,
                        targetLat = lat,
                        index = n,
                        speedMul = 1.0,
                        startS = 0.0,
                        dir0 = 1,
                    )
                SimulationMath.pickWaypoint(agent)
                out.add(agent)
                n++
            }
        }

        return out
    }

    private fun parseRoutes(arr: JSONArray?): List<Route> {
        if (arr == null) return emptyList()
        val out = ArrayList<Route>(arr.length())
        for (i in 0 until arr.length()) {
            val line = arr.optJSONArray(i) ?: continue
            if (line.length() < 2) continue
            val pts = Array(line.length()) { j ->
                val pair = line.getJSONArray(j)
                doubleArrayOf(pair.getDouble(0), pair.getDouble(1))
            }
            out.add(Route(pts))
        }
        return out
    }

    private fun parseAttributes(obj: JSONObject?): Map<String, String> {
        if (obj == null) return emptyMap()
        val out = HashMap<String, String>()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            out[k] = obj.optString(k)
        }
        return out
    }
}
