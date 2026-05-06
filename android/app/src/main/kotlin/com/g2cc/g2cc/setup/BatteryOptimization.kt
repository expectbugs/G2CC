package com.g2cc.g2cc.setup

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

/**
 * Battery-optimization exemption helper.
 *
 * Without the exemption, Android Doze can kill the foreground service after
 * the screen has been off for a while — defeating the entire point of a
 * persistent BLE / WebSocket bridge. Per the spec §13 + Android App Discipline:
 * surface a one-time setup flow that requests it.
 *
 * The user MUST manually approve in Settings — Android does not allow direct
 * grant via `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission alone. This
 * helper provides:
 *  - `isExempt(context)` — read current state
 *  - `requestIntent(packageName)` — Intent to launch the request dialog
 *  - `settingsIntent()` — Intent to the system Battery-optimization settings
 *    list (used as a fallback if the request dialog isn't surfaced).
 */
object BatteryOptimization {
    fun isExempt(context: Context): Boolean {
        val pm = context.getSystemService(PowerManager::class.java) ?: return false
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    /** Direct request — opens Android's "allow this app to ignore battery optimization?" dialog. */
    fun requestIntent(packageName: String): Intent =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:$packageName")
        }

    /** Fallback: open the Settings list so the user can flip the toggle manually. */
    fun settingsIntent(): Intent =
        Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
}
