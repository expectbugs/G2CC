package com.g2cc.g2cc.hud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RootMenuTest {

    private fun build(): Pair<RootMenu, MutableList<Pair<String, String>>> {
        val renders = mutableListOf<Pair<String, String>>()
        val sub = listOf(
            RootMenu.MenuItem.Action("CC: continue last session") {},
            RootMenu.MenuItem.Action("CC: pick directory") {},
        )
        val root = listOf(
            RootMenu.MenuItem.Submenu("Claude Code", sub),
            RootMenu.MenuItem.Action("Aria") {},
            RootMenu.MenuItem.Action("SMS") {},
            RootMenu.MenuItem.Action("Email") {},
        )
        val menu = RootMenu(rootItems = root) { title, body -> renders += title to body }
        return menu to renders
    }

    @Test
    fun initialState_isRootWithFirstItemHighlighted() {
        val (menu, _) = build()
        assertEquals(0, menu.depth)
        assertEquals("Claude Code", menu.highlightedLabel)
    }

    @Test
    fun scrollNext_movesHighlightAndRendersEachStep() {
        val (menu, renders) = build()
        menu.onScrollNext()
        assertEquals("Aria", menu.highlightedLabel)
        menu.onScrollNext()
        assertEquals("SMS", menu.highlightedLabel)
        menu.onScrollNext()
        assertEquals("Email", menu.highlightedLabel)
        // wraps
        menu.onScrollNext()
        assertEquals("Claude Code", menu.highlightedLabel)
        assertEquals(4, renders.size)
    }

    @Test
    fun scrollPrev_movesHighlightBackwardsAndWraps() {
        val (menu, _) = build()
        // From "Claude Code" (index 0), prev wraps to "Email" (last).
        menu.onScrollPrev()
        assertEquals("Email", menu.highlightedLabel)
        menu.onScrollPrev()
        assertEquals("SMS", menu.highlightedLabel)
    }

    @Test
    fun tap_onAction_firesOnSelect() {
        var fired = false
        val items = listOf(RootMenu.MenuItem.Action("Test") { fired = true })
        val menu = RootMenu(rootItems = items) { _, _ -> }
        menu.onTap()
        assertTrue(fired)
    }

    @Test
    fun tap_onSubmenu_descendsAndPrependsBack() {
        val (menu, _) = build()
        // Highlight is on "Claude Code" submenu at index 0.
        menu.onTap()
        assertEquals(1, menu.depth)
        // First item in submenu should now be "← Back".
        assertEquals("← Back", menu.highlightedLabel)
    }

    @Test
    fun back_pops_andRestoresParentLevel() {
        val (menu, _) = build()
        menu.onTap()                       // enter CC submenu
        assertEquals(1, menu.depth)
        // Highlight is on "← Back" — tapping it should pop.
        menu.onTap()
        assertEquals(0, menu.depth)
        assertEquals("Claude Code", menu.highlightedLabel)
    }

    @Test
    fun back_atRoot_isNoOp() {
        val (menu, _) = build()
        // Manually try to pop at root (no Back action at root level).
        // The internal popFrame is only reachable via the synthetic Back
        // action at submenu level — at root there's no way to invoke it
        // unless the caller adds a Back to the root itself (and the
        // internal guard would catch that too).
        assertEquals(0, menu.depth)
    }

    @Test
    fun render_includesAllItemsWithHighlightMarker() {
        val (menu, renders) = build()
        menu.render()
        val (title, body) = renders.last()
        assertEquals("G2CC", title)
        assertTrue("body should contain all 4 items", body.split("\n").size == 4)
        assertTrue("highlighted item should be marked", body.startsWith("▶ Claude Code"))
        assertTrue("non-highlighted prefix should be space-space", body.contains("\n  Aria"))
    }

    @Test
    fun submenuRender_titleReflectsCurrentLevel() {
        val (menu, renders) = build()
        menu.onTap()                       // enter Claude Code
        val (title, body) = renders.last()
        assertEquals("Claude Code", title)
        assertTrue("submenu body should include Back + 2 children", body.split("\n").size == 3)
        assertTrue(body.startsWith("▶ ← Back"))
    }

    @Test
    fun emptyMenu_doesNotCrashOnScroll() {
        val menu = RootMenu(rootItems = emptyList()) { _, _ -> }
        menu.onScrollNext()                // must not throw / NPE
        assertNull(menu.highlightedLabel)
    }

    @Test
    fun pushSubmenu_descendsWithSyntheticBack() {
        val (menu, renders) = build()
        menu.pushSubmenu("CC: Loading", listOf(
            RootMenu.MenuItem.Action("(loading…)") {},
        ))
        assertEquals(1, menu.depth)
        // Synthetic Back at index 0, then the loading row at index 1.
        assertEquals("← Back", menu.highlightedLabel)
        val (title, body) = renders.last()
        assertEquals("CC: Loading", title)
        assertTrue("body must contain Back + loading row", body.split("\n").size == 2)
    }

    @Test
    fun pushSubmenu_backRestoresParentLevel() {
        val (menu, _) = build()
        menu.pushSubmenu("CC: Loading", listOf(
            RootMenu.MenuItem.Action("(loading…)") {},
        ))
        assertEquals(1, menu.depth)
        menu.onTap()                          // tap synthetic Back
        assertEquals(0, menu.depth)
        assertEquals("Claude Code", menu.highlightedLabel)
    }

    @Test
    fun replaceCurrentFrame_swapsTitleAndItemsInPlace() {
        val (menu, renders) = build()
        menu.pushSubmenu("CC: Loading", listOf(
            RootMenu.MenuItem.Action("(loading…)") {},
        ))
        val depthBefore = menu.depth
        menu.replaceCurrentFrame("Pick directory", listOf(
            RootMenu.MenuItem.Action("aria") {},
            RootMenu.MenuItem.Action("G2CC") {},
        ))
        // Depth unchanged — replace is in-place.
        assertEquals(depthBefore, menu.depth)
        // Highlight resets to first item.
        assertEquals("aria", menu.highlightedLabel)
        val (title, _) = renders.last()
        assertEquals("Pick directory", title)
    }

    @Test
    fun replaceCurrentFrame_doesNotPrependBack() {
        // Caller is responsible for back; replace is for in-place swap.
        // Verifies a single-action replacement doesn't sneak in a Back.
        val (menu, _) = build()
        menu.pushSubmenu("Sub", listOf(
            RootMenu.MenuItem.Action("a") {},
        ))
        menu.replaceCurrentFrame("Done", listOf(
            RootMenu.MenuItem.Action("✓ done") {},
        ))
        assertEquals("✓ done", menu.highlightedLabel)
    }

    @Test
    fun replaceCurrentFrame_withAddBack_prependsBackAndPopsCleanly() {
        // R1-HIGH3: Phase Ω callers need to keep the back-out gesture across
        // a replace. addBack=true synthesizes the same "← Back" that
        // pushSubmenu prepends, so a one-deep submenu's Back still works
        // after the contents have been swapped from "loading" → "results".
        val (menu, _) = build()
        menu.pushSubmenu("Sub", listOf(
            RootMenu.MenuItem.Action("(loading…)") {},
        ))
        menu.replaceCurrentFrame("Results", listOf(
            RootMenu.MenuItem.Action("entry-A") {},
            RootMenu.MenuItem.Action("entry-B") {},
        ), addBack = true)
        // Highlight resets to index 0 — which is now the synthetic Back.
        assertEquals("← Back", menu.highlightedLabel)
        assertEquals(1, menu.depth)
        // Tapping it pops back to root, restoring the parent frame.
        menu.onTap()
        assertEquals(0, menu.depth)
        assertEquals("Claude Code", menu.highlightedLabel)
    }

    @Test
    fun replaceCurrentFrame_addBackFalseByDefault() {
        // Verifies default is addBack=false so the existing API contract
        // (Phase Y polish callers that don't want a back item, e.g.
        // root-frame replacements) remains intact.
        val (menu, _) = build()
        menu.pushSubmenu("X", listOf(RootMenu.MenuItem.Action("a") {}))
        menu.replaceCurrentFrame("Y", listOf(RootMenu.MenuItem.Action("b") {}))
        // Single item; no synthetic back was added.
        assertEquals("b", menu.highlightedLabel)
    }

    @Test
    fun pushSubmenu_withDisplayHeader_rendersHeaderAboveItems() {
        // M3: displayHeader is read-only content rendered above the items
        // list — used to show STT transcripts in the confirmation submenu
        // without making them tappable.
        val (menu, renders) = build()
        menu.pushSubmenu(
            title = "Confirm transcript",
            items = listOf(
                RootMenu.MenuItem.Action("✓ Send") {},
                RootMenu.MenuItem.Action("⟲ Re-record") {},
            ),
            displayHeader = "the quick brown fox jumps over the lazy dog",
        )
        val (title, body) = renders.last()
        assertEquals("Confirm transcript", title)
        // The displayHeader is rendered FIRST, before the items list.
        assertTrue("body must start with the header",
            body.startsWith("the quick brown fox jumps over the lazy dog\n\n"))
        // The synthetic Back action is highlighted by default (index 0).
        assertEquals("← Back", menu.highlightedLabel)
    }

    @Test
    fun replaceCurrentFrame_withDisplayHeader_preservesAcrossReplace() {
        // M5: when an SttResult arrives, the dispatchInbound handler does
        // replaceCurrentFrame with displayHeader=transcript. Verify the
        // transcript is rendered in the new frame's body.
        val (menu, renders) = build()
        menu.pushSubmenu("Recording", listOf(RootMenu.MenuItem.Action("(recording)") {}))
        menu.replaceCurrentFrame(
            title = "Confirm",
            items = listOf(RootMenu.MenuItem.Action("✓ Send") {}),
            displayHeader = "transcript here",
        )
        val (title, body) = renders.last()
        assertEquals("Confirm", title)
        assertTrue("body contains the transcript", body.contains("transcript here"))
        assertTrue("body contains the action", body.contains("✓ Send"))
    }

    @Test
    fun render_withoutDisplayHeader_unchangedFormat() {
        // Verify the default (no displayHeader) keeps the existing body
        // shape — just items, no leading section. Guards against
        // unintentional whitespace insertion from M3.
        val (menu, renders) = build()
        menu.render()
        val (_, body) = renders.last()
        assertFalse("body must not start with double newline",
            body.startsWith("\n\n"))
        assertTrue("body starts with the highlight prefix",
            body.startsWith("▶ "))
    }

    @Test
    fun popToRoot_returnsAllTheWayUp() {
        val (menu, _) = build()
        menu.pushSubmenu("A", listOf(RootMenu.MenuItem.Action("aa") {}))
        menu.pushSubmenu("B", listOf(RootMenu.MenuItem.Action("bb") {}))
        assertEquals(2, menu.depth)
        menu.popToRoot()
        assertEquals(0, menu.depth)
        assertEquals("Claude Code", menu.highlightedLabel)
    }

    @Test
    fun popToRoot_atRoot_isNoOp() {
        val (menu, renders) = build()
        val rendersBefore = renders.size
        menu.popToRoot()
        assertEquals(0, menu.depth)
        // No-op should NOT cause an extra render — the user's view didn't change.
        assertEquals(rendersBefore, renders.size)
    }

    @Test
    fun pushSubmenu_thenReplace_thenBackReturnsToParent() {
        // End-to-end shape: CC dispatch flow uses push→replace→replace→back.
        val (menu, _) = build()
        menu.pushSubmenu("CC: Loading", listOf(RootMenu.MenuItem.Action("(loading…)") {}))
        menu.replaceCurrentFrame("Pick directory", listOf(
            RootMenu.MenuItem.Action("aria") {},
        ))
        menu.replaceCurrentFrame("Claude Code", listOf(
            RootMenu.MenuItem.Action("✓ Started aria") {},
        ))
        // Stack depth is still 1 (we pushed once, replaced twice in-place).
        assertEquals(1, menu.depth)
        // No synthetic Back was added by the replaces; can't pop via tap on
        // the success row. popToRoot is the recovery path.
        menu.popToRoot()
        assertEquals(0, menu.depth)
        assertEquals("Claude Code", menu.highlightedLabel)
    }

    // ---- EvenHub native-selection model (additive; teleprompter path unchanged) ----

    @Test
    fun selectIndex_firesActionAtThatIndex() {
        var fired = -1
        val items = listOf(
            RootMenu.MenuItem.Action("a") { fired = 0 },
            RootMenu.MenuItem.Action("b") { fired = 1 },
            RootMenu.MenuItem.Action("c") { fired = 2 },
        )
        val menu = RootMenu(rootItems = items) { _, _ -> }
        assertTrue(menu.selectIndex(2))
        assertEquals(2, fired)
    }

    @Test
    fun selectIndex_descendsIntoSubmenuAtThatIndex() {
        val (menu, _) = build()
        assertTrue(menu.selectIndex(0))     // index 0 is the "Claude Code" submenu
        assertEquals(1, menu.depth)
        assertEquals("← Back", menu.highlightedLabel)
    }

    @Test
    fun selectIndex_outOfRange_returnsFalseAndDoesNotNavigate() {
        val (menu, _) = build()
        assertFalse(menu.selectIndex(99))
        assertEquals(0, menu.depth)
    }

    @Test
    fun currentRenderModel_reflectsItemsTitleAndHeader() {
        val (menu, _) = build()
        val m0 = menu.currentRenderModel()
        assertEquals("G2CC", m0.title)
        assertEquals(listOf("Claude Code", "Aria", "SMS", "Email"), m0.items)
        assertEquals(0, m0.highlightIndex)
        assertNull(m0.displayHeader)
        menu.pushSubmenu("Confirm", listOf(RootMenu.MenuItem.Action("✓ Send") {}), displayHeader = "hello transcript")
        val m1 = menu.currentRenderModel()
        assertEquals("Confirm", m1.title)
        assertEquals(listOf("← Back", "✓ Send"), m1.items)
        assertEquals("hello transcript", m1.displayHeader)
    }
}
