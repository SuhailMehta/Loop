package com.loop.simulation

/** One simulated person's mutable state, ticked forward every frame. */
internal class Agent(
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

/**
 * A snapshot of one agent's position, ready to cross the JS boundary.
 *
 * Deliberately not `Agent` itself — this is the wire shape, including the
 * occasional simulated GPS fault mixed in by `Simulation.snapshot()`;
 * `Agent` is the simulation's own truth. Keeping them separate is what lets
 * the bridge layer stay a pure translation from this into `WritableMap`,
 * with no simulation knowledge of its own.
 */
internal data class AgentFix(
    val id: String,
    val lng: Double,
    val lat: Double,
    val bearing: Double,
    val speed: Double,
    val accuracy: Double,
    val timestamp: Double,
    val label: String,
    val variant: Int,
    val persona: String,
    val participation: String,
)
