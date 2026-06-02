package com.g2cc.g2cc.hud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SttConfirmationFlowTest {

    private class Spy {
        val renders = mutableListOf<String>()
        val prompts = mutableListOf<String>()
        val flow = SttConfirmationFlow(
            renderHud = { text -> renders += text },
            sendPrompt = { text -> prompts += text },
        )
    }

    @Test
    fun initialState_isNotPending_noRendersNoPrompts() {
        val s = Spy()
        assertFalse(s.flow.isPending())
        assertNull(s.flow.getPendingPrompt())
        assertEquals(0, s.renders.size)
        assertEquals(0, s.prompts.size)
    }

    @Test
    fun onSttResult_rendersFullTranscriptUntruncated() {
        val s = Spy()
        val long = "x".repeat(2000) + " end"
        s.flow.onSttResult(long)
        assertTrue(s.flow.isPending())
        assertEquals(1, s.renders.size)
        val rendered = s.renders.last()
        assertTrue("rendered must contain the full transcript", rendered.contains(long))
        assertTrue("rendered must include tap-to-send hint", rendered.contains("tap"))
        assertTrue("rendered must include reject hint", rendered.contains("2-tap"))
    }

    @Test
    fun onTap_whenPending_sendsPromptAndClears() {
        val s = Spy()
        s.flow.onSttResult("hello world")
        val consumed = s.flow.onTap()
        assertTrue("tap should be consumed when pending", consumed)
        assertEquals(1, s.prompts.size)
        assertEquals("hello world", s.prompts.last())
        assertFalse(s.flow.isPending())
        assertNull(s.flow.getPendingPrompt())
    }

    @Test
    fun onTap_whenNotPending_returnsFalseAndSendsNothing() {
        val s = Spy()
        val consumed = s.flow.onTap()
        assertFalse("tap should pass through when no pending", consumed)
        assertEquals(0, s.prompts.size)
    }

    @Test
    fun onDoubleTap_whenPending_discardsAndClearsNoPrompt() {
        val s = Spy()
        s.flow.onSttResult("the quick brown fox")
        val consumed = s.flow.onDoubleTap()
        assertTrue(consumed)
        assertEquals(0, s.prompts.size)
        assertFalse(s.flow.isPending())
    }

    @Test
    fun onDoubleTap_whenNotPending_returnsFalse() {
        val s = Spy()
        val consumed = s.flow.onDoubleTap()
        assertFalse(consumed)
        assertEquals(0, s.prompts.size)
    }

    @Test
    fun secondSttResult_supersedesPrior_latestWins() {
        val s = Spy()
        s.flow.onSttResult("first")
        s.flow.onSttResult("second")
        assertTrue(s.flow.isPending())
        // Confirm now — only the latest transcript should land as a Prompt.
        s.flow.onTap()
        assertEquals(1, s.prompts.size)
        assertEquals("second", s.prompts.last())
    }

    @Test
    fun getPendingPrompt_returnsFormattedPrompt_doesNotClear() {
        val s = Spy()
        s.flow.onSttResult("hi there")
        val prompt1 = s.flow.getPendingPrompt()
        assertNotNull(prompt1)
        assertTrue(prompt1!!.contains("hi there"))
        // Idempotent — calling again does not clear pending state.
        val prompt2 = s.flow.getPendingPrompt()
        assertEquals(prompt1, prompt2)
        assertTrue(s.flow.isPending())
    }

    @Test
    fun getPendingPrompt_returnsNull_whenNothingPending() {
        val s = Spy()
        assertNull(s.flow.getPendingPrompt())
    }

    @Test
    fun onDisconnected_clearsPendingWithoutPrompt() {
        val s = Spy()
        s.flow.onSttResult("preserved across reconnect? no")
        s.flow.onDisconnected()
        assertFalse(s.flow.isPending())
        assertEquals("must not send a Prompt on disconnect", 0, s.prompts.size)
    }

    @Test
    fun onDisconnected_whenNotPending_noOp() {
        val s = Spy()
        s.flow.onDisconnected()             // must not throw / NPE
        assertFalse(s.flow.isPending())
    }

    @Test
    fun multilineTranscript_preservedInPrompt() {
        // CC transcripts can contain newlines (e.g. quoted multi-line speech).
        // The pending prompt must preserve them; HUD scroll handles long content.
        val s = Spy()
        val transcript = "Line one of the transcript.\nLine two with more detail.\nLine three."
        s.flow.onSttResult(transcript)
        s.flow.onTap()
        assertEquals(transcript, s.prompts.last())
    }

    @Test
    fun emptyTranscript_stillRenders_butConfirmSendsEmpty() {
        // Server's empty-transcript path should send stt_error instead of
        // stt_result, but if it ever slips through we still need to behave
        // — don't crash; the user can double-tap to discard.
        val s = Spy()
        s.flow.onSttResult("")
        assertTrue(s.flow.isPending())
        s.flow.onTap()
        assertEquals("", s.prompts.last())
    }

    @Test
    fun reConfirmAfterDiscard_freshSttResult_works() {
        // User flow: STT arrives, reject, re-record, new STT, confirm.
        val s = Spy()
        s.flow.onSttResult("first try")
        s.flow.onDoubleTap()                       // discard
        assertFalse(s.flow.isPending())
        s.flow.onSttResult("better try")
        s.flow.onTap()
        assertEquals(1, s.prompts.size)
        assertEquals("better try", s.prompts.last())
    }
}
