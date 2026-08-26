package com.loop.simulation

import kotlin.math.abs

/** A polyline with cumulative distances precomputed, so lookups are O(segments). */
internal class Route(val pts: Array<DoubleArray>) {
    val cum = DoubleArray(pts.size)
    val totalM: Double

    /** Closed routes WRAP; open routes reverse. Getting this wrong sends runners backwards. */
    val closed: Boolean

    init {
        var total = 0.0
        for (i in 1 until pts.size) {
            total += SimulationMath.haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])
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
