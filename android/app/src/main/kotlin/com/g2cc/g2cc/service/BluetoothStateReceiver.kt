package com.g2cc.g2cc.service

import android.bluetooth.BluetoothAdapter
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.g2cc.g2cc.G2Pipeline

/**
 * Listens for `BluetoothAdapter.ACTION_STATE_CHANGED` so the pipeline survives
 * the user (or system) toggling Bluetooth. Registered dynamically from
 * `G2CCService.onCreate` and unregistered in `onDestroy` — never declared in
 * the manifest because Android 8+ blocks most implicit-broadcast manifest
 * receivers.
 *
 * Per Phase D resilience audit: without this, a BT toggle invalidates every
 * `BluetoothDevice` handle Nordic is holding, and we have no app-level path
 * to recover. The notification keeps showing "L:disc R:disc" indefinitely
 * even after BT comes back. This receiver closes that gap by tearing down on
 * STATE_OFF (so the next STATE_ON gets a clean slate) and re-scanning on
 * STATE_ON.
 *
 * Hard rules:
 *  - No silent failure: every transition logs loudly via Log.i.
 *  - No timeouts: the pipeline's own scanAndConnect is event-driven.
 */
class BluetoothStateReceiver(
    private val pipeline: G2Pipeline,
) : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
        val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
        when (state) {
            BluetoothAdapter.STATE_ON -> {
                Log.i(TAG, "Bluetooth STATE_ON — re-running scanAndConnect")
                pipeline.send(com.g2cc.g2cc.net.ClientMessage.Diag("bt-state: ON — rescanning"))
                pipeline.onBluetoothStateOn()
            }
            BluetoothAdapter.STATE_OFF -> {
                Log.i(TAG, "Bluetooth STATE_OFF — tearing down BLE pipeline")
                pipeline.send(com.g2cc.g2cc.net.ClientMessage.Diag("bt-state: OFF — tearing down BLE"))
                pipeline.onBluetoothStateOff()
            }
            BluetoothAdapter.STATE_TURNING_OFF, BluetoothAdapter.STATE_TURNING_ON -> {
                // Informational — no action; STATE_OFF / STATE_ON will follow.
                Log.i(TAG, "Bluetooth transitioning: state=$state")
            }
            else -> Log.w(TAG, "Bluetooth STATE_CHANGED unexpected state=$state")
        }
    }

    companion object {
        const val TAG = "BluetoothStateReceiver"
    }
}
