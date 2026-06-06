package com.g2cc.g2cc.render

import java.io.ByteArrayOutputStream

/** Lowercase hex of a byte array (mask to a byte — never sign-extend). */
fun hx(b: ByteArray): String = b.joinToString("") { "%02x".format(it.toInt() and 0xFF) }

/** Parse a hex string to bytes. */
fun unhx(s: String): ByteArray =
    ByteArray(s.length / 2) { ((Character.digit(s[it * 2], 16) shl 4) or Character.digit(s[it * 2 + 1], 16)).toByte() }

/**
 * Split a paced AA-packet stream back into per-message reassembled e0-20 PAYLOADS (header +
 * CRC stripped), grouping by the multi-packet pktTot/pktSer counters. Used to inspect what
 * [G2Renderer] actually emitted.
 */
fun splitMessages(packets: List<ByteArray>): List<ByteArray> {
    val msgs = ArrayList<ByteArray>()
    var acc = ByteArrayOutputStream()
    for (p in packets) {
        val len = p[3].toInt() and 0xFF
        val tot = p[4].toInt() and 0xFF
        val ser = p[5].toInt() and 0xFF
        val isFinal = ser >= tot
        val payloadLen = if (isFinal) len - 2 else len
        acc.write(p, 8, payloadLen)
        if (isFinal) { msgs.add(acc.toByteArray()); acc = ByteArrayOutputStream() }
    }
    return msgs
}

/** Recording [DisplaySink] for renderer orchestration tests. */
class FakeSink : DisplaySink {
    data class Call(val packets: List<ByteArray>, val delays: List<Long>, val label: String)
    val calls = ArrayList<Call>()
    var failNext = false
    override fun write(packets: List<ByteArray>, delaysAfterMs: List<Long>, label: String, onComplete: (Boolean) -> Unit) {
        calls.add(Call(packets, delaysAfterMs, label))
        onComplete(!failNext)
    }
    fun lastMessages(): List<ByteArray> = splitMessages(calls.last().packets)

    /** All reassembled messages across every write() call. With per-message sends the renderer
     *  issues one write() per message, so this is the logical message stream regardless of batching. */
    fun messages(): List<ByteArray> = splitMessages(calls.flatMap { it.packets })
}

/** The exact UTF-8 strings embedded in the Chess capture (U=19), reconstructed with escapes
 *  so the byte-match tests don't depend on terminal glyph handling. */
object ChessText {
    /** Launch + layout container text: "White - Move 3" / rule / "Tap to speak" / "Scroll to begin ▲▼". */
    val HEADER = "\nWhite - Move 3\n" + "─".repeat(8) + "\n\nTap to speak\nScroll to begin ▲▼"
    /** The f1=5 text-update content: same header but "Preparing board…". */
    val PREPARING = "\nWhite - Move 3\n" + "─".repeat(8) + "\n\nPreparing board…"
}
