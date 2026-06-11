package com.g2cc.g2cc.intents

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.g2cc.g2cc.service.ConnectionService

/**
 * Tasker / Assistant / adb-broadcast entry point. Each action is idempotent
 * and explicit — no implicit state inference, no silent no-ops.
 *
 * Documented in /home/user/G2CC/android/INTENTS.md. Re-audited for v1.7
 * (upgrades Phase 9): the receiver had silently fallen OUT of the manifest
 * with the parked G2CCService — re-registered, rewired to ConnectionService.
 * PING is live; the rest are DEPRECATED-WITH-LOG: the DE owns dictation
 * (server-initiated audio_request via the glasses menu — phone-initiated
 * recording has no DE meaning) and owns its own UI (picker), and the
 * dispatch target is a server concern now.
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
                Log.i(TAG, "PING (service running=${ConnectionService.isRunning})")
            }
            ACTION_START_RECORDING,
            ACTION_STOP_RECORDING -> {
                Log.w(TAG, "$action is DEPRECATED since v1.7 — DE dictation is server-initiated (glasses menu Dictate/Ask); no phone-side recording path exists")
            }
            ACTION_SHOW_DIRECTORY_PICKER,
            ACTION_SWITCH_DISPATCH_TARGET -> {
                Log.w(TAG, "$action is DEPRECATED since v1.7 — the DE owns the picker UI and the server owns dispatch")
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
