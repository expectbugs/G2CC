package com.g2cc.g2cc.os

import com.g2cc.g2cc.render.Display
import com.g2cc.g2cc.render.Region
import com.g2cc.g2cc.render.RegionKind
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Glasses-OS layout constants — mirrors the CLOCK_* / OS_CONTENT_* block in
 * shared/src/constants.ts. Keep the two in sync (the compiler can't cross-check).
 *
 * The clock is APP-OWNED: the client injects it into every Scene and ticks it
 * locally (off the WebSocket), so it is also the mandatory always-present text
 * region + never-blank signal the firmware needs to paint a screen. The display
 * server lays content out AROUND the reserved cutout — [SceneCodec] loud-fails
 * if a server region reuses the clock id/name or overlaps its rect.
 *
 * [CLOCK_WIDTH] is a HARDWARE-VERIFY value: confirm "HH:MM:SS" fits without
 * wrap/clip on the real glasses, then tune this one number.
 */
object OsLayout {
    const val CLOCK_ID = 1
    const val CLOCK_NAME = "clock"
    const val CLOCK_HEIGHT = 28                 // = STATUS_BAR_HEIGHT (proven-paintable)
    const val CLOCK_WIDTH = 132                 // ~8 glyphs @ 20px; verify on glass
    const val CLOCK_Y = 0
    val CLOCK_X = Display.WIDTH - CLOCK_WIDTH    // 444 — flush right

    /** Content area the server composes into: full width, below the clock band. */
    val CONTENT_Y = CLOCK_HEIGHT + 2
    val CONTENT_HEIGHT = Display.HEIGHT - CONTENT_Y
    /** Top-left title band width, beside the clock. */
    val TITLE_WIDTH = CLOCK_X - 2

    /** The app-owned clock region (always id/name/geometry-stable across scenes). */
    fun clockRegion(): Region =
        Region(CLOCK_ID, CLOCK_NAME, CLOCK_X, CLOCK_Y, CLOCK_WIDTH, CLOCK_HEIGHT, RegionKind.TEXT)

    private val fmt = SimpleDateFormat("HH:mm:ss", Locale.US)
    fun clockText(now: Date = Date()): String = fmt.format(now)

    /** Does the rect [x,y,w,h] intersect the reserved clock cutout? */
    fun overlapsClock(x: Int, y: Int, w: Int, h: Int): Boolean =
        x < CLOCK_X + CLOCK_WIDTH && x + w > CLOCK_X &&
            y < CLOCK_Y + CLOCK_HEIGHT && y + h > CLOCK_Y
}
