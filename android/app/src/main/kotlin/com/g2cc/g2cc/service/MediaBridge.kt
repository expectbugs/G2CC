package com.g2cc.g2cc.service

import android.content.ComponentName
import android.content.Context
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import com.g2cc.g2cc.harness.DiagLog
import com.g2cc.g2cc.net.MediaInfo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream

/**
 * Phase 7 — now-playing + transport via MediaSessionManager. The EXISTING
 * NotificationListener grant authorizes getActiveSessions(component); NO new
 * permission. subscribe() registers a controller + callback that pushes
 * MediaInfo on every metadata/playback change; command() drives the active
 * controller's transport. Single-process (shares ConnectionService's process).
 *
 * Discipline: loud failures (DiagLog), never a silent catch; album art is
 * encoded once per track (page-2 image on the server). [U] on-glass.
 */
object MediaBridge {
    private var msm: MediaSessionManager? = null
    private var controller: MediaController? = null
    private var callback: MediaController.Callback? = null
    private var sessionsListener: MediaSessionManager.OnActiveSessionsChangedListener? = null
    private var push: ((MediaInfo) -> Unit)? = null
    @Volatile private var lastArtKey = ""   // avoid re-encoding the same album art (read off ioScope)
    /** Album-art JPEG encode runs OFF the main thread (the callbacks fire on
     *  main — the same ANR class NotifyListener's C1 fix moved off main). */
    private val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Synchronized
    fun subscribe(ctx: Context, onState: (MediaInfo) -> Unit) {
        push = onState
        try {
            val m = ctx.getSystemService(MediaSessionManager::class.java)
            if (m == null) { DiagLog.log("media", "no MediaSessionManager"); onState(MediaInfo(playing = false)); return }
            // Re-subscribe (Media Reload / window re-entry) must not STACK
            // listeners (review 2026-07-05: every repeat subscribe() added
            // another OnActiveSessionsChangedListener; unsubscribe() removes
            // only the latest — the leaked ones fired N callbacks per session
            // change for the life of the process). Remove the previous first.
            sessionsListener?.let { l ->
                try { (msm ?: m).removeOnActiveSessionsChangedListener(l) } catch (e: Exception) { DiagLog.log("media", "stale listener remove failed: $e") }
            }
            sessionsListener = null
            msm = m
            val comp = ComponentName(ctx, NotifyListener::class.java)
            val sessions = m.getActiveSessions(comp)
            attach(sessions.firstOrNull())
            // track the active-session set changing (e.g. switching music apps)
            val listener = MediaSessionManager.OnActiveSessionsChangedListener { list -> attach(list?.firstOrNull()) }
            sessionsListener = listener
            m.addOnActiveSessionsChangedListener(listener, comp)
            DiagLog.log("media", "subscribed (${sessions.size} active sessions)")
            pushNow()
        } catch (e: SecurityException) {
            DiagLog.log("media", "subscribe DENIED (NLS grant needed): $e"); onState(MediaInfo(playing = false))
        } catch (e: Exception) {
            DiagLog.log("media", "subscribe failed: $e"); onState(MediaInfo(playing = false))
        }
    }

    @Synchronized
    fun unsubscribe() {
        try { sessionsListener?.let { msm?.removeOnActiveSessionsChangedListener(it) } } catch (e: Exception) { DiagLog.log("media", "remove listener failed: $e") }
        sessionsListener = null
        detachCallback()
        controller = null
        msm = null
        push = null
        lastArtKey = ""
        DiagLog.log("media", "unsubscribed")
    }

    @Synchronized
    fun command(cmd: String) {
        val tc = controller?.transportControls
        if (tc == null) { DiagLog.log("media", "command $cmd but no active controller"); return }
        try {
            when (cmd) {
                "play_pause" -> if (controller?.playbackState?.state == PlaybackState.STATE_PLAYING) tc.pause() else tc.play()
                "next" -> tc.skipToNext()
                "prev" -> tc.skipToPrevious()
                "shuffle" -> {
                    // The FRAMEWORK media-session API (android.media.session, what we use via
                    // MediaSessionManager) has NO shuffle setter — that's androidx
                    // MediaControllerCompat only. Players that support shuffle expose it as a
                    // CUSTOM ACTION in PlaybackState; send that. Loud fallback when absent
                    // (Adam 2026-06-18; was wrongly skipToNext).
                    val act = controller?.playbackState?.customActions?.firstOrNull {
                        it.action.contains("shuffle", true) || it.name?.toString()?.contains("shuffle", true) == true
                    }
                    if (act != null) { tc.sendCustomAction(act, null); DiagLog.log("media", "shuffle via custom action '${act.action}'") }
                    else DiagLog.log("media", "no shuffle custom action exposed by this player — ignored (open the app to toggle)")
                }
                else -> DiagLog.log("media", "unknown command $cmd")
            }
        } catch (e: Exception) { DiagLog.log("media", "command $cmd failed: $e") }
    }

    private fun attach(c: MediaController?) {
        if (c?.sessionToken == controller?.sessionToken) return
        detachCallback()
        controller = c
        if (c == null) { push?.invoke(MediaInfo(playing = false)); return }
        val cb = object : MediaController.Callback() {
            override fun onPlaybackStateChanged(state: PlaybackState?) = pushNow()
            override fun onMetadataChanged(metadata: MediaMetadata?) = pushNow()
            override fun onSessionDestroyed() { detachCallback(); controller = null; push?.invoke(MediaInfo(playing = false)) }
        }
        callback = cb
        try { c.registerCallback(cb) } catch (e: Exception) { DiagLog.log("media", "registerCallback failed: $e") }
    }

    private fun detachCallback() {
        val c = controller; val cb = callback
        if (c != null && cb != null) try { c.unregisterCallback(cb) } catch (e: Exception) { DiagLog.log("media", "unregister failed: $e") }
        callback = null
    }

    private fun pushNow() {
        val p = push ?: return
        val c = controller ?: run { p(MediaInfo(playing = false)); return }
        try {
            val md = c.metadata
            val ps = c.playbackState
            val title = md?.getString(MediaMetadata.METADATA_KEY_TITLE)
            val artist = md?.getString(MediaMetadata.METADATA_KEY_ARTIST) ?: md?.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST)
            val album = md?.getString(MediaMetadata.METADATA_KEY_ALBUM)
            val dur = md?.getLong(MediaMetadata.METADATA_KEY_DURATION)?.takeIf { it > 0 }
            val pos = ps?.position?.takeIf { it >= 0 }
            val artKey = "$artist|$title|$album"
            // Push the text snapshot IMMEDIATELY (main, cheap — no art).
            val base = MediaInfo(
                playing = ps?.state == PlaybackState.STATE_PLAYING,
                title = title, artist = artist, album = album,
                durationMs = dur, positionMs = pos, app = c.packageName, artB64 = null,
            )
            p(base)
            if (artKey != lastArtKey) {
                val bmp = md?.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART) ?: md?.getBitmap(MediaMetadata.METADATA_KEY_ART)
                // Commit the dedupe key ONLY once a bitmap is in hand (review
                // 2026-07-05: marking it before a LATE-loading art existed
                // skipped the track's art forever — every later metadata push
                // matched the key and bailed). A failed/oversize encode resets
                // the key so a later push can retry.
                if (bmp != null) {
                    lastArtKey = artKey
                    // H2: encode + re-push the art OFF the main thread (ANR class).
                    ioScope.launch {
                        val art = encodeArt(bmp)
                        if (art == null) {
                            // Reset ONLY if we still own the key (diff-review 2026-07-05):
                            // a STALE failure landing after a track change was clobbering
                            // the newer track's committed key, dropping its in-flight art.
                            if (lastArtKey == artKey) lastArtKey = ""
                            return@launch
                        }
                        if (lastArtKey == artKey) push?.invoke(base.copy(artB64 = art))   // still the same track
                    }
                }
            }
        } catch (e: Exception) { DiagLog.log("media", "pushNow failed: $e") }
    }

    private fun encodeArt(bmp: android.graphics.Bitmap?): String? {
        if (bmp == null) return null
        return try {
            val maxDim = 240
            val scale = maxDim.toFloat() / maxOf(bmp.width, bmp.height)
            val scaled = if (scale < 1f) android.graphics.Bitmap.createScaledBitmap(
                bmp, (bmp.width * scale).toInt().coerceAtLeast(1), (bmp.height * scale).toInt().coerceAtLeast(1), true) else bmp
            val out = ByteArrayOutputStream()
            scaled.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, out)
            val bytes = out.toByteArray()
            if (bytes.size > 300_000) { DiagLog.log("media", "album art ${bytes.size} B — dropped"); return null }
            android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        } catch (e: Exception) { DiagLog.log("media", "art encode failed: $e"); null }
    }
}
