package com.g2cc.g2cc.audio

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
) {
    @get:Synchronized @set:Synchronized
    var isStreaming: Boolean = false
        private set

    fun start() {
        synchronized(this) {
            if (isStreaming) return
            isStreaming = true
            connection.send(ClientMessage.AudioStart)
            mic.start { event ->
                when (event) {
                    is MicCapture.Event.Started -> {
                        Log.i(TAG, "started source=${event.source} sr=${event.sampleRate} ch=${event.channels} enc=${event.encoding}")
                    }
                    is MicCapture.Event.Frame -> {
                        if (!isStreaming) return@start
                        connection.sendBinary(event.pcm)
                    }
                    is MicCapture.Event.Failure -> {
                        Log.e(TAG, "capture failure: ${event.reason}", event.cause)
                        // Loud failure: flip back to idle by sending audio_end so server doesn't
                        // wait forever for a tail of frames. The server's stt.transcribe will
                        // surface "Audio too short" or similar to the HUD.
                        if (isStreaming) {
                            connection.send(ClientMessage.AudioEnd)
                            isStreaming = false
                        }
                    }
                    is MicCapture.Event.Stopped -> {
                        Log.i(TAG, "capture stopped")
                    }
                }
            }
        }
    }

    fun stop() {
        synchronized(this) {
            if (!isStreaming) return
            isStreaming = false
            mic.stop()
            connection.send(ClientMessage.AudioEnd)
        }
    }

    companion object {
        const val TAG = "G2CCAudioStreamer"
    }
}
