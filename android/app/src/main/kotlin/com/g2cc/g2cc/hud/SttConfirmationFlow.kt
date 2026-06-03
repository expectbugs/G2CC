package com.g2cc.g2cc.hud

import android.util.Log
import com.g2cc.g2cc.net.ClientMessage
import com.g2cc.g2cc.net.ConnectionManager
import java.util.concurrent.atomic.AtomicReference

/**
 * Phase 8 (audio) — client-side confirmation gate for STT results.
 *
 *   server → SttResult(text)
 *     ↓ this class renders the FULL untruncated transcript on HUD with a
 *       gesture hint ("tap = send, 2-tap = discard")
 *     ↓ wait for the user's next gesture
 *   user single-tap   → ClientMessage.Prompt(text) (sends to active dispatcher)
 *   user double-tap   → discard (no message to server)
 *
 * Why this exists: STT is fallible. Sending a bogus transcript to Claude Code
 * costs a turn and contaminates the conversation. Adam wants to see what was
 * heard, untruncated, before it lands as a prompt.
 *
 * Hard rules (per overhaul.md §22-24 / project CLAUDE.md):
 *   - **NO TIMEOUTS.** The user gets as long as they need to read + decide.
 *   - **NO TRUNCATION.** Full transcript on HUD; firmware scrolls if it overflows.
 *   - **NO SILENT FAILURES.** If BLE is down at SttResult time, the prompt
 *     buffers (caller queries [getPendingPrompt] from the BLE-Ready edge so
 *     reconnect re-renders it).
 *
 * Reject gesture caveat: in the current teleprompter display path
 * (PHASE_Y_ENABLED=false), the firmware intercepts double-tap to show
 * "End Feature?" — so the [onDoubleTap] reject pathway may not actually
 * receive events in production. If Adam reports that, swap to a different
 * reject gesture (long-press isn't available; an in-HUD "Discard" menu item
 * navigated via ring scroll is the obvious fallback).
 *
 * The constructor takes functional callbacks (not concrete Hud +
 * ConnectionManager) so unit tests can drive it without BLE / WS mocks.
 * Mirrors RootMenu's render-callback shape.
 */
class SttConfirmationFlow(
    /** Render the formatted prompt on HUD. Caller wires this to
     *  `hud.render(text)` in production. */
    private val renderHud: (String) -> Unit,
    /** Send the confirmed transcript as a Prompt over WS. Caller wires this
     *  to `connection.send(ClientMessage.Prompt(text))` in production. */
    private val sendPrompt: (String) -> Unit,
) {
    /** The currently-pending transcript, if any. Single-slot — if a second
     *  SttResult arrives before the first is resolved (which shouldn't
     *  happen because the audio path is serialized server-side via
     *  sttInFlight, but we guard regardless), the latest one wins and the
     *  prior is logged loudly as superseded. */
    private val pending: AtomicReference<String?> = AtomicReference(null)

    /** Called by G2Pipeline.dispatchInbound when SttResult arrives.
     *
     *  Renders the formatted prompt on HUD; if HUD is unavailable (BLE
     *  down), the transcript still lives in [pending] so the BLE-Ready
     *  re-render path can pick it up via [getPendingPrompt]. */
    fun onSttResult(text: String) {
        val prev = pending.getAndSet(text)
        if (prev != null) {
            Log.w(TAG, "superseding pending STT confirmation (prior ${prev.length}c, new ${text.length}c) — prior discarded")
        }
        Log.i(TAG, "STT confirmation pending: ${text.length} chars")
        // Per CLAUDE.md "no-truncation" — the firmware scrolls; we send the
        // full string. The hint trailer tells the user the gestures.
        renderHud(formatPrompt(text))
    }

    /** User produced a single-tap event. Sends the pending transcript as a
     *  Prompt to the active dispatcher. Returns true if it consumed the tap
     *  (i.e. a transcript was pending); false otherwise so the caller's
     *  audio-toggle / menu / etc. fallback can run. */
    fun onTap(): Boolean {
        val text = pending.getAndSet(null) ?: return false
        Log.i(TAG, "STT confirmation CONFIRMED — sending ${text.length}c as Prompt")
        sendPrompt(text)
        return true
    }

    /** User produced a double-tap event. Discards the pending transcript.
     *  Returns true if it consumed the gesture; false otherwise. */
    fun onDoubleTap(): Boolean {
        val text = pending.getAndSet(null) ?: return false
        Log.i(TAG, "STT confirmation REJECTED — discarded ${text.length}c")
        return true
    }

    /** True iff a transcript is waiting on the user. The caller (G2Pipeline)
     *  uses this to gate scroll/ tap dispatch order. */
    fun isPending(): Boolean = pending.get() != null

    /** If a transcript is pending, return the formatted HUD prompt so the
     *  BLE-Ready reconnect path can re-render it. Returns null otherwise.
     *  Does NOT clear the pending state — only [onTap]/[onDoubleTap] do. */
    fun getPendingPrompt(): String? {
        val text = pending.get() ?: return null
        return formatPrompt(text)
    }

    /** Return the raw pending transcript (not formatted) so it can be handed
     *  off to a fresh SttConfirmationFlow when BLE rebuilds. R4-CRITICAL2:
     *  installBleClients re-creates the flow whenever Hud is replaced; without
     *  this hand-off, the user's transcript is silently discarded on every
     *  BLE rescan. Caller pattern:
     *      val prior = oldFlow?.takePendingForHandoff()
     *      newFlow = SttConfirmationFlow.forProduction(...)
     *      if (prior != null) newFlow.onSttResult(prior) */
    fun takePendingForHandoff(): String? = pending.getAndSet(null)

    /** Called when the WebSocket disconnects. The pending transcript is
     *  discarded loudly AND a visible "lost" message replaces the
     *  confirmation prompt on HUD — otherwise the prompt keeps showing
     *  "tap = send" while pending is empty, so the user's next tap morphs
     *  into a new recording with zero visible feedback (R1-HIGH1).
     *
     *  The prompt could survive the disconnect if we wanted, but Prompt
     *  requires an active dispatcher and the user's intent may not match
     *  a new session on reconnect. Conservative discard is safer. */
    fun onDisconnected() {
        val text = pending.getAndSet(null) ?: return
        Log.w(TAG, "STT confirmation DROPPED on WS disconnect — ${text.length}c discarded; user re-records on reconnect")
        // Replace the stale "tap = send" prompt so the next tap is unambiguous.
        // Updates Hud.lastRenderedText so reconnect re-renders this message,
        // not the stale prompt.
        renderHud("(transcript lost on reconnect)\n\nTap to start a new recording.")
    }

    private fun formatPrompt(text: String): String =
        "You said:\n$text\n\ntap = send\n2-tap = discard"

    companion object {
        const val TAG = "G2CCSttConfirm"

        /** Production wiring helper — connects the functional callbacks to
         *  the real Hud + ConnectionManager. Tests construct the class
         *  directly with lambdas.
         *
         *  R5-MEDIUM1: route Hud.render's onComplete to a loud Log.w so a
         *  failed BLE write (degraded link, MTU mismatch, transient stack
         *  bug) surfaces in logcat. The user-visible failure mode is
         *  "prompt invisible, tap silently confirms" — this won't fix that
         *  race but it gives Adam a debugging trail. */
        fun forProduction(hud: Hud, connection: ConnectionManager): SttConfirmationFlow =
            SttConfirmationFlow(
                renderHud = { text ->
                    hud.render(text) { ok ->
                        if (!ok) {
                            android.util.Log.w(
                                TAG,
                                "BLE write failed for STT prompt — user may not see it; " +
                                "next tap would still confirm the pending transcript",
                            )
                        }
                    }
                },
                sendPrompt = { text -> connection.send(ClientMessage.Prompt(text)) },
            )
    }
}
