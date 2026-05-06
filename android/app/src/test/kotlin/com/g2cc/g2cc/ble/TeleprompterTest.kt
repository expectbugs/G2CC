package com.g2cc.g2cc.ble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TeleprompterTest {

    @Test
    fun formatPages_padsToMinimumFourteen() {
        val pages = Teleprompter.formatPages("hello")
        assertTrue("min 14 pages per docs/teleprompter.md §Known Issues", pages.size >= 14)
    }

    @Test
    fun formatPages_eachPageHasTrailingSpaceNewline() {
        val pages = Teleprompter.formatPages("hello world")
        for (p in pages) {
            assertTrue("page must end with ' \\n' per docs/teleprompter.md", p.endsWith(" \n"))
        }
    }

    @Test
    fun formatPages_eachPageHasExactlyTenLines() {
        val pages = Teleprompter.formatPages("hello world this is a longer test paragraph " +
            "that should wrap across multiple lines and produce a few pages.")
        for ((i, p) in pages.withIndex()) {
            // 10 newlines between lines + the trailing " \n" → split gives 11 entries.
            val parts = p.split('\n')
            assertEquals("page $i line count", 11, parts.size)
        }
    }

    @Test
    fun buildContentPage_hasValidCrcAndCorrectService() {
        val text = List(10) { "line $it".padEnd(20) }.joinToString("\n") + " \n"
        val packet = Teleprompter.buildContentPage(seq = 12, msgId = 30, pageNum = 0, text = text)
        assertTrue(G2Frame.verifyCrc(packet))
        // service hi/lo are bytes 6/7
        assertEquals(0x06.toByte(), packet[6])
        assertEquals(0x20.toByte(), packet[7])
    }

    @Test
    fun buildInit_carriesScrollMode() {
        val manualPacket = Teleprompter.buildInit(
            seq = 9, msgId = 21, totalLines = 10, mode = Teleprompter.ScrollMode.Manual,
        )
        val aiPacket = Teleprompter.buildInit(
            seq = 9, msgId = 21, totalLines = 10, mode = Teleprompter.ScrollMode.Ai,
        )
        // The mode byte appears near the end of the init payload.
        // Both packets should differ in exactly one byte (the mode).
        assertEquals(manualPacket.size, aiPacket.size)
        var diffs = 0
        for (i in manualPacket.indices) {
            if (manualPacket[i] != aiPacket[i]) diffs++
        }
        // CRC will also change if the mode byte does, so we expect 1 mode diff + up to 2 CRC diffs.
        assertTrue("manual vs ai packets differ in 1-3 bytes (mode + CRC), got $diffs", diffs in 1..3)
    }

    @Test
    fun buildSyncTrigger_usesAuthControlService() {
        val packet = Teleprompter.buildSyncTrigger(seq = 23, msgId = 35)
        assertEquals(0x80.toByte(), packet[6])
        assertEquals(0x00.toByte(), packet[7])
        assertTrue(G2Frame.verifyCrc(packet))
    }
}
