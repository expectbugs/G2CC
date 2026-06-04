package com.g2cc.g2cc.ble

import java.io.ByteArrayOutputStream

/**
 * Reassembles multi-packet AA frames (PktTot > 1) arriving on the notify
 * characteristic into one logical frame for [EventParser].
 *
 * Wire format per PROTOCOL_NOTES.md §"Multi-packet messages": Seq is constant
 * across all packets of a message; PktTot = total count; PktSer = 1..PktTot.
 * Each fragment is itself a complete AA frame (8-byte header + chunk + 2-byte
 * CRC over the chunk), exactly mirroring [G2Frame.commandMulti] on the send
 * side. Reassembly concatenates the fragment PAYLOAD chunks and re-wraps them in
 * a single header (PktTot=PktSer=1) plus a recomputed CRC over the joined
 * payload, so the result re-validates through [EventParser.parse] like any
 * single-packet frame.
 *
 * Why this exists: the notify callback previously fed each raw GATT packet to
 * EventParser independently. A fragmented glasses→phone frame would then CRC-fail
 * on every fragment and surface as `Event.Malformed` — a silent loss of a real
 * event. PktTot/PktSer in the header exist for exactly this case.
 *
 * NOTE: no captured glasses→phone frame has yet been observed to fragment (ring
 * events are <16 B; the largest known reply, the ~179 B app list, fits one
 * MTU-247 notification). This is the documented-format interpretation, INERT
 * until a real fragmented notify arrives — single-packet frames (PktTot ≤ 1, the
 * only case seen today) pass straight through byte-for-byte. When the first
 * multi-packet notify is captured, verify reassembly against it.
 *
 * One instance per connection; [offer] is called from the single BLE notify
 * callback thread (no internal locking needed).
 */
class FrameReassembler {

    /**
     * Result of offering a fragment.
     *  - [deliver] non-null → a complete frame ready for EventParser.
     *  - [warning] non-null → a loud diagnostic the caller should log.
     * Both may be set at once (e.g. a single-packet frame arrived while a partial
     * was still accumulating: deliver the single frame AND warn about the dropped
     * partial). Both null → still accumulating; nothing to do.
     */
    data class Out(val deliver: ByteArray?, val warning: String?)

    private var seq: Int = -1
    private var type: Int = 0
    private var svcHi: Byte = 0
    private var svcLo: Byte = 0
    private var pktTotal: Int = 0          // 0 = no partial in flight
    private var nextSerial: Int = 1
    private val payload = ByteArrayOutputStream()

    private fun pending(): Boolean = pktTotal > 0

    private fun reset() {
        seq = -1; type = 0; svcHi = 0; svcLo = 0; pktTotal = 0; nextSerial = 1
        payload.reset()
    }

    fun offer(fragment: ByteArray): Out {
        // Too short to carry a header, or not an AA frame — hand it straight to
        // EventParser (which flags it), but note any partial we're abandoning.
        if (fragment.size < G2Frame.HEADER_SIZE + G2Frame.CRC_SIZE || fragment[0] != G2Constants.MAGIC) {
            val w = if (pending()) "non-frame bytes arrived mid-reassembly; dropped partial (had ${nextSerial - 1}/$pktTotal)".also { reset() } else null
            return Out(fragment, w)
        }
        val total = fragment[4].toInt() and 0xFF
        val serial = fragment[5].toInt() and 0xFF

        // Single-packet (the only case observed today) — deliver as-is, unchanged.
        if (total <= 1) {
            val w = if (pending()) "single-packet frame interrupted reassembly; dropped partial (had ${nextSerial - 1}/$pktTotal)".also { reset() } else null
            return Out(fragment, w)
        }

        // Multi-packet fragment. Each fragment is a full AA frame, so verify ITS
        // own CRC before trusting its header/chunk.
        if (!G2Frame.verifyCrc(fragment)) {
            val suffix = if (pending()) "; dropped partial (had ${nextSerial - 1}/$pktTotal)" else ""
            reset()
            return Out(null, "multi-packet fragment CRC fail (serial=$serial/$total)$suffix")
        }
        val fragSeq = fragment[2].toInt() and 0xFF
        var warning: String? = null

        if (serial == 1) {
            if (pending()) warning = "new message started before previous completed; dropped partial (had ${nextSerial - 1}/$pktTotal)"
            reset()
            seq = fragSeq
            type = fragment[1].toInt() and 0xFF
            svcHi = fragment[6]
            svcLo = fragment[7]
            pktTotal = total
            nextSerial = 1
        } else if (!pending() || fragSeq != seq || serial != nextSerial || total != pktTotal) {
            val reason = "out-of-order/mismatched fragment (serial=$serial expected=$nextSerial, " +
                "seq=$fragSeq expected=$seq, total=$total expected=$pktTotal); dropped"
            reset()
            return Out(null, reason)
        }

        // Append this fragment's payload chunk (bytes 8 .. size-2).
        payload.write(fragment, G2Frame.HEADER_SIZE, fragment.size - G2Frame.HEADER_SIZE - G2Frame.CRC_SIZE)
        nextSerial = serial + 1

        return if (serial == total) {
            val frame = assemble()
            reset()
            Out(frame, warning)
        } else {
            Out(null, warning)
        }
    }

    /** Build one synthetic AA frame from the joined payload: header
     *  (PktTot=PktSer=1) + payload + freshly computed CRC. EventParser.parse
     *  re-verifies this CRC, so the reassembled frame runs the same validation as
     *  any single-packet frame. The Len byte holds only the low byte of
     *  (payload+CRC) — parse() ignores Len, and a reassembled payload can exceed
     *  the 1-byte field. */
    private fun assemble(): ByteArray {
        val body = payload.toByteArray()
        val out = ByteArray(G2Frame.HEADER_SIZE + body.size + G2Frame.CRC_SIZE)
        out[0] = G2Constants.MAGIC
        out[1] = type.toByte()
        out[2] = (seq and 0xFF).toByte()
        out[3] = ((body.size + G2Frame.CRC_SIZE) and 0xFF).toByte()
        out[4] = 1
        out[5] = 1
        out[6] = svcHi
        out[7] = svcLo
        body.copyInto(out, G2Frame.HEADER_SIZE)
        val crc = Crc16.compute(body)
        out[G2Frame.HEADER_SIZE + body.size] = (crc and 0xFF).toByte()
        out[G2Frame.HEADER_SIZE + body.size + 1] = ((crc ushr 8) and 0xFF).toByte()
        return out
    }
}
