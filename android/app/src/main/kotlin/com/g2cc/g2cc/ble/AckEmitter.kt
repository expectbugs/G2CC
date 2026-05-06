package com.g2cc.g2cc.ble

import android.util.Log

/**
 * Phase 7 hookpoint — emits BLE delivery-status acks back over the WebSocket
 * to the server's Channel Router (per spec §10).
 *
 * Phase 5 doesn't have a WebSocket client yet (Phase 6), so this is a
 * placeholder shape:
 *
 *   - Server tags an outbound message with a `messageId`.
 *   - The Android side calls `markVerified(messageId)` after a successful BLE
 *     write+notify roundtrip OR `markUnverified(messageId, reason)` on failure
 *     or timeout (an APPLICATION-level ack window — see CLAUDE.md interpretation).
 *   - The emitter posts a BleAckMsg to the WebSocket sender (Phase 6 wires).
 *
 * Per spec §10 the ack-window is a *delivery status* threshold, not an
 * *operation timeout* — the underlying operation is not killed; only the
 * channel status falls to `unverified` if no ack arrives within the window.
 */
object AckEmitter {

    /** Phase 6 wires this; today it just logs so wiring is observable. */
    fun markVerified(messageId: String) {
        Log.i(TAG, "ack VERIFIED messageId=$messageId")
        // Phase 6: send BleAckMsg(messageId, status='verified') over the WebSocket.
    }

    fun markUnverified(messageId: String, reason: String) {
        Log.w(TAG, "ack UNVERIFIED messageId=$messageId reason=$reason")
        // Phase 6: send BleAckMsg(messageId, status='unverified', reason) over the WebSocket.
    }

    const val TAG = "G2CCAckEmitter"
}
