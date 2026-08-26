package com.loop.source.bridge

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
import com.loop.LoopLog
import com.loop.simulation.AgentFix
import com.loop.simulation.ScenarioParser
import com.loop.simulation.Simulation
import com.loop.source.LocationForegroundService
import com.loop.specs.NativeLoopSourceSpec
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Native entity source, implemented as a TurboModule.
 *
 * THIS FILE IS THE BRIDGE, NOT THE SIMULATION
 *
 * "What a person is doing right now" — routes, movement, the deliberately
 * injected bad readings — lives entirely in `com.loop.simulation`, with no
 * React Native type anywhere in it. What's left here is scheduling,
 * backpressure, JSON-in/`WritableMap`-out marshalling, and the handful of
 * TurboModule methods JS actually calls. That split is what makes the
 * simulation testable with no `ReactApplicationContext`, and keeps this
 * class to the thickness of an actual bridge rather than a whole engine.
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
@ReactModule(name = NativeLoopSourceSpec.NAME)
class LoopSourceModule(reactContext: ReactApplicationContext) :
    NativeLoopSourceSpec(reactContext) {

    private val log = LoopLog("LoopSourceModule")
    private val simulation = Simulation()

    init {
        log.d("module constructed, instance=${System.identityHashCode(this)}")
        // Registered here rather than resolved by MainApplication reaching into
        // this module, so the module owns its own lifecycle: MainApplication
        // only needs to know a receiver MAY exist, never a concrete instance.
        current = this
    }

    private val executor: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "loop-native-source").apply { isDaemon = true }
        }

    private var future: ScheduledFuture<*>? = null
    private val sequence = AtomicInteger(0)

    /**
     * Backpressure: at most one unacknowledged batch outstanding at a time.
     *
     * The simulation's own `step()` always runs on schedule, so world state
     * never falls behind — only EMISSION is withheld while a previous batch is
     * unacknowledged. That is deliberate: the alternative (skipping `step()`
     * too) would make the simulation itself stall during a JS block, whereas
     * withholding only the send means the very next permitted emission carries
     * the freshest state rather than whatever was true when the block began.
     */
    @Volatile private var awaitingAck: Boolean = false
    @Volatile private var awaitingSinceNanos: Long = 0L

    // ---------------------------------------------------------------------
    // TurboModule surface
    // ---------------------------------------------------------------------

    override fun start(scenarioJson: String, intervalMs: Double) {
        log.d("start() instance=${System.identityHashCode(this)} intervalMs=$intervalMs")
        stop()

        val agents =
            try {
                ScenarioParser.parse(scenarioJson)
            } catch (t: Throwable) {
                log.e("bad scenario json", t)
                emptyList()
            }

        if (agents.isEmpty()) return
        simulation.start(agents)

        awaitingAck = false
        emitBatch()

        val period = intervalMs.toLong().coerceAtLeast(16L)
        future =
            executor.scheduleAtFixedRate(
                {
                    try {
                        // World state always advances; only the SEND is gated.
                        simulation.step()
                        maybeEmitBatch()
                    } catch (t: Throwable) {
                        // A throw inside scheduleAtFixedRate silently cancels every
                        // future run — the source would die with no diagnostic.
                        log.e("tick failed", t)
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
            log.e("foreground service start failed", t)
            false
        }
    }

    override fun stopBackgroundTracking() {
        try {
            LocationForegroundService.stop(reactApplicationContext)
        } catch (t: Throwable) {
            log.e("foreground service stop failed", t)
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
        simulation.stop()
        awaitingAck = false
    }

    /** Credit returned. The next scheduled tick is now free to emit again. */
    override fun ackFixes() {
        log.d("ack received")
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
                log.d("tick skipped — awaiting ack")
                return
            }
            log.w("ack timeout — resuming emission without one")
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
    // Marshalling — the only place a simulation fix becomes a bridge type
    // ---------------------------------------------------------------------

    /** One event per tick carrying every fix — never one event per entity. */
    private fun emitBatch() {
        val fixes = simulation.snapshot()
        if (fixes.isEmpty()) return

        val array = Arguments.createArray()
        for (fix in fixes) {
            array.pushMap(fix.toWritableMap())
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
        log.d("emit seq=${batch.getInt("sequence")}")

        // Emitted from the source thread; the generated emitter marshals onto the
        // JS thread itself, so the timer never blocks waiting for JS.
        emitOnFixes(batch)
    }

    private fun AgentFix.toWritableMap(): WritableMap {
        val map = Arguments.createMap()
        map.putString("id", id)
        map.putDouble("lng", lng)
        map.putDouble("lat", lat)
        map.putDouble("bearing", bearing)
        map.putDouble("speed", speed)
        map.putDouble("accuracy", accuracy)
        map.putDouble("timestamp", timestamp)
        // The same attribute contract the JS source emits, so the kit's style
        // expressions and selection sheet behave identically for both.
        map.putString("label", label)
        map.putInt("variant", variant)
        map.putString("persona", persona)
        map.putString("participation", participation)
        return map
    }

    companion object {
        const val SOURCE_ID = "native-turbo"
        private const val PREFS = "loop.state"
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
        @Volatile private var current: LoopSourceModule? = null

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
    }
}
