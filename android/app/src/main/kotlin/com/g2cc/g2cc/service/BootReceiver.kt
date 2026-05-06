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
 *    - LOCKED_BOOT_COMPLETED encrypted-storage boot phase (we ignore here, app
 *                            isn't directBootAware — Prefs lives in CE storage)
 *    - MY_PACKAGE_REPLACED   sideload update; restart service immediately
 *
 *  Only auto-starts if the user has already completed setup (server URL +
 *  auth token persisted) — otherwise this would launch a service that
 *  immediately fails to connect, and we want LOUD failure points the user
 *  controls. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        Log.i(TAG, "onReceive action=$action")
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_LOCKED_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            return
        }
        if (action == Intent.ACTION_LOCKED_BOOT_COMPLETED) {
            // Skip the locked-boot phase; CE storage isn't available yet.
            return
        }
        val prefs = Prefs(context.applicationContext)
        if (prefs.serverUrl == null || prefs.authToken == null) {
            Log.i(TAG, "skipping auto-start: setup incomplete")
            return
        }
        G2CCService.start(context.applicationContext)
    }

    companion object {
        const val TAG = "G2CCBootReceiver"
    }
}
