package com.g2cc.g2cc.audio

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.io.IOException

/**
 * Stereo 32-bit float capture from the DJI Mic 3 USB receiver, with a
 * phone-mic fallback for away-from-workplace use.
 *
 * Pass-through ONLY — no on-device DSP, no downmix, no denoise. The server
 * runs the NLMS + DeepFilterNet + Parakeet pipeline (Phase 8 server-side).
 *
 * Per spec §B2:
 *   - 48 kHz, 32-bit float, stereo (TX1 + TX2 sample-synchronized)
 *   - DJI receiver appears as a USB audio device when plugged into the Pixel
 *     via USB-C → USB-A adapter; AudioDeviceInfo.TYPE_USB_DEVICE / TYPE_USB_HEADSET
 *   - Falls back to MIC source (single-channel 16 kHz 16-bit) if no USB audio
 *
 * Hard rules:
 *   - **No timeouts** on the read loop — capture runs as long as `start()` ↔
 *     `stop()` keeps it open.
 *   - **No silent failures** — every failure mode (no permission, AudioRecord
 *     init fail, USB device not found) emits a typed `Failure` event.
 */
class MicCapture(private val context: Context) {

    sealed interface Event {
        data class Started(val source: Source, val sampleRate: Int, val channels: Int, val encoding: Int) : Event
        data class Frame(val pcm: ByteArray, val timestamp: Long) : Event
        data class Failure(val reason: String, val cause: Throwable? = null) : Event
        data object Stopped : Event
    }

    enum class Source { DjiUsb, PhoneMic }

    private var record: AudioRecord? = null
    private var captureJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO)

    @get:Synchronized @set:Synchronized
    var isCapturing: Boolean = false
        private set

    /** Try DJI USB first; fall back to phone mic. Emits events on the supplied callback.
     *  The callback is called from a background coroutine — caller must marshal to its
     *  preferred dispatcher. */
    fun start(onEvent: (Event) -> Unit) {
        synchronized(this) {
            if (isCapturing) {
                onEvent(Event.Failure("already capturing"))
                return
            }
            if (!hasRecordPermission()) {
                onEvent(Event.Failure("RECORD_AUDIO permission not granted"))
                return
            }

            val attempt = startUsb(onEvent) ?: startPhoneMic(onEvent)
            if (attempt == null) {
                onEvent(Event.Failure("no usable audio source (USB or phone mic)"))
                return
            }
            val (rec, source, sampleRate, channels, encoding) = attempt
            record = rec
            isCapturing = true

            try {
                rec.startRecording()
            } catch (e: IllegalStateException) {
                onEvent(Event.Failure("AudioRecord.startRecording() failed", e))
                releaseLocked()
                return
            }

            onEvent(Event.Started(source, sampleRate, channels, encoding))

            captureJob = scope.launch {
                runReadLoop(rec, encoding, onEvent)
                onEvent(Event.Stopped)
            }
        }
    }

    fun stop() {
        synchronized(this) {
            if (!isCapturing) return
            isCapturing = false
            try { record?.stop() } catch (e: Exception) { Log.w(TAG, "stop threw", e) }
            captureJob?.cancel()
            releaseLocked()
        }
    }

    private fun releaseLocked() {
        try { record?.release() } catch (e: Exception) { Log.w(TAG, "release threw", e) }
        record = null
        captureJob = null
    }

    private fun hasRecordPermission(): Boolean = ContextCompat.checkSelfPermission(
        context, Manifest.permission.RECORD_AUDIO,
    ) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission")
    private fun startUsb(onEvent: (Event) -> Unit): AttemptResult? {
        val am = context.getSystemService(AudioManager::class.java) ?: return null
        val devices = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            am.getDevices(AudioManager.GET_DEVICES_INPUTS)
        } else {
            return null
        }
        // Prefer USB_DEVICE (e.g. DJI receiver via USB-C OTG). USB_HEADSET is also accepted.
        val usbDevice = devices.firstOrNull {
            it.type == AudioDeviceInfo.TYPE_USB_DEVICE || it.type == AudioDeviceInfo.TYPE_USB_HEADSET
        }
        if (usbDevice == null) {
            Log.i(TAG, "no USB audio input device found; falling back to phone mic")
            return null
        }

        val sampleRate = usbDevice.sampleRates?.firstOrNull { it == 48_000 }
            ?: usbDevice.sampleRates?.maxOrNull()
            ?: 48_000
        // Bug-fix-pass-2 #7: removed CHANNEL_IN_FRONT_BACK fallback — that mask
        // is also stereo (2 channels) but the original code's channelCount math
        // treated it as mono. Stick to CHANNEL_IN_STEREO for USB; if the device
        // doesn't support stereo input via USB-audio, we fall back to phone mic.
        val channelMask = AudioFormat.CHANNEL_IN_STEREO
        val encoding = AudioFormat.ENCODING_PCM_FLOAT     // 32-bit float per spec §B2
        val bufCheck = AudioRecord.getMinBufferSize(sampleRate, channelMask, encoding)
        if (bufCheck <= 0) {
            onEvent(Event.Failure("CHANNEL_IN_STEREO + PCM_FLOAT not supported at $sampleRate Hz on USB"))
            return null
        }
        val bufSize = bufCheck * 4   // 4× margin
        val rec = try {
            AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.UNPROCESSED)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(sampleRate)
                        .setChannelMask(channelMask)
                        .setEncoding(encoding)
                        .build(),
                )
                .setBufferSizeInBytes(bufSize)
                .build()
        } catch (e: Exception) {
            onEvent(Event.Failure("AudioRecord build failed for USB", e))
            return null
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (!rec.setPreferredDevice(usbDevice)) {
                Log.w(TAG, "setPreferredDevice(USB) returned false; OS may route elsewhere")
            }
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            onEvent(Event.Failure("AudioRecord state != INITIALIZED for USB"))
            try { rec.release() } catch (e: Exception) { Log.w(TAG, "release", e) }
            return null
        }
        return AttemptResult(rec, Source.DjiUsb, sampleRate, 2, encoding)
    }

    @SuppressLint("MissingPermission")
    private fun startPhoneMic(onEvent: (Event) -> Unit): AttemptResult? {
        // Spec §B7 phone-mic fallback path: 16 kHz mono, 16-bit PCM.
        // Server runs high-pass + DFN before ASR. NO downmix on-device.
        val sampleRate = 16_000
        val encoding = AudioFormat.ENCODING_PCM_16BIT
        val channelMask = AudioFormat.CHANNEL_IN_MONO
        val bufSize = AudioRecord.getMinBufferSize(sampleRate, channelMask, encoding) * 4
        if (bufSize <= 0) {
            onEvent(Event.Failure("phone mic min-buffer-size invalid: $bufSize"))
            return null
        }
        val rec = try {
            AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.UNPROCESSED)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(sampleRate)
                        .setChannelMask(channelMask)
                        .setEncoding(encoding)
                        .build(),
                )
                .setBufferSizeInBytes(bufSize)
                .build()
        } catch (e: Exception) {
            onEvent(Event.Failure("AudioRecord build failed for phone mic", e))
            return null
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            onEvent(Event.Failure("AudioRecord state != INITIALIZED for phone mic"))
            try { rec.release() } catch (e: Exception) { Log.w(TAG, "release", e) }
            return null
        }
        return AttemptResult(rec, Source.PhoneMic, sampleRate, 1, encoding)
    }

    private fun runReadLoop(rec: AudioRecord, encoding: Int, onEvent: (Event) -> Unit) {
        // Bug fix #7: rate-aware frame size. Target ~20ms of audio per WebSocket
        // binary frame regardless of sample rate / channel count / encoding —
        // gives consistent ~50 Hz update rate to the server.
        val bytesPerSample = when (encoding) {
            AudioFormat.ENCODING_PCM_FLOAT -> 4
            AudioFormat.ENCODING_PCM_16BIT -> 2
            AudioFormat.ENCODING_PCM_8BIT -> 1
            else -> 2
        }
        val sampleRate = rec.sampleRate
        val channels = if (rec.channelCount > 0) rec.channelCount else 1
        val targetBytes = ((sampleRate * channels * bytesPerSample) * TARGET_FRAME_MS / 1000)
            .coerceAtLeast(MIN_FRAME_BYTES)
            .coerceAtMost(MAX_FRAME_BYTES)
        // Round to a multiple of bytesPerSample×channels so we don't slice mid-sample.
        val align = bytesPerSample * channels
        val frameSize = (targetBytes / align) * align
        Log.i(TAG, "frameSize=$frameSize bytes (~${TARGET_FRAME_MS}ms @ ${sampleRate}Hz × $channels ch × $bytesPerSample bytes)")

        val frameBytes = ByteArray(frameSize)
        while (isCapturing) {
            val read = try {
                rec.read(frameBytes, 0, frameBytes.size, AudioRecord.READ_BLOCKING)
            } catch (e: IOException) {
                onEvent(Event.Failure("read threw", e))
                return
            }
            if (read < 0) {
                onEvent(Event.Failure("AudioRecord.read returned error code $read"))
                return
            }
            if (read == 0) continue
            val out = if (read == frameBytes.size) frameBytes.copyOf() else frameBytes.copyOf(read)
            onEvent(Event.Frame(out, System.currentTimeMillis()))
        }
    }

    private data class AttemptResult(
        val rec: AudioRecord,
        val source: Source,
        val sampleRate: Int,
        val channels: Int,
        val encoding: Int,
    )

    companion object {
        const val TAG = "G2CCMicCapture"
        // Target ~20ms of audio per frame. At 48 kHz stereo float32 that's
        // ~7680 bytes; at 16 kHz mono int16 that's ~640 bytes. Same latency,
        // very different byte counts.
        private const val TARGET_FRAME_MS = 20
        private const val MIN_FRAME_BYTES = 256
        private const val MAX_FRAME_BYTES = 16 * 1024
    }
}
