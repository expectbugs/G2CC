package com.g2cc.g2cc.os

import com.g2cc.g2cc.net.ClientMessage
import com.g2cc.g2cc.render.RegionKind
import com.g2cc.g2cc.render.Scene

/**
 * Pure control-mode gesture → `input` message mapper (multi-surface 2026-07-13).
 * Takes primitives (scene-px coordinates from [MirrorGeometry.viewToScene]),
 * never a MotionEvent — fully unit-tested; [com.g2cc.g2cc.harness.ControlMirrorView]
 * owns the thin GestureDetector binding.
 *
 * Mapping (ring parity — the same events the R-lens EventParser path sends):
 *  - Single tap on a drawn list row → `hub_select{widgetType: region.name, index: row}`
 *    (the server resolves labels against its own lastView; stale taps are eaten
 *    + resynced server-side, so client hit-testing is safe).
 *  - Single tap anywhere else → `tap`.
 *  - Double tap → `double_tap` (back). Safe on Android — the detector waits out
 *    the double-tap window before confirming a single tap.
 *  - Drag → `focus{region: capture.name, value}` per [SCROLL_NOTCH_PX] scene-px
 *    of travel: pacing by PIXELS, not timers (the no-timeouts rule). Remainder
 *    carries across calls within one gesture; [reset] drops it on finger-up.
 *    Direction: drag UP = value 2 = next — ws-handler.ts:1105 (2026-07-13) f3
 *    semantics, `1=up/prev, 2=down/next` (G2_BLE_PROTOCOL.md §6.6).
 *    When the capture is a LIST: no messages — adaptive pitch already shows
 *    every row (v1 decision; taps do the selecting). No capture → no-op.
 *  - Long-press / horizontal swipes: unmapped in v1 (documented punt).
 *
 * Stateful (the scroll accumulator) but with zero Android dependencies.
 */
class ControlInputMapper {

    /** A already-scene-mapped touch gesture. */
    sealed interface Gesture {
        /** Tap at scene-px (x,y). */
        data class SingleTap(val x: Float, val y: Float) : Gesture
        /** Double tap = back (position irrelevant — ring parity). */
        data object DoubleTap : Gesture
        /** Scroll travel in scene px. POSITIVE = finger moved UP (the
         *  GestureDetector distanceY convention: old.y − new.y). */
        data class ScrollBy(val dyScenePx: Float) : Gesture
    }

    private var acc = 0f

    /** Gesture ended (ACTION_UP/CANCEL) — drop the sub-notch scroll remainder. */
    fun reset() { acc = 0f }

    /** Map one gesture to the `input` messages to send (0..n — a fast drag can
     *  owe several focus notches in a single call). */
    fun map(scene: Scene?, gesture: Gesture): List<ClientMessage.Input> = when (gesture) {
        is Gesture.SingleTap -> {
            val hit = scene?.let { MirrorGeometry.hitListRow(it, gesture.x, gesture.y) }
            if (hit != null) {
                listOf(ClientMessage.Input(event = "hub_select", widgetType = hit.first.name, index = hit.second))
            } else {
                listOf(ClientMessage.Input(event = "tap"))
            }
        }
        Gesture.DoubleTap -> listOf(ClientMessage.Input(event = "double_tap"))
        is Gesture.ScrollBy -> mapScroll(scene, gesture.dyScenePx)
    }

    private fun mapScroll(scene: Scene?, dy: Float): List<ClientMessage.Input> {
        val capture = scene?.let { MirrorGeometry.captureOf(it) } ?: return emptyList()
        // LIST capture: adaptive pitch shows all rows — dragging has nothing to
        // scroll (v1); don't accumulate either, so a later antenna scene starts clean.
        if (capture.kind == RegionKind.LIST) return emptyList()
        acc += dy
        val out = ArrayList<ClientMessage.Input>()
        while (acc >= SCROLL_NOTCH_PX) {                                    // drag UP → next
            out += ClientMessage.Input(event = "focus", region = capture.name, value = 2)
            acc -= SCROLL_NOTCH_PX
        }
        while (acc <= -SCROLL_NOTCH_PX) {                                   // drag DOWN → prev
            out += ClientMessage.Input(event = "focus", region = capture.name, value = 1)
            acc += SCROLL_NOTCH_PX
        }
        return out
    }

    companion object {
        /** Scene-px of drag travel per focus notch (≈ one ring notch). */
        const val SCROLL_NOTCH_PX = 48f
    }
}
