package com.g2cc.g2cc.ble

import java.util.UUID

/**
 * G2 BLE service / characteristic UUIDs.
 *
 * EVERY UUID below has a citation comment to the source-of-truth in
 * /home/user/G2CC/docs/PROTOCOL_NOTES.md (which itself cites the i-soxi
 * captures + proto definitions). NEVER add a UUID here without lineage —
 * per CLAUDE.md "Reverse-Engineered Protocol Discipline".
 *
 * Originally verified against i-soxi/even-g2-protocol commit b227335 on
 * 2026-05-05. **Firmware drift confirmed 2026-06-01** via deep characteristic
 * dump captured on Adam's G2 pair (server log `[client-diag] DEEP: ...`).
 *
 * The drift: i-soxi described a single parent service `0x0000` containing
 * characteristics 0x5401 (W), 0x5402 (n), 0x5450 (service decl), 0x6402
 * (display), etc. Current firmware promoted each functional group to its own
 * top-level service whose UUID is the OLD service-declaration suffix:
 *   - Service 0x5450 now contains chars 0x5401 (W) + 0x5402 (n)  ← MAIN
 *   - Service 0x6450 now contains chars 0x6401 (W) + 0x6402 (n)  ← Display
 *   - Service 0x7450 now contains chars 0x7401 (W) + 0x7402 (n)  ← unknown
 *   - Service 0x1001 now contains chars 0x0001 (W) + 0x0002 (n)  ← unknown
 *   - Nordic UART (6e400001-...) also present — likely DFU / debug
 * The characteristic suffixes (5401/5402) survived the refactor; only the
 * parent SERVICE UUID moved.
 */
object G2Constants {

    /** PROTOCOL_NOTES.md §"BLE Services & Characteristics" — service UUID base.
     *  Format: 00002760-08c2-11e1-9073-0e8ac72e{xxxx} */
    private const val UUID_BASE_PREFIX = "00002760-08c2-11e1-9073-0e8ac72e"

    private fun uuid(suffixHex: Int): UUID =
        UUID.fromString(String.format("%s%04x", UUID_BASE_PREFIX, suffixHex))

    /** Suffix 0x5450 — main service container on current firmware.
     *  Holds the canonical write (0x5401) + notify (0x5402) characteristics.
     *  Pre-drift this was characteristic CHAR_SERVICE_DECL under service 0x0000. */
    val SERVICE: UUID = uuid(0x5450)

    /** PROTOCOL_NOTES.md §"BLE Services" suffix 5401 — Write characteristic.
     *  Phone → Glasses commands. Write Without Response. MTU 512.
     *  Survived firmware drift; only parent service moved (was 0x0000, now 0x5450). */
    val CHAR_WRITE: UUID = uuid(0x5401)

    /** PROTOCOL_NOTES.md §"BLE Services" suffix 5402 — Notify characteristic.
     *  Glasses → Phone responses + ack. CCCD enabled by writing 0x0100.
     *  Survived firmware drift; parent service is now 0x5450. */
    val CHAR_NOTIFY: UUID = uuid(0x5402)

    /** Suffix 0x6450 — display-channel service container on current firmware.
     *  Holds chars 0x6401 (W) + 0x6402 (n). Phase 6+ may need this for raw
     *  display rendering separate from the main protocol. */
    val SERVICE_DISPLAY: UUID = uuid(0x6450)

    /** PROTOCOL_NOTES.md §"BLE Services" suffix 6402 — Display rendering channel.
     *  Phase 5 does NOT use this (proto types undocumented for non-teleprompter
     *  rendering); kept here as a constant for Phase 6+. Parent service is now 0x6450. */
    val CHAR_DISPLAY: UUID = uuid(0x6402)

    /** PROTOCOL_NOTES.md §"Device naming — DUAL GLASS".
     *  G2 advertises as TWO devices: "Even G2_XX_L_YYYYYY" and "Even G2_XX_R_YYYYYY".
     *  The Android scanner pairs both lenses. */
    const val NAME_PREFIX = "Even G2"
    const val NAME_LEFT_INFIX = "_L_"
    const val NAME_RIGHT_INFIX = "_R_"

    /** PROTOCOL_NOTES.md §"Packet wire format" — header magic byte. */
    const val MAGIC = 0xAA.toByte()

    /** Packet types per PROTOCOL_NOTES.md §"Message Types": */
    const val TYPE_COMMAND = 0x21.toByte()    // Phone → Glasses
    const val TYPE_RESPONSE = 0x12.toByte()   // Glasses → Phone

    /** PROTOCOL_NOTES.md §"Service ID catalog" — service IDs (high byte, low byte).
     *  The byte pair is encoded into header[6..7] of every packet. */
    object Services {
        // Auth & control
        val AUTH_CONTROL = byteArrayOf(0x80.toByte(), 0x00)   // sync, capability
        val AUTH_DATA = byteArrayOf(0x80.toByte(), 0x20)      // capability with payload
        val AUTH_RESPONSE = byteArrayOf(0x80.toByte(), 0x01)  // glasses ack

        // Feature services
        val DISPLAY_WAKE = byteArrayOf(0x04.toByte(), 0x20)
        val TELEPROMPTER = byteArrayOf(0x06.toByte(), 0x20)
        val DASHBOARD = byteArrayOf(0x07.toByte(), 0x20)
        val DEVICE_INFO = byteArrayOf(0x09.toByte(), 0x00)
        /** Device-info QUERY (write channel) — G2_BLE_PROTOCOL.md init table
         *  rows 4+12: `09-20` type 1/2; type 2 → the 45 B `09-00` carrying
         *  firmware + battery (§10). */
        val DEVICE_INFO_QUERY = byteArrayOf(0x09.toByte(), 0x20)
        val CONVERSATE = byteArrayOf(0x0B.toByte(), 0x20)     // Glasses → Phone (output only)
        val TASKS = byteArrayOf(0x0C.toByte(), 0x20)
        val CONFIGURATION = byteArrayOf(0x0D.toByte(), 0x00)
        val DISPLAY_CONFIG = byteArrayOf(0x0E.toByte(), 0x20)
        val CONVERSATE_ALT = byteArrayOf(0x11.toByte(), 0x20)
        val COMMIT = byteArrayOf(0x20.toByte(), 0x20)
        val DISPLAY_TRIGGER = byteArrayOf(0x81.toByte(), 0x20)
        val NOTIFICATION = byteArrayOf(0x02.toByte(), 0x20)   // metadata only — partial
    }

    /** PROTOCOL_NOTES.md §"Connection parameters" — informational; Nordic library
     *  uses its own connection parameter request mechanism. */
    object ConnectionParams {
        const val INTERVAL_MIN_MS = 7.5
        const val INTERVAL_MAX_MS = 30.0
        const val SLAVE_LATENCY = 0
        const val SUPERVISION_TIMEOUT_MS = 2_000
        const val MTU = 512
    }
}
