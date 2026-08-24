package com.geokit.source

import android.Manifest
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.geokit.specs.NativeGeoKitSourceSpec
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random
import org.json.JSONArray
import org.json.JSONObject

/**
 * Native entity source, implemented as a TurboModule.
 *
 * PROVIDER PARITY IS THE POINT OF THIS FILE
 *
 * An earlier version generated its own free-wandering population. That made the
 * bridge mode useless as a comparison: entities had no names, no participation,
 * and walked through buildings outside every venue, so switching providers
 * changed WHAT was on screen rather than HOW it got there. A swap demo where the
 * two sides show different things proves nothing.
 *
 * So the same scenario — the same OpenStreetMap routes, labels and attributes —
 * is handed to this module at startup and walked with the same movement model.
 * Switching providers now changes only the thread the simulation runs on and the
 * path the data takes to the map. That is the variable under test; everything
 * else is held constant.
 *
 * The structural difference that remains: generation happens on a native thread
 * and never stops when JS is busy.
 */
@ReactModule(name = NativeGeoKitSourceSpec.NAME)
class GeoKitSourceModule(reactContext: ReactApplicationContext) :
    NativeGeoKitSourceSpec(reactContext) {

    init {
        android.util.Log.d("GeoKitSource", "module constructed, instance=${System.identityHashCode(this)}")
        // Registered here rather than resolved by MainApplication reaching into
        // this module, so the module owns its own lifecycle: MainApplication
        // only needs to know a receiver MAY exist, never a concrete instance.
        current = this
    }

    // ---------------------------------------------------------------------
    // Route model — mirrors src/geo/sources/MockSource.ts
    // ---------------------------------------------------------------------

    /** A polyline with cumulative distances precomputed, so lookups are O(segments). */
    private class Route(val pts: Array<DoubleArray>) {
        val cum = DoubleArray(pts.size)
        val totalM: Double
        /** Closed routes WRAP; open routes reverse. Getting this wrong sends runners backwards. */
        val closed: Boolean

        init {
            var total = 0.0
            for (i in 1 until pts.size) {
                total += haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])
                cum[i] = total
            }
            totalM = total
            val f = pts.first()
            val l = pts.last()
            closed = abs(f[0] - l[0]) < 1e-9 && abs(f[1] - l[1]) < 1e-9
        }

        fun positionAt(s: Double): DoubleArray {
            val clamped = s.coerceIn(0.0, totalM)
            var i = 1
            while (i < cum.size && cum[i] < clamped) i++
            val prev = (i - 1).coerceAtLeast(0)
            val a = pts[prev]
            val b = pts.getOrElse(i) { pts[prev] }
            val segStart = cum[prev]
            val segLen = (cum.getOrElse(i) { segStart }) - segStart
            val t = if (segLen > 0) (clamped - segStart) / segLen else 0.0
            return doubleArrayOf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        }
    }

    private class Agent(
        val id: String,
        val label: String,
        val variant: Int,
        val personaIndex: Int,
        val extra: Map<String, String>,
        val route: Route?,
        var lng: Double,
        var lat: Double,
        var s: Double,
        var direction: Int,
        var bearing: Double,
        var speed: Double,
        var dwellSec: Double,
        var targetLng: Double,
        var targetLat: Double,
        /** Raw spawn index — seed for every deterministic quantity. */
        val index: Int,
        /** Personal speed multiplier from index, so it never varies per run. */
        val speedMul: Double,
        /** Distance along route at simulation time zero. */
        val startS: Double,
        /** Direction at simulation time zero. */
        val dir0: Int,
    )

    private val executor: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "geokit-native-source").apply { isDaemon = true }
        }

    private var future: ScheduledFuture<*>? = null
    private var agents: List<Agent> = emptyList()
    private val sequence = AtomicInteger(0)
    private var lastTickNanos: Long = 0L

    /**
     * Backpressure: at most one unacknowledged batch outstanding at a time.
     *
     * `step()` always runs on schedule, so world state never falls behind —
     * only EMISSION is withheld while a previous batch is unacknowledged. That
     * is deliberate: the alternative (skipping `step()` too) would make the
     * simulation itself stall during a JS block, whereas withholding only the
     * send means the very next permitted emission carries the freshest state
     * rather than whatever was true when the block began.
     */
    @Volatile private var awaitingAck: Boolean = false
    @Volatile private var awaitingSinceNanos: Long = 0L

    // ---------------------------------------------------------------------
    // TurboModule surface
    // ---------------------------------------------------------------------

    override fun start(scenarioJson: String, intervalMs: Double) {
        android.util.Log.d(
            "GeoKitSource",
            "start() instance=${System.identityHashCode(this)} intervalMs=$intervalMs",
        )
        stop()

        agents =
            try {
                buildAgents(JSONObject(scenarioJson))
            } catch (t: Throwable) {
                android.util.Log.e("GeoKitSource", "bad scenario json", t)
                emptyList()
            }

        if (agents.isEmpty()) return

        awaitingAck = false
        lastTickNanos = System.nanoTime()
        emitBatch()

        val period = intervalMs.toLong().coerceAtLeast(16L)
        future =
            executor.scheduleAtFixedRate(
                {
                    try {
                        // World state always advances; only the SEND is gated.
                        step()
                        maybeEmitBatch()
                    } catch (t: Throwable) {
                        // A throw inside scheduleAtFixedRate silently cancels every
                        // future run — the source would die with no diagnostic.
                        android.util.Log.e("GeoKitSource", "tick failed", t)
                    }
                },
                period,
                period,
                TimeUnit.MILLISECONDS,
            )
    }

    /**
     * Promote tracking to a foreground service.
     *
     * Android 13+ will not display the required ongoing notification without
     * POST_NOTIFICATIONS. Returning false rather than starting anyway lets the
     * caller show a degraded state, instead of the app appearing to track in
     * background and silently stopping at the lock screen.
     */
    override fun startBackgroundTracking(title: String, body: String): Boolean {
        val ctx = reactApplicationContext
        if (Build.VERSION.SDK_INT >= 33) {
            val granted =
                ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) ==
                    PackageManager.PERMISSION_GRANTED
            if (!granted) return false
        }
        return try {
            LocationForegroundService.start(ctx, title, body)
            true
        } catch (t: Throwable) {
            android.util.Log.e("GeoKitSource", "foreground service start failed", t)
            false
        }
    }

    override fun stopBackgroundTracking() {
        try {
            LocationForegroundService.stop(reactApplicationContext)
        } catch (t: Throwable) {
            android.util.Log.e("GeoKitSource", "foreground service stop failed", t)
        }
    }

    /**
     * SharedPreferences, not the JS heap.
     *
     * The heap does not survive the process being reclaimed, and being reclaimed
     * is the entire case this exists for.
     */
    override fun saveSnapshot(json: String) {
        prefs().edit().putString(KEY_SNAPSHOT, json).apply()
    }

    override fun loadSnapshot(): String = prefs().getString(KEY_SNAPSHOT, "") ?: ""

    private fun prefs() =
        reactApplicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    override fun stop() {
        future?.cancel(false)
        future = null
        agents = emptyList()
        awaitingAck = false
    }

    /** Credit returned. The next scheduled tick is now free to emit again. */
    override fun ackFixes() {
        android.util.Log.d("GeoKitSource", "ack received")
        awaitingAck = false
    }

    /**
     * Emit unless a previous batch is still unacknowledged.
     *
     * The timeout exists so a single lost ack — a JS-side exception thrown
     * between receiving a batch and calling back, or the app being torn down
     * mid-flight — cannot permanently starve the source. Five ticks' worth of
     * silence is well past anything a normal processing delay would cause, so
     * crossing it is treated as evidence the ack is not coming rather than
     * merely late.
     */
    private fun maybeEmitBatch() {
        if (awaitingAck) {
            val waitedNanos = System.nanoTime() - awaitingSinceNanos
            if (waitedNanos < ACK_TIMEOUT_NANOS) {
                // Ground truth for the §8.4 re-measurement: every tick this
                // branch is taken is a tick that would previously have queued
                // an unbounded, discardable batch and now queues nothing.
                android.util.Log.d("GeoKitSource", "tick skipped — awaiting ack")
                return
            }
            android.util.Log.w("GeoKitSource", "ack timeout — resuming emission without one")
        }
        emitBatch()
    }

    override fun getCapabilities(): WritableMap {
        val map = Arguments.createMap()
        map.putString("sourceId", SOURCE_ID)
        map.putBoolean("backgroundTracking", true)
        map.putBoolean("activityRecognition", false)
        map.putBoolean("deferredUpdates", true)
        map.putInt("maxEntities", 0)
        map.putBoolean("producesTracks", false)
        return map
    }

    override fun invalidate() {
        stop()
        executor.shutdownNow()
        if (current === this) current = null
        super.invalidate()
    }

    /**
     * Deliver the platform's own memory-pressure signal to JS.
     *
     * This is the actual fix for the gap an `AppState` listener could not close:
     * `onTrimMemory` fires while the app is still in the foreground, under real
     * memory pressure — exactly the case backgrounding cannot detect. JS decides
     * what to shed (`EntityStore.shedMemory`); this module only forwards the
     * platform's signal and its severity.
     */
    private fun emitMemoryPressure(level: String) {
        val map = Arguments.createMap()
        map.putString("level", level)
        emitOnMemoryPressure(map)
    }

    // ---------------------------------------------------------------------
    // Scenario parsing
    // ---------------------------------------------------------------------

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
                    val s = routeOffset(n, route.totalM)
                    val p = route.positionAt(s)
                    val label =
                        if (labels != null && labels.length() > 0) labels.optString(i % labels.length())
                        else "#${i + 1}"

                    out.add(
                        Agent(
                            id = "e-%04d".format(n),
                            label = label,
                            variant = n % VARIANT_COUNT,
                            personaIndex = persona,
                            extra = extra,
                            route = route,
                            lng = p[0],
                            lat = p[1],
                            s = s,
                            // A closed course is run one way; open paths may start either.
                            direction = if (route.closed) 1 else if (n % 2 == 0) 1 else -1,
                            bearing = 0.0,
                            speed = PERSONA_SPEEDS[persona % PERSONA_SPEEDS.size],
                            dwellSec = 0.0,
                            targetLng = p[0],
                            targetLat = p[1],
                            index = n,
                            speedMul = 0.85 + agentNoise(n, 1) * 0.3,
                            startS = s,
                            dir0 = if (route.closed) 1 else if (n % 2 == 0) 1 else -1,
                        )
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
            val mPerLng = metresPerDegreeLng(cLat)

            for (i in 0 until wander) {
                val angle = Random.nextDouble() * TAU
                val dist = sqrt(Random.nextDouble()) * radius
                val lng = cLng + (cos(angle) * dist) / mPerLng
                val lat = cLat + (sin(angle) * dist) / METRES_PER_DEG_LAT
                val persona = i % PERSONA_SPEEDS.size
                val agent =
                    Agent(
                        id = "e-%04d".format(n),
                        label = "#${i + 1}",
                        variant = n % VARIANT_COUNT,
                        personaIndex = persona,
                        extra = emptyMap(),
                        route = null,
                        lng = lng,
                        lat = lat,
                        s = 0.0,
                        direction = 1,
                        bearing = Random.nextDouble() * 360.0,
                        speed = PERSONA_SPEEDS[persona],
                        dwellSec = 0.0,
                        targetLng = lng,
                        targetLat = lat,
                        index = n,
                        speedMul = 1.0,
                        startS = 0.0,
                        dir0 = 1,
                    )
                pickWaypoint(agent)
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

    // ---------------------------------------------------------------------
    // Movement
    // ---------------------------------------------------------------------

    private fun step() {
        val now = System.nanoTime()
        val dtSec = ((now - lastTickNanos) / 1_000_000_000.0).coerceAtMost(5.0)
        lastTickNanos = now

        for (agent in agents) {
            if (agent.route != null) evalRoute(agent, System.currentTimeMillis())
            else stepWander(agent, dtSec)
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
        val speed = PERSONA_SPEEDS[agent.personaIndex % PERSONA_SPEEDS.size] * agent.speedMul
        val tSec = nowMs / 1000.0

        val at = routeDistanceAt(agent.index, speed, route.totalM, agent.startS, agent.dir0, tSec)
        val p = route.positionAt(at.first)

        val back = routeDistanceAt(agent.index, speed, route.totalM, agent.startS, agent.dir0, tSec - 1.0)
        val bp = route.positionAt(back.first)

        agent.s = at.first
        agent.direction = at.second
        agent.lng = p[0]
        agent.lat = p[1]
        if (haversine(bp[0], bp[1], p[0], p[1]) > 0.5) {
            agent.bearing = bearingDeg(bp[0], bp[1], p[0], p[1])
        }
        agent.speed =
            if (movingSeconds(agent.index, tSec) - movingSeconds(agent.index, tSec - 1.0) > 0.5) speed
            else 0.0
    }

    private fun pickWaypoint(agent: Agent) {
        val mPerLng = metresPerDegreeLng(agent.lat)
        val angle = Random.nextDouble() * TAU
        val dist = PERSONA_WANDER[agent.personaIndex % PERSONA_WANDER.size] *
            (0.4 + Random.nextDouble() * 0.6)
        agent.targetLng = agent.lng + (cos(angle) * dist) / mPerLng
        agent.targetLat = agent.lat + (sin(angle) * dist) / METRES_PER_DEG_LAT
    }

    private fun stepWander(agent: Agent, dtSec: Double) {
        val mPerLng = metresPerDegreeLng(agent.lat)
        val dLng = (agent.targetLng - agent.lng) * mPerLng
        val dLat = (agent.targetLat - agent.lat) * METRES_PER_DEG_LAT
        if (hypot(dLng, dLat) < 15.0) {
            pickWaypoint(agent)
            return
        }

        val desired = Math.toDegrees(atan2(dLng, dLat))
        var delta = ((desired - agent.bearing + 540.0) % 360.0) - 180.0
        val maxTurn = 45.0 * dtSec
        delta = delta.coerceIn(-maxTurn, maxTurn)
        agent.bearing = (agent.bearing + delta + 360.0) % 360.0

        agent.speed = PERSONA_SPEEDS[agent.personaIndex % PERSONA_SPEEDS.size] *
            (0.85 + Random.nextDouble() * 0.3)

        val travel = agent.speed * dtSec
        val rad = Math.toRadians(agent.bearing)
        agent.lng += (sin(rad) * travel) / mPerLng
        agent.lat += (cos(rad) * travel) / METRES_PER_DEG_LAT
    }

    /** One event per tick carrying every fix — never one event per entity. */
    private fun emitBatch() {
        val local = agents
        if (local.isEmpty()) return

        val now = System.currentTimeMillis().toDouble()
        val array = Arguments.createArray()

        for (agent in local) {
            val teleport = Random.nextDouble() < TELEPORT_RATE
            val badAccuracy = Random.nextDouble() < BAD_ACCURACY_RATE

            val fix = Arguments.createMap()
            fix.putString("id", agent.id)
            fix.putDouble("lng", if (teleport) agent.lng + 0.05 else agent.lng)
            fix.putDouble("lat", agent.lat)
            fix.putDouble("bearing", agent.bearing)
            fix.putDouble("speed", agent.speed)
            fix.putDouble("accuracy", if (badAccuracy) 250.0 else 5.0 + Random.nextDouble() * 10.0)
            fix.putDouble("timestamp", now)

            // The same attribute contract the JS source emits, so the kit's style
            // expressions and selection sheet behave identically for both.
            fix.putString("label", agent.label)
            fix.putInt("variant", agent.variant)
            fix.putString("persona", PERSONA_KINDS[agent.personaIndex % PERSONA_KINDS.size])
            fix.putString("participation", agent.extra["participation"] ?: "supporter")

            array.pushMap(fix)
        }

        val batch = Arguments.createMap()
        batch.putArray("fixes", array)
        batch.putInt("sequence", sequence.incrementAndGet())

        // Claim the credit BEFORE emitting, not after: emission is fire-and-
        // forget from this thread's point of view, so there is no "after send
        // completed" moment to hook — the credit must already be held by the
        // time the call is made, or a second tick landing before this one
        // returns could slip through.
        awaitingAck = true
        awaitingSinceNanos = System.nanoTime()
        android.util.Log.d("GeoKitSource", "emit seq=${batch.getInt("sequence")}")

        // Emitted from the source thread; the generated emitter marshals onto the
        // JS thread itself, so the timer never blocks waiting for JS.
        emitOnFixes(batch)
    }

    companion object {
        const val SOURCE_ID = "native-turbo"
        private const val PREFS = "geokit.state"
        private const val KEY_SNAPSHOT = "snapshot"

        /** Self-heal window for a lost ack. See `maybeEmitBatch`. */
        private val ACK_TIMEOUT_NANOS = TimeUnit.SECONDS.toNanos(5)

        /**
         * The live module instance, if the TurboModule has been created.
         *
         * `MainApplication.onTrimMemory` runs at the Application level and has no
         * reference to any React module — Application is constructed before
         * React, and may receive trim callbacks before a module ever exists, or
         * after Fabric tears one down. Routing through this holder means the
         * Application only needs to know a receiver may exist, never hold a
         * concrete (and potentially stale) reference of its own.
         */
        @Volatile private var current: GeoKitSourceModule? = null

        /**
         * Entry point for `MainApplication.onTrimMemory`.
         *
         * Android's trim levels are collapsed to two severities matching
         * `EntityStore.shedMemory`'s levels, so the platform-specific mapping
         * lives in exactly one place rather than being re-derived in JS:
         *
         *   moderate — UI_HIDDEN, RUNNING_LOW, BACKGROUND
         *   critical — RUNNING_CRITICAL, MODERATE, COMPLETE
         *
         * `RUNNING_MODERATE` (level 5 — still foregrounded, no UI hidden yet) is
         * deliberately unhandled: it is the earliest and least specific signal
         * Android sends, and reacting to it would shed state on fluctuations too
         * minor to matter, trading rebuild cost for memory that was never
         * seriously at risk.
         */
        fun notifyTrimMemory(androidLevel: Int) {
            val severity =
                when (androidLevel) {
                    ComponentCallbacks2.TRIM_MEMORY_COMPLETE,
                    ComponentCallbacks2.TRIM_MEMORY_MODERATE,
                    ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL,
                    -> "critical"

                    ComponentCallbacks2.TRIM_MEMORY_BACKGROUND,
                    ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW,
                    ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN,
                    -> "moderate"

                    else -> return
                }
            current?.emitMemoryPressure(severity)
        }

        private const val TAU = 2.0 * Math.PI
        private const val METRES_PER_DEG_LAT = 110_574.0
        private const val TELEPORT_RATE = 0.002
        private const val BAD_ACCURACY_RATE = 0.01
        private const val DWELL_RATE = 0.02
        private const val VARIANT_COUNT = 8

        private val PERSONA_SPEEDS = doubleArrayOf(1.4, 3.1, 6.0, 12.5, 3.6)
        private val PERSONA_WANDER = doubleArrayOf(300.0, 700.0, 1500.0, 3000.0, 1000.0)
        private val PERSONA_KINDS =
            arrayOf("walking", "jogging", "cycling", "driving", "running")

        private const val GOLDEN_CONJUGATE = 0.618033988749895
        private const val CYCLE_S = 40.0
        private const val DWELL_S = 5.0
        private const val MOVING_S = CYCLE_S - DWELL_S

        /** Mirrors routeOffset() in MockSource.ts exactly. */
        private fun routeOffset(n: Int, totalM: Double): Double {
            val frac = (n + 1) * GOLDEN_CONJUGATE
            return (frac - kotlin.math.floor(frac)) * totalM
        }

        /** Mirrors agentNoise() in MockSource.ts exactly. */
        private fun agentNoise(n: Int, salt: Int): Double {
            val frac = (n + 1) * GOLDEN_CONJUGATE + salt * 0.7548776662466927
            return frac - kotlin.math.floor(frac)
        }

        /** Mirrors movingSeconds() in MockSource.ts exactly. */
        private fun movingSeconds(n: Int, tSec: Double): Double {
            val phase = agentNoise(n, 3) * CYCLE_S
            val shifted = tSec + phase
            val cycles = kotlin.math.floor(shifted / CYCLE_S)
            val rem = shifted - cycles * CYCLE_S
            val active = cycles * MOVING_S + kotlin.math.min(rem, MOVING_S)
            val zeroCycles = kotlin.math.floor(phase / CYCLE_S)
            val activeAtZero =
                zeroCycles * MOVING_S +
                    kotlin.math.min(phase - zeroCycles * CYCLE_S, MOVING_S)
            return active - activeAtZero
        }

        /** Mirrors routeDistanceAt() in MockSource.ts exactly. Returns (s, direction). */
        private fun routeDistanceAt(
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

        private fun metresPerDegreeLng(lat: Double): Double =
            111_320.0 * cos(Math.toRadians(lat))

        private fun haversine(lng1: Double, lat1: Double, lng2: Double, lat2: Double): Double {
            val r = 6_371_008.8
            val dLat = Math.toRadians(lat2 - lat1)
            val dLng = Math.toRadians(lng2 - lng1)
            val a = sin(dLat / 2) * sin(dLat / 2) +
                cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) *
                sin(dLng / 2) * sin(dLng / 2)
            return 2 * r * asin(sqrt(a))
        }

        private fun bearingDeg(lng1: Double, lat1: Double, lng2: Double, lat2: Double): Double {
            val phi1 = Math.toRadians(lat1)
            val phi2 = Math.toRadians(lat2)
            val dLambda = Math.toRadians(lng2 - lng1)
            val y = sin(dLambda) * cos(phi2)
            val x = cos(phi1) * sin(phi2) - sin(phi1) * cos(phi2) * cos(dLambda)
            return (Math.toDegrees(atan2(y, x)) + 360.0) % 360.0
        }
    }
}
