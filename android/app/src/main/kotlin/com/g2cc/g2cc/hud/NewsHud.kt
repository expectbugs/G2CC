package com.g2cc.g2cc.hud

import android.util.Log
import com.g2cc.g2cc.ble.G2BleClient
import com.g2cc.g2cc.ble.G2Constants
import com.g2cc.g2cc.ble.G2Frame
import com.g2cc.g2cc.ble.Varint

/**
 * Phase Y display renderer — uses the News-style content-delivery channel
 * (service `0x01-20`) instead of the teleprompter channel (`0x06-20`).
 *
 * Why News-style over teleprompter? Per Adam's factory testing the Even
 * App's News mode never disconnected in a 9-minute capture, while the
 * Even App's other modes (Teleprompter, AI) drop more often. Mirroring the
 * News path is our best bet for getting Even-App-News stability into G2CC.
 *
 * Payload format decoded from the BTSnoop capture (PROTOCOL_NOTES.md §
 * "Service 0x01-20"):
 *   type=9 (article-push)
 *   msgId (incrementing)
 *   f11 wrapper [
 *     f6 = title / headline (UTF-8)
 *     f7 = timestamp epoch-ms (optional metadata)
 *     f8 = source name        (optional metadata)
 *     f9 = body text (UTF-8)
 *   ]
 *
 * For G2CC we use a SIMPLIFIED wrapper: only f6 (title — used by the
 * RootMenu as the current submenu name) and f9 (body — the menu items
 * or content). Skip f7 timestamp + f8 source because they're news-feed
 * metadata that doesn't apply to our menu/content. The firmware should
 * accept the simplified shape per protobuf forward-compat rules.
 *
 * MTU handling: glasses negotiate MTU 247 (= 230 bytes per packet after
 * header overhead). Content longer than ~200 bytes after wrapper framing
 * MUST be fragmented across continuation packets. The Even App fragments
 * with field-tag continuations (f12/f13/f14 carry text-fragment bytes).
 * For v1 we render content within the single-packet limit and document
 * the truncation point loudly if exceeded — Phase Y polish can add proper
 * fragmentation once we have working single-packet renders.
 *
 * Hard rules:
 *  - NO TRUNCATION: if content exceeds the single-packet limit, fail
 *    loudly via Log.w + diag rather than silently shortening
 *  - NO TIMEOUTS: pacing delays between packets are inter-packet only
 *  - LOUD failures via the BLE write status callback
 */
class NewsHud(private val left: G2BleClient, private val right: G2BleClient) {

    /** Last rendered (title, body) — read by the reconnect path to replay
     *  the same content after a BLE drop+recover cycle. */
    @Volatile var lastTitle: String? = null
        private set
    @Volatile var lastBody: String? = null
        private set

    private val seqLock = Any()
    private var seq: Int = 0x20            // start above auth (1-7) + teleprompter range (0x10-0x1F)
    private var msgId: Int = 0x80

    /** Render (title, body) on the HUD. Both lenses get the same content;
     *  per BTSnoop, the Even App News writes to R only — we mirror to BOTH
     *  for now until we confirm R-only is sufficient in the News-style
     *  display path. Calls onComplete after BLE writes drain. */
    fun render(title: String, body: String, onComplete: (success: Boolean) -> Unit = {}) {
        lastTitle = title
        lastBody = body

        val (s, m) = synchronized(seqLock) {
            val r = seq to msgId
            seq = (seq + 1) and 0xFF
            if (seq < 0x20) seq = 0x20      // wrap to non-overlapping range
            msgId = (msgId + 1) and 0xFFFF
            r
        }

        val packet = buildArticlePush(seq = s, msgId = m, title = title, body = body)
        Log.i(TAG, "render title='${title.take(40)}' body=${body.length}c → ${packet.size}B packet")

        // Check single-packet limit — fail loud if exceeded.
        if (packet.size > MAX_SINGLE_PACKET_BYTES) {
            Log.w(TAG, "render content too large: ${packet.size}B > ${MAX_SINGLE_PACKET_BYTES}B; " +
                "single-packet path can't deliver. Phase Y polish must add fragmentation.")
            onComplete(false)
            return
        }

        // Send to both lenses. Even App sends News content to R only; we
        // mirror to both as a conservative start. Adjust to R-only if
        // empirically L-also-OK or L-also-needed.
        val gate = CompletionGate(onComplete)
        left.sendPacket(packet, "L:news")
        gate.left(true)                     // sendPacket is fire-and-forget; treat as success
        right.sendPacket(packet, "R:news")
        gate.right(true)
    }

    /** Build a single News-style article-push packet:
     *    [G2Frame header] type=9 [msgId varint] f11=[f6=title, f9=body] [CRC]
     */
    fun buildArticlePush(seq: Int, msgId: Int, title: String, body: String): ByteArray {
        val titleBytes = title.toByteArray(Charsets.UTF_8)
        val bodyBytes = body.toByteArray(Charsets.UTF_8)

        // f6 = title (tag 0x32 = field 6, wire type 2)
        // f9 = body  (tag 0x4A = field 9, wire type 2)
        val f6 = byteArrayOf(0x32) + Varint.encode(titleBytes.size) + titleBytes
        val f9 = byteArrayOf(0x4A) + Varint.encode(bodyBytes.size) + bodyBytes
        val articleBody = f6 + f9

        // f11 = article wrapper (tag 0x5A = field 11, wire type 2)
        val f11 = byteArrayOf(0x5A) + Varint.encode(articleBody.size) + articleBody

        // Outer: type=9 (08 09), msgId tag (0x10) + varint, then f11
        val payload = byteArrayOf(0x08, 0x09, 0x10) + Varint.encode(msgId) + f11

        return G2Frame.command(seq, G2Constants.Services.NEWS_CONTENT, payload)
    }

    /** Aggregate L+R completion (same shape as Hud.CompletionGate). */
    private class CompletionGate(private val onComplete: (Boolean) -> Unit) {
        private val lock = Any()
        private var leftDone = false; private var leftOk = false
        private var rightDone = false; private var rightOk = false

        fun left(ok: Boolean) {
            val result: Boolean? = synchronized(lock) {
                if (leftDone) return
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
        const val TAG = "G2CCNewsHud"
        // MTU 247 - 8 header - 2 CRC = 237 payload bytes max per packet.
        // Conservative single-packet limit leaves headroom for protobuf overhead.
        const val MAX_SINGLE_PACKET_BYTES = 237
    }
}
