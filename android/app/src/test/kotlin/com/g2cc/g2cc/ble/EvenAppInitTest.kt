package com.g2cc.g2cc.ble

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EvenAppInitTest {

    /** Strip the G2Frame header (8 bytes) + CRC (2 bytes) to get the payload. */
    private fun payloadOf(packet: ByteArray): ByteArray {
        return packet.copyOfRange(G2Frame.HEADER_SIZE, packet.size - G2Frame.CRC_SIZE)
    }

    @Test
    fun deviceInfoQuery_payloadMatchesBtsnoopForMsgId0x10() {
        // BTSnoop T+28.26s: aa21020a01010920 080110101a0c4a0a08011001180120012802
        // Payload (after 8-byte header): 080110101a0c4a0a08011001180120012802
        val pkt = EvenAppInit.buildDeviceInfoQuery(seq = 0x02, msgId = 0x10)
        val expected = byteArrayOf(
            0x08, 0x01, 0x10, 0x10,
            0x1A, 0x0C, 0x4A, 0x0A,
            0x08, 0x01, 0x10, 0x01, 0x18, 0x01, 0x20, 0x01, 0x28, 0x02,
        )
        assertArrayEquals(expected, payloadOf(pkt))
    }

    @Test
    fun displayWake_payloadMatchesBtsnoopForMsgId0x1f() {
        // BTSnoop T+30.21s: 0801101f1a080801100118072801
        val pkt = EvenAppInit.buildDisplayWake(seq = 0x14, msgId = 0x1F)
        val expected = byteArrayOf(
            0x08, 0x01, 0x10, 0x1F,
            0x1A, 0x08, 0x08, 0x01, 0x10, 0x01, 0x18, 0x07, 0x28, 0x01,
        )
        assertArrayEquals(expected, payloadOf(pkt))
    }

    @Test
    fun displayTrigger_payloadMatchesBtsnoopForMsgId0x1b() {
        // BTSnoop T+29.50s: 0801101b1a00
        val pkt = EvenAppInit.buildDisplayTrigger(seq = 0x10, msgId = 0x1B)
        val expected = byteArrayOf(0x08, 0x01, 0x10, 0x1B, 0x1A, 0x00)
        assertArrayEquals(expected, payloadOf(pkt))
    }

    @Test
    fun r1Registration_includesMacAddress() {
        // BTSnoop T+29.16s: 080110181a0c0a06b8f03568d9db10011800
        // MAC (BLE order, little-endian): b8 f0 35 68 d9 db = human: db:d9:68:35:f0:b8
        val mac = byteArrayOf(0xB8.toByte(), 0xF0.toByte(), 0x35, 0x68, 0xD9.toByte(), 0xDB.toByte())
        val pkt = EvenAppInit.buildR1Registration(seq = 0x10, msgId = 0x18, r1MacBleOrder = mac)
        val expected = byteArrayOf(
            0x08, 0x01, 0x10, 0x18,
            0x1A, 0x0C, 0x0A, 0x06,
            0xB8.toByte(), 0xF0.toByte(), 0x35, 0x68, 0xD9.toByte(), 0xDB.toByte(),
            0x10, 0x01, 0x18, 0x00,
        )
        assertArrayEquals(expected, payloadOf(pkt))
    }

    @Test
    fun r1Registration_rejectsBadMacLength() {
        val tooShort = byteArrayOf(0x01, 0x02, 0x03)
        try {
            EvenAppInit.buildR1Registration(seq = 1, msgId = 1, r1MacBleOrder = tooShort)
            assertTrue("should have thrown", false)
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("6 bytes"))
        }
    }

    @Test
    fun innerBlockLengthPrefix_stays12_acrossMsgIdSizes() {
        // 4th-pass review HIGH (BLE bug 12) concern: the inner-block length
        // prefix `0x1A 0x0C` must remain correct regardless of msgId varint
        // length (1, 2, or 3+ bytes). Reviewer claimed this was broken;
        // it's not — the inner block is independent of msgId. Verify
        // explicitly for 1-byte (msgId=0x10), 2-byte (msgId=0x100), and
        // 3-byte (msgId=0x10000) varints.
        for (msgId in listOf(0x10, 0x100, 0x10000)) {
            val pkt = EvenAppInit.buildR1Registration(
                seq = 0x20, msgId = msgId,
                r1MacBleOrder = byteArrayOf(1, 2, 3, 4, 5, 6),
            )
            val payload = payloadOf(pkt)
            // Find the `0x1A` tag — it should be followed by `0x0C` (length 12).
            val idx = payload.indexOf(0x1A.toByte())
            assertTrue("0x1A tag must exist in payload for msgId=$msgId", idx >= 0)
            assertEquals(
                "inner block length prefix must be 0x0C regardless of msgId varint size (msgId=$msgId)",
                0x0C.toByte(), payload[idx + 1],
            )
        }
    }

    @Test
    fun fullInitSequence_includesAllExpectedPackets() {
        val seq = EvenAppInit.buildFullInitSequence(
            startSeq = 0x10, startMsgId = 0x100,
            r1MacBleOrder = byteArrayOf(1, 2, 3, 4, 5, 6),
        )
        // 7 packets: deviceInfo, displayWake, unknown30, unknown10,
        // r1Registration, displayTrigger, commit. (R1 included.)
        assertEquals(7, seq.size)
        // Each tuple should be (non-empty packet, positive delay).
        for ((packet, delay) in seq) {
            assertTrue("packet must be non-empty", packet.isNotEmpty())
            assertTrue("packet must start with magic 0xAA", packet[0] == 0xAA.toByte())
            assertTrue("delay must be > 0", delay > 0)
            // CRC verification — verifies every produced packet is a
            // wire-format-valid G2 frame.
            assertTrue("packet must have valid CRC", G2Frame.verifyCrc(packet))
        }
    }

    @Test
    fun fullInitSequence_skipsR1RegistrationWhenMacNull() {
        val seq = EvenAppInit.buildFullInitSequence(
            startSeq = 0x10, startMsgId = 0x100, r1MacBleOrder = null,
        )
        // Without R1 MAC, 6 packets instead of 7.
        assertEquals(6, seq.size)
    }
}
