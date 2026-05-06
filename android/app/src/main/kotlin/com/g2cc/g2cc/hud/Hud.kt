package com.g2cc.g2cc.hud

import android.util.Log
import com.g2cc.g2cc.ble.G2BleClient
import com.g2cc.g2cc.ble.Teleprompter

/**
 * Bridges WebSocket display content to BLE Teleprompter writes.
 *
 * Phase 6 ships a minimal renderer that pages text via Teleprompter.formatPages()
 * and pushes each page using the Teleprompter init / content / marker / sync
 * sequence. Phase 7 wires confirm-on-HUD; Phase 8 wires speak/see/confirm.
 *
 * Hard rules baked in:
 *  - **No truncation.** `render()` accepts arbitrarily long text; pages count
 *    grows. The G2 firmware natively scrolls, so the user can read the full
 *    content via tap-scroll.
 *  - **No `withTimeout`** wrapping BLE writes; the BLE client surfaces failures
 *    via its `state` flow, which the caller observes for status updates.
 */
class Hud(private val left: G2BleClient, private val right: G2BleClient) {

    private var seq: Int = 0x10        // server reserves 0x00-0x0F for auth; we start higher
    private var msgId: Int = 0x20

    /** Render `text` on the HUD via the teleprompter primitive. Returns the
     *  number of pages produced (informational; UI may show "page 1 of N"). */
    fun render(text: String): Int {
        val pages = Teleprompter.formatPages(text)
        Log.i(TAG, "render: ${text.length} chars → ${pages.size} pages")

        sendBoth(Teleprompter.buildDisplayConfig(seq = nextSeq(), msgId = nextMsgId()), "displayConfig")
        sendBoth(
            Teleprompter.buildInit(
                seq = nextSeq(),
                msgId = nextMsgId(),
                totalLines = pages.size * LINES_PER_PAGE,
                mode = Teleprompter.ScrollMode.Manual,
            ),
            "init",
        )

        val firstBatch = pages.take(10)
        for ((i, p) in firstBatch.withIndex()) {
            sendBoth(Teleprompter.buildContentPage(nextSeq(), nextMsgId(), i, p), "page $i")
        }

        sendBoth(Teleprompter.buildMarker(nextSeq(), nextMsgId()), "marker")

        if (pages.size > 10) {
            for (i in 10 until minOf(12, pages.size)) {
                sendBoth(Teleprompter.buildContentPage(nextSeq(), nextMsgId(), i, pages[i]), "page $i")
            }
        }

        sendBoth(Teleprompter.buildSyncTrigger(nextSeq(), nextMsgId()), "sync")

        if (pages.size > 12) {
            for (i in 12 until pages.size) {
                sendBoth(Teleprompter.buildContentPage(nextSeq(), nextMsgId(), i, pages[i]), "page $i")
            }
        }

        return pages.size
    }

    /** Send a single packet to both lenses. Per PROTOCOL_NOTES.md §"Device naming
     *  — DUAL GLASS": both lenses are independent BLE devices and need their
     *  own writes. */
    private fun sendBoth(packet: ByteArray, label: String) {
        left.sendPacket(packet, "L:$label")
        right.sendPacket(packet, "R:$label")
    }

    private fun nextSeq(): Int {
        val s = seq
        seq = (seq + 1) and 0xFF
        return s
    }

    private fun nextMsgId(): Int {
        val m = msgId
        msgId = (msgId + 1) and 0xFFFF
        return m
    }

    companion object {
        const val TAG = "G2CCHud"
        private const val LINES_PER_PAGE = 10
    }
}
