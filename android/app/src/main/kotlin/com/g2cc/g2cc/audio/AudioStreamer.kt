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
) {
    @get:Synchronized @set:Synchronized
    var isStreaming: Boolean = false
        private set

    fun start() {
        synchronized(this) {
            if (isStreaming) return
            isStreaming = true
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
                            MicCapture.Source.PhoneMic -> "phone-mic"
                        }
                        connection.send(
                            ClientMessage.AudioStart(
                                sampleRate = event.sampleRate,
                                channels = event.channels,
                                encoding = encName,
                                source = sourceName,
                            ),
                        )
                    }
                    is MicCapture.Event.Frame -> {
                        // Hold the streamer lock around the isStreaming check + sendBinary
                        // so a concurrent stop() can't slip between the read and the send
                        // — that race used to allow one Frame to fire AFTER audio_end was
                        // already sent, violating the protocol invariant.
                        synchronized(this@AudioStreamer) {
                            if (!isStreaming) return@synchronized
                            connection.sendBinary(event.pcm)
                        }
                    }
                    is MicCapture.Event.Failure -> {
                        Log.e(TAG, "capture failure: ${event.reason}", event.cause)
                        // 4th-pass F1 (Android): synchronize this handler like the Frame
                        // handler — a concurrent stop() could otherwise interleave between
                        // the isStreaming read and the AudioEnd send, producing duplicate
                        // AudioEnd messages (server-side protocol violation).
                        synchronized(this@AudioStreamer) {
                            if (isStreaming) {
                                connection.send(ClientMessage.AudioEnd)
                                isStreaming = false
                                mic.stop()
                            }
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
