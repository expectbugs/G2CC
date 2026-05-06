package com.g2cc.g2cc.intents

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.g2cc.g2cc.service.G2CCService

/**
 * Tasker / Assistant / adb-broadcast entry point. Each action is idempotent
 * and explicit — no implicit state inference, no silent no-ops.
 *
 * Documented in /home/user/G2CC/android/INTENTS.md. Other automations on the
 * phone can target these actions via:
 *
 *   adb shell am broadcast -a com.g2cc.intent.action.PING
 *
 * Phase 4: PING + START/STOP_RECORDING / SHOW_DIRECTORY_PICKER /
 * SWITCH_DISPATCH_TARGET are accepted and logged. Real handlers wire in
 * during Phase 6 (recording/picker) and Phase 9 (dispatch-target switch).
 */
class IntentReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: run {
            Log.w(TAG, "received intent with no action; ignoring")
            return
        }
        Log.i(TAG, "received action=$action extras=${intent.extras?.keySet()?.joinToString()}")
        when (action) {
            ACTION_PING -> {
                Log.i(TAG, "PING (service running=${G2CCService.isRunning})")
            }
            ACTION_START_RECORDING,
            ACTION_STOP_RECORDING,
            ACTION_SHOW_DIRECTORY_PICKER,
            ACTION_SWITCH_DISPATCH_TARGET -> {
                // Forward to the service so it dispatches via G2Pipeline.
                G2CCService.dispatchAction(context.applicationContext, action, intent.extras)
            }
            else -> Log.w(TAG, "unknown action: $action")
        }
    }

    companion object {
        const val TAG = "G2CCIntent"

        const val ACTION_PING = "com.g2cc.intent.action.PING"
        const val ACTION_START_RECORDING = "com.g2cc.intent.action.START_RECORDING"
        const val ACTION_STOP_RECORDING = "com.g2cc.intent.action.STOP_RECORDING"
        const val ACTION_SHOW_DIRECTORY_PICKER = "com.g2cc.intent.action.SHOW_DIRECTORY_PICKER"
        const val ACTION_SWITCH_DISPATCH_TARGET = "com.g2cc.intent.action.SWITCH_DISPATCH_TARGET"

        const val EXTRA_TARGET_ID = "target_id"
    }
}
