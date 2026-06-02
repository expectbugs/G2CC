package com.g2cc.g2cc.ble

import android.util.Log

/**
 * Parser for input events the glasses send back over the Notify characteristic.
 *
 * **Updated 2026-06-02 with BTSnoop intel from Even App News session.** The
 * ring event channel is service `0x01-01` on the R lens notify characteristic.
 * Three event types observed:
 *
 *   - `0x0b` (tap): always exactly `08 0b 10 01 6a 02 08 01`. Fires at the
 *     END of scroll sessions = "user opened the highlighted item".
 *   - `0x0c` (scroll): `08 0c 10 01 72 [len] [sub-event]`. Sub-event
 *     contains scroll metadata. Empty `72 00` = focus/wake event when ring
 *     starts moving; non-empty = an actual scroll notch.
 *   - `0x03` (decorated/internal): wrapped in a 0x12345678 magic + counter
 *     envelope. Looks like internal-menu events from the glasses' own UI
 *     layer. Surface as InternalMenuEvent for now; not actionable for our
 *     menu navigation.
 *
 * **Direction encoding unconfirmed.** Adam's BTSnoop capture was browsing
 * the Even App News feed, scrolling mostly downward. The sub-event field
 * structure is `[f1=v[2|3|4] f2=v[incrementing]]` — `f1` may encode
 * direction OR scroll speed; we don't have a controlled up-then-down
 * capture to distinguish. For now: any non-empty scroll event emits
 * ScrollDown with a TODO to revisit. Going wrong-direction is recoverable
 * (user scrolls back); silently dropping events is not.
 *
 * Frames from OTHER services (auth acks 0x80-01, display config 0x0e-00,
 * device info 0x09-00 etc.) still surface as Unknown so we don't silently
 * lose them — important for debugging.
 *
 * Per CLAUDE.md "no silent failure": every malformed frame emits as
 * Event.Malformed with a hex dump, and every unrecognized service emits
 * Event.Unknown with full context. The caller decides how loudly to log.
 */
object EventParser {

    sealed interface Event {
        /** Not yet decoded. Hex dump in `payloadHex`. Includes the service id
         *  so callers can filter (e.g. ignore display-config acks). */
        data class Unknown(val service: Pair<Byte, Byte>, val payloadHex: String) : Event
        /** Single-tap / select. Always the same byte pattern; user "opened" the
         *  currently-highlighted thing on glasses HUD. */
        data object Tap : Event
        /** Double-tap. **Currently never emitted** — the G2 firmware handles
         *  double-tap natively (shows "End Feature?" dialog) BEFORE the event
         *  reaches the phone. Kept in the sealed hierarchy in case we find a
         *  capture where it does come through (e.g. when in a custom display
         *  mode that disables the native handler). */
        data object DoubleTap : Event
        /** Scroll up — provisional direction (BTSnoop only had downward scrolls;
         *  if scrolls feel reversed in practice, swap the ScrollUp/ScrollDown
         *  mapping in [decodeScroll] below). */
        data object ScrollUp : Event
        /** Scroll down — see ScrollUp note. */
        data object ScrollDown : Event
        /** Ring detected motion start (empty 0x0c scroll event with `72 00`).
         *  Useful for waking up menu / starting a scroll session. */
        data object ScrollFocus : Event
        /** Decorated internal-menu event from the glasses' own UI (service
         *  0x01-01 type 3 with 0x12345678 magic). Surface so we can ignore
         *  cleanly; not actionable for our app-side menu navigation. */
        data class InternalMenuEvent(val counter: Int, val payloadHex: String) : Event
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

        // Service 0x01-01 = ring input event channel (BTSnoop 2026-06-02).
        if (service.first == 0x01.toByte() && service.second == 0x01.toByte()) {
            return decodeInputEvent(payload)
        }
        // Everything else (auth acks, display config responses, etc.) — surface
        // as Unknown so the caller can filter quietly without us losing data.
        Log.d(TAG, "event service=${service.first.toInt() and 0xFF}-${service.second.toInt() and 0xFF} payload=${payload.toHex()}")
        return Event.Unknown(service, payload.toHex())
    }

    /** Decode a service 0x01-01 payload into a typed event. Payload structure:
     *  `08 [type] 10 [msg_id_varint] [sub-fields...]`. */
    private fun decodeInputEvent(payload: ByteArray): Event {
        if (payload.size < 4) return Event.Malformed("0x01-01 payload too short", payload.toHex())
        // Expect `08 [type]` prefix.
        if (payload[0] != 0x08.toByte()) {
            return Event.Unknown(0x01.toByte() to 0x01.toByte(), payload.toHex())
        }
        val type = payload[1].toInt() and 0xFF
        return when (type) {
            0x0B -> Event.Tap                                // Confirmed: `08 0b 10 01 6a 02 08 01`
            0x0C -> decodeScroll(payload)                    // Scroll family
            0x03 -> decodeInternalMenu(payload)              // Decorated 0x12345678-wrapped events
            else -> Event.Unknown(0x01.toByte() to 0x01.toByte(), payload.toHex())
        }
    }

    /** Type 0x0c scroll family. Look at the `72 [len] [data]` sub-field. */
    private fun decodeScroll(payload: ByteArray): Event {
        // Skip past `08 0c 10 [msg_id_varint]` to find the 0x72 sub-field.
        // msg_id is a varint of unknown length; scan forward.
        var idx = 2  // past `08 0c`
        if (idx >= payload.size || payload[idx] != 0x10.toByte()) {
            return Event.Unknown(0x01.toByte() to 0x01.toByte(), payload.toHex())
        }
        idx++  // past 0x10
        // Skip varint (msg_id). 4th-pass review MEDIUM (BLE bug 4): the
        // prior loop could exit at `idx == payload.size` with all bytes
        // having continuation set (truncated varint), then the unconditional
        // `idx++` pushed idx PAST size and we silently fell through to
        // ScrollFocus — masking a malformed packet as a benign event.
        // Now: verify the loop exited cleanly on a non-continuation byte
        // OR emit Event.Malformed loudly.
        while (idx < payload.size && (payload[idx].toInt() and 0x80) != 0) idx++
        if (idx >= payload.size) {
            return Event.Malformed("scroll: unterminated varint (truncated payload)", payload.toHex())
        }
        idx++  // past last varint byte (the one without continuation set)
        if (idx >= payload.size) return Event.ScrollFocus  // no sub-field = wake/focus event
        if (payload[idx] != 0x72.toByte()) {
            return Event.Unknown(0x01.toByte() to 0x01.toByte(), payload.toHex())
        }
        idx++  // past 0x72
        if (idx >= payload.size) return Event.Malformed("scroll: truncated after 0x72 tag", payload.toHex())
        val subLen = payload[idx].toInt() and 0xFF
        idx++  // past length byte
        if (subLen == 0) return Event.ScrollFocus
        // Non-empty sub-event = actual scroll notch. Direction encoding
        // unconfirmed — emit ScrollDown provisionally per the doc note above.
        return Event.ScrollDown
    }

    /** Type 0x03 decorated event — wrapped in 0x12345678 magic + counter.
     *  We don't act on these (the glasses' internal UI handled it already)
     *  but surface for diagnostic purposes. */
    private fun decodeInternalMenu(payload: ByteArray): Event {
        // Structure: `08 03 10 [magic_varint=0x12345678] 32 [len] [event]`
        // Extract the counter from the wrapped event if possible (f1 of the
        // inner f6 message). Best-effort.
        var counter = -1
        // Scan for `32 [len] 08 [counter_varint]` pattern (the f6/f1 fields).
        var i = 0
        while (i < payload.size - 4) {
            if (payload[i] == 0x32.toByte() && payload[i + 2] == 0x08.toByte()) {
                // Next bytes form a varint counter.
                var v = 0
                var shift = 0
                var k = i + 3
                while (k < payload.size) {
                    val b = payload[k].toInt() and 0xFF
                    v = v or ((b and 0x7F) shl shift)
                    if ((b and 0x80) == 0) {
                        counter = v
                        break
                    }
                    shift += 7
                    k++
                }
                break
            }
            i++
        }
        return Event.InternalMenuEvent(counter, payload.toHex())
    }

    private fun ByteArray.toHex(): String =
        joinToString(" ") { "%02X".format(it.toInt() and 0xFF) }

    const val TAG = "G2EventParser"
}
