package com.g2cc.g2cc.hud

import android.util.Log

/**
 * Phase Y / Ω scaffolding — the G2CC root menu.
 *
 * **Not wired into G2Pipeline yet** — Phase Y switches the display path from
 * teleprompter (0x06-20) to News-style content (0x01-20), at which point
 * this controller becomes what the user sees on the HUD. The render hook
 * is left as a callback so the Phase Y display path can plug in later
 * without redesigning the menu.
 *
 * Architectural framing (per Adam's "take over the main menu" requirement
 * 2026-06-03): G2CC enters News-style display mode at startup and stays in
 * it indefinitely. The CONTENT we render inside that mode IS the G2CC root
 * menu, not News articles. To the user this looks like G2CC has replaced
 * the default Even menu — the only escape is the firmware-native "End
 * Feature?" double-tap dialog (which we can't suppress; it's the OS-level
 * safety hatch back to the default Even HUD).
 *
 * Menu tree shape (Phase Ω): each MenuItem is either an [Action] (leaf,
 * runs a callback on tap) or a [Submenu] (branch, navigates into a nested
 * MenuItem list on tap). Scroll moves the highlight within the current
 * level; tap drills in or fires action; "back" returns to the parent level.
 *
 * Ring event mapping (from EventParser.kt and BTSnoop intel):
 *   - Scroll = move highlight down (we only have ScrollDown confirmed;
 *     ScrollUp goes through the same path once direction encoding is
 *     determined by a controlled up-vs-down BTSnoop capture)
 *   - Tap (0x0b notification on service 0x01-01) = select highlighted item
 *   - Double-tap = firmware shows "End Feature?" — we DON'T receive it,
 *     it's intercepted by the firmware. So no "back" gesture from the
 *     ring; submenu navigation needs a different mechanism (a synthetic
 *     "Back" menu item at the top of every submenu is the simplest UX).
 *
 * Hard rules:
 *   - NO TIMEOUTS — menu doesn't auto-close on inactivity
 *   - NO TRUNCATION — long item lists scroll within the body display area
 *   - Loud failures via Log + diag (no swallowed exceptions)
 */
class RootMenu(
    rootItems: List<MenuItem>,
    /** Called whenever the menu state changes and the HUD should re-render.
     *  Title = current submenu name (root = "G2CC"); body = listing of items
     *  with the highlighted one marked. Phase Y's News-style display path
     *  feeds these into the 0x01-20 article-wrapper writes (f6=title,
     *  f9=body). */
    private val onRender: (title: String, body: String) -> Unit,
) {
    sealed interface MenuItem {
        val label: String

        /** Leaf — selecting it fires onSelect(). */
        data class Action(
            override val label: String,
            val onSelect: () -> Unit,
        ) : MenuItem

        /** Branch — selecting it navigates into [items]. */
        data class Submenu(
            override val label: String,
            val items: List<MenuItem>,
        ) : MenuItem
    }

    /** A frame on the navigation stack. */
    private data class Frame(
        val title: String,
        val items: List<MenuItem>,
        var highlightIndex: Int,
    )

    // Root is always at stack[0]. Push on Submenu enter; pop on Back action.
    private val stack: MutableList<Frame> = mutableListOf(
        Frame(title = "G2CC", items = rootItems, highlightIndex = 0),
    )

    private val currentFrame: Frame get() = stack.last()

    /** Called from G2Pipeline's event collector on Tap (0x01-01 type 0x0b).
     *  Returns true if the tap was consumed by menu navigation (always true
     *  if this controller is active). */
    fun onTap(): Boolean {
        val frame = currentFrame
        val item = frame.items.getOrNull(frame.highlightIndex) ?: return true
        when (item) {
            is MenuItem.Action -> {
                Log.i(TAG, "tap → Action '${item.label}'")
                try {
                    item.onSelect()
                } catch (e: Exception) {
                    // Loud per CLAUDE.md "no silent failures": menu actions
                    // should never silently swallow.
                    Log.e(TAG, "Action '${item.label}' onSelect threw", e)
                }
            }
            is MenuItem.Submenu -> {
                Log.i(TAG, "tap → enter Submenu '${item.label}' (${item.items.size} items)")
                // Synthesize a "Back" action prepended to each submenu so
                // the user can navigate back without needing a gesture we
                // can't reliably receive (ring double-tap is intercepted by
                // firmware for "End Feature?").
                val backItem = MenuItem.Action("← Back") { popFrame() }
                val withBack = listOf(backItem) + item.items
                stack += Frame(title = item.label, items = withBack, highlightIndex = 0)
                render()
            }
        }
        return true
    }

    /** Move highlight to the next item (wraps). Called on ring scroll. */
    fun onScrollNext() {
        val frame = currentFrame
        if (frame.items.isEmpty()) return
        frame.highlightIndex = (frame.highlightIndex + 1) % frame.items.size
        render()
    }

    /** Move highlight to the previous item (wraps). Only used when the
     *  scroll-direction decode is verified; until then call onScrollNext
     *  on every scroll event. */
    fun onScrollPrev() {
        val frame = currentFrame
        if (frame.items.isEmpty()) return
        frame.highlightIndex = (frame.highlightIndex - 1 + frame.items.size) % frame.items.size
        render()
    }

    /** Programmatic back — pop one level. Tied to the synthetic "← Back"
     *  Action at the top of each submenu. */
    private fun popFrame() {
        if (stack.size <= 1) {
            Log.w(TAG, "popFrame at root — ignoring (no parent to return to)")
            return
        }
        stack.removeAt(stack.size - 1)
        render()
    }

    /** Force-render the current state. Useful at startup AND when the
     *  display path comes back online after a reconnect. */
    fun render() {
        val frame = currentFrame
        val title = frame.title
        // Body: one item per line, highlighted item prefixed with "▶".
        // Non-highlighted prefixed with "  " for visual alignment. Long
        // item lists scroll within the body display area — firmware
        // handles vertical scroll natively (per existing teleprompter
        // observations).
        val body = buildString {
            for ((i, item) in frame.items.withIndex()) {
                if (i == frame.highlightIndex) append("▶ ") else append("  ")
                append(item.label)
                if (i < frame.items.size - 1) append("\n")
            }
        }
        Log.i(TAG, "render title='$title' highlight=${frame.highlightIndex}/${frame.items.size}")
        onRender(title, body)
    }

    /** For debug + tests: current highlighted item label, or null if empty. */
    val highlightedLabel: String?
        get() = currentFrame.items.getOrNull(currentFrame.highlightIndex)?.label

    /** For debug + tests: current navigation depth (0 = root). */
    val depth: Int get() = stack.size - 1

    companion object {
        const val TAG = "G2CCRootMenu"
    }
}
