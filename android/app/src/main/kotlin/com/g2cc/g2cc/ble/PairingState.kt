package com.g2cc.g2cc.ble

import android.content.Context
import android.content.SharedPreferences

/**
 * Persisted bonded-address pair (left + right G2 lenses).
 *
 * Per CLAUDE.md "Android App Discipline":
 *   - **BLE bonding state survives across app restarts.** Don't blow it away
 *     on every connect — read it first, reuse if valid.
 *   - **Pairing UX is one-time.** Don't make Adam re-pair on every install.
 *
 * G2 doesn't use OS-level BLE bonding (PROTOCOL_NOTES.md §"Pairing model"),
 * so "bonded" here means: we've completed a successful 7-packet auth handshake
 * with this BD address before, and remembered it. Reconnect uses the saved
 * address to skip scanning when both lenses are still nearby.
 */
class PairingState(context: Context) {

    private val sp: SharedPreferences =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    var leftAddress: String?
        get() = sp.getString(KEY_LEFT, null)
        set(value) { sp.edit().putString(KEY_LEFT, value).apply() }

    var rightAddress: String?
        get() = sp.getString(KEY_RIGHT, null)
        set(value) { sp.edit().putString(KEY_RIGHT, value).apply() }

    var leftDeviceName: String?
        get() = sp.getString(KEY_LEFT_NAME, null)
        set(value) { sp.edit().putString(KEY_LEFT_NAME, value).apply() }

    var rightDeviceName: String?
        get() = sp.getString(KEY_RIGHT_NAME, null)
        set(value) { sp.edit().putString(KEY_RIGHT_NAME, value).apply() }

    fun forSide(side: Side): String? = when (side) {
        Side.Left -> leftAddress
        Side.Right -> rightAddress
    }

    fun setForSide(side: Side, address: String, deviceName: String) {
        when (side) {
            Side.Left -> { leftAddress = address; leftDeviceName = deviceName }
            Side.Right -> { rightAddress = address; rightDeviceName = deviceName }
        }
    }

    fun clear() { sp.edit().clear().apply() }

    val hasPair: Boolean get() = leftAddress != null && rightAddress != null

    companion object {
        private const val FILE = "g2cc-pairing"
        private const val KEY_LEFT = "left_addr"
        private const val KEY_RIGHT = "right_addr"
        private const val KEY_LEFT_NAME = "left_name"
        private const val KEY_RIGHT_NAME = "right_name"
    }
}
