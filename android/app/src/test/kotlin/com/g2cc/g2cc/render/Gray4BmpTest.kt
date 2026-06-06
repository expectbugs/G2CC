package com.g2cc.g2cc.render

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Random

/**
 * Verifies the 4bpp BMP encoder against the REAL captured BMP headers (U=19 Chess tiles), so
 * the bytes we generate are exactly what the firmware accepted on hardware.
 */
class Gray4BmpTest {

    // First 54 bytes (file header + DIB header) of the captured tiles — content-independent.
    private val CAP_HEADER_200x100 =
        "424d86270000000000007600000028000000c800000064000000010004000000000010270000130b0000130b00001000000000000000"
    private val CAP_HEADER_200x40 =
        "424d16100000000000007600000028000000c8000000280000000100040000000000a00f0000130b0000130b00001000000000000000"

    @Test
    fun header_200x100_matchesCapture() {
        val bmp = Gray4Bmp.encode(200, 100, ByteArray(200 * 100))
        assertEquals(CAP_HEADER_200x100, hx(bmp.copyOfRange(0, 54)))
        assertEquals(10118, bmp.size) // 118 preamble + 10000 pixel bytes
    }

    @Test
    fun header_200x40_matchesCapture() {
        val bmp = Gray4Bmp.encode(200, 40, ByteArray(200 * 40))
        assertEquals(CAP_HEADER_200x40, hx(bmp.copyOfRange(0, 54)))
        assertEquals(4118, bmp.size)
    }

    @Test
    fun palette_isLinearGrayRamp() {
        val pal = Gray4Bmp.palette()
        assertEquals(64, pal.size)
        // index i -> (0x11*i, 0x11*i, 0x11*i, 0x00) BGRA
        for (i in 0 until 16) {
            val g = (0x11 * i) and 0xFF
            assertEquals(g, pal[i * 4].toInt() and 0xFF)
            assertEquals(g, pal[i * 4 + 1].toInt() and 0xFF)
            assertEquals(g, pal[i * 4 + 2].toInt() and 0xFF)
            assertEquals(0, pal[i * 4 + 3].toInt() and 0xFF)
        }
    }

    @Test
    fun rowBytes_paddedTo4() {
        assertEquals(100, Gray4Bmp.rowBytes(200))
        assertEquals(288, Gray4Bmp.rowBytes(576))
        assertEquals(4, Gray4Bmp.rowBytes(3))   // 3px*4bpp = 12 bits -> 2 bytes -> pad to 4
        assertEquals(4, Gray4Bmp.rowBytes(1))
    }

    @Test
    fun roundTrip_preservesPixels() {
        val rnd = Random(42)
        val idx = ByteArray(200 * 100) { rnd.nextInt(16).toByte() }
        val dec = Gray4Bmp.decode(Gray4Bmp.encode(200, 100, idx))
        assertEquals(200, dec.width)
        assertEquals(100, dec.height)
        assertArrayEquals(idx, dec.indices)
    }

    @Test
    fun roundTrip_oddWidth_handlesPadding() {
        val rnd = Random(7)
        val idx = ByteArray(7 * 5) { rnd.nextInt(16).toByte() }
        val dec = Gray4Bmp.decode(Gray4Bmp.encode(7, 5, idx))
        assertArrayEquals(idx, dec.indices)
    }

    @Test(expected = IllegalArgumentException::class)
    fun pixelOutOfRange_throwsLoud() {
        Gray4Bmp.encode(2, 1, byteArrayOf(16, 0))
    }

    @Test(expected = IllegalArgumentException::class)
    fun sizeMismatch_throwsLoud() {
        Gray4Bmp.encode(10, 10, ByteArray(50))
    }
}
