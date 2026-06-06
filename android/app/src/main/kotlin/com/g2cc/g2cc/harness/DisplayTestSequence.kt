package com.g2cc.g2cc.harness

import com.g2cc.g2cc.render.Display
import com.g2cc.g2cc.render.scene

/**
 * What the [TestHarness] must provide for the sequence to drive the renderer + UI. The Activity
 * implements it; each `render*` call sends to the glasses, updates the on-phone expected mirror,
 * sets the phone status line, and diags the step + result.
 */
interface TestHarness {
    suspend fun render(label: String, scene: com.g2cc.g2cc.render.Scene): Boolean
    suspend fun renderImage(label: String, region: String, bmp: ByteArray): Boolean
    suspend fun renderText(label: String, region: String, text: String): Boolean
    fun note(msg: String)
    suspend fun pause(ms: Long)
}

/**
 * The Test Display sequence — rebuilt to mimic exactly what the native Even Hub apps (Chess etc.)
 * do, since that's what the firmware renders:
 *   - **Every scene carries the top status bar** (`status` text region) — never an image-only
 *     layout. The harness ticks a clock into it once a second, so there's always a live text
 *     region present and the display never goes static.
 *   - **All image content is ≤200×100 tiles** (the largest region the games ever used), pushed as
 *     discrete, paced, keepalive-interleaved chunk writes by the renderer.
 * Start small (one tile) and build up, so a failure isolates the first thing that breaks.
 */
object DisplayTestSequence {
    private const val SW = Display.WIDTH    // 576
    private const val SH = Display.HEIGHT   // 288
    private const val BAR = 28              // status bar height (≈ native menu-header)

    suspend fun run(h: TestHarness) {
        // 1 — the confirmation: status bar + ONE 200×100 image tile. Smallest native-shaped scene.
        h.render("1/9  Single 200×100 tile", scene {
            text("status", 0, 0, SW, BAR, "G2CC")
            image("tile", (SW - 200) / 2, BAR + 24, 200, 100, TestImages.panel("TILE", 200, 100, 0x22))
        })
        h.pause(3500)

        // 2 — partial image update (same layout → just an f1=3 to the one tile).
        h.renderImage("2/9  Partial image update (1 tile)", "tile", TestImages.panel("TILE 2", 200, 100, 0x55))
        h.pause(2500)

        // 3 — Chess replica: a text region (left) + two stacked 200×100 image tiles (right).
        h.render("3/9  Chess shape: text + 2 tiles", scene {
            text("status", 0, 0, SW, BAR, "G2CC")
            text("info", 8, BAR + 8, 160, SH - BAR - 12, "CHESS\nSHAPE\n\ntext +\ntwo image\ntiles\n(f1=7)", scroll = false)
            image("top", 376, BAR + 12, 200, 100, TestImages.panel("TOP", 200, 100, 0x33))
            image("bot", 376, BAR + 120, 200, 100, TestImages.panel("BOT", 200, 100, 0x66))
        })
        h.pause(3500)

        // 4 — partial: re-push ONE board tile only (dirty-rect within a multi-region layout).
        h.renderImage("4/9  Partial: one tile only (BOT)", "bot", TestImages.panel("BOT!", 200, 100, 0x99))
        h.pause(2500)

        // 5 — partial: update the text region only (f1=5).
        h.renderText("5/9  Partial: text only (f1=5)", "info", "CHESS\nSHAPE\n\nTEXT\nUPDATED\n(f1=5)")
        h.pause(2500)

        // 6 — Gray4Bmp (16-level ramp) + Quantize (dither gradient), two tiles.
        h.render("6/9  Gray ramp + dither tiles", scene {
            text("status", 0, 0, SW, BAR, "G2CC")
            image("ramp", 8, BAR + 20, 200, 100, TestImages.grayRamp(200, 100))
            image("dith", 368, BAR + 20, 200, 100, TestImages.ditherGradient(200, 100))
        })
        h.pause(3500)

        // 7 — Rasterizer: own fonts + vector shapes in a tile.
        h.render("7/9  Rasterized UI tile", scene {
            text("status", 0, 0, SW, BAR, "G2CC")
            image("ui", (SW - 200) / 2, BAR + 24, 200, 100, TestImages.rasterUi("RASTER", 200, 100))
        })
        h.pause(3500)

        // 8 — animation + measured rate: a box stepping across a 200×100 tile (native tile size).
        h.render("8/9  Animation setup", scene {
            text("status", 0, 0, SW, BAR, "G2CC")
            image("anim", (SW - 200) / 2, BAR + 24, 200, 100, TestImages.animFrame(0, 200, 100))
        })
        h.pause(800)
        val frames = 8
        val t0 = System.currentTimeMillis()
        for (i in 0 until frames) {
            val x = i * (200 - 30) / (frames - 1)
            h.renderImage("8/9  Animation frame ${i + 1}/$frames", "anim", TestImages.animFrame(x, 200, 100))
        }
        val dt = System.currentTimeMillis() - t0
        h.note("ANIM: $frames frames (200×100 tile) in ${dt}ms = ${dt / frames} ms/frame")
        h.pause(1500)

        // 9 — done.
        h.render("9/9  Tests complete", scene {
            text("status", 0, 0, SW, BAR, "G2CC")
            image("done", (SW - 200) / 2, BAR + 24, 200, 100, TestImages.panel("DONE", 200, 100, 0x00))
        })
    }
}
