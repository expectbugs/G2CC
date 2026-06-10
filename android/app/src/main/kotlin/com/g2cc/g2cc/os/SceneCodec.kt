package com.g2cc.g2cc.os

import com.g2cc.g2cc.ble.EventParser
import com.g2cc.g2cc.net.ClientMessage
import com.g2cc.g2cc.net.SceneContent
import com.g2cc.g2cc.net.WireScene
import com.g2cc.g2cc.render.Content
import com.g2cc.g2cc.render.Region
import com.g2cc.g2cc.render.RegionKind
import com.g2cc.g2cc.render.Scene
import java.util.Base64

/**
 * Pure bridge between the WebSocket wire types ([WireScene] / [EventParser.Event])
 * and the proven render model ([Scene] / [ClientMessage.Input]). No Android
 * dependency → fully unit-tested.
 *
 *  - [toScene]: a server [WireScene] → a render [Scene]. Injects the app-owned
 *    clock region (guaranteeing the mandatory text region) and decodes base64
 *    gray4 BMP image content. Loud-fails (IllegalArgumentException) on a
 *    reserved clock id/name collision, a region overlapping the clock cutout,
 *    an unknown kind, content that doesn't match its region's kind, or bad
 *    base64 — never a silent drop. (Scene's own init then validates bounds,
 *    uniqueness, and content/kind agreement; Gray4Bmp.decode validates the BMP
 *    itself at render time.)
 *  - [toInput]: an [EventParser.Event] → the [ClientMessage.Input] to send the
 *    PC, or null for non-input events (Unknown / Malformed / InternalMenuEvent)
 *    that the caller logs but does not forward.
 */
object SceneCodec {

    fun toScene(wire: WireScene, clockText: String): Scene {
        val regions = ArrayList<Region>(wire.regions.size + 1)
        val content = HashMap<String, Content>()

        // App-owned clock first — always present, so every screen has a text region.
        // The clock also doubles as the UNIVERSAL INPUT ANTENNA: make it scrollable
        // (a focus target → ring scroll + tap) ONLY when the scene carries no other
        // focusable (scrollable) region. So pure-image screens become navigable via
        // the clock, while text/list screens keep their own region as the scroll
        // target (no focus ambiguity). A zero-range single-line scrollable fires a
        // focus boundary event on every notch (hardware-confirmed 2026-06-06).
        val clockIsAntenna = wire.regions.none { it.kind == "text" && it.content?.scroll == true }
        val clock = OsLayout.clockRegion()
        regions += clock
        content[clock.name] = Content.Text(clockText, scroll = clockIsAntenna)

        for (wr in wire.regions) {
            require(wr.id != OsLayout.CLOCK_ID) {
                "server region '${wr.name}' uses reserved clock id ${OsLayout.CLOCK_ID}"
            }
            require(wr.name != OsLayout.CLOCK_NAME) {
                "server region uses reserved clock name '${OsLayout.CLOCK_NAME}'"
            }
            require(!OsLayout.overlapsClock(wr.x, wr.y, wr.w, wr.h)) {
                "server region '${wr.name}' [${wr.x},${wr.y},${wr.w},${wr.h}] overlaps the clock cutout " +
                    "[${OsLayout.CLOCK_X},${OsLayout.CLOCK_Y},${OsLayout.CLOCK_WIDTH},${OsLayout.CLOCK_HEIGHT}]"
            }
            val kind = parseKind(wr.kind)
            regions += Region(wr.id, wr.name, wr.x, wr.y, wr.w, wr.h, kind)
            wr.content?.let { content[wr.name] = toContent(wr.name, kind, it) }
        }
        return Scene(regions, content)
    }

    private fun parseKind(s: String): RegionKind = when (s) {
        "text" -> RegionKind.TEXT
        "image" -> RegionKind.IMAGE
        else -> throw IllegalArgumentException("unknown region kind '$s'")
    }

    private fun toContent(name: String, kind: RegionKind, c: SceneContent): Content = when (c.kind) {
        "text" -> {
            require(kind == RegionKind.TEXT) { "text content on non-text region '$name'" }
            // The antenna ("ant") doubles as the version indicator: its text is decorative
            // (it's just a zero-range scroll target), so show the CLIENT APK version there so
            // Adam can confirm on-glass that the right build installed.
            val text = if (name == "ant") "G2 OS v${OsLayout.OS_VERSION}" else (c.text ?: "")
            Content.Text(text, c.scroll ?: false)
        }
        "image" -> {
            require(kind == RegionKind.IMAGE) { "image content on non-image region '$name'" }
            val b64 = c.bmpBase64
                ?: throw IllegalArgumentException("image content for region '$name' missing bmpBase64")
            val bytes = try {
                Base64.getDecoder().decode(b64)
            } catch (e: IllegalArgumentException) {
                throw IllegalArgumentException("image content for region '$name': bad base64 — ${e.message}")
            }
            Content.Image(bytes) // Gray4Bmp.decode validates the BMP (dims/format) at render time
        }
        else -> throw IllegalArgumentException("unknown content kind '${c.kind}' for region '$name'")
    }

    /** Map an EventParser event to the input to forward, or null if it isn't a
     *  forwardable user input (the caller still logs Unknown/Malformed/etc.).
     *
     *  In the EvenHub hijack session (hardware capture 2026-06-06) physical input
     *  surfaces on the e0-01 hub channel, NOT the ring 0x01-01 channel: a single
     *  tap arrives as an empty-code gesture (-1) → mapped to 'tap'; other codes
     *  (double-tap=3, long-press=4, …) stay 'hub_gesture'; scroll arrives as a
     *  HubFocus naming the focused region → 'focus'. */
    fun toInput(ev: EventParser.Event): ClientMessage.Input? = when (ev) {
        EventParser.Event.Tap -> ClientMessage.Input("tap")
        EventParser.Event.DoubleTap -> ClientMessage.Input("double_tap")
        EventParser.Event.ScrollUp -> ClientMessage.Input("scroll_up")
        EventParser.Event.ScrollDown -> ClientMessage.Input("scroll_down")
        EventParser.Event.ScrollFocus -> ClientMessage.Input("scroll_focus")
        is EventParser.Event.HubSelect -> ClientMessage.Input("hub_select", widgetType = ev.widgetType, index = ev.index)
        is EventParser.Event.HubGesture ->
            if (ev.code == -1) ClientMessage.Input("tap")                       // empty-code hub gesture = single tap
            else ClientMessage.Input("hub_gesture", code = ev.code)
        is EventParser.Event.HubFocus -> ClientMessage.Input("focus", region = ev.name, value = ev.f3)
        is EventParser.Event.HubAck -> null          // display-write ack — handled by the renderer, not input
        is EventParser.Event.Unknown -> null
        is EventParser.Event.Malformed -> null
        is EventParser.Event.InternalMenuEvent -> null
    }
}
