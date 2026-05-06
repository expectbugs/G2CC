package com.g2cc.g2cc.ble

/**
 * 7-packet authentication handshake.
 *
 * Verbatim port of /home/user/G2 Custom/even-g2-protocol/examples/teleprompter/teleprompter.py:70-114.
 * G2 uses application-level auth instead of BLE pairing/bonding (PROTOCOL_NOTES.md
 * §"Pairing model"). The exact byte sequences below are reverse-engineered;
 * field semantics (capability flags, transaction id) per i-soxi proto's
 * AuthRequest / TimeSyncRequest messages.
 *
 * Sequence:
 *   1. (0x80-00) Capability query
 *   2. (0x80-20) Capability response request
 *   3. (0x80-20) Time sync with transaction id
 *   4. (0x80-00) Additional capability exchange
 *   5. (0x80-00) Additional capability exchange
 *   6. (0x80-20) Final capability
 *   7. (0x80-20) Final time sync
 *
 * After the handshake completes (glasses ack received via 0x5402 notify on
 * service AUTH_RESPONSE 0x80-01), the connection is considered authenticated
 * and feature services can flow.
 */
object AuthSequence {

    /** Build the 7-packet handshake at the given Unix timestamp (seconds since epoch).
     *  The transaction id is hardcoded to -24 (per teleprompter.py) — its semantics
     *  are not yet reverse-engineered, but the value is reused across all observed
     *  captures so we keep it constant. */
    fun build(unixTimestampSec: Long): List<ByteArray> {
        val tsVarint = Varint.encode(unixTimestampSec.toInt())   // varint encoding tolerates int range here
        // Transaction id: per teleprompter.py:74 → 10 bytes 0xE8 FF FF FF FF FF FF FF FF 01
        // (interpreted as -24 signed in two's-complement-ish encoding)
        val txid = byteArrayOf(
            0xE8.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte(),
            0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0x01.toByte(),
        )

        val packets = ArrayList<ByteArray>(7)

        // 1. Capability query — service 0x80-00
        // teleprompter.py:79-82 — payload is fixed bytes.
        packets += G2Frame.command(
            seq = 1,
            service = G2Constants.Services.AUTH_CONTROL,
            payload = byteArrayOf(
                0x08, 0x04, 0x10, 0x0C,
                0x1A, 0x04, 0x08, 0x01, 0x10, 0x04,
            ),
        )

        // 2. Capability response request — service 0x80-20
        packets += G2Frame.command(
            seq = 2,
            service = G2Constants.Services.AUTH_DATA,
            payload = byteArrayOf(
                0x08, 0x05, 0x10, 0x0E,
                0x22, 0x02, 0x08, 0x02,
            ),
        )

        // 3. Time sync with transaction id — service 0x80-20
        // teleprompter.py:91 — `0x08 0x80 0x01 0x10 0x0F 0x82 0x08 0x11 0x08` then ts_varint then `0x10` then txid.
        run {
            val parts = ArrayList<Byte>().apply {
                addAll(
                    byteArrayOf(
                        0x08, 0x80.toByte(), 0x01, 0x10, 0x0F,
                        0x82.toByte(), 0x08, 0x11, 0x08,
                    ).toList(),
                )
                addAll(tsVarint.toList())
                add(0x10.toByte())
                addAll(txid.toList())
            }
            packets += G2Frame.command(
                seq = 3,
                service = G2Constants.Services.AUTH_DATA,
                payload = parts.toByteArray(),
            )
        }

        // 4. Additional capability exchange — service 0x80-00
        packets += G2Frame.command(
            seq = 4,
            service = G2Constants.Services.AUTH_CONTROL,
            payload = byteArrayOf(
                0x08, 0x04, 0x10, 0x10,
                0x1A, 0x04, 0x08, 0x01, 0x10, 0x04,
            ),
        )

        // 5. Additional capability exchange — service 0x80-00
        packets += G2Frame.command(
            seq = 5,
            service = G2Constants.Services.AUTH_CONTROL,
            payload = byteArrayOf(
                0x08, 0x04, 0x10, 0x11,
                0x1A, 0x04, 0x08, 0x01, 0x10, 0x04,
            ),
        )

        // 6. Final capability — service 0x80-20
        packets += G2Frame.command(
            seq = 6,
            service = G2Constants.Services.AUTH_DATA,
            payload = byteArrayOf(
                0x08, 0x05, 0x10, 0x12,
                0x22, 0x02, 0x08, 0x01,
            ),
        )

        // 7. Final time sync — service 0x80-20
        run {
            val parts = ArrayList<Byte>().apply {
                addAll(
                    byteArrayOf(
                        0x08, 0x80.toByte(), 0x01, 0x10, 0x13,
                        0x82.toByte(), 0x08, 0x11, 0x08,
                    ).toList(),
                )
                addAll(tsVarint.toList())
                add(0x10.toByte())
                addAll(txid.toList())
            }
            packets += G2Frame.command(
                seq = 7,
                service = G2Constants.Services.AUTH_DATA,
                payload = parts.toByteArray(),
            )
        }

        return packets
    }
}
