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
 * Audio capture for the G2CC speak/see/confirm flow. Source is selected at
 * `start()` by descending quality:
 *
 *   1. **DjiUsb** — DJI Mic 3 *receiver* over USB-C: 48 kHz, 32-bit float,
 *      stereo (TX1 + TX2 sample-synchronized). AudioDeviceInfo.TYPE_USB_DEVICE
 *      / TYPE_USB_HEADSET. The high-fidelity path the server NR pipeline is
 *      tuned for. (Gated on a working receiver — the dongle, not the mic.)
 *   2. **DjiBluetooth** — DJI Mic 3 *transmitter* paired straight to the phone
 *      over Bluetooth (no receiver): HFP/SCO, **16 kHz mono 16-bit** (the HFP
 *      wideband ceiling — DJI caps BT-to-phone there). Routed via
 *      AudioManager.setCommunicationDevice() + MODE_IN_COMMUNICATION; captured
 *      with AudioSource.VOICE_COMMUNICATION (the only source that rides SCO).
 *   3. **PhoneMic** — the phone's own mic, 16 kHz mono 16-bit. Last resort.
 *
 * Pass-through for the USB/phone paths — no on-device DSP, no downmix, no
 * denoise; the server runs the NR + DeepFilterNet + Parakeet pipeline.
 *
 * CAVEAT (DjiBluetooth): the SCO mic is only reachable through Android's
 * *communication* capture path (VOICE_COMMUNICATION), so the OS applies its own
 * AEC/NS/AGC that we cannot disable here. That is NOT our DSP, but it is NOT
 * clean pass-through either — it can interfere with the server's learned-profile
 * subtraction. Flagged loudly because it directly bears on "is BT good enough."
 *
 * Hard rules:
 *   - **No timeouts** on the read loop — capture runs as long as `start()` ↔
 *     `stop()` keeps it open. SCO link establishment after
 *     setCommunicationDevice() is not waited on; the read loop simply reads
 *     whatever the route delivers (early frames may be silence until SCO settles).
 *   - **No silent failures** — every failure mode (no permission, AudioRecord
 *     init fail, USB/BT device not found, comms-route refused) is logged; an
 *     unrecoverable "no usable source at all" emits a typed `Failure` event.
 */
class MicCapture(private val context: Context) {

    sealed interface Event {
        data class Started(val source: Source, val sampleRate: Int, val channels: Int, val encoding: Int) : Event
        data class Frame(val pcm: ByteArray, val timestamp: Long) : Event
        data class Failure(val reason: String, val cause: Throwable? = null) : Event
        data object Stopped : Event
    }

    enum class Source { DjiUsb, DjiBluetooth, PhoneMic }

    private var record: AudioRecord? = null
    private var captureJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO)

    // Set true once we've taken over the comms audio route for the BT-SCO path
    // (MODE_IN_COMMUNICATION + setCommunicationDevice). Guards teardown so we only
    // restore routing/mode that we actually changed — and never disturb the comms
    // route on the USB / phone-mic paths. Touched only under the instance lock.
    private var commsRouted = false
    private var savedAudioMode: Int? = null

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

            // Descending quality: DJI USB receiver (48k float stereo) → DJI TX
            // over Bluetooth SCO (16k mono) → phone's own mic (16k mono). The
            // first two return null + log when their device is simply absent, so
            // the chain falls through cleanly; only a total miss is a Failure.
            val attempt = startUsb(onEvent)
                ?: startBluetoothSco(onEvent)
                ?: startPhoneMic(onEvent)
            if (attempt == null) {
                onEvent(Event.Failure("no usable audio source (USB, Bluetooth, or phone mic)"))
                return
            }
            val (rec, source, sampleRate, channels, encoding) = attempt
            record = rec
            isCapturing = true

            try {
                rec.startRecording()
            } catch (e: IllegalStateException) {
                onEvent(Event.Failure("AudioRecord.startRecording() failed", e))
                // A-H2: reset isCapturing to false BEFORE releasing, otherwise
                // the instance is sticky-true and subsequent start() calls
                // return "already capturing" — mic permanently wedged.
                isCapturing = false
                releaseLocked()
                return
            }

            onEvent(Event.Started(source, sampleRate, channels, encoding))

            captureJob = scope.launch {
                try {
                    runReadLoop(rec, encoding, onEvent)
                } finally {
                    // A-H1: if runReadLoop exited via an error path (USB unplug,
                    // read returning ERROR_DEAD_OBJECT, etc.) isCapturing is still
                    // true and resources are still held. Own the cleanup here so
                    // the instance isn't permanently wedged. stop() flips
                    // isCapturing=false first then cancels this job, so the check
                    // below avoids double-release in the user-stopped path.
                    synchronized(this@MicCapture) {
                        if (isCapturing) {
                            Log.w(TAG, "read-loop exited while isCapturing=true — cleaning up")
                            isCapturing = false
                            releaseLocked()
                        }
                    }
                    onEvent(Event.Stopped)
                }
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
        clearCommsRouteLocked()
    }

    /** Undo the BT-SCO comms takeover (clear the selected comms device, restore
     *  the prior audio mode). Idempotent and a no-op for the USB / phone-mic
     *  paths, so it's safe to call from every teardown. */
    private fun clearCommsRouteLocked() {
        if (!commsRouted) return
        try {
            val am = context.getSystemService(AudioManager::class.java)
            if (am != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice()
                savedAudioMode?.let { am.mode = it }
            }
        } catch (e: Exception) {
            Log.w(TAG, "clearCommsRoute threw", e)
        }
        savedAudioMode = null
        commsRouted = false
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
            // Fallback, NOT Failure (review 2026-06-11): the chain continues to SCO/phone
            // mic, but AudioStreamer treats any Failure as fatal — it killed the streamer
            // so the LATER successful source's frames were all dropped and stop() became
            // a no-op: the mic ran forever. "Only a total miss is a Failure."
            Log.w(TAG, "USB: CHANNEL_IN_STEREO + PCM_FLOAT not supported at $sampleRate Hz; falling through")
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
            Log.w(TAG, "USB: AudioRecord build failed; falling through", e)   // fallback, not Failure (see above)
            return null
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (!rec.setPreferredDevice(usbDevice)) {
                Log.w(TAG, "setPreferredDevice(USB) returned false; OS may route elsewhere")
            }
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            Log.w(TAG, "USB: AudioRecord state != INITIALIZED; falling through")   // fallback, not Failure
            try { rec.release() } catch (e: Exception) { Log.w(TAG, "release", e) }
            return null
        }
        return AttemptResult(rec, Source.DjiUsb, sampleRate, 2, encoding)
    }

    /**
     * DJI Mic 3 transmitter paired straight to the phone over Bluetooth (no
     * receiver). Routes the comms capture path to the HFP/SCO mic via
     * setCommunicationDevice() + MODE_IN_COMMUNICATION, then captures 16 kHz mono
     * 16-bit through AudioSource.VOICE_COMMUNICATION (the only source that rides
     * SCO). Returns null + logs (not a Failure event) when no BT comms device is
     * paired or the route can't be taken — so the chain falls through to the
     * phone mic without aborting the whole capture.
     */
    @SuppressLint("MissingPermission")
    private fun startBluetoothSco(onEvent: (Event) -> Unit): AttemptResult? {
        // setCommunicationDevice / getAvailableCommunicationDevices are API 31+.
        // Pre-31 would need the deprecated startBluetoothSco() dance; the target
        // hardware (Pixel 10a) is well past 31, so we skip rather than carry it.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            Log.i(TAG, "BT-SCO capture needs API 31+; SDK=${Build.VERSION.SDK_INT}, skipping")
            return null
        }
        val am = context.getSystemService(AudioManager::class.java) ?: return null

        // getAvailableCommunicationDevices() returns SINK-role devices; a paired
        // HFP mic (DJI TX over BT) appears as TYPE_BLUETOOTH_SCO (or TYPE_BLE_HEADSET
        // for an LE-Audio device). Selecting it as the comms device is what routes
        // the *capture* mic to that headset — you do not setPreferredDevice an input.
        val btDevice = am.availableCommunicationDevices.firstOrNull {
            it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
        }
        if (btDevice == null) {
            Log.i(TAG, "no Bluetooth comms (SCO/LE) device paired; falling through")
            return null
        }

        // Take over the comms route. MODE_IN_COMMUNICATION is what brings the SCO
        // link up for capture; setCommunicationDevice() aims it at the DJI. Mark
        // commsRouted = true BEFORE the fallible calls so every error path below
        // restores the prior mode/route via clearCommsRouteLocked().
        savedAudioMode = am.mode
        commsRouted = true
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        val routed = try {
            am.setCommunicationDevice(btDevice)
        } catch (e: Exception) {
            clearCommsRouteLocked()
            Log.w(TAG, "setCommunicationDevice threw; falling through", e)
            return null
        }
        if (!routed) {
            clearCommsRouteLocked()
            Log.w(TAG, "setCommunicationDevice(type=${btDevice.type}) returned false; falling through")
            return null
        }

        // HFP wideband = 16 kHz mono 16-bit: exactly what the DJI sends over BT and
        // what Parakeet ingests natively. Same wire shape as the phone-mic fallback,
        // so the server's existing 16k-mono pipeline handles it with no changes.
        val sampleRate = 16_000
        val channelMask = AudioFormat.CHANNEL_IN_MONO
        val encoding = AudioFormat.ENCODING_PCM_16BIT
        val bufCheck = AudioRecord.getMinBufferSize(sampleRate, channelMask, encoding)
        if (bufCheck <= 0) {
            clearCommsRouteLocked()
            Log.w(TAG, "BT-SCO min-buffer-size invalid at ${sampleRate}Hz: $bufCheck; falling through")
            return null
        }
        val bufSize = bufCheck * 4
        val rec = try {
            AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
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
            clearCommsRouteLocked()
            Log.w(TAG, "AudioRecord build failed for BT-SCO; falling through", e)
            return null
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            try { rec.release() } catch (e: Exception) { Log.w(TAG, "release", e) }
            clearCommsRouteLocked()
            Log.w(TAG, "AudioRecord state != INITIALIZED for BT-SCO; falling through")
            return null
        }
        Log.i(TAG, "BT-SCO capture: '${btDevice.productName}' type=${btDevice.type} @ ${sampleRate}Hz mono")
        return AttemptResult(rec, Source.DjiBluetooth, sampleRate, 1, encoding)
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

        // ENCODING_PCM_FLOAT REQUIRES the float[] overload: the byte[] read returns
        // ERROR_INVALID_OPERATION unconditionally for float records (AOSP
        // AudioRecord.java:1617, verified 2026-06-11) — the old byte[] path made every
        // DJI-USB capture fail deterministically on its first read.
        if (encoding == AudioFormat.ENCODING_PCM_FLOAT) {
            val floatBuf = FloatArray(frameSize / 4)
            val byteBuf = java.nio.ByteBuffer.allocate(frameSize).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            while (isCapturing) {
                val read = try {
                    rec.read(floatBuf, 0, floatBuf.size, AudioRecord.READ_BLOCKING)
                } catch (e: IOException) {
                    if (isCapturing) onEvent(Event.Failure("read threw", e))
                    return
                }
                if (read < 0) {
                    // A negative code after stop() is the release-wakes-the-read race, not
                    // a real failure (review 2026-06-11) — only report while capturing.
                    if (isCapturing) onEvent(Event.Failure("AudioRecord.read(float) returned error code $read"))
                    return
                }
                if (read == 0) continue
                byteBuf.clear()
                for (k in 0 until read) byteBuf.putFloat(floatBuf[k])
                onEvent(Event.Frame(byteBuf.array().copyOf(read * 4), System.currentTimeMillis()))
            }
            return
        }
        val frameBytes = ByteArray(frameSize)
        while (isCapturing) {
            val read = try {
                rec.read(frameBytes, 0, frameBytes.size, AudioRecord.READ_BLOCKING)
            } catch (e: IOException) {
                if (isCapturing) onEvent(Event.Failure("read threw", e))
                return
            }
            if (read < 0) {
                if (isCapturing) onEvent(Event.Failure("AudioRecord.read returned error code $read"))   // post-stop race: see float path
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
