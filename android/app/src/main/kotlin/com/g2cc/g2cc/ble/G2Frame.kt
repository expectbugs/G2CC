package com.g2cc.g2cc.ble

/**
 * G2 BLE packet builder — frame format per PROTOCOL_NOTES.md §"Packet wire format".
 *
 * Layout:
 *   ┌────┬────┬────┬────┬──────┬──────┬─────┬─────┬──────────┬──────┬──────┐
 *   │Mag │Typ │Seq │Len │PktTot│PktSer│SvcHi│SvcLo│ Payload  │CRClo │CRChi │
 *   └────┴────┴────┴────┴──────┴──────┴─────┴─────┴──────────┴──────┴──────┘
 *
 *  - Magic: 0xAA
 *  - Type: 0x21 (Phone → Glasses) or 0x12 (Glasses → Phone)
 *  - Seq: 0–255, monotonic per-direction
 *  - Len: payload length + 2 (the +2 accounts for the CRC)
 *  - PktTot/PktSer: multi-packet support; usually (1, 1)
 *  - SvcHi/SvcLo: from G2Constants.Services.*
 *  - CRC: CRC-16/CCITT over the payload bytes only, little-endian
 *
 * Citation: /home/user/G2 Custom/even-g2-protocol/examples/teleprompter/teleprompter.py:60-63
 */
object G2Frame {

    /** Build a single-packet command frame. */
    fun command(
        seq: Int,
        service: ByteArray,
        payload: ByteArray,
        pktTotal: Int = 1,
        pktSerial: Int = 1,
    ): ByteArray = build(G2Constants.TYPE_COMMAND, seq, service, payload, pktTotal, pktSerial)

    /** Multi-packet command builder. PROTOCOL_NOTES.md §"Multi-Packet Messages":
     *  Sequence ID stays constant across all packets in the message; PktTot/PktSer
     *  identify the current packet. Splits along payload boundaries when the
     *  payload exceeds (MTU - header - CRC). */
    fun commandMulti(
        seq: Int,
        service: ByteArray,
        payload: ByteArray,
        mtu: Int = G2Constants.ConnectionParams.MTU,
    ): List<ByteArray> {
        // Two ceilings on a single packet's payload: the BLE MTU, AND the AA-frame
        // Len field, which is ONE byte. Len = payload + CRC_SIZE, so payload can
        // never exceed 0xFF - CRC_SIZE (253) no matter how large the MTU. Sizing
        // chunks to the MTU alone (e.g. 502 at MTU 512) overflows Len and makes
        // build() throw — so clamp to the smaller of the two.
        val maxPayload = minOf(mtu - HEADER_SIZE - CRC_SIZE, 0xFF - CRC_SIZE)
        require(maxPayload > 0) { "MTU $mtu too small for header+crc (need >${HEADER_SIZE + CRC_SIZE})" }
        if (payload.size <= maxPayload) {
            return listOf(command(seq, service, payload, pktTotal = 1, pktSerial = 1))
        }
        val total = (payload.size + maxPayload - 1) / maxPayload
        val packets = ArrayList<ByteArray>(total)
        var offset = 0
        var serial = 1
        while (offset < payload.size) {
            val end = minOf(offset + maxPayload, payload.size)
            val slice = payload.copyOfRange(offset, end)
            packets.add(command(seq, service, slice, pktTotal = total, pktSerial = serial))
            offset = end
            serial++
        }
        return packets
    }

    /** Internal builder. Validates ranges and computes CRC. */
    private fun build(
        type: Byte,
        seq: Int,
        service: ByteArray,
        payload: ByteArray,
        pktTotal: Int,
        pktSerial: Int,
    ): ByteArray {
        require(seq in 0..0xFF) { "seq out of range: $seq" }
        require(service.size == 2) { "service must be 2 bytes (high+low), got ${service.size}" }
        require(pktTotal in 1..0xFF && pktSerial in 1..pktTotal) {
            "invalid packet sequence: total=$pktTotal serial=$pktSerial"
        }
        val length = payload.size + CRC_SIZE
        require(length <= 0xFF) {
            "single packet payload+CRC too large: $length (max 255). Use commandMulti() for chunking."
        }

        val out = ByteArray(HEADER_SIZE + payload.size + CRC_SIZE)
        out[0] = G2Constants.MAGIC
        out[1] = type
        out[2] = (seq and 0xFF).toByte()
        out[3] = length.toByte()
        out[4] = pktTotal.toByte()
        out[5] = pktSerial.toByte()
        out[6] = service[0]
        out[7] = service[1]
        payload.copyInto(out, destinationOffset = HEADER_SIZE)
        val crc = Crc16.compute(payload)
        out[HEADER_SIZE + payload.size] = (crc and 0xFF).toByte()
        out[HEADER_SIZE + payload.size + 1] = ((crc ushr 8) and 0xFF).toByte()
        return out
    }

    /** Verify a received packet's CRC. Returns true if valid. */
    fun verifyCrc(packet: ByteArray): Boolean {
        if (packet.size < HEADER_SIZE + CRC_SIZE) return false
        val payloadEnd = packet.size - CRC_SIZE
        val expected = Crc16.compute(packet, HEADER_SIZE, payloadEnd - HEADER_SIZE)
        val gotLo = packet[payloadEnd].toInt() and 0xFF
        val gotHi = packet[payloadEnd + 1].toInt() and 0xFF
        val got = gotLo or (gotHi shl 8)
        return got == expected
    }

    const val HEADER_SIZE = 8
    const val CRC_SIZE = 2
}
