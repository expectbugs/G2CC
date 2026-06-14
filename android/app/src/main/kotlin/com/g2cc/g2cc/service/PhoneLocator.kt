package com.g2cc.g2cc.service

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.g2cc.g2cc.harness.DiagLog

/**
 * Phase 15 — ring the phone to find it. Maxes STREAM_ALARM and plays the alarm
 * ringtone for ~30 s (self-stopping), then restores the prior volume. `stop()`
 * cancels early. No new permission. Loud diag both ends.
 *
 * NOTE: "cancel on any phone interaction" (screen-on/unlock) is a follow-up —
 * v1 relies on the 30 s auto-stop and the explicit phone_locate stop.
 */
object PhoneLocator {
    private val handler = Handler(Looper.getMainLooper())
    private var ringtone: android.media.Ringtone? = null
    private var prevVolume = -1
    private var autoStop: Runnable? = null
    private const val RING_MS = 30_000L

    @Synchronized
    fun start(ctx: Context) {
        try {
            val am = ctx.getSystemService(AudioManager::class.java) ?: run { DiagLog.log("locate", "no AudioManager"); return }
            if (prevVolume < 0) prevVolume = am.getStreamVolume(AudioManager.STREAM_ALARM)
            am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
            val uri = RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE)
            ringtone?.let { if (it.isPlaying) it.stop() }
            ringtone = RingtoneManager.getRingtone(ctx, uri)?.apply {
                if (Build.VERSION.SDK_INT >= 28) {
                    audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build()
                    isLooping = true
                }
                play()
            }
            DiagLog.log("locate", "ringing — STREAM_ALARM maxed (was $prevVolume), ~30 s")
            autoStop?.let { handler.removeCallbacks(it) }
            autoStop = Runnable { stop(ctx) }.also { handler.postDelayed(it, RING_MS) }
        } catch (e: Exception) {
            DiagLog.log("locate", "start failed: $e")
            // A partial start (volume already maxed at line above, ringtone/timer
            // not armed) must not strand STREAM_ALARM at max. stop() is reentrant.
            stop(ctx)
        }
    }

    @Synchronized
    fun stop(ctx: Context) {
        try {
            autoStop?.let { handler.removeCallbacks(it) }; autoStop = null
            ringtone?.let { if (it.isPlaying) it.stop() }; ringtone = null
            if (prevVolume >= 0) {
                ctx.getSystemService(AudioManager::class.java)?.setStreamVolume(AudioManager.STREAM_ALARM, prevVolume, 0)
                DiagLog.log("locate", "stopped — volume restored to $prevVolume")
                prevVolume = -1
            }
        } catch (e: Exception) { DiagLog.log("locate", "stop failed: $e") }
    }
}
