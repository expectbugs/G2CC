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

    /** A frame on the navigation stack.
     *
     *  [displayHeader] is optional read-only content rendered between the
     *  title and the items list — used for content that's NOT a tappable
     *  menu item (e.g. an STT transcript shown above [Confirm / Re-record /
     *  Cancel] options). Null = no header section, default behavior. */
    private data class Frame(
        val title: String,
        val items: List<MenuItem>,
        var highlightIndex: Int,
        val displayHeader: String? = null,
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
        val item = currentFrame.items.getOrNull(currentFrame.highlightIndex) ?: return true
        activate(item)
        return true
    }

    /** Native menu-list selection (EvenHub path): the firmware tracks focus
     *  locally (it draws the selection border) and reports the chosen index on
     *  `e0-01`. Acts on items[index] directly rather than our local highlight;
     *  syncs highlightIndex for any fallback render. Returns false (loud) if the
     *  index is out of range. */
    fun selectIndex(index: Int): Boolean {
        val frame = currentFrame
        val item = frame.items.getOrNull(index) ?: run {
            Log.w(TAG, "selectIndex($index) out of range (${frame.items.size} items)")
            return false
        }
        frame.highlightIndex = index
        activate(item)
        return true
    }

    /** Shared activation used by both [onTap] (teleprompter highlight model) and
     *  [selectIndex] (EvenHub firmware-index model). */
    private fun activate(item: MenuItem) {
        when (item) {
            is MenuItem.Action -> {
                Log.i(TAG, "activate → Action '${item.label}'")
                try {
                    item.onSelect()
                } catch (e: Exception) {
                    // Loud per CLAUDE.md "no silent failures": menu actions
                    // should never silently swallow.
                    Log.e(TAG, "Action '${item.label}' onSelect threw", e)
                }
            }
            is MenuItem.Submenu -> {
                Log.i(TAG, "activate → enter Submenu '${item.label}' (${item.items.size} items)")
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

    /** Push a new submenu frame programmatically (not from a tap). Used by
     *  feature modules that respond to async server events — e.g. CC dispatch
     *  receives a DirectoryListReply and needs to push a directory submenu.
     *
     *  Mirrors the on-tap Submenu enter logic: synthesizes a "← Back" Action
     *  at index 0 so the user can bail out without a gesture we can't
     *  reliably receive (ring double-tap fires firmware's "End Feature?").
     *
     *  Re-renders on push so the HUD reflects the new frame immediately. */
    fun pushSubmenu(title: String, items: List<MenuItem>, displayHeader: String? = null) {
        val backItem = MenuItem.Action("← Back") { popFrame() }
        val withBack = listOf(backItem) + items
        stack += Frame(title = title, items = withBack, highlightIndex = 0, displayHeader = displayHeader)
        Log.i(TAG, "pushSubmenu '$title' (${items.size} items, header=${displayHeader?.length ?: 0}c, depth now ${stack.size - 1})")
        render()
    }

    /** Replace the contents of the current frame in place. Used to swap a
     *  transient "Loading…" frame for a populated one (e.g. directory list
     *  arrives), or to swap a populated frame for a "Done ✓" confirmation
     *  after a feature module completes its async work. Highlight resets to
     *  index 0.
     *
     *  If [addBack] is true (default false), prepend a synthetic "← Back"
     *  action that pops this frame — same shape as [pushSubmenu]'s
     *  synthesized back. Pass true when replacing a frame that was pushed
     *  with [pushSubmenu] (so the user keeps a navigation-out gesture
     *  through the replacement), false for in-place swaps that should
     *  inherit the existing items' back-handling. The previous default of
     *  always-false stranded users in Phase Ω feature flows because the
     *  loading-frame's synthetic back was lost on every replace
     *  (R1-HIGH3). */
    fun replaceCurrentFrame(
        title: String,
        items: List<MenuItem>,
        addBack: Boolean = false,
        displayHeader: String? = null,
    ) {
        val current = currentFrame
        val finalItems = if (addBack) {
            val backItem = MenuItem.Action("← Back") { popFrame() }
            listOf(backItem) + items
        } else {
            items
        }
        stack[stack.size - 1] = Frame(
            title = title,
            items = finalItems,
            highlightIndex = 0,
            displayHeader = displayHeader,
        )
        Log.i(TAG, "replaceCurrentFrame '${current.title}' → '$title' (${finalItems.size} items, addBack=$addBack, header=${displayHeader?.length ?: 0}c)")
        render()
    }

    /** Pop all frames back to the root. Useful after a feature module
     *  completes — leaves the user back at the top-level menu rather than
     *  stranded in a submenu they can't recover from. */
    fun popToRoot() {
        if (stack.size <= 1) return       // already at root
        while (stack.size > 1) stack.removeAt(stack.size - 1)
        Log.i(TAG, "popToRoot — depth now 0")
        render()
    }

    /** Force-render the current state. Useful at startup AND when the
     *  display path comes back online after a reconnect. */
    fun render() {
        val frame = currentFrame
        val title = frame.title
        // Body: optional displayHeader (read-only content like an STT
        // transcript) followed by the items list. Each item on its own
        // line; highlighted item prefixed with "▶", others with "  ".
        // Long content scrolls within the body display area — firmware
        // handles vertical scroll natively (per existing teleprompter
        // observations).
        val body = buildString {
            if (frame.displayHeader != null) {
                append(frame.displayHeader)
                append("\n\n")
            }
            for ((i, item) in frame.items.withIndex()) {
                if (i == frame.highlightIndex) append("▶ ") else append("  ")
                append(item.label)
                if (i < frame.items.size - 1) append("\n")
            }
        }
        Log.i(TAG, "render title='$title' highlight=${frame.highlightIndex}/${frame.items.size} header=${frame.displayHeader?.length ?: 0}c")
        onRender(title, body)
    }

    /** Structured snapshot of the current frame for the EvenHub renderer (native
     *  menu-list). The teleprompter path uses the (title, body) text from
     *  [onRender]; the EvenHub path pulls this to build a menu-list + menu-header.
     *  Additive — does not change the [onRender] contract. */
    data class RenderModel(
        val title: String,
        val items: List<String>,
        val highlightIndex: Int,
        val displayHeader: String?,
    )

    /** Snapshot the current frame as a [RenderModel] for the EvenHub renderer. */
    fun currentRenderModel(): RenderModel = currentFrame.let { f ->
        RenderModel(f.title, f.items.map { it.label }, f.highlightIndex, f.displayHeader)
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
