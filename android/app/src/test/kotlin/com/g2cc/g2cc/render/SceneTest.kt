package com.g2cc.g2cc.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Scene model: validation + the dirty-rect diff that drives partial updates. */
class SceneTest {

    private fun img(w: Int, h: Int) = Gray4Bmp.encode(w, h, ByteArray(w * h))

    @Test
    fun diff_vsNull_isFullLayoutPlusAllContent() {
        val s = scene {
            text("a", 0, 0, 100, 50, "hi")
            image("b", 0, 60, 100, 50, img(100, 50))
        }
        val d = s.diff(null)
        assertTrue(d.layoutChanged)
        assertEquals(setOf("a", "b"), d.changedRegions.toSet())
    }

    @Test
    fun diff_sameLayout_onlyChangedContent() {
        val pic = img(100, 50)
        val s1 = scene { text("a", 0, 0, 100, 50, "hi"); image("b", 0, 60, 100, 50, pic) }
        val s2 = Scene(s1.regions, mapOf("a" to Content.Text("bye"), "b" to Content.Image(pic)))
        val d = s2.diff(s1)
        assertFalse(d.layoutChanged)
        assertEquals(listOf("a"), d.changedRegions)   // only the text changed; same image bytes are not dirty
    }

    @Test
    fun diff_differentGeometry_isLayoutChange() {
        val s1 = scene { text("a", 0, 0, 100, 50, "x") }
        val s2 = scene { text("a", 0, 0, 120, 50, "x") }   // width changed
        assertTrue(s2.diff(s1).layoutChanged)
    }

    @Test
    fun image_contentEqualityIsByValue() {
        assertEquals(Content.Image(img(10, 10)), Content.Image(img(10, 10)))
    }

    @Test
    fun diff_contentRemoval_isReportedNotSilent() {
        val pic = img(100, 50)
        val s1 = scene { text("a", 0, 0, 100, 50, "hi"); image("b", 0, 60, 100, 50, pic) }
        val s2 = Scene(s1.regions, mapOf("a" to Content.Text("hi")))   // b's content removed
        val d = s2.diff(s1)
        assertFalse(d.layoutChanged)
        assertEquals(listOf("b"), d.removedRegions)
        assertFalse(d.changedRegions.contains("b"))
    }

    @Test
    fun diff_scrollFlagChange_forcesLayoutRepush() {
        val s1 = scene { text("a", 0, 0, 100, 50, "hi", scroll = false) }
        val s2 = Scene(s1.regions, mapOf("a" to Content.Text("hi", scroll = true)))   // only scroll changed
        assertTrue(s2.diff(s1).layoutChanged)
    }

    @Test(expected = IllegalArgumentException::class)
    fun outOfBounds_throws() {
        scene { text("a", 500, 0, 200, 50) }   // right edge 700 > 576
    }

    @Test(expected = IllegalArgumentException::class)
    fun duplicateNames_throw() {
        Scene(listOf(Region(1, "a", 0, 0, 10, 10, RegionKind.TEXT), Region(2, "a", 0, 20, 10, 10, RegionKind.TEXT)))
    }

    @Test(expected = IllegalArgumentException::class)
    fun wrongKindContent_throws() {
        Scene(listOf(Region(1, "a", 0, 0, 10, 10, RegionKind.TEXT)), mapOf("a" to Content.Image(ByteArray(0))))
    }

    @Test(expected = IllegalArgumentException::class)
    fun contentForUnknownRegion_throws() {
        Scene(listOf(Region(1, "a", 0, 0, 10, 10, RegionKind.TEXT)), mapOf("ghost" to Content.Text("x")))
    }

    // ---- LIST regions (the DE menu / browse lists — docs/DE_DESIGN.md) ----

    @Test
    fun diff_listItemsChange_forcesLayoutRepush() {
        // List items ride the LAYOUT frame (no list content-update on the wire), so an
        // items swap must rebuild — this is what makes dynamic menus an f1=7 rebuild.
        val s1 = scene { list("menu", 0, 38, 96, 212, listOf("Next", "Prev"), eventCapture = true) }
        val s2 = Scene(s1.regions, mapOf("menu" to Content.ListItems(listOf("Approve", "Deny"), eventCapture = true)))
        assertTrue(s2.diff(s1).layoutChanged)
    }

    @Test
    fun diff_sameListContent_isNotDirty() {
        val s1 = scene { list("menu", 0, 38, 96, 212, listOf("Next", "Prev"), eventCapture = true) }
        val s2 = Scene(s1.regions, mapOf("menu" to Content.ListItems(listOf("Next", "Prev"), eventCapture = true)))
        val d = s2.diff(s1)
        assertFalse(d.layoutChanged)
        assertTrue(d.changedRegions.isEmpty())
    }

    @Test(expected = IllegalArgumentException::class)
    fun listContentOnTextRegion_throws() {
        Scene(listOf(Region(1, "a", 0, 0, 10, 10, RegionKind.TEXT)), mapOf("a" to Content.ListItems(listOf("x"))))
    }

    @Test(expected = IllegalArgumentException::class)
    fun emptyListItems_throw() {
        Content.ListItems(emptyList())
    }

    @Test
    fun diff_styleChange_isLayoutChange() {
        // RegionStyle is part of Region equality, so a border change re-pushes the layout.
        val s1 = scene { text("a", 0, 0, 100, 50, "x") }
        val s2 = scene { text("a", 0, 0, 100, 50, "x", style = RegionStyle(borderWidth = 1, borderColor = 6)) }
        assertTrue(s2.diff(s1).layoutChanged)
    }
}
