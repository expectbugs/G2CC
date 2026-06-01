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
    private var seq: Int = 0x10        // server reserves 0x00-0x0F for auth; we start higher
    private var msgId: Int = 0x20

    /** Render `text` on the HUD via the teleprompter primitive. Returns the
     *  number of pages produced (informational; UI may show "page 1 of N").
     *
     *  When all BLE writes drain, `onComplete(true)` fires if both lenses
     *  succeeded; `onComplete(false)` if either side reported a failure.
     *  Phase 7 fix #3: ConfirmationFlow uses this to send BleAckMsg with the
     *  delivery status. */
    fun render(text: String, onComplete: (success: Boolean) -> Unit = {}): Int {
        val pages = Teleprompter.formatPages(text)
        Log.i(TAG, "render: ${text.length} chars → ${pages.size} pages")

        // Build the full packet bundle with locked counter access. Per
        // i-soxi/docs/teleprompter.md §"Message Sequence" the order is:
        //   display_config → init → first 10 pages → marker → next 2 pages
        //   → sync trigger → remaining pages
        //
        // Reset seq/msgId at the start of each render. The 8-bit seq used to
        // wrap (~14 renders × 18 packets) and 16-bit msgId would eventually
        // wrap too. Per-render reset gives each batch a fresh range so
        // in-batch ordering is unambiguous. NOTE: this assumes renders
        // serialize; two concurrent render() calls would collide on the
        // same seq range. Phase 9 polish should add a render-level lock if
        // concurrent renders become a real scenario.
        val packets = synchronized(counterLock) {
            seq = 0x10
            msgId = 0x20
            buildList {
                add(Teleprompter.buildDisplayConfig(nextSeqLocked(), nextMsgIdLocked()))
                add(
                    Teleprompter.buildInit(
                        seq = nextSeqLocked(),
                        msgId = nextMsgIdLocked(),
                        totalLines = pages.size * LINES_PER_PAGE,
                        mode = Teleprompter.ScrollMode.Manual,
                    ),
                )
                for ((i, p) in pages.take(10).withIndex()) {
                    add(Teleprompter.buildContentPage(nextSeqLocked(), nextMsgIdLocked(), i, p))
                }
                add(Teleprompter.buildMarker(nextSeqLocked(), nextMsgIdLocked()))
                if (pages.size > 10) {
                    for (i in 10 until minOf(12, pages.size)) {
                        add(Teleprompter.buildContentPage(nextSeqLocked(), nextMsgIdLocked(), i, pages[i]))
                    }
                }
                add(Teleprompter.buildSyncTrigger(nextSeqLocked(), nextMsgIdLocked()))
                if (pages.size > 12) {
                    for (i in 12 until pages.size) {
                        add(Teleprompter.buildContentPage(nextSeqLocked(), nextMsgIdLocked(), i, pages[i]))
                    }
                }
            }
        }

        // Per PROTOCOL_NOTES.md §"Device naming — DUAL GLASS": both lenses are
        // independent BLE devices, each gets its own queued write batch.
        // We aggregate completion: both must succeed for `onComplete(true)`.
        val gate = CompletionGate(onComplete)
        left.queueWrites(packets, "L:render") { gate.left(it) }
        right.queueWrites(packets, "R:render") { gate.right(it) }

        return pages.size
    }

    /** MUST be called inside `synchronized(counterLock)`. */
    private fun nextSeqLocked(): Int {
        val s = seq
        seq = (seq + 1) and 0xFF
        return s
    }

    /** MUST be called inside `synchronized(counterLock)`. */
    private fun nextMsgIdLocked(): Int {
        val m = msgId
        msgId = (msgId + 1) and 0xFFFF
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
