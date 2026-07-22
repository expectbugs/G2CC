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
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
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
 *   3. **PhoneMic** — REMOVED from the chain (DJI-only policy, spec §8; the
 *      enum value remains for the parked startPhoneMic, which has NO call
 *      site — never re-add it). The chain LOUD-FAILS after BT-SCO.
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
    /** Capture generation (review 2026-07-05): the old read-loop's finally
     *  block, landing AFTER a rapid stop()->start(), used to see the NEW
     *  capture's isCapturing=true and release the NEW AudioRecord (the wsGen
     *  stale-guard pattern). Bumped on every start(). */
    private val captureGen = java.util.concurrent.atomic.AtomicInteger(0)
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

    /** Try DJI USB, then DJI-over-BT-SCO; loud-fail after that (NO phone mic
     *  — spec §8). Emits events on the supplied callback.
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

            // DJI ONLY (Adam 2026-06-11): USB receiver (48k float stereo) → DJI TX
            // over Bluetooth SCO (16k mono). The PHONE-MIC FALLBACK IS DISABLED BY
            // POLICY — a dictation must never silently ride the phone's mic; if no
            // DJI source is present this is a LOUD failure the glasses show
            // ([audio-error] → error card), not a degraded capture. (The receiver
            // is out of service, so BT-SCO is the expected daily path.)
            val attempt = startUsb(onEvent)
                ?: startBluetoothSco(onEvent)
            if (attempt == null) {
                onEvent(Event.Failure("DJI Mic unavailable (no USB receiver; no Bluetooth TX connected) — phone-mic fallback is disabled by policy"))
                return
            }
            val (rec, source, sampleRate, channels, encoding, expectedDevice, effects) = attempt
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
                releaseEffects(effects)
                releaseLocked()
                return
            }

            onEvent(Event.Started(source, sampleRate, channels, encoding))

            val myGen = captureGen.incrementAndGet()
            captureJob = scope.launch {
                try {
                    runReadLoop(rec, encoding, expectedDevice, onEvent)
                } finally {
                    // The LOOP owns release now (2026-07-22 drain-on-stop): stop()
                    // no longer releases, so the loop can drain the buffered tail
                    // after record.stop() — the final word's samples used to be
                    // discarded. Local resources (rec, effects) release
                    // UNCONDITIONALLY (they belong to THIS capture); the SHARED
                    // state (record field, comms route, isCapturing) stays
                    // gen-guarded so a rapid stop()->start()'s stale finally
                    // can't touch the NEW capture (review 2026-07-05 pattern).
                    releaseEffects(effects)
                    try { rec.release() } catch (e: Exception) { Log.w(TAG, "release threw", e) }
                    synchronized(this@MicCapture) {
                        if (myGen == captureGen.get()) {
                            if (isCapturing) {
                                Log.w(TAG, "read-loop exited while isCapturing=true — cleaning up")
                                isCapturing = false
                            }
                            if (record === rec) record = null
                            captureJob = null
                            clearCommsRouteLocked()
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
            // Stop (NOT release) the record: a blocking read returns promptly
            // after stop() and buffered samples stay readable — the read loop
            // drains them (the dictation's final word) and then owns the
            // release + comms-route restore in its finally (2026-07-22).
            try { record?.stop() } catch (e: Exception) { Log.w(TAG, "stop threw", e) }
        }
    }

    private fun releaseEffects(effects: List<AudioEffect>) {
        for (fx in effects) {
            try { fx.release() } catch (e: Exception) { Log.w(TAG, "effect release threw", e) }
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
            Log.i(TAG, "no USB audio input device found; falling through to BT-SCO (chain ends there — no phone mic)")
            return null
        }

        val sampleRate = usbDevice.sampleRates?.firstOrNull { it == 48_000 }
            ?: usbDevice.sampleRates?.maxOrNull()
            ?: 48_000
        // Bug-fix-pass-2 #7: removed CHANNEL_IN_FRONT_BACK fallback — that mask
        // is also stereo (2 channels) but the original code's channelCount math
        // treated it as mono. Stick to CHANNEL_IN_STEREO for USB; if the device
        // doesn't support stereo input via USB-audio, we fall through to BT-SCO.
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
     * paired or the route can't be taken — the chain then LOUD-FAILS (no phone
     * mic; spec §8).
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
        val comms = am.availableCommunicationDevices.filter {
            it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
        }
        // DJI-only policy (review 2026-06-11b): prefer the DJI TX by product
        // name — `firstOrNull` could silently capture a car kit / earbuds and
        // announce it to the server as "dji-bt". A non-DJI device is still
        // usable as a last resort (name heuristics can miss), but LOUDLY.
        val btDevice = comms.firstOrNull { it.productName?.toString()?.contains("DJI", ignoreCase = true) == true }
            ?: comms.firstOrNull()
        if (btDevice == null) {
            Log.i(TAG, "no Bluetooth comms (SCO/LE) device paired; falling through")
            return null
        }
        if (btDevice.productName?.toString()?.contains("DJI", ignoreCase = true) != true) {
            Log.w(TAG, "BT comms device '${btDevice.productName}' does not look like the DJI TX — capturing from it anyway (only comms device available); check the pairing if dictation sounds wrong")
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
        // 2026-07-22 accuracy pass: VOICE_COMMUNICATION drags in the platform's
        // AEC/NS/AGC ("the OS applies its own DSP that we cannot disable here" —
        // partially wrong: the audiofx control interfaces CAN ask them off).
        // Double noise-suppression (platform NS before the server's Wiener) and
        // AGC pumping are exactly the phonetic-mush makers; disable whatever the
        // device lets us, loudly logging what stuck.
        val effects = disablePlatformVoiceDsp(rec.audioSessionId)
        Log.i(TAG, "BT-SCO capture: '${btDevice.productName}' type=${btDevice.type} @ ${sampleRate}Hz mono")
        return AttemptResult(rec, Source.DjiBluetooth, sampleRate, 1, encoding, expectedDevice = btDevice, effects = effects)
    }

    /** Ask the platform's voice-call DSP (AEC / NS / AGC) OFF for this capture
     *  session. Whether each toggle takes effect is device-dependent — every
     *  outcome is logged so "is the OS still crushing the DJI audio?" is
     *  answerable from logcat instead of guessed. Returned handles are held
     *  (releasing an AudioEffect can re-enable the stage) until capture end. */
    private fun disablePlatformVoiceDsp(sessionId: Int): List<AudioEffect> {
        val held = ArrayList<AudioEffect>(3)
        fun tryDisable(name: String, available: Boolean, create: () -> AudioEffect?) {
            if (!available) {
                Log.i(TAG, "$name: not exposed on this device — nothing to disable")
                return
            }
            try {
                val fx = create()
                if (fx == null) {
                    Log.w(TAG, "$name: create() returned null — cannot control it")
                    return
                }
                val status = fx.setEnabled(false)
                held += fx
                Log.i(TAG, "$name: setEnabled(false) status=$status, enabled now=${fx.enabled}")
            } catch (e: Exception) {
                Log.w(TAG, "$name: disable threw — platform DSP stays as-is", e)
            }
        }
        tryDisable("AcousticEchoCanceler", AcousticEchoCanceler.isAvailable()) { AcousticEchoCanceler.create(sessionId) }
        tryDisable("NoiseSuppressor", NoiseSuppressor.isAvailable()) { NoiseSuppressor.create(sessionId) }
        tryDisable("AutomaticGainControl", AutomaticGainControl.isAvailable()) { AutomaticGainControl.create(sessionId) }
        return held
    }

    // PARKED (Adam 2026-06-11): phone-mic capture is disabled by policy — kept only
    // as reference / emergency re-enable. Not called from the source chain.
    @Suppress("unused")
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

    /** Is the record's LIVE route the device we selected? Compared by BT type +
     *  address when both sides expose one (the comms-device object and the
     *  input-role routed object are different AudioDeviceInfo instances, so id
     *  equality is NOT reliable — match on what identifies the physical device). */
    private fun routedToExpected(rec: AudioRecord, expected: AudioDeviceInfo): Boolean {
        val routed = rec.routedDevice ?: return false
        val btType = routed.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || routed.type == AudioDeviceInfo.TYPE_BLE_HEADSET
        if (!btType) return false
        val expAddr = expected.address
        val gotAddr = routed.address
        return expAddr.isNullOrEmpty() || gotAddr.isNullOrEmpty() || expAddr == gotAddr
    }

    private fun runReadLoop(rec: AudioRecord, encoding: Int, expected: AudioDeviceInfo?, onEvent: (Event) -> Unit) {
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

        // ROUTE VERIFICATION (2026-07-22 accuracy pass, BT-SCO path): until the
        // record's live route lands on the selected DJI device, frames are the
        // WRONG MIC — setCommunicationDevice() is asynchronous, and the settle
        // window used to ship phone-mic/silence bytes labeled 'dji-bt' (a
        // straight DJI-only-policy violation, and mush for Parakeet). Wrong-mic
        // frames are DROPPED (never sent); if the route never engages within
        // ~ROUTE_SETTLE_MAX_FRAMES of audio, LOUD-FAIL — the server shows the
        // error card instead of transcribing pocket audio. Frame-count-based
        // supervision, not an I/O timeout: reads keep their no-timeout shape.
        var routeVerified = expected == null
        var droppedForRoute = 0
        val routeStartMs = System.currentTimeMillis()
        // Returns true when the frame may be emitted; false while pre-route
        // (dropped) — and fails the capture when the route never arrives.
        fun routeGate(): Boolean {
            if (routeVerified) return true
            if (routedToExpected(rec, expected!!)) {
                routeVerified = true
                Log.i(
                    TAG,
                    "route VERIFIED on '${rec.routedDevice?.productName}' after " +
                        "${System.currentTimeMillis() - routeStartMs}ms ($droppedForRoute pre-route frame(s) dropped)",
                )
                return true
            }
            droppedForRoute++
            if (droppedForRoute >= ROUTE_SETTLE_MAX_FRAMES) {
                val routed = rec.routedDevice
                onEvent(
                    Event.Failure(
                        "BT-SCO route never engaged after ${System.currentTimeMillis() - routeStartMs}ms — " +
                            "audio is coming from '${routed?.productName ?: "(no route)"}' (type=${routed?.type ?: -1}), " +
                            "not the DJI. Refusing to ship wrong-mic audio (DJI-only policy). " +
                            "Check the DJI TX Bluetooth connection and try again.",
                    ),
                )
                // The Failure path stops the streamer → stop() → drain/cleanup.
                return false
            }
            return false
        }

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
                if (!routeGate()) { if (droppedForRoute >= ROUTE_SETTLE_MAX_FRAMES) return else continue }
                byteBuf.clear()
                for (k in 0 until read) byteBuf.putFloat(floatBuf[k])
                onEvent(Event.Frame(byteBuf.array().copyOf(read * 4), System.currentTimeMillis()))
            }
            // DRAIN (2026-07-22, float path — see the int16 drain below). Only a
            // VERIFIED route's tail is worth keeping (pre-route = wrong mic).
            var fDrains = 0
            var fDrained = 0
            while (routeVerified && fDrains < DRAIN_MAX_READS) {
                val read = try {
                    rec.read(floatBuf, 0, floatBuf.size, AudioRecord.READ_NON_BLOCKING)
                } catch (e: Exception) {
                    break
                }
                if (read <= 0) break
                byteBuf.clear()
                for (k in 0 until read) byteBuf.putFloat(floatBuf[k])
                fDrained += read * 4
                onEvent(Event.Frame(byteBuf.array().copyOf(read * 4), System.currentTimeMillis()))
                fDrains++
            }
            if (fDrained > 0) Log.i(TAG, "drained $fDrained tail bytes after stop ($fDrains read(s))")
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
            if (!routeGate()) { if (droppedForRoute >= ROUTE_SETTLE_MAX_FRAMES) return else continue }
            val out = if (read == frameBytes.size) frameBytes.copyOf() else frameBytes.copyOf(read)
            onEvent(Event.Frame(out, System.currentTimeMillis()))
        }
        // DRAIN (2026-07-22): stop() stopped the record but buffered samples —
        // the dictation's final syllables — stay readable. Bounded non-blocking
        // reads flush them so the tail isn't discarded (it always was before).
        // Only a VERIFIED route's tail is worth keeping (pre-route = wrong mic).
        var drains = 0
        var drained = 0
        while (routeVerified && drains < DRAIN_MAX_READS) {
            val read = try {
                rec.read(frameBytes, 0, frameBytes.size, AudioRecord.READ_NON_BLOCKING)
            } catch (e: Exception) {
                break
            }
            if (read <= 0) break
            drained += read
            onEvent(Event.Frame(frameBytes.copyOf(read), System.currentTimeMillis()))
            drains++
        }
        if (drained > 0) Log.i(TAG, "drained $drained tail bytes after stop ($drains read(s))")
    }

    private data class AttemptResult(
        val rec: AudioRecord,
        val source: Source,
        val sampleRate: Int,
        val channels: Int,
        val encoding: Int,
        /** The device frames MUST come from (BT-SCO path) — the read loop drops
         *  frames until AudioRecord.getRoutedDevice() lands on it and LOUD-FAILS
         *  if it never does. null = no verification (USB uses setPreferredDevice). */
        val expectedDevice: AudioDeviceInfo? = null,
        /** Platform voice-DSP handles (AEC/NS/AGC) held DISABLED for this
         *  capture's session; released by the read loop's finally. */
        val effects: List<AudioEffect> = emptyList(),
    )

    companion object {
        const val TAG = "G2CCMicCapture"
        // Target ~20ms of audio per frame. At 48 kHz stereo float32 that's
        // ~7680 bytes; at 16 kHz mono int16 that's ~640 bytes. Same latency,
        // very different byte counts.
        private const val TARGET_FRAME_MS = 20
        private const val MIN_FRAME_BYTES = 256
        private const val MAX_FRAME_BYTES = 16 * 1024
        /** Route-settle budget (2026-07-22): ~20 ms frames × 100 ≈ 2 s for the
         *  comms route to land on the DJI before the capture LOUD-FAILS.
         *  Frame-count supervision, not a clock-bound I/O timeout. */
        private const val ROUTE_SETTLE_MAX_FRAMES = 100
        /** Post-stop tail-drain bound: ≤25 non-blocking reads (~0.5 s of audio)
         *  flush the buffered final syllables, then the loop releases. */
        private const val DRAIN_MAX_READS = 25
    }
}
