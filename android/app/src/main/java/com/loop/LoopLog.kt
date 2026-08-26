package com.loop

import android.util.Log

/**
 * One log call site for the whole app, tagged per caller rather than under a
 * single shared string — each class holds its own `LoopLog(tag)` instance, so
 * logcat filtering can target one class specifically instead of everything
 * native at once.
 *
 * Gated on `BuildConfig.DEBUG` rather than a manual log-level flag — a
 * release build compiles with logging fully out, not just quieted, so there
 * is no runtime switch a misconfigured production build could leave on.
 */
internal class LoopLog(private val tag: String) {
    fun d(message: String) {
        if (BuildConfig.DEBUG) Log.d(tag, message)
    }

    fun w(message: String) {
        if (BuildConfig.DEBUG) Log.w(tag, message)
    }

    fun e(message: String, error: Throwable? = null) {
        if (BuildConfig.DEBUG) Log.e(tag, message, error)
    }
}
