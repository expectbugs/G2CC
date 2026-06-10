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

/** The msgId (protobuf f2) of a reassembled e0-20 message payload (`08 <f1> 10 <msgId> …`). */
fun msgIdOf(payload: ByteArray): Int {
    require(payload.isNotEmpty() && payload[0] == 0x08.toByte()) { "not an e0-20 message: ${hx(payload)}" }
    var i = 1
    while (i < payload.size && (payload[i].toInt() and 0x80) != 0) i++   // skip the f1 varint
    i++                                                                   // past the f1 terminator byte
    require(i < payload.size && payload[i] == 0x10.toByte()) { "no f2/msgId field: ${hx(payload)}" }
    i++
    var v = 0; var shift = 0
    while (i < payload.size) {
        val b = payload[i].toInt() and 0xFF; i++
        v = v or ((b and 0x7f) shl shift)
        if (b and 0x80 == 0) return v
        shift += 7
    }
    error("truncated msgId varint: ${hx(payload)}")
}

private fun msgIdOrNull(payload: ByteArray): Int? = runCatching { msgIdOf(payload) }.getOrNull()

/** Recording [DisplaySink] for renderer orchestration tests. When [acker] is wired (see [mkRenderer]),
 *  it simulates the glasses acking every e0-20 write — so the renderer's image ack-gate advances. With
 *  [acker] left null, image chunks PARK after their write, letting a test drive [G2Renderer.onImageAck]
 *  manually to assert the gating. */
class FakeSink : DisplaySink {
    data class Call(val packets: List<ByteArray>, val delays: List<Long>, val label: String)
    val calls = ArrayList<Call>()
    var failNext = false
    var acker: ((Int) -> Unit)? = null
    override fun write(packets: List<ByteArray>, delaysAfterMs: List<Long>, label: String, onComplete: (Boolean) -> Unit) {
        calls.add(Call(packets, delaysAfterMs, label))
        val ok = !failNext
        onComplete(ok)
        // Simulate the glasses' e0-00 ack AFTER the write completes (so a parked image chunk resumes).
        if (ok) acker?.let { ack -> splitMessages(packets).forEach { m -> msgIdOrNull(m)?.let(ack) } }
    }
    fun lastMessages(): List<ByteArray> = splitMessages(calls.last().packets)

    /** All reassembled messages across every write() call. With per-message sends the renderer
     *  issues one write() per message, so this is the logical message stream regardless of batching. */
    fun messages(): List<ByteArray> = splitMessages(calls.flatMap { it.packets })
}

/** A renderer wired to auto-ack through [sink] (the default for orchestration tests — image chunks
 *  flow as if the glasses ack each one). For ack-gate/abort tests, construct G2Renderer(sink) directly
 *  so chunks park. */
fun mkRenderer(sink: FakeSink, diag: (String) -> Unit = {}): G2Renderer =
    G2Renderer(sink, diag).also { sink.acker = it::onImageAck }

/** The exact UTF-8 strings embedded in the Chess capture (U=19), reconstructed with escapes
 *  so the byte-match tests don't depend on terminal glyph handling. */
object ChessText {
    /** Launch + layout container text: "White - Move 3" / rule / "Tap to speak" / "Scroll to begin ▲▼". */
    val HEADER = "\nWhite - Move 3\n" + "─".repeat(8) + "\n\nTap to speak\nScroll to begin ▲▼"
    /** The f1=5 text-update content: same header but "Preparing board…". */
    val PREPARING = "\nWhite - Move 3\n" + "─".repeat(8) + "\n\nPreparing board…"
}
