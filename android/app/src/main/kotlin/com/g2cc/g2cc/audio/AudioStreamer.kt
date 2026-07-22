package com.g2cc.g2cc.audio

import android.media.AudioFormat
import android.util.Log
import com.g2cc.g2cc.net.ClientMessage
import com.g2cc.g2cc.net.ConnectionManager

/**
 * Wires MicCapture frames to the WebSocket as binary data between
 * `audio_start` and `audio_end` text messages.
 *
 * Pass-through only. NO on-device DSP, NO compression, NO downmix.
 *
 * The server's STT pipeline takes the raw PCM and runs NLMS + DeepFilterNet
 * + Parakeet (Phase 8 server-side). Phone-mic fallback path produces 16 kHz
 * 16-bit mono PCM that the server runs through high-pass + DFN before ASR.
 *
 * Hard rules:
 *   - **No truncation** on long captures — we stream every frame as it comes.
 *   - **No silent failures** — Failure events from MicCapture surface to
 *     the WebSocket via stt_error logs (Phase 8 polish may add a structured
 *     wire message).
 *   - **No timeouts** on the streamer; the user controls start/stop.
 */
class AudioStreamer(
    private val mic: MicCapture,
    private val connection: ConnectionManager,
    /** Invoked on ANY capture failure (incl. the synchronous never-started paths:
     *  RECORD_AUDIO missing, no source, startRecording() failed). The DE wires this
     *  to a server-bound '[audio-error]' diag so the failure is NEVER logcat-only —
     *  without it the server's dictation state machine waits forever for audio
     *  that will never come. */
    private val onFailure: (String) -> Unit = {},
    /** Phase 9: handsfree continuous-listening. The mic stays open and the WS
     *  framing is RE-CUT into ~WINDOW_MS chunks (audio_end + a fresh
     *  audio_start(mode=handsfree)) so the server VAD-gates + transcribes each
     *  window live and routes it to the voice grammar. dictate (default) is the
     *  proven one-shot path, unchanged. */
    private val handsfree: Boolean = false,
) {
    @get:Synchronized @set:Synchronized
    var isStreaming: Boolean = false
        private set

    // Did we actually send audio_start? A synchronous capture failure fires BEFORE Started, so
    // audio_end must be gated on this to keep the server's start→end invariant. @Volatile: set on
    // the MicCapture callback thread, read under the streamer lock.
    @Volatile private var startSent = false

    // Drain-aware stop (2026-07-22): stop() asks the mic to stop, but the capture
    // loop then DRAINS its buffered tail (the dictation's final syllables) and
    // emits those frames before Event.Stopped. audio_end therefore rides the
    // Stopped event — not stop() itself — so the tail lands INSIDE the
    // start→end window instead of being dropped by an already-sent end.
    // While `stopping`, isStreaming stays true so drained Frames still pass.
    private var stopping = false

    // Handsfree windowing state (touched only under the streamer lock): the
    // announced format to re-emit audio_start, and a running byte count toward
    // the next window flush.
    private var fmtSampleRate = 0
    private var fmtChannels = 0
    private var fmtEnc = "int16"
    private var fmtSource: String? = null
    private var winBytes = 0
    private var winLimit = 0   // bytes per ~WINDOW_MS window; 0 until Started

    fun start() {
        synchronized(this) {
            if (isStreaming) return
            isStreaming = true
            startSent = false
            // Bug-fix-pass-2 #8: defer audio_start until MicCapture reports the
            // actual format. The phone-mic fallback path is 16 kHz / 1 ch / int16
            // (server's existing pipeline handles directly). The DJI USB path is
            // 48 kHz / 2 ch / float32 (server doesn't yet have a pipeline for
            // this — Phase 8 wiring; until then the server should reject loudly
            // rather than misinterpret the bytes as int16).
            mic.start { event ->
                when (event) {
                    is MicCapture.Event.Started -> {
                        Log.i(TAG, "started source=${event.source} sr=${event.sampleRate} ch=${event.channels} enc=${event.encoding}")
                        val encName = when (event.encoding) {
                            AudioFormat.ENCODING_PCM_FLOAT -> "float32"
                            AudioFormat.ENCODING_PCM_16BIT -> "int16"
                            AudioFormat.ENCODING_PCM_8BIT -> "int8"
                            else -> "unknown"
                        }
                        val sourceName = when (event.source) {
                            MicCapture.Source.DjiUsb -> "dji-usb"
                            MicCapture.Source.DjiBluetooth -> "dji-bt"
                            MicCapture.Source.PhoneMic -> "phone-mic"
                        }
                        // Stash the format so handsfree windowing can re-emit audio_start.
                        fmtSampleRate = event.sampleRate; fmtChannels = event.channels
                        fmtEnc = encName; fmtSource = sourceName; winBytes = 0
                        val bytesPerSample = when (encName) { "float32" -> 4; "int8" -> 1; else -> 2 }
                        // Long math (review 2026-07-05): Int overflowed at >=96 kHz
                        // stereo float32 x WINDOW_MS, going negative and disabling
                        // handsfree window re-cutting entirely.
                        winLimit = (event.sampleRate.toLong() * event.channels * bytesPerSample * WINDOW_MS / 1000)
                            .coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
                        connection.send(
                            ClientMessage.AudioStart(
                                sampleRate = event.sampleRate,
                                channels = event.channels,
                                encoding = encName,
                                source = sourceName,
                                mode = if (handsfree) "handsfree" else null,
                            ),
                        )
                        startSent = true
                    }
                    is MicCapture.Event.Frame -> {
                        // Hold the streamer lock around the isStreaming check + sendBinary
                        // so a concurrent stop() can't slip between the read and the send
                        // — that race used to allow one Frame to fire AFTER audio_end was
                        // already sent, violating the protocol invariant.
                        synchronized(this@AudioStreamer) {
                            if (!isStreaming) return@synchronized
                            connection.sendBinary(event.pcm)
                            // Handsfree: re-cut the WS framing every ~WINDOW_MS so the server
                            // gets discrete buffers to VAD-gate + transcribe live. The mic
                            // never stops — only the audio_end/audio_start markers move.
                            // Not while stopping: a drain-window flush would re-open a
                            // window AFTER the final audio_end (protocol violation).
                            if (handsfree && winLimit > 0 && !stopping) {
                                winBytes += event.pcm.size
                                if (winBytes >= winLimit) {
                                    connection.send(ClientMessage.AudioEnd)
                                    connection.send(
                                        ClientMessage.AudioStart(
                                            sampleRate = fmtSampleRate, channels = fmtChannels,
                                            encoding = fmtEnc, source = fmtSource, mode = "handsfree",
                                        ),
                                    )
                                    winBytes = 0
                                }
                            }
                        }
                    }
                    is MicCapture.Event.Failure -> {
                        Log.e(TAG, "capture failure: ${event.reason}", event.cause)
                        // 4th-pass F1 (Android): synchronize this handler like the Frame
                        // handler — a concurrent stop() could otherwise interleave between
                        // the isStreaming read and the AudioEnd send, producing duplicate
                        // AudioEnd messages (server-side protocol violation).
                        val report: Boolean
                        synchronized(this@AudioStreamer) {
                            report = isStreaming
                            if (isStreaming) {
                                // Only send audio_end if audio_start actually went out. The three
                                // synchronous failure paths (no RECORD_AUDIO, no source,
                                // startRecording() failed) fire BEFORE Started, so a bare audio_end
                                // here breaks the server's start→end invariant ("audio_end without
                                // prior audio_start").
                                if (startSent) connection.send(ClientMessage.AudioEnd)
                                isStreaming = false
                                startSent = false
                                mic.stop()
                            }
                        }
                        // Outside the lock (callback may do I/O): surface to the server —
                        // but ONLY for failures of a LIVE capture. A post-stop read-race
                        // failure sent a spurious [audio-error] that killed the WM's
                        // 'transcribing' state and discarded the just-recorded dictation's
                        // real transcript (review 2026-06-11).
                        if (report) onFailure(event.reason)
                        else Log.w(TAG, "capture failure after stop — not reported: ${event.reason}")
                    }
                    is MicCapture.Event.Stopped -> {
                        // Drain-aware audio_end (2026-07-22): the capture loop has
                        // emitted its LAST frame (tail drained) — close the window
                        // now. The Failure path already closed it (isStreaming
                        // false), so this gate makes the duplicate impossible.
                        synchronized(this@AudioStreamer) {
                            if (isStreaming) {
                                if (startSent) connection.send(ClientMessage.AudioEnd)
                                isStreaming = false
                                startSent = false
                            }
                            stopping = false
                        }
                        Log.i(TAG, "capture stopped")
                    }
                }
            }
        }
    }

    fun stop() {
        synchronized(this) {
            // ALWAYS stop the mic (idempotent): a Failure that already cleared isStreaming
            // could leave the capture loop running while the early-return skipped
            // mic.stop() — the read loop then ran forever (review 2026-06-11).
            if (!isStreaming) {
                mic.stop()
                stopping = false
                startSent = false
                return
            }
            if (stopping) {
                mic.stop()   // duplicate stop — idempotent nudge, the drain finishes on its own
                return
            }
            // Drain-aware (2026-07-22): keep isStreaming TRUE so the frames the
            // capture loop drains after record.stop() still pass the Frame gate;
            // Event.Stopped (post-drain) sends audio_end + clears the state. If
            // the capture never started a loop (pre-Started failure), the Failure
            // handler already cleared isStreaming and we never reach here.
            stopping = true
            mic.stop()
        }
    }

    companion object {
        const val TAG = "G2CCAudioStreamer"
        /** Handsfree WS-window length (Phase 9). ~3 s balances command latency
         *  vs. Parakeet cost; the server VAD-gates silence so quiet windows are
         *  free. [U] — tune on real on-glass usage. */
        const val WINDOW_MS = 3000
    }
}
