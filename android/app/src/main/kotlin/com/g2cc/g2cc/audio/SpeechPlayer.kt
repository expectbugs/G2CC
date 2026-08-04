package com.g2cc.g2cc.audio

import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Log
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The earbud SPEECH lane (2026-08-04, docs/EARBUD_SPEC.md §C7): plays the
 * server's TTS PCM (24 kHz mono s16, streamed as tag-0x11 WS binary frames)
 * through a streaming AudioTrack and reports the HONEST outcome per utterance
 * via onAck (→ ClientMessage.SpeakAck).
 *
 * Route guard — the v1.19 SCO-verification discipline, output edition: an
 * utterance plays ONLY toward a Bluetooth output device, re-verified on the
 * LIVE route after the first write. No BT route → no sound, ack 'failed'.
 * The phone speaker is NEVER an output (work rule).
 *
 * Design: ONE writer thread owns the AudioTrack and processes commands
 * strictly in order; the server serializes utterances (next speak waits for
 * the prior ack), so at most one utterance is live. cancel() flips the
 * utterance's flag EAGERLY (concurrent map) so blocking writes and the drain
 * loop exit fast; the queued Cancel command then does the track teardown in
 * order. No timeouts — the drain is progress-supervised polling; a stalled
 * sink (BT died mid-utterance) fails loudly after ~8 s of zero head movement.
 */
class SpeechPlayer(
    private val audioManager: AudioManager,
    /** SpeakAck sink: (id, status 'played'|'failed', reason?, route?). */
    private val onAck: (id: String, status: String, reason: String?, route: String?) -> Unit,
    /** Lane-audible signal — the controller ducks its media lane + holds
     *  transient AudioFocus while true. */
    private val onSpeaking: (Boolean) -> Unit,
) {
    private class Utterance(val id: String, val num: Long) {
        @Volatile var cancelled = false
        var bytesQueued = 0L
        var chunks = 0
        var acked = false
    }

    private sealed interface Cmd {
        class Start(val utt: Utterance) : Cmd
        class Pcm(val num: Long, val bytes: ByteArray) : Cmd
        class End(val num: Long, val expectedChunks: Int) : Cmd
        class Cancel(val num: Long?) : Cmd
        data object Quit : Cmd
    }

    private val queue = LinkedBlockingQueue<Cmd>()
    /** Live utterances by num — written by the writer thread, cancel-flagged
     *  from any thread. */
    private val live = ConcurrentHashMap<Long, Utterance>()
    @Volatile private var alive = true

    init {
        thread(name = "g2cc-speech", isDaemon = true) { runWriter() }
    }

    fun speakStart(id: String, num: Long) {
        val utt = Utterance(id, num)
        live[num] = utt
        queue.put(Cmd.Start(utt))
    }

    fun frame(num: Long, pcm: ByteArray) = queue.put(Cmd.Pcm(num, pcm))

    fun speakEnd(num: Long, expectedChunks: Int) = queue.put(Cmd.End(num, expectedChunks))

    /** Barge-in. Flags first (unblocks writes/drain fast), teardown in order. */
    fun cancel(num: Long?) {
        for ((k, u) in live) if (num == null || k == num) u.cancelled = true
        queue.put(Cmd.Cancel(num))
    }

    fun shutdown() {
        alive = false
        for (u in live.values) u.cancelled = true
        queue.put(Cmd.Quit)
    }

    // ---- writer thread ----

    private fun btDevice(): AudioDeviceInfo? =
        audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull { isBt(it) }

    private fun isBt(d: AudioDeviceInfo?): Boolean = d != null && (
        d.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
            d.type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
            d.type == AudioDeviceInfo.TYPE_BLE_SPEAKER ||
            d.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
        )

    private fun routeName(d: AudioDeviceInfo?): String =
        if (d == null) "(no route)" else "${d.type}:${d.productName}"

    private fun runWriter() {
        var track: AudioTrack? = null
        var current: Utterance? = null

        fun releaseTrack() {
            try { track?.pause(); track?.flush(); track?.release() } catch (e: Exception) {
                Log.w(TAG, "track release threw", e)
            }
            if (track != null) runCatching { onSpeaking(false) }
            track = null
        }

        fun finish(utt: Utterance, status: String, reason: String?, route: String?) {
            if (utt.acked) return
            utt.acked = true
            live.remove(utt.num)
            Log.i(TAG, "speech ${utt.id}: $status${reason?.let { " ($it)" } ?: ""}${route?.let { " via $it" } ?: ""}")
            runCatching { onAck(utt.id, status, reason, route) }
                .onFailure { Log.e(TAG, "onAck callback threw", it) }
        }

        while (alive) {
            when (val cmd = queue.take()) {
                is Cmd.Quit -> break

                is Cmd.Start -> {
                    // Server serializes speaks; a Start with one live means the
                    // prior was cancelled and its teardown already ran (flag
                    // order) — but guard anyway, loudly.
                    current?.let {
                        Log.w(TAG, "Start(${cmd.utt.id}) while ${it.id} still current — superseding")
                        finish(it, "failed", "superseded by ${cmd.utt.id}", null)
                        releaseTrack()
                    }
                    current = cmd.utt
                    if (cmd.utt.cancelled) { finish(cmd.utt, "failed", "cancelled", null); current = null; continue }
                    val bt = btDevice()
                    if (bt == null) {
                        Log.e(TAG, "ROUTE GUARD: no Bluetooth output — refusing ${cmd.utt.id} (the speaker is never an option)")
                        finish(cmd.utt, "failed", "no Bluetooth output route (earbud not connected)", null)
                        current = null
                        continue
                    }
                    val minBuf = AudioTrack.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
                    track = try {
                        AudioTrack.Builder()
                            .setAudioAttributes(
                                AudioAttributes.Builder()
                                    .setUsage(AudioAttributes.USAGE_MEDIA)
                                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                    .build(),
                            )
                            .setAudioFormat(
                                AudioFormat.Builder()
                                    .setSampleRate(SAMPLE_RATE)
                                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                                    .build(),
                            )
                            .setBufferSizeInBytes(maxOf(minBuf * 4, 64 * 1024))
                            .setTransferMode(AudioTrack.MODE_STREAM)
                            .build()
                    } catch (e: Exception) {
                        Log.e(TAG, "AudioTrack build failed", e)
                        finish(cmd.utt, "failed", "AudioTrack build failed: ${e.message}", null)
                        current = null
                        continue
                    }
                    try {
                        track!!.play()
                    } catch (e: Exception) {
                        Log.e(TAG, "AudioTrack.play failed", e)
                        finish(cmd.utt, "failed", "AudioTrack.play failed: ${e.message}", null)
                        releaseTrack(); current = null
                        continue
                    }
                    runCatching { onSpeaking(true) }
                    Log.i(TAG, "speech ${cmd.utt.id} (num=${cmd.utt.num}) started (BT present: ${routeName(bt)})")
                }

                is Cmd.Pcm -> {
                    val utt = current
                    val t = track
                    if (utt == null || t == null || cmd.num != utt.num) {
                        Log.w(TAG, "late/stray speech frame for num=${cmd.num} — dropped")
                        continue
                    }
                    if (utt.cancelled) continue
                    var off = 0
                    var failed = false
                    while (off < cmd.bytes.size && !utt.cancelled && alive) {
                        val n = t.write(cmd.bytes, off, cmd.bytes.size - off)
                        if (n < 0) {
                            finish(utt, "failed", "AudioTrack.write error $n", routeName(runCatching { t.routedDevice }.getOrNull()))
                            releaseTrack(); current = null
                            failed = true
                            break
                        }
                        off += n
                    }
                    if (failed) continue
                    utt.chunks++
                    utt.bytesQueued += cmd.bytes.size
                    if (utt.chunks == 1 && !utt.cancelled) {
                        // LIVE route re-verification on the first written chunk.
                        val routed = runCatching { t.routedDevice }.getOrNull()
                        if (!isBt(routed)) {
                            Log.e(TAG, "ROUTE GUARD: live route ${routeName(routed)} is not BT — killing ${utt.id}")
                            utt.cancelled = true
                            finish(utt, "failed", "routed to ${routeName(routed)} — not the earbud; refusing", routeName(routed))
                            releaseTrack(); current = null
                        }
                    }
                }

                is Cmd.End -> {
                    val utt = current
                    val t = track
                    if (utt == null || cmd.num != utt.num) {
                        Log.w(TAG, "speak_end for num=${cmd.num} with no matching utterance — ignored")
                        continue
                    }
                    if (cmd.expectedChunks >= 0 && utt.chunks != cmd.expectedChunks) {
                        Log.w(TAG, "speech ${utt.id}: chunk hole — got ${utt.chunks}/${cmd.expectedChunks} (played what arrived)")
                    }
                    if (t == null) { finish(utt, "failed", "no track at end", null); current = null; continue }
                    // Drain: progress-supervised head polling until everything
                    // written has PLAYED, then ack. Cancel flags break it fast.
                    val totalFrames = utt.bytesQueued / 2
                    var lastHead = -1L
                    var stuck = 0
                    var stalled = false
                    while (alive && !utt.cancelled) {
                        val head = try { t.playbackHeadPosition.toLong() and 0xFFFFFFFFL } catch (e: Exception) { -1L }
                        if (head < 0 || head >= totalFrames) break
                        if (head == lastHead) {
                            if (++stuck > STALL_POLLS) { stalled = true; break }
                        } else { stuck = 0; lastHead = head }
                        Thread.sleep(40)
                    }
                    val route = routeName(runCatching { t.routedDevice }.getOrNull())
                    when {
                        stalled -> finish(utt, "failed", "playback stalled at $lastHead/$totalFrames frames (BT route died?)", route)
                        utt.cancelled -> finish(utt, if (utt.bytesQueued > 0) "played" else "failed", "cancelled", route)
                        else -> finish(utt, "played", null, route)
                    }
                    releaseTrack()
                    current = null
                }

                is Cmd.Cancel -> {
                    val utt = current
                    if (utt != null && (cmd.num == null || cmd.num == utt.num)) {
                        finish(utt, if (utt.bytesQueued > 0) "played" else "failed", "cancelled",
                            routeName(runCatching { track?.routedDevice }.getOrNull()))
                        releaseTrack()
                        current = null
                    }
                    // Flags for queued-but-never-started utterances were set in
                    // cancel(); their Start commands ack 'failed cancelled'.
                }
            }
        }
        releaseTrack()
        for (u in live.values) if (!u.acked) { u.acked = true; runCatching { onAck(u.id, "failed", "speech lane shut down", null) } }
        live.clear()
    }

    companion object {
        const val TAG = "G2CCSpeech"
        /** Kokoro native rate — mirrors shared TTS_SAMPLE_RATE. */
        const val SAMPLE_RATE = 24_000
        /** Drain stall supervision: ~STALL_POLLS × 40 ms ≈ 8 s of ZERO head
         *  progress = the sink died. Progress supervision, not a time bound
         *  on the utterance (a 5-minute read drains fine). */
        private const val STALL_POLLS = 200
    }
}
