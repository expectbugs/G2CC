package com.g2cc.g2cc.hud

import android.util.Log
import com.g2cc.g2cc.net.ClientMessage
import com.g2cc.g2cc.net.ConnectionManager
import com.g2cc.g2cc.net.ServerMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.atomic.AtomicReference

/**
 * Phase 7 — drives the `confirm_on_hud` UX:
 *
 *   server → ConfirmOnHud(requestId, text)
 *     ↓ this class renders text on HUD (scrollable, never truncated)
 *     ↓ wait for the next gesture event from the BLE EventParser
 *   user single-tap   → ConfirmOnHudResponse(requestId, 'confirmed')
 *   user double-tap   → ConfirmOnHudResponse(requestId, 'rejected')
 *
 * Hard rules:
 *   - **NO TIMEOUTS.** Per spec §22 + overhaul.md §22, the confirmation step
 *     waits as long as the user needs. There is no auto-confirm, no
 *     auto-discard, no clock-bound expiry.
 *   - **NO SILENT FAILURES.** If the WebSocket disconnects before the user
 *     responds, the in-flight request is dropped with a loud log; the server
 *     side already rejects its promise loudly (ws-handler.ts onClose path).
 *   - **NO TRUNCATION.** The HUD scrolls; full text reachable.
 *
 * Dispatcher-agnostic: any caller upstream of the WebSocket can invoke
 * `confirm_on_hud` (vanilla CC permission gate today; swarm specialists
 * later per overhaul.md §10). The Android side only sees the message; it
 * doesn't care who sent it.
 */
class ConfirmationFlow(
    private val hud: Hud,
    private val connection: ConnectionManager,
) {
    /** The currently-pending request, if any. Single-slot — multiple in-flight
     *  requests stack server-side; we render whichever arrived most recently
     *  (the server's confirmOnHud() in ws-handler.ts is awaited sequentially
     *  by callers, so concurrent requests for one client are not expected). */
    private val pending: AtomicReference<ServerMessage.ConfirmOnHud?> = AtomicReference(null)

    private val _active = MutableStateFlow(false)
    val active: StateFlow<Boolean> = _active.asStateFlow()

    /** Called by G2Pipeline when a ConfirmOnHud arrives.
     *
     *  Phase 7 fix #3: after the BLE write batch drains, send a `BleAckMsg`
     *  with the delivery status. The server's Channel Router uses this to
     *  flip the channel status to `verified` (writes drained successfully)
     *  or `unverified` (any write failed / no ack within window).
     *
     *  Third-pass fix: if a prior request is still pending when a new one
     *  arrives (Channel Router bug, two specialists, or any unexpected
     *  overlap), explicitly REJECT the prior so its server-side promise
     *  resolves loudly instead of deadlocking forever (no-timeouts rule
     *  means the server waits indefinitely). */
    fun onConfirmRequest(msg: ServerMessage.ConfirmOnHud) {
        Log.i(TAG, "confirm requested id=${msg.requestId} textLen=${msg.text.length}")
        val prev = pending.getAndSet(msg)
        if (prev != null) {
            Log.w(TAG, "superseding pending confirm id=${prev.requestId} (new id=${msg.requestId}) — emitting rejected for prior")
            connection.send(ClientMessage.ConfirmOnHudResponse(prev.requestId, "rejected"))
        }
        _active.value = true
        // Render scrollably; the rendered prefix tells the user their gesture options.
        // Per spec §6 "Confirm: tap • Reject: double-tap" line.
        val rendered = "${msg.text}\n\nConfirm: tap   Reject: double-tap"
        hud.render(rendered) { success ->
            connection.send(
                ClientMessage.BleAck(
                    messageId = msg.requestId,
                    status = if (success) "verified" else "unverified",
                    reason = if (success) null else "BLE write batch failed (see logcat)",
                ),
            )
        }
    }

    /** User produced a single-tap event. Emit confirmed if a request is pending. */
    fun onTap(): Boolean {
        val msg = pending.getAndSet(null) ?: return false
        _active.value = false
        Log.i(TAG, "confirm CONFIRMED id=${msg.requestId}")
        connection.send(ClientMessage.ConfirmOnHudResponse(msg.requestId, "confirmed"))
        return true
    }

    /** User produced a double-tap event. Emit rejected if a request is pending. */
    fun onDoubleTap(): Boolean {
        val msg = pending.getAndSet(null) ?: return false
        _active.value = false
        Log.i(TAG, "confirm REJECTED id=${msg.requestId}")
        connection.send(ClientMessage.ConfirmOnHudResponse(msg.requestId, "rejected"))
        return true
    }

    /** Called when the WebSocket disconnects. Drops any pending request loudly
     *  — the server-side promise will surface "Disconnected before confirmation"
     *  per ws-handler.ts. */
    fun onDisconnected() {
        val msg = pending.getAndSet(null) ?: return
        _active.value = false
        Log.w(TAG, "confirm DROPPED (disconnected) id=${msg.requestId}")
    }

    companion object {
        const val TAG = "G2CCConfirmFlow"
    }
}
