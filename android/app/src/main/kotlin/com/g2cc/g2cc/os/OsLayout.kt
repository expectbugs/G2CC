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
    /** Bump on EVERY APK build so Adam can confirm on-glass that the new build installed.
     *  Shown in the top-left antenna ("G2 OS vX.Y") + the connect splash. */
    const val OS_VERSION = "0.9"
    const val CLOCK_ID = 1
    const val CLOCK_NAME = "clock"
    // 38 = the DE title-bar height (DE_BAR_H in shared/src/constants.ts) — the clock cutout
    // is the bar's right end, so the heights must match (docs/DE_DESIGN.md §1). ≥38px also
    // avoids the firmware overflow scrollbar on short bars.
    const val CLOCK_HEIGHT = 38
    const val CLOCK_WIDTH = 132                 // "12:59 PM" fits w/ margin; verify on glass
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

    // 12-hour minute-tick ("1:04 PM") — decided 2026-06-10 (docs/DE_DESIGN.md §1). One BLE
    // text write per MINUTE instead of per second: 60× less clock traffic on the link (the
    // v0.8 "clock janky during image push" factor) and a direct power win for the future hat.
    private val fmt = SimpleDateFormat("h:mm a", Locale.US)
    fun clockText(now: Date = Date()): String = fmt.format(now)

    /** Does the rect [x,y,w,h] intersect the reserved clock cutout? */
    fun overlapsClock(x: Int, y: Int, w: Int, h: Int): Boolean =
        x < CLOCK_X + CLOCK_WIDTH && x + w > CLOCK_X &&
            y < CLOCK_Y + CLOCK_HEIGHT && y + h > CLOCK_Y
}
