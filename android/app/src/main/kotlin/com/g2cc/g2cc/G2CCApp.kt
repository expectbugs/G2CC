package com.g2cc.g2cc

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.util.Log

/** Application entry point — currently just creates the FG service notification channel.
 *  Phase 6 will hook the WebSocket client lifecycle here. */
class G2CCApp : Application() {

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "G2CC v0.0.1 onCreate")
        ensureNotificationChannel()
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.fg_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.fg_channel_desc)
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    companion object {
        const val TAG = "G2CC"
        const val CHANNEL_ID = "g2cc-fg"
    }
}
