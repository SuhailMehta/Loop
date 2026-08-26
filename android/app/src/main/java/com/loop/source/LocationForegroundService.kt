package com.loop.source

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.loop.LoopLog

/**
 * Keeps location tracking alive when the app is not in the foreground.
 *
 * WHY THIS IS REQUIRED
 *
 * Android throttles and then stops location delivery for a backgrounded
 * process. For an events product this removes the entire capability: a user
 * following a marathon puts the phone in a pocket, and without a foreground
 * service the map stops updating exactly when it matters.
 *
 * The persistent notification is not an inconvenience to be minimised — it is
 * the contract. The platform grants continued location access in exchange for
 * telling the user, visibly and continuously, that it is happening. For a
 * product handling location that trade is correct on privacy grounds
 * independent of what the platform requires.
 *
 * START_REDELIVER_INTENT so that if the process is killed under memory
 * pressure, Android restarts the service with the original intent rather than a
 * null one — the service resumes with its configuration instead of coming back
 * inert.
 */
class LocationForegroundService : Service() {

    private val log = LoopLog("LocationForegroundService")

    override fun onBind(intent: Intent?): IBinder? = null

    /**
     * `startForeground` can throw even though `startForegroundService` at the
     * call site did not.
     *
     * The two calls are not on the same synchronous stack: `startForegroundService`
     * only enqueues the start and returns immediately, so a try/catch at that
     * call site (in `LoopSourceModule.startBackgroundTracking`) cannot see a
     * failure that surfaces later, here, when the OS actually delivers the
     * command. Android 12+ additionally requires the app to be in an "eligible"
     * state — recently foregrounded — to promote a location-typed service; a
     * caller that reacts to its OWN app leaving the foreground can lose that
     * race, since by the time this runs the eligible window may have already
     * closed. That throws `SecurityException` here, uncaught, which without
     * this guard kills the entire process rather than only this feature.
     */
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Sharing location"
        val body = intent?.getStringExtra(EXTRA_BODY) ?: "Your position is visible to your group"

        return try {
            createChannel()
            startForeground(NOTIFICATION_ID, buildNotification(title, body))
            START_REDELIVER_INTENT
        } catch (t: Throwable) {
            log.e("startForeground failed — degrading, not crashing", t)
            stopSelf()
            START_NOT_STICKY
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        val channel =
            NotificationChannel(
                CHANNEL_ID,
                "Location sharing",
                // LOW: continuously present, so it must never make a sound or
                // interrupt. It is a status indicator, not an alert.
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Shown while your location is being shared with your group."
                setShowBadge(false)
            }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(title: String, body: String): Notification {
        // Tapping the notification returns to the app rather than starting a new
        // task, so the user lands back on the map they left.
        val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending =
            PendingIntent.getActivity(
                this,
                0,
                launch,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(pending)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "loop.location"
        private const val NOTIFICATION_ID = 4201
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_BODY = "body"

        fun start(context: Context, title: String, body: String) {
            val intent =
                Intent(context, LocationForegroundService::class.java).apply {
                    putExtra(EXTRA_TITLE, title)
                    putExtra(EXTRA_BODY, body)
                }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LocationForegroundService::class.java))
        }
    }
}
