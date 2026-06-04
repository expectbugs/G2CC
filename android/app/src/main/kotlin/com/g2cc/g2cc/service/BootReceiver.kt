package com.g2cc.g2cc.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.g2cc.g2cc.storage.Prefs

/** Auto-start the G2CC service after device boot or app update.
 *
 *  Triggers:
 *    - BOOT_COMPLETED        normal boot
 *    - MY_PACKAGE_REPLACED   sideload update; restart service immediately
 *
 *  4th-pass review LOW: LOCKED_BOOT_COMPLETED was previously declared in
 *  the manifest filter, but the receiver is `directBootAware="false"` so it
 *  never actually fires for that intent. Removed from both manifest and
 *  here to keep the code honest.
 *
 *  Only auto-starts if the user has already completed setup (server URL +
 *  auth token persisted) AND battery-optimization exemption is granted —
 *  otherwise this would launch a service that fails to connect OR gets
 *  killed by Doze within minutes, and we want LOUD failure points the user
 *  controls. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        Log.i(TAG, "onReceive action=$action")
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            return
        }
        val prefs = Prefs(context.applicationContext)
        if (prefs.serverUrl == null || prefs.authToken == null) {
            Log.i(TAG, "skipping auto-start: setup incomplete")
            return
        }
        // 4th-pass review LOW: re-check battery-opt exemption at boot. The
        // user could have revoked the exemption since setup; auto-starting
        // a service the OS will Doze-kill in minutes is worse than not
        // starting at all (no failure surface, user thinks G2CC is broken).
        //
        // 4th-pass-final review MEDIUM: don't silently return when revoked.
        // Post a high-priority notification telling the user to re-grant
        // — otherwise the app sits dormant after every reboot with no
        // visible failure surface (defeats LOUD AND PROUD).
        if (!com.g2cc.g2cc.setup.BatteryOptimization.isExempt(context.applicationContext)) {
            Log.w(TAG, "skipping auto-start: battery-opt exemption revoked since setup — posting notification")
            postBatteryOptRevokedNotification(context.applicationContext)
            return
        }
        G2CCService.start(context.applicationContext)
    }

    private fun postBatteryOptRevokedNotification(context: Context) {
        // On Android 13+ posting ANY notification requires the runtime
        // POST_NOTIFICATIONS permission (the FG-service notification is exempt;
        // this standalone one is NOT). If it's denied, nm.notify() silently
        // no-ops — which would reproduce the very silent-dormancy this method
        // exists to prevent. We can't launch an Activity from a background boot
        // receiver either, so the honest move is to log LOUDLY that the user
        // won't see the prompt; they'll still discover "not running" next time
        // they open MainActivity. (Don't pretend we surfaced it.)
        if (!androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()) {
            Log.w(
                TAG,
                "battery-opt exemption revoked AND notifications are disabled " +
                    "(POST_NOTIFICATIONS denied) — cannot surface the re-grant prompt. " +
                    "G2CC will stay stopped until the user reopens the app.",
            )
            return
        }
        try {
            val launchIntent = android.content.Intent(context, com.g2cc.g2cc.MainActivity::class.java)
            val pi = android.app.PendingIntent.getActivity(
                context, 0, launchIntent,
                android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val notif = androidx.core.app.NotificationCompat.Builder(context, com.g2cc.g2cc.G2CCApp.CHANNEL_ID)
                .setSmallIcon(com.g2cc.g2cc.R.drawable.ic_notification)
                .setContentTitle("G2CC: battery optimization re-enabled")
                .setContentText("Tap to grant exemption — without it, G2CC will be killed by Doze.")
                .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build()
            val nm = context.getSystemService(android.app.NotificationManager::class.java) ?: return
            nm.notify(NOTIF_ID_BATT_REVOKED, notif)
        } catch (e: Exception) {
            Log.w(TAG, "postBatteryOptRevokedNotification failed", e)
        }
    }

    companion object {
        const val TAG = "G2CCBootReceiver"
        private const val NOTIF_ID_BATT_REVOKED = 0xCC2D
    }
}
