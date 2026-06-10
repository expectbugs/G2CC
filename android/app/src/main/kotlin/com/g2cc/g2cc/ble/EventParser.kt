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
 * **Direction encoding — scoped status.** The LIVE path ([HubFocus] on `e0-01`)
 * is now CONFIRMED: f3=1 = scroll-up, f3=2 = scroll-down (g2cap capture 2026-06-10,
 * docs/G2_BLE_PROTOCOL.md §6.6). The legacy ring channel `0x01-01` ([decodeScroll]
 * below) is a DIFFERENT path that these captures did not exercise (the hijack gets
 * input via `e0-01`, not `0x01-01`); its direction stays provisional — any non-empty
 * 0x01-01 scroll emits ScrollDown. Going wrong-direction is recoverable (user scrolls
 * back); silently dropping events is not.
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
        /** EvenHub (`e0-01` `f1=2`) native menu-list selection — the firmware
         *  tracks focus locally (draws the select border) and reports the chosen
         *  [index] in container [widgetType]. Primary input for the hijack path. */
        data class HubSelect(val widgetType: String, val index: Int) : Event
        /** EvenHub (`e0-01` `f1=2`) low-level gesture (codes 3/4/5/7 observed).
         *  Firmware handles menu scroll natively, so these are informational. */
        data class HubGesture(val code: Int) : Event
        /** EvenHub (`e0-01` `f1=2`) focus/scroll report — the firmware names the
         *  currently-focused container by [containerId] + [name] (OUR own region
         *  id/name, echoed back) with a small [f3] = scroll direction.
         *  **CONFIRMED 2026-06-10** from the g2cap capture (each scroll ground-truthed
         *  against the on-screen breadcrumb): **f3=1 = scroll-up (SCROLL_TOP), f3=2 =
         *  scroll-down (SCROLL_BOTTOM)** — the SDK `OsEventTypeList`. (docs/G2_BLE_PROTOCOL.md
         *  §6.6.) The server (ws-handler) already maps 1→prev / 2→next. Wire:
         *  `08 02 6a <l> 12 <l> 08 <id> 12 <l> <name> 18 <f3>`. */
        data class HubFocus(val containerId: Int, val name: String, val f3: Int) : Event
        /** EvenHub (`e0-00`) ack for one of our `e0-20` writes: [ackType] = `req.f1 + 1`
         *  (launch 0→1, image 3→4, text 5→6, layout 7→8, keepalive 12→12), [msgId] = the echoed
         *  request msgId (`ack.f2`). The renderer ack-gates image chunks on these (G2Renderer.onImageAck).
         *  Decoded 2026-06-10 — docs/G2_BLE_PROTOCOL.md §5. */
        data class HubAck(val ackType: Int, val msgId: Int) : Event
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
        // Service 0xe0-01 = EvenHub Hub-app input channel (the hijack path).
        if (service.first == 0xE0.toByte() && service.second == 0x01.toByte()) {
            return decodeHubInput(payload)
        }
        // Service 0xe0-00 = EvenHub ack channel (acks for our display writes). The renderer
        // ack-gates image chunks on these, so decode the (ackType, msgId).
        if (service.first == 0xE0.toByte() && service.second == 0x00.toByte()) {
            return decodeHubAck(payload)
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
            0x0B -> decodeTap(payload)                       // Verify exact trailer to avoid false positives
            0x0C -> decodeScroll(payload)                    // Scroll family
            0x03 -> decodeInternalMenu(payload)              // Decorated 0x12345678-wrapped events
            else -> Event.Unknown(0x01.toByte() to 0x01.toByte(), payload.toHex())
        }
    }

    /** Decode tap (type=0x0b). 4th-pass review LOW (BLE bug 5): the byte
     *  0x0B is a common protobuf field tag — defensive match on the FULL
     *  observed trailer `6a 02 08 01` so a future firmware change that
     *  reuses 0x0B for a different event doesn't silently misinterpret
     *  as Tap. Falls through to Unknown if the trailer doesn't match. */
    private fun decodeTap(payload: ByteArray): Event {
        // Expected exact wire: `08 0b 10 01 6a 02 08 01` (8 bytes).
        val expected = byteArrayOf(0x08, 0x0B, 0x10, 0x01, 0x6A, 0x02, 0x08, 0x01)
        if (payload.size == expected.size && payload.contentEquals(expected)) {
            return Event.Tap
        }
        return Event.Unknown(0x01.toByte() to 0x01.toByte(), payload.toHex())
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
                    // Bound the shift like Varint.decode does — a garbage run of
                    // continuation bytes must not overflow Int into a wrapped
                    // value. counter stays -1 (diagnostic-only field) on overflow.
                    if (shift >= 35) break
                    k++
                }
                break
            }
            i++
        }
        return Event.InternalMenuEvent(counter, payload.toHex())
    }

    /** Decode an EvenHub ack on service 0xe0-00: `08 <ackType> 10 <msgId varint> …`
     *  (f1=ackType, f2=echoed msgId). Tolerant of trailing descriptor fields (the image ack
     *  carries f6). Falls back to Unknown if the prefix doesn't match. */
    private fun decodeHubAck(payload: ByteArray): Event {
        val svc = 0xE0.toByte() to 0x00.toByte()
        if (payload.size < 2 || payload[0] != 0x08.toByte()) return Event.Unknown(svc, payload.toHex())
        val (ackType, n1) = Varint.decode(payload, 1)
        val i = 1 + n1
        if (i >= payload.size || payload[i] != 0x10.toByte()) {
            // ackType present but no msgId field — still useful as a typed ack (msgId=-1).
            return Event.HubAck(ackType, -1)
        }
        val (msgId, _) = Varint.decode(payload, i + 1)
        return Event.HubAck(ackType, msgId)
    }

    /** Decode an EvenHub input event on service 0xe0-01 (`f1=2`). Two shapes
     *  (PROTOCOL_NOTES §"EvenHub channel", decoded 2026-06-04):
     *    - SELECTION  `08 02 6a <l> 0a <l> [08 id] 12 <l> <type> [20 idx]`
     *        → [Event.HubSelect] (firmware reports the chosen item + container)
     *    - GESTURE    `08 02 6a <l> 1a <l> 08 <code> ...`
     *        → [Event.HubGesture] (firmware handles scroll natively) */
    private fun decodeHubInput(payload: ByteArray): Event {
        val svc = 0xE0.toByte() to 0x01.toByte()
        // All observed events are `08 02` (f1=2 input) then f13 (tag 0x6a).
        if (payload.size < 3 || payload[0] != 0x08.toByte() || payload[1] != 0x02.toByte()) {
            return Event.Unknown(svc, payload.toHex())
        }
        if (payload[2] != 0x6A.toByte()) return Event.Unknown(svc, payload.toHex())
        return try {
            val (f13Len, used) = Varint.decode(payload, 3)
            val start = 3 + used
            if (start + f13Len > payload.size) {
                return Event.Malformed("hub input: f13 overruns payload", payload.toHex())
            }
            val f13 = payload.copyOfRange(start, start + f13Len)
            when (f13.firstOrNull()?.toInt()?.and(0xFF)) {
                0x0A -> decodeHubSelection(f13, payload.toHex())   // f13.f1 = selection
                0x12 -> decodeHubFocus(f13, payload.toHex())       // f13.f2 = focus/scroll
                0x1A -> decodeHubGesture(f13, payload.toHex())     // f13.f3 = gesture
                else -> Event.Unknown(svc, payload.toHex())
            }
        } catch (e: IllegalArgumentException) {
            Event.Malformed("hub input: ${e.message}", payload.toHex())
        }
    }

    /** f13.f1 submessage = `{f1=containerId, f2="<widgetType>", f4=<index>}`. */
    private fun decodeHubSelection(f13: ByteArray, rawHex: String): Event {
        return try {
            val (subLen, used) = Varint.decode(f13, 1)          // f13 = 0a <len> <sub>
            val s = 1 + used
            if (s + subLen > f13.size) return Event.Malformed("hub select: overruns", rawHex)
            val sub = f13.copyOfRange(s, s + subLen)
            var widgetType: String? = null
            var index = 0
            var i = 0
            while (i < sub.size) {
                val tag = sub[i].toInt() and 0xFF; i++
                when (tag) {
                    0x08 -> { val (_, u) = Varint.decode(sub, i); i += u }   // f1 containerId (ignored)
                    0x12 -> {                                                 // f2 widgetType string
                        val (len, u) = Varint.decode(sub, i); i += u
                        if (i + len > sub.size) return Event.Malformed("hub select: name overruns", rawHex)
                        widgetType = String(sub, i, len, Charsets.UTF_8); i += len
                    }
                    0x20 -> { val (v, u) = Varint.decode(sub, i); i += u; index = v }  // f4 index
                    else -> return Event.Malformed("hub select: unexpected tag 0x${"%02x".format(tag)}", rawHex)
                }
            }
            if (widgetType != null) Event.HubSelect(widgetType, index)
            else Event.Malformed("hub select: no widgetType", rawHex)
        } catch (e: IllegalArgumentException) {
            Event.Malformed("hub select: ${e.message}", rawHex)
        }
    }

    /** f13.f3 submessage = `{f1=<gestureCode>, ...}`. Firmware handles scroll
     *  locally; informational. */
    private fun decodeHubGesture(f13: ByteArray, rawHex: String): Event {
        return try {
            val (subLen, used) = Varint.decode(f13, 1)          // f13 = 1a <len> <sub>
            val s = 1 + used
            if (s + subLen > f13.size) return Event.Malformed("hub gesture: overruns", rawHex)
            val sub = f13.copyOfRange(s, s + subLen)
            if (sub.isEmpty() || sub[0] != 0x08.toByte()) return Event.HubGesture(-1)
            val (code, _) = Varint.decode(sub, 1)
            Event.HubGesture(code)
        } catch (e: IllegalArgumentException) {
            Event.Malformed("hub gesture: ${e.message}", rawHex)
        }
    }

    /** f13.f2 submessage = `{f1=containerId, f2="<name>", f3=<dir/state>}` — the
     *  firmware reporting focus/scroll on a container, naming it by OUR region id
     *  and name. Decoded 2026-06-06 from a controlled scroll capture. */
    private fun decodeHubFocus(f13: ByteArray, rawHex: String): Event {
        return try {
            val (subLen, used) = Varint.decode(f13, 1)          // f13 = 12 <len> <sub>
            val s = 1 + used
            if (s + subLen > f13.size) return Event.Malformed("hub focus: overruns", rawHex)
            val sub = f13.copyOfRange(s, s + subLen)
            var containerId = -1
            var name: String? = null
            var f3 = -1
            var i = 0
            while (i < sub.size) {
                val tag = sub[i].toInt() and 0xFF; i++
                when (tag) {
                    0x08 -> { val (v, u) = Varint.decode(sub, i); i += u; containerId = v }   // f1 containerId
                    0x12 -> {                                                                  // f2 name string
                        val (len, u) = Varint.decode(sub, i); i += u
                        if (i + len > sub.size) return Event.Malformed("hub focus: name overruns", rawHex)
                        name = String(sub, i, len, Charsets.UTF_8); i += len
                    }
                    0x18 -> { val (v, u) = Varint.decode(sub, i); i += u; f3 = v }             // f3 direction/state
                    else -> return Event.Malformed("hub focus: unexpected tag 0x${"%02x".format(tag)}", rawHex)
                }
            }
            if (name != null) Event.HubFocus(containerId, name, f3)
            else Event.Malformed("hub focus: no name", rawHex)
        } catch (e: IllegalArgumentException) {
            Event.Malformed("hub focus: ${e.message}", rawHex)
        }
    }

    private fun ByteArray.toHex(): String =
        joinToString(" ") { "%02X".format(it.toInt() and 0xFF) }

    const val TAG = "G2EventParser"
}
