package com.g2cc.g2cc.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.g2cc.g2cc.BuildConfig

/** Auto-start the bridge after device boot or a sideload update.
 *
 *  Re-registered + REWRITTEN for the v1.7+ architecture (review 2026-06-11b):
 *  the old receiver had silently fallen out of the manifest with the parked
 *  G2CCService — after ANY reboot the bridge stayed down until Adam opened
 *  the app (and "system reboot" is a required reconnect scenario, project
 *  CLAUDE.md). It was also triply dead as written: it gated on Prefs keys the
 *  BuildConfig flow never writes, started the PARKED G2CCService, and its
 *  notification deep-linked an Activity that isn't in the manifest. Now:
 *    - gate = BuildConfig.AUTH_TOKEN (the real config source since v1.6)
 *    - starts ConnectionService via startAndConnect (the harness's own path);
 *      connectedDevice-type FGS is allowed from BOOT_COMPLETED — the mic FGS
 *      type is denied in background and re-granted by the existing
 *      micFgsGranted retry on the next app-open (dictation until then gets
 *      the loud audio_request refusal, not silence)
 *    - the battery-opt re-grant prompt deep-links HarnessActivity
 *
 *  Triggers: BOOT_COMPLETED (normal boot) + MY_PACKAGE_REPLACED (sideload
 *  update — restart immediately so an install doesn't strand the bridge). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        Log.i(TAG, "onReceive action=$action")
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            return
        }
        if (BuildConfig.AUTH_TOKEN.isEmpty()) {
            // A build without harness-secrets.properties can't auth anyway —
            // starting a service that loops on auth failures helps nobody.
            Log.w(TAG, "skipping auto-start: no AUTH_TOKEN baked into this build")
            return
        }
        // Re-check the battery-opt exemption: auto-starting a service the OS
        // will Doze-kill in minutes is worse than not starting (no failure
        // surface) — prompt loudly instead (4th-pass review decision, kept).
        if (!com.g2cc.g2cc.setup.BatteryOptimization.isExempt(context.applicationContext)) {
            Log.w(TAG, "skipping auto-start: battery-opt exemption revoked — posting re-grant prompt")
            postBatteryOptRevokedNotification(context.applicationContext)
            return
        }
        // F9 (review 2026-07-13): resume the persisted mode(s) — a boot after a
        // pure control-mode evening must not start a forever BLE hunt for
        // glasses that are in the case.
        Log.i(TAG, "auto-starting ConnectionService (resume persisted modes)")
        ConnectionService.startAndResume(context.applicationContext)
    }

    private fun postBatteryOptRevokedNotification(context: Context) {
        // POST_NOTIFICATIONS may be denied — nm.notify() would silently no-op,
        // reproducing the silent dormancy this prompt exists to prevent. We
        // can't launch an Activity from a boot receiver; log LOUDLY that the
        // user won't see the prompt (they'll find "not running" in the app).
        if (!androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()) {
            Log.w(
                TAG,
                "battery-opt exemption revoked AND notifications are disabled " +
                    "(POST_NOTIFICATIONS denied) — cannot surface the re-grant prompt. " +
                    "G2CC stays stopped until the app is reopened.",
            )
            return
        }
        try {
            val launchIntent = Intent(context, com.g2cc.g2cc.harness.HarnessActivity::class.java)
            val pi = android.app.PendingIntent.getActivity(
                context, 0, launchIntent,
                android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val notif = androidx.core.app.NotificationCompat.Builder(context, com.g2cc.g2cc.G2CCApp.CHANNEL_ID)
                .setSmallIcon(com.g2cc.g2cc.R.drawable.ic_notification)
                .setContentTitle("G2CC: battery optimization re-enabled")
                .setContentText("Tap to re-grant the exemption — without it Doze kills the bridge.")
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
