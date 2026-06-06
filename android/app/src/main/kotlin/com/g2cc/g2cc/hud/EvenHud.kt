package com.g2cc.g2cc.hud

import android.util.Log
import com.g2cc.g2cc.ble.EvenHub
import com.g2cc.g2cc.ble.G2BleClient

/**
 * g2code-style renderer on the EvenHub (`e0-20`) hijack path — the production
 * counterpart to [Hud] (teleprompter). Renders the two-region g2code layout —
 * a `menu-header` status bar (region 1) over a `menu-list` / `main` content
 * region (region 2) — via the [EvenHub] container encoder, and writes the
 * frames to the R lens (L is held alive at the connection level, same as the
 * proven probe + teleprompter path).
 *
 * Responsibilities (BLE orchestration; the wire encoding lives in [EvenHub]):
 *  - own the monotonic AA-frame `seq` / protobuf `msgId` counters
 *  - cold-launch the DocuLens slot (prelude → launch → first content)
 *  - render menus / text / confirm screens as `e0-20 f1=7` content-updates
 *  - mint the `f1=12` keepalive frame for the pipeline's heartbeat loop
 *
 * Hard rules (CLAUDE.md): no truncation (long content multi-packets, never
 * clipped), no timeouts (BLE failures surface via the write callback), loud
 * failures (write failure → Log + the onComplete(false) the caller diags).
 */
class EvenHud(
    private val left: G2BleClient,
    private val right: G2BleClient,
    /** Loud-failure hook → server diag stream (CLAUDE.md). Render packet counts
     *  and BLE write results go here so a multi-packet send the glasses drop is
     *  visible over SSH, not just in logcat. No-op default keeps tests simple. */
    private val diag: (String) -> Unit = {},
) {

    private val counterLock = Any()
    // Persistent monotonic counters (NOT reset per render) so overlapping renders
    // never collide on a seq/msgId. seq wraps within [0x10,0xFF] to stay clear of
    // the auth seq range (0x00-0x0F); msgId wraps within [0x20,0xFF] — a >255
    // (2-byte varint) msgId silently kills the hijacked slot (see G2Renderer doc).
    private var seq: Int = 0x10
    private var msgId: Int = 0x20

    private fun nextSeq(): Int = synchronized(counterLock) {
        val s = seq; seq = if (seq >= 0xFF) 0x10 else seq + 1; s
    }

    private fun nextMsgId(): Int = synchronized(counterLock) {
        val m = msgId; msgId = if (msgId >= 0xFF) 0x20 else msgId + 1; m   // 1-byte: >255 msgId kills the slot
    }

    /** Phone-initiated COLD launch: display prelude → DocuLens launch (`f1=0`) →
     *  first content. Paced like the proven probe re-establishment (150 ms between
     *  stages). The first content reflects the CURRENT frame: a confirm screen
     *  when [displayHeader] is non-null (so a reconnect mid-confirm/STT repaints
     *  the transcript, not a bare menu), otherwise a menu. After this the pipeline
     *  heartbeat holds the session with [keepaliveFrame]. */
    fun coldLaunch(
        statusText: String,
        items: List<String>,
        displayHeader: String? = null,
        onComplete: (Boolean) -> Unit = {},
    ) {
        val frames = ArrayList<ByteArray>()
        val delays = ArrayList<Long>()
        for (f in EvenHub.COLD_INIT) { frames += f; delays += STAGE_PACE_MS }
        frames += EvenHub.launch(nextSeq(), nextMsgId()); delays += STAGE_PACE_MS
        val content = if (displayHeader != null) {
            EvenHub.confirmScreen(nextSeq(), nextMsgId(), statusText, displayHeader, items)
        } else {
            EvenHub.menuScreen(nextSeq(), nextMsgId(), statusText, items)
        }
        appendPaced(frames, delays, content)
        Log.i(TAG, "coldLaunch: ${frames.size} frames (prelude + launch + ${if (displayHeader != null) "confirm" else "menu"}/${items.size} items)")
        writeR(frames, delays, "coldLaunch", onComplete)
    }

    /** Render a menu screen: `menu-header` status bar + `menu-list` items. */
    fun renderMenu(statusText: String, items: List<String>, onComplete: (Boolean) -> Unit = {}) {
        val packets = EvenHub.menuScreen(nextSeq(), nextMsgId(), statusText, items)
        Log.i(TAG, "renderMenu: '${statusText.take(24)}' ${items.size} items → ${packets.size} pkts")
        writeR(packets, pacing(packets.size), "renderMenu", onComplete)
    }

    /** Render a text screen: `menu-header` status bar + `main` body (CC output). */
    fun renderText(statusText: String, body: String, onComplete: (Boolean) -> Unit = {}) {
        val packets = EvenHub.textScreen(nextSeq(), nextMsgId(), statusText, body)
        Log.i(TAG, "renderText: '${statusText.take(24)}' ${body.length}c → ${packets.size} pkts")
        writeR(packets, pacing(packets.size), "renderText", onComplete)
    }

    /** Render a confirmation screen: read-only [body] above a selectable
     *  [options] menu-list (firmware reports the choice on `e0-01`). */
    fun renderConfirm(statusText: String, body: String, options: List<String>, onComplete: (Boolean) -> Unit = {}) {
        val packets = EvenHub.confirmScreen(nextSeq(), nextMsgId(), statusText, body, options)
        Log.i(TAG, "renderConfirm: '${statusText.take(20)}' ${body.length}c + ${options.size} options → ${packets.size} pkts")
        writeR(packets, pacing(packets.size), "renderConfirm", onComplete)
    }

    /** Mint a session-keepalive frame (`f1=12`) with fresh seq/msgId. The pipeline
     *  heartbeat writes this to R every ~4 s (probe v12 cadence). */
    fun keepaliveFrame(): ByteArray = EvenHub.keepalive(nextSeq(), nextMsgId())

    // ---- internals ----

    private fun appendPaced(frames: ArrayList<ByteArray>, delays: ArrayList<Long>, packets: List<ByteArray>) {
        for ((i, p) in packets.withIndex()) {
            frames += p
            delays += if (i < packets.size - 1) PACKET_PACE_MS else STAGE_PACE_MS
        }
    }

    private fun pacing(n: Int): List<Long> = List(n) { i -> if (i < n - 1) PACKET_PACE_MS else STAGE_PACE_MS }

    /** Write to the R lens only — R is the display lens (probe + teleprompter
     *  finding); L stays authenticated at the connection level. Failures are
     *  loud: the write callback's `false` is surfaced to the caller's diag. */
    private fun writeR(packets: List<ByteArray>, delays: List<Long>, label: String, onComplete: (Boolean) -> Unit) {
        val bytes = packets.sumOf { it.size }
        // Loud per CLAUDE.md: surface render size + write result to the diag stream
        // (not just logcat) so a multi-packet send the glasses drop is visible over
        // SSH. The 83-dir directory hang was invisible precisely because this
        // render/write path was silent.
        diag("hud→R $label: ${packets.size} pkt / ${bytes}B — writing")
        right.queueWrites(packets, "R:$label", delays) { ok ->
            if (!ok) Log.w(TAG, "$label: R write reported failure")
            diag("hud→R $label: write ${if (ok) "OK" else "FAILED"} (${packets.size} pkt)")
            onComplete(ok)
        }
    }

    companion object {
        const val TAG = "G2CCEvenHud"
        // Inter-stage pacing for the cold-launch (prelude → launch → content),
        // mirroring the probe's proven 150 ms REESTABLISH_PACE_MS. Fragments of a
        // single multi-packet content-update go out faster (they're one frame).
        private const val STAGE_PACE_MS = 150L
        private const val PACKET_PACE_MS = 30L
    }
}
