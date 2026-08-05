package com.g2cc.g2cc.audio

import android.content.Context
import android.media.AudioAttributes as FwAudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.SoundPool
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import com.g2cc.g2cc.net.ClientMessage
import com.g2cc.g2cc.net.ServerMessage
import kotlin.math.pow

/**
 * The earbud OUTPUT coordinator (2026-08-04, docs/EARBUD_SPEC.md §C7):
 *
 *  - speech lane: SpeechPlayer (WS 0x11 frames → AudioTrack), with transient
 *    AudioFocus (third-party apps duck) + our-media duck while speaking
 *  - media lane: media3 ExoPlayer playing the server's /media/track URLs
 *    (server-relative → prefixed with the configured host), reporting honest
 *    media_event states; the SERVER owns the queue
 *  - chimes: SoundPool earcons, instant, phone-local
 *  - an OWNED platform MediaSession so Pixel Buds 2a tap gestures reach us as
 *    transport callbacks → forwarded as `input{event:media_button}` — the
 *    SERVER owns the semantics (single=pause/quiet, double=Companion PTT,
 *    triple=next track)
 *
 * Route guard: the media lane refuses to start with no BT output present
 * (media_event error) — the phone speaker is NEVER an output. The speech
 * lane enforces its own guard (SpeechPlayer).
 *
 * All entry points are called from the service/WS threads; ExoPlayer calls
 * are marshalled onto the main looper via the player's application looper
 * requirement (constructed on main via Handler below).
 */
class AudioOutController(
    private val context: Context,
    private val serverBase: String,                      // "http://host:port"
    private val sendToServer: (ClientMessage) -> Boolean,
    private val sendInput: (ClientMessage.Input) -> Boolean,
) {
    private val am = context.getSystemService(AudioManager::class.java)
    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    // ---- chimes ----
    private val soundPool = SoundPool.Builder()
        .setMaxStreams(2)
        .setAudioAttributes(
            FwAudioAttributes.Builder()
                .setUsage(FwAudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                .setContentType(FwAudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build(),
        )
        .build()
    private val chimeIds = HashMap<String, Int>()
    private val chimeLoaded = HashSet<Int>()

    init {
        soundPool.setOnLoadCompleteListener { _, sampleId, status ->
            if (status == 0) synchronized(chimeLoaded) { chimeLoaded.add(sampleId) }
            else Log.e(TAG, "chime load failed (sample $sampleId status $status)")
        }
        fun load(name: String, resName: String) {
            val resId = context.resources.getIdentifier(resName, "raw", context.packageName)
            if (resId == 0) {
                Log.e(TAG, "chime resource $resName missing from the APK — '$name' will be silent (loud once here)")
                return
            }
            chimeIds[name] = soundPool.load(context, resId, 1)
        }
        load("rec_start", "chime_rec_start")
        load("rec_stop", "chime_rec_stop")
        load("done", "chime_done")
        load("error", "chime_error")
        load("timer", "chime_timer")
        load("notify", "chime_notify")
    }

    fun chime(name: String) {
        val id = chimeIds[name]
        if (id == null) {
            Log.w(TAG, "unknown/unloaded chime '$name' — ignored (known: ${chimeIds.keys})")
            return
        }
        val loaded = synchronized(chimeLoaded) { chimeLoaded.contains(id) }
        if (!loaded) { Log.w(TAG, "chime '$name' not loaded yet — skipped"); return }
        // Route etiquette: chimes ride sonification; if no BT output, skip
        // (silent phone at work beats a pocket beep).
        if (btOut() == null) { Log.w(TAG, "chime '$name' skipped — no BT output route"); return }
        soundPool.play(id, CHIME_VOL, CHIME_VOL, 1, 0, 1f)
    }

    private fun btOut(): AudioDeviceInfo? =
        am?.getDevices(AudioManager.GET_DEVICES_OUTPUTS)?.firstOrNull {
            it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                it.type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
                it.type == AudioDeviceInfo.TYPE_BLE_SPEAKER ||
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
        }

    // ---- speech lane + focus ----

    private var focusRequest: AudioFocusRequest? = null

    val speech = SpeechPlayer(
        am!!,
        onAck = { id, status, reason, route ->
            if (!sendToServer(ClientMessage.SpeakAck(id, status, reason, route))) {
                Log.e(TAG, "speak_ack($id,$status) could not be sent — WS down")
            }
        },
        onSpeaking = { speaking ->
            main.post {
                if (speaking) {
                    // Transient duck focus: third-party audio ducks for free.
                    val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                        .setAudioAttributes(
                            FwAudioAttributes.Builder()
                                .setUsage(FwAudioAttributes.USAGE_MEDIA)
                                .setContentType(FwAudioAttributes.CONTENT_TYPE_SPEECH)
                                .build(),
                        )
                        .build()
                    focusRequest = req
                    val r = am.requestAudioFocus(req)
                    if (r != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) Log.w(TAG, "transient focus not granted ($r) — speaking anyway")
                } else {
                    focusRequest?.let { am.abandonAudioFocusRequest(it) }
                    focusRequest = null
                }
            }
        },
    )

    // ---- media lane (media3) ----

    private var player: ExoPlayer? = null
    private var mediaId: String? = null
    private var duckedVolume = false
    private var mediaSession: MediaSession? = null
    /** Review 2026-08-04 #2: a media_ctl lambda posted BEFORE shutdown() but
     *  executing AFTER the release must not rebuild a zombie player+session on
     *  a dead service. Set synchronously in shutdown(); checked on main. */
    @Volatile private var shuttingDown = false

    /** Build the player + session lazily on the main thread. */
    private fun ensurePlayer(then: (ExoPlayer) -> Unit) {
        main.post {
            if (shuttingDown) { Log.w(TAG, "player command after shutdown — dropped (no zombie rebuild)"); return@post }
            val existing = player
            if (existing != null) { then(existing); return@post }
            val p = ExoPlayer.Builder(context)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(C.USAGE_MEDIA)
                        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                        .build(),
                    /* handleAudioFocus = */ true,   // pauses us when others take focus
                )
                // Deep-review #20 (WORK RULE): an earbud disconnect mid-music
                // must PAUSE, never continue on the phone speaker.
                .setHandleAudioBecomingNoisy(true)
                // v1.22 (MUSIC_SPEC D5.1): minutes-class buffer — Tailscale-at-
                // work hiccup insurance. A blip mid-track plays on from RAM
                // instead of stalling; the defaults buffered only ~50 s.
                .setLoadControl(
                    DefaultLoadControl.Builder()
                        .setBufferDurationsMs(
                            /* minBufferMs = */ 60_000,
                            /* maxBufferMs = */ 300_000,
                            /* bufferForPlaybackMs = */ 1_500,
                            /* bufferForPlaybackAfterRebufferMs = */ 5_000,
                        )
                        .build(),
                )
                .build()
            p.addListener(object : Player.Listener {
                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    val id = mediaId ?: return
                    updateSessionState(isPlaying)
                    sendToServer(ClientMessage.MediaEvent(id, if (isPlaying) "playing" else "paused", p.currentPosition))
                }
                override fun onPlaybackStateChanged(state: Int) {
                    val id = mediaId ?: return
                    if (state == Player.STATE_ENDED) {
                        sendToServer(ClientMessage.MediaEvent(id, "ended", p.currentPosition))
                    }
                }
                override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
                    // v1.22 gapless (D5.1): the rolling 2-item playlist rolled
                    // to the prestaged track on its own. Anchor OUR id to the
                    // new item and tell the server honestly — it advances its
                    // queue WITHOUT re-opening and preloads the following one.
                    if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) return
                    val newId = item?.mediaId
                    if (newId.isNullOrEmpty()) {
                        Log.e(TAG, "auto-transition to an item with NO mediaId — cannot report (server will see a stale id)")
                        return
                    }
                    mediaId = newId
                    // Prune the finished item so the playlist stays a rolling
                    // 2-item window (index 0 = now playing after removal).
                    if (p.currentMediaItemIndex > 0) {
                        runCatching { p.removeMediaItem(0) }
                            .onFailure { Log.w(TAG, "rolling-window prune failed", it) }
                    }
                    updateSessionMetadata(item)
                    Log.i(TAG, "gapless auto-advance → $newId")
                    sendToServer(ClientMessage.MediaEvent(newId, "playing", p.currentPosition, reason = "auto_advanced"))
                }
                override fun onPlayerError(error: PlaybackException) {
                    val id = mediaId ?: return
                    Log.e(TAG, "media lane error", error)
                    sendToServer(ClientMessage.MediaEvent(id, "error", p.currentPosition, reason = error.errorCodeName))
                }
            })
            player = p
            ensureSession()
            then(p)
        }
    }

    /** The OWNED MediaSession — the earbud-button surface. Active whenever the
     *  controller exists so Buds taps reach us when WE are the media target
     *  (i.e. whenever our lane was the last thing playing). */
    private fun ensureSession() {
        if (mediaSession != null) return
        val s = MediaSession(context, "g2cc-earbud")
        s.setCallback(object : MediaSession.Callback() {
            override fun onPlay() { forwardButton("play") }
            override fun onPause() { forwardButton("pause") }
            override fun onSkipToNext() { forwardButton("next") }
            override fun onSkipToPrevious() { forwardButton("prev") }
            override fun onStop() { forwardButton("stop") }
        })
        s.isActive = true
        mediaSession = s
        updateSessionState(false)
        Log.i(TAG, "owned MediaSession active — earbud buttons route to the server")
    }

    private fun forwardButton(button: String) {
        Log.i(TAG, "earbud media button: $button")
        if (!sendInput(ClientMessage.Input(event = "media_button", button = button))) {
            Log.e(TAG, "media_button '$button' DROPPED — WS not ready")
        }
    }

    private fun updateSessionState(playing: Boolean) {
        val s = mediaSession ?: return
        val actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
            PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or
            PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_STOP
        val state = PlaybackState.Builder()
            .setActions(actions)
            .setState(
                if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                player?.currentPosition ?: 0L,
                if (playing) 1f else 0f,
            )
            .build()
        runCatching { s.setPlaybackState(state) }.onFailure { Log.w(TAG, "session state update failed", it) }
    }

    // ---- ServerMessage entry points (called from the WS reader) ----

    fun onSpeakStart(msg: ServerMessage.SpeakStart) {
        // Music etiquette for OUR lane is server-driven (media_ctl duck/pause
        // arrives separately); the speech lane just plays.
        speech.speakStart(msg.id, msg.num)
    }

    fun onSpeechFrame(num: Long, pcm: ByteArray) = speech.frame(num, pcm)

    fun onSpeakEnd(msg: ServerMessage.SpeakEnd) = speech.speakEnd(msg.num, msg.chunks)

    fun onSpeakCancel(msg: ServerMessage.SpeakCancel) = speech.cancel(msg.num)

    /** Build a playlist item carrying the SERVER's media id as the ExoPlayer
     *  mediaId — the auto-transition handler reports it back verbatim. */
    private fun buildItem(id: String, url: String, title: String, artist: String?, album: String?): MediaItem {
        val full = if (url.startsWith("http")) url else serverBase + url
        return MediaItem.Builder()
            .setMediaId(id)
            .setUri(full)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    .setArtist(artist)
                    .setAlbumTitle(album)
                    .build(),
            )
            .build()
    }

    private fun updateSessionMetadata(item: MediaItem?) {
        val md = item?.mediaMetadata ?: return
        runCatching {
            mediaSession?.setMetadata(
                android.media.MediaMetadata.Builder()
                    .putString(android.media.MediaMetadata.METADATA_KEY_TITLE, md.title?.toString() ?: "")
                    .putString(android.media.MediaMetadata.METADATA_KEY_ARTIST, md.artist?.toString() ?: "")
                    .build(),
            )
        }
    }

    /** Replace/append the prestaged NEXT item so the playlist is a rolling
     *  2-item window (v1.22 D5.1). Called on main via ensurePlayer. */
    private fun stageNext(p: ExoPlayer, next: ServerMessage.MediaNext) {
        val item = buildItem(next.id, next.url, next.title, next.artist, next.album)
        val cur = p.currentMediaItemIndex
        while (p.mediaItemCount > cur + 1) {
            runCatching { p.removeMediaItem(p.mediaItemCount - 1) }
                .onFailure { Log.w(TAG, "stale next removal failed", it); return }
        }
        p.addMediaItem(item)
        Log.i(TAG, "prestaged next → ${next.id} ('${next.title}') — ${p.mediaItemCount} item(s) loaded")
    }

    fun onMediaOpen(msg: ServerMessage.MediaOpen) {
        if (btOut() == null) {
            Log.e(TAG, "ROUTE GUARD: media_open '${msg.title}' with no BT output — refusing (the speaker is never an option)")
            sendToServer(ClientMessage.MediaEvent(msg.id, "error", 0, reason = "no Bluetooth output route (earbud not connected)"))
            return
        }
        ensurePlayer { p ->
            // mediaId assignment on MAIN (review #E12): a boundary transition
            // firing in the WS→main hop window could otherwise interleave its
            // own mediaId write; main-thread ordering settles it.
            mediaId = msg.id
            val item = buildItem(msg.id, msg.url, msg.title, msg.artist, msg.album)
            p.setMediaItem(item, msg.startMs ?: 0L)
            p.volume = 1f
            duckedVolume = false
            p.prepare()
            p.play()
            // v1.22 (cap media-prestage): the server may ship the next track
            // with the open — stage it as item 2 for a gapless boundary.
            msg.next?.let { stageNext(p, it) }
            updateSessionMetadata(item)
            Log.i(TAG, "media_open ${msg.id}: '${msg.title}'${msg.next?.let { " (+next ${it.id})" } ?: ""}")
        }
    }

    fun onMediaCtl(msg: ServerMessage.MediaCtl) {
        when (msg.cmd) {
            "volume" -> {
                // STREAM_MUSIC absolute — device volume, not player gain.
                val pct = (msg.value ?: 60.0).coerceIn(0.0, 100.0)
                val max = am?.getStreamMaxVolume(AudioManager.STREAM_MUSIC) ?: 15
                val idx = Math.round(pct / 100.0 * max).toInt()
                runCatching { am?.setStreamVolume(AudioManager.STREAM_MUSIC, idx, 0) }
                    .onFailure { Log.e(TAG, "setStreamVolume failed", it) }
                Log.i(TAG, "media volume → $pct% (index $idx/$max)")
                return
            }
        }
        ensurePlayer { p ->
            when (msg.cmd) {
                "play" -> p.play()
                "pause" -> p.pause()
                "stop" -> { p.stop(); p.clearMediaItems(); mediaId = null }
                "seek" -> p.seekTo((msg.value ?: 0.0).toLong())
                "duck" -> {
                    val db = msg.value ?: -12.0
                    p.volume = 10.0.pow(db / 20.0).toFloat().coerceIn(0f, 1f)
                    duckedVolume = true
                }
                "unduck" -> { p.volume = 1f; duckedVolume = false }
                // v1.22 gapless (D5.1): stage the following track behind the
                // one now playing (sent by the server after each auto-advance).
                "preload" -> {
                    val next = msg.next
                    if (next == null) Log.e(TAG, "media_ctl preload with no `next` payload — ignored LOUDLY")
                    else stageNext(p, next)
                }
                else -> Log.w(TAG, "unknown media_ctl cmd '${msg.cmd}' — ignored LOUDLY")
            }
        }
    }

    fun shutdown() {
        shuttingDown = true
        speech.shutdown()
        main.post {
            runCatching { mediaSession?.release() }
            mediaSession = null
            runCatching { player?.release() }
            player = null
        }
        runCatching { soundPool.release() }
    }

    companion object {
        const val TAG = "G2CCAudioOut"
        private const val CHIME_VOL = 0.6f
    }
}
