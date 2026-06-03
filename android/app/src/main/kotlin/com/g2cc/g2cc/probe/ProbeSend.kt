package com.g2cc.g2cc.probe

import com.g2cc.g2cc.ble.G2Constants
import com.g2cc.g2cc.ble.G2Frame
import java.util.UUID

/**
 * Pure (Android-free, testable) logic for the probe's "Send to characteristic"
 * feature — probe v3. The UI lives in [ProbeActivity]; all byte/UUID prep and
 * validation lives here so it can be unit-tested without BLE or a device.
 *
 * Two send modes, motivated by docs/EVENHUB_FINDING.md:
 *
 *  - **RAW** — write the exact bytes to a chosen GATT characteristic,
 *    verbatim. This is the truest replay of captured Even App writes: it
 *    preserves the original sequence byte and CRC exactly as the Even App
 *    sent them. Use this to replay a frame lifted straight from a BTSnoop.
 *
 *  - **FRAME** — wrap a 2-byte service ID + payload in a canonical AA-frame
 *    via [G2Frame.command] (auto sequence, computed CRC) and write it to the
 *    main write characteristic [G2Constants.CHAR_WRITE] (0x5401). This is how
 *    an EvenHub `0xe0-00` acknowledgment is constructed: the `0xe0-XX` service
 *    ID lives in the frame HEADER (bytes 6–7), written through 0x5401 — it is
 *    NOT a separate GATT characteristic
 *    (EVENHUB_FINDING.md §"Discovered service tree": notifies on `e0-01`
 *    arrive on the standard 0x5402 char; writes to `e0-00` go through 0x5401).
 *
 * Failures throw [IllegalArgumentException] with a human-readable message —
 * the caller surfaces it loudly. Nothing here silently drops or pads bytes
 * (CLAUDE.md: NO SILENT FAILURES).
 */
object ProbeSend {

    enum class Mode { RAW, FRAME }

    /** Result of preparing a send: which characteristic to write, the exact
     *  bytes to write, and a human-readable one-line summary for the log. */
    data class Prepared(
        val charUuid: UUID,
        val bytes: ByteArray,
        val summary: String,
    ) {
        // ByteArray needs explicit equals/hashCode for value semantics in tests.
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Prepared) return false
            return charUuid == other.charUuid &&
                bytes.contentEquals(other.bytes) &&
                summary == other.summary
        }

        override fun hashCode(): Int {
            var result = charUuid.hashCode()
            result = 31 * result + bytes.contentHashCode()
            result = 31 * result + summary.hashCode()
            return result
        }
    }

    /** G2 characteristic UUID base — PROTOCOL_NOTES.md §"BLE Services & Characteristics".
     *  Same prefix as [G2Constants]; a 4-hex suffix selects a characteristic. */
    private const val UUID_BASE_PREFIX = "00002760-08c2-11e1-9073-0e8ac72e"

    /**
     * Parse a loose hex string into bytes. Tolerant of the separators that
     * show up when pasting from a BTSnoop or our own diag log: spaces, tabs,
     * newlines, commas, colons, dashes, underscores, pipes, and `0x` prefixes.
     *
     * Throws [IllegalArgumentException] on an odd number of hex digits or any
     * non-hex character — it never silently drops or pads. An all-separator
     * (or empty) string parses to an empty array; callers that require bytes
     * enforce that themselves.
     */
    fun parseHex(input: String): ByteArray {
        val sb = StringBuilder(input.length)
        var i = 0
        while (i < input.length) {
            val c = input[i]
            if (c == '0' && i + 1 < input.length && (input[i + 1] == 'x' || input[i + 1] == 'X')) {
                i += 2 // skip an 0x / 0X prefix
                continue
            }
            if (c.isWhitespace() || c == ',' || c == ':' || c == '-' || c == '_' || c == '|') {
                i += 1
                continue
            }
            sb.append(c)
            i += 1
        }
        val hex = sb.toString()
        require(hex.length % 2 == 0) {
            "hex has an odd digit count (${hex.length}); each byte needs exactly 2 hex chars"
        }
        val out = ByteArray(hex.length / 2)
        for (j in out.indices) {
            val hi = Character.digit(hex[j * 2], 16)
            val lo = Character.digit(hex[j * 2 + 1], 16)
            require(hi >= 0 && lo >= 0) {
                "non-hex characters near '${hex.substring(j * 2, j * 2 + 2)}'"
            }
            out[j] = ((hi shl 4) or lo).toByte()
        }
        return out
    }

    /**
     * Resolve a target characteristic from user input. Accepts either:
     *  - a 4-hex-digit suffix on the G2 base prefix (e.g. `5401`, `0x6402`), or
     *  - a full 36-char UUID string.
     *
     * Throws [IllegalArgumentException] on anything else.
     */
    fun resolveCharUuid(input: String): UUID {
        val t = input.trim()
        require(t.isNotEmpty()) { "target characteristic is empty" }
        if (t.contains('-')) {
            // A full UUID; UUID.fromString throws IllegalArgumentException if malformed.
            return UUID.fromString(t)
        }
        val suffix = if (t.startsWith("0x") || t.startsWith("0X")) t.substring(2) else t
        require(suffix.length == 4 && suffix.all { Character.digit(it, 16) >= 0 }) {
            "target must be a 4-hex-digit characteristic suffix (e.g. 5401) or a full UUID; got '$input'"
        }
        return UUID.fromString("$UUID_BASE_PREFIX$suffix")
    }

    /**
     * Prepare a send. In [Mode.RAW] the `addrField` is the target characteristic
     * and `bodyField` is the exact bytes to write. In [Mode.FRAME] the
     * `addrField` is the 2-byte service ID and `bodyField` is the payload to be
     * wrapped (with [seq] and a computed CRC) and written to 0x5401.
     */
    fun prepare(mode: Mode, addrField: String, bodyField: String, seq: Int): Prepared = when (mode) {
        Mode.RAW -> {
            val uuid = resolveCharUuid(addrField)
            val bytes = parseHex(bodyField)
            require(bytes.isNotEmpty()) { "RAW mode: no bytes to send" }
            Prepared(
                uuid,
                bytes,
                "RAW ${bytes.size}B verbatim -> char ${uuid.toString().takeLast(4)}",
            )
        }
        Mode.FRAME -> {
            val service = parseHex(addrField)
            require(service.size == 2) {
                "FRAME mode: service must be exactly 2 bytes (e.g. 'e0 00'); got ${service.size}"
            }
            val payload = parseHex(bodyField)
            val frame = G2Frame.command(seq = seq, service = service, payload = payload)
            val svcStr = "%02x-%02x".format(service[0].toInt() and 0xFF, service[1].toInt() and 0xFF)
            Prepared(
                G2Constants.CHAR_WRITE,
                frame,
                "FRAME svc=$svcStr seq=$seq payload=${payload.size}B -> 0x5401 (${frame.size}B wire)",
            )
        }
    }
}
