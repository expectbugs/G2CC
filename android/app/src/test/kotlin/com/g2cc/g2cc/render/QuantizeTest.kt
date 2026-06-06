package com.g2cc.g2cc.render

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Math-sanity tests for ARGB→gray4 quantization + dithering (no real-image claims). */
class QuantizeTest {

    @Test
    fun luma_knownValues() {
        assertEquals(0, Quantize.luma(0x000000))
        assertEquals(255, Quantize.luma(0xFFFFFF))
        assertEquals(128, Quantize.luma(0x808080))
        assertEquals(76, Quantize.luma(0xFF0000))   // 255*77>>8
        assertEquals(149, Quantize.luma(0x00FF00))   // 255*150>>8 (integer truncation)
    }

    @Test
    fun level_quantizesEndpointsAndMid() {
        assertEquals(0, Quantize.level(0))
        assertEquals(15, Quantize.level(255))
        assertEquals(8, Quantize.level(128))
    }

    @Test
    fun toGray4_noDither_blackAndWhite() {
        assertArrayEquals(ByteArray(16) { 0 }, Quantize.toGray4(IntArray(16) { 0x000000 }, 4, 4, dither = false))
        assertArrayEquals(ByteArray(16) { 15 }, Quantize.toGray4(IntArray(16) { 0xFFFFFF }, 4, 4, dither = false))
    }

    @Test
    fun toGray4_dither_staysInRange() {
        // a 16x16 gray gradient
        val grad = IntArray(256) { val v = it and 0xFF; (v shl 16) or (v shl 8) or v }
        val out = Quantize.toGray4(grad, 16, 16, dither = true)
        for (b in out) assertTrue("level out of 0..15: ${b.toInt()}", (b.toInt() and 0xFF) in 0..15)
    }

    @Test
    fun toGray4_dither_blackWhiteStillSaturate() {
        // dithering must not push pure black above 0 or pure white below 15
        assertArrayEquals(ByteArray(16) { 0 }, Quantize.toGray4(IntArray(16) { 0x000000 }, 4, 4, dither = true))
        assertArrayEquals(ByteArray(16) { 15 }, Quantize.toGray4(IntArray(16) { 0xFFFFFF }, 4, 4, dither = true))
    }
}
