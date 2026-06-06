package com.g2cc.g2cc.hud

import android.util.Log
import com.g2cc.g2cc.ble.G2BleClient
import com.g2cc.g2cc.ble.Teleprompter

/**
 * Bridges WebSocket display content to BLE Teleprompter writes.
 *
 * Phase 6 ships a minimal renderer that pages text via Teleprompter.formatPages()
 * and pushes each page using the Teleprompter init / content / marker / sync
 * sequence. Phase 7 wires confirm-on-HUD with completion callback (so the
 * BleAck can fire after the BLE writes drain).
 *
 * Hard rules baked in:
 *  - **No truncation.** `render()` accepts arbitrarily long text; pages count
 *    grows. The G2 firmware natively scrolls, so the user can read the full
 *    content via tap-scroll.
 *  - **No `withTimeout`** wrapping BLE writes; the BLE client surfaces failures
 *    via its `state` flow, which the caller observes for status updates.
 *  - **Sequence counters are synchronized** so concurrent renders don't race
 *    on `seq` / `msgId` (Phase 7 fix #8).
 */
class Hud(private val left: G2BleClient, private val right: G2BleClient) {

    private val counterLock = Any()
    // PERSISTENT across renders (NOT reset per-render). Two render() calls that
    // overlap (e.g. heartbeat re-render racing a server Output) used to both
    // reset to 0x10 and emit colliding seq ranges. Keeping a monotonic counter
    // — guarded by counterLock during each render's build — gives every render a
    // distinct, contiguous block. Wraps within [0x10,0xFF] / [0x20,0xFF] so it
    // never re-enters the auth seq range (0x00-0x0F).
    private var seq: Int = 0x10        // server reserves 0x00-0x0F for auth; we start higher
    private var msgId: Int = 0x20

    /** Last rendered first page text — used by the heartbeat to re-send a
     *  content_page packet (the strongest "teleprompter session still active"
     *  signal). Null until first render. */
    @Volatile var lastPage0: String? = null
        private set

    /** Last raw render input text — used by G2Pipeline.observeBleHealth to
     *  replay the current HUD content after a BLE drop+reconnect cycle. If
     *  null, the caller falls back to the hello frame. */
    @Volatile var lastRenderedText: String? = null
        private set

    /** Render `text` on the HUD via the teleprompter primitive. Returns the
     *  number of pages produced (informational; UI may show "page 1 of N").
     *
     *  When all BLE writes drain, `onComplete(true)` fires if both lenses
     *  succeeded; `onComplete(false)` if either side reported a failure.
     *  Phase 7 fix #3: ConfirmationFlow uses this to send BleAckMsg with the
     *  delivery status. */
    fun render(
        text: String,
        fastReRender: Boolean = false,
        onComplete: (success: Boolean) -> Unit = {},
    ): Int {
        val pages = Teleprompter.formatPages(text)
        lastPage0 = pages.firstOrNull()
        lastRenderedText = text
        Log.i(TAG, "render: ${text.length} chars → ${pages.size} pages (fast=$fastReRender)")

        // Build the full packet bundle with locked counter access. Per
        // i-soxi/docs/teleprompter.md §"Message Sequence" the order is:
        //   display_config → init → first 10 pages → marker → next 2 pages
        //   → sync trigger → remaining pages
        //
        // seq/msgId are NOT reset here — they advance monotonically across
        // renders (see field decl). The whole packet build runs under
        // counterLock, so two overlapping render() calls each draw a distinct
        // contiguous block instead of both starting at 0x10 and colliding.
        // (We deliberately do NOT coalesce/drop a concurrent render — each
        // render() call may carry different content, so dropping one could lose
        // a real Output update. Two legitimate render requests = two bursts.)
        //
        // delaysAfterMs mirrors the i-soxi teleprompter.py inter-packet sleeps:
        //   display_config → 300 ms (fast: 100 ms)
        //   init           → 500 ms (longest — firmware switches into HUD mode; fast: 200 ms)
        //   content page   → 100 ms (fast: 30 ms)
        //   marker         → 100 ms (fast: 30 ms)
        //   sync_trigger   → 100 ms (fast: 30 ms)
        // Without these delays the take-over succeeds but text never renders
        // (confirmed 2026-06-01 on Adam's pair: ok=true + L=3 R=24 notifies but
        // blank screen + "End Feature?" from R1 ring → flooded firmware).
        // Fast mode (re-renders against an already-HUD-mode firmware) cuts
        // ~60% off the wall-clock recovery window after a BLE reconnect.
        val d_displayConfig = if (fastReRender) 100L else 300L
        val d_init          = if (fastReRender) 200L else 500L
        val d_page          = if (fastReRender) 30L  else 100L
        val d_marker        = if (fastReRender) 30L  else 100L
        val d_sync          = if (fastReRender) 30L  else 100L
        val packets = ArrayList<ByteArray>()
        val delays = ArrayList<Long>()
        synchronized(counterLock) {
            packets += Teleprompter.buildDisplayConfig(nextSeqLocked(), nextMsgIdLocked())
            delays += d_displayConfig

            packets += Teleprompter.buildInit(
                seq = nextSeqLocked(),
                msgId = nextMsgIdLocked(),
                totalLines = pages.size * LINES_PER_PAGE,
                mode = Teleprompter.ScrollMode.Manual,
            )
            delays += d_init

            for ((i, p) in pages.take(10).withIndex()) {
                packets += Teleprompter.buildContentPage(nextSeqLocked(), nextMsgIdLocked(), i, p)
                delays += d_page
            }
            packets += Teleprompter.buildMarker(nextSeqLocked(), nextMsgIdLocked())
            delays += d_marker
            if (pages.size > 10) {
                for (i in 10 until minOf(12, pages.size)) {
                    packets += Teleprompter.buildContentPage(nextSeqLocked(), nextMsgIdLocked(), i, pages[i])
                    delays += d_page
                }
            }
            packets += Teleprompter.buildSyncTrigger(nextSeqLocked(), nextMsgIdLocked())
            delays += d_sync
            if (pages.size > 12) {
                for (i in 12 until pages.size) {
                    packets += Teleprompter.buildContentPage(nextSeqLocked(), nextMsgIdLocked(), i, pages[i])
                    delays += d_page
                }
            }
        }

        // Per PROTOCOL_NOTES.md §"Device naming — DUAL GLASS": both lenses are
        // independent BLE devices. The Python i-soxi reference picks ONE lens
        // (L by default) and renders to it; the firmware does eye-to-eye
        // sync internally so the user sees the HUD in both eyes.
        //
        // Phase D body-blockage experiment (2026-06-02): we observed L lens
        // notify counts barely move (4→22) while R counts climb hundreds per
        // minute — L is silent on teleprompter despite receiving the same
        // packets. Sending to BOTH means 2× BLE write load during the 2.5 s
        // render window, doubling vulnerability to body-induced supervision
        // timeout. Switching to R-only: half the RF load, same visible HUD.
        // L connection still held (auth handshake + heartbeat at the
        // connection-interval level keep it alive) but no teleprompter
        // writes go there.
        //
        // 4th-pass review MEDIUM (BLE bug 6): gate.left(true) is a
        // DELIBERATE "we didn't send to L, treat as N/A success" — NOT a
        // claim that delivery to L was verified. Read with bug-6 context:
        // the success boolean returned to onComplete reflects R only.
        // Heartbeat & observeBleHealth still monitor L's actual liveness
        // via the per-lens ConnectionState flow, so L going dead is caught
        // there (not silenced here).
        val gate = CompletionGate(onComplete)
        gate.left(true)   // R-only render — L not written to, see comment above
        right.queueWrites(packets, "R:render", delays) { gate.right(it) }

        return pages.size
    }

    /** MUST be called inside `synchronized(counterLock)`. Wraps within
     *  [0x10, 0xFF] so it never collides with the auth seq range (0x00-0x0F). */
    private fun nextSeqLocked(): Int {
        val s = seq
        seq = if (seq >= 0xFF) 0x10 else seq + 1
        return s
    }

    /** MUST be called inside `synchronized(counterLock)`. Wraps within
     *  [0x20, 0xFF] — a >255 (2-byte varint) msgId silently kills the slot. */
    private fun nextMsgIdLocked(): Int {
        val m = msgId
        msgId = if (msgId >= 0xFF) 0x20 else msgId + 1   // 1-byte: >255 msgId kills the slot
        return m
    }

    /** Aggregate left + right completion. Fires the caller's callback once,
     *  with `true` only if both sides reported success. */
    private class CompletionGate(private val onComplete: (Boolean) -> Unit) {
        private val lock = Any()
        private var leftDone = false; private var leftOk = false
        private var rightDone = false; private var rightOk = false

        fun left(ok: Boolean) {
            // Bug-fix-pass-2 #5: read leftOk/rightOk INSIDE the synchronized
            // block to establish happens-before for cross-thread visibility.
            // The prior version released the lock then read the fields — without
            // a memory barrier the second thread could race the first's writes.
            val result: Boolean? = synchronized(lock) {
                if (leftDone) return  // double-call guard
                leftDone = true; leftOk = ok
                if (rightDone) (leftOk && rightOk) else null
            }
            if (result != null) onComplete(result)
        }

        fun right(ok: Boolean) {
            val result: Boolean? = synchronized(lock) {
                if (rightDone) return
                rightDone = true; rightOk = ok
                if (leftDone) (leftOk && rightOk) else null
            }
            if (result != null) onComplete(result)
        }
    }

    companion object {
        const val TAG = "G2CCHud"
        private const val LINES_PER_PAGE = 10
    }
}
