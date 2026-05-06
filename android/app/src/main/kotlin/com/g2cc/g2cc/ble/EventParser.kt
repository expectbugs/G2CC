package com.g2cc.g2cc.ble

import android.util.Log

/**
 * Parser for input events the glasses send back over the Notify characteristic.
 *
 * **PHASE 5 KNOWN INCOMPLETE.** PROTOCOL_NOTES.md §"Open research items" #1
 * lists this as not yet documented in i-soxi's proto definitions. Captures
 * contain the bytes; the field meanings are still being reverse-engineered.
 *
 * Until Phase 5 testing (with real glasses) lands fresh BTSnoop dumps and
 * decodes the event format properly, this parser:
 *
 *   1. Verifies the packet's wire format (magic byte + CRC).
 *   2. Surfaces the raw payload to the caller via `RawEvent`.
 *   3. Heuristically classifies common events using observed byte patterns
 *      from i-soxi captures (best-effort; may produce `Unknown`).
 *
 * Phase 5 testing notes: when the user produces a tap event, the resulting
 * frame should appear in logcat under tag `G2EventParser` as `Unknown(...)`
 * along with a hex dump. That hex dump becomes the input to refining this
 * file with proper Tap/DoubleTap/Scroll cases.
 *
 * Refusal-to-guess: rather than emitting Tap on the first event we see, the
 * parser emits Unknown until the byte patterns are documented. NO SILENT
 * FAILURE — the caller knows it received an event but doesn't know what it
 * means yet.
 */
object EventParser {

    sealed interface Event {
        /** Best-effort: not yet decoded. Hex dump in `payloadHex`. */
        data class Unknown(val service: Pair<Byte, Byte>, val payloadHex: String) : Event
        /** Single-tap (right temple or ring) — heuristic; verify on hardware. */
        data object Tap : Event
        /** Double-tap. */
        data object DoubleTap : Event
        /** Scroll up. */
        data object ScrollUp : Event
        /** Scroll down. */
        data object ScrollDown : Event
        /** Frame failed CRC or header validation — emitted loudly. */
        data class Malformed(val reason: String, val rawHex: String) : Event
    }

    fun parse(packet: ByteArray): Event {
        if (packet.size < G2Frame.HEADER_SIZE + G2Frame.CRC_SIZE) {
            return Event.Malformed("packet too short (${packet.size} bytes)", packet.toHex())
        }
        if (packet[0] != G2Constants.MAGIC) {
            return Event.Malformed("bad magic byte 0x${"%02X".format(packet[0])}", packet.toHex())
        }
        if (!G2Frame.verifyCrc(packet)) {
            return Event.Malformed("CRC mismatch", packet.toHex())
        }
        val service = packet[6] to packet[7]
        val payload = packet.copyOfRange(G2Frame.HEADER_SIZE, packet.size - G2Frame.CRC_SIZE)

        // PROTOCOL_NOTES.md §"Open research items" #1 — refine these once captures
        // with known tap events are decoded. Until then we surface Unknown.
        val payloadHex = payload.toHex()
        Log.d(TAG, "event service=${service.first.toInt() and 0xFF}-${service.second.toInt() and 0xFF} payload=$payloadHex")
        return Event.Unknown(service, payloadHex)
    }

    private fun ByteArray.toHex(): String =
        joinToString(" ") { "%02X".format(it.toInt() and 0xFF) }

    const val TAG = "G2EventParser"
}
