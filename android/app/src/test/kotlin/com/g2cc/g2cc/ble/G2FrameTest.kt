package com.g2cc.g2cc.ble

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class G2FrameTest {

    @Test
    fun command_emitsHeaderMagicAndType() {
        val packet = G2Frame.command(
            seq = 1,
            service = G2Constants.Services.AUTH_CONTROL,
            payload = byteArrayOf(0x01, 0x02, 0x03),
        )
        assertEquals(G2Constants.MAGIC, packet[0])
        assertEquals(G2Constants.TYPE_COMMAND, packet[1])
        assertEquals(1.toByte(), packet[2])
        // length = payload(3) + crc(2) = 5
        assertEquals(5.toByte(), packet[3])
        // pktTot/pktSer default to 1/1
        assertEquals(1.toByte(), packet[4])
        assertEquals(1.toByte(), packet[5])
        // service bytes
        assertEquals(0x80.toByte(), packet[6])
        assertEquals(0x00.toByte(), packet[7])
        // payload
        assertEquals(0x01.toByte(), packet[8])
        assertEquals(0x02.toByte(), packet[9])
        assertEquals(0x03.toByte(), packet[10])
        // total size = header(8) + payload(3) + crc(2) = 13
        assertEquals(13, packet.size)
    }

    @Test
    fun command_crcRoundtrip() {
        val packet = G2Frame.command(
            seq = 7,
            service = G2Constants.Services.TELEPROMPTER,
            payload = byteArrayOf(0x08, 0x03, 0x10, 0x01, 0x2A, 0x02, 0x08, 0x00),
        )
        assertTrue("CRC must verify on a freshly-built packet", G2Frame.verifyCrc(packet))
    }

    @Test
    fun verifyCrc_rejectsCorrupted() {
        val packet = G2Frame.command(
            seq = 1,
            service = G2Constants.Services.AUTH_CONTROL,
            payload = byteArrayOf(0x01),
        )
        // Flip a payload bit; CRC should now fail.
        val corrupted = packet.copyOf()
        corrupted[8] = (corrupted[8].toInt() xor 0x01).toByte()
        assertFalse("flipped payload bit must fail CRC", G2Frame.verifyCrc(corrupted))
    }

    @Test(expected = IllegalArgumentException::class)
    fun command_rejectsBadServiceLength() {
        G2Frame.command(seq = 1, service = byteArrayOf(0x80.toByte()), payload = byteArrayOf())
    }

    @Test(expected = IllegalArgumentException::class)
    fun command_rejectsOversizedPayload() {
        // 254-byte payload → length = 254 + 2 (CRC) = 256 → exceeds 0xFF.
        G2Frame.command(
            seq = 1,
            service = G2Constants.Services.TELEPROMPTER,
            payload = ByteArray(254),
        )
    }

    @Test
    fun commandMulti_singlePacket_whenPayloadFits() {
        val packets = G2Frame.commandMulti(
            seq = 5,
            service = G2Constants.Services.TELEPROMPTER,
            payload = byteArrayOf(0x01, 0x02),
            mtu = 64,
        )
        assertEquals(1, packets.size)
        assertEquals(1.toByte(), packets[0][4])           // total = 1
        assertEquals(1.toByte(), packets[0][5])           // serial = 1
    }

    @Test
    fun commandMulti_chunksWhenPayloadExceedsMtu() {
        val payloadSize = 100
        val mtu = 32                                       // header(8) + crc(2) leaves 22 bytes per chunk
        val payload = ByteArray(payloadSize) { (it and 0xFF).toByte() }
        val packets = G2Frame.commandMulti(
            seq = 9,
            service = G2Constants.Services.TELEPROMPTER,
            payload = payload,
            mtu = mtu,
        )
        // ceil(100 / 22) = 5
        assertEquals(5, packets.size)
        for ((i, p) in packets.withIndex()) {
            assertEquals(5.toByte(), p[4])
            assertEquals((i + 1).toByte(), p[5])
            assertEquals(9.toByte(), p[2])                 // seq stays constant
            assertTrue("chunk $i CRC valid", G2Frame.verifyCrc(p))
        }
    }
}
