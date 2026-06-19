package com.g2cc.g2cc.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
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
 * Cancel-on-interaction (Adam 2026-06-18): while ringing we listen for SCREEN_ON /
 * USER_PRESENT — picking up the phone silences it immediately (no waiting out the
 * 30 s). Both are protected system broadcasts (runtime-registered, NOT_EXPORTED).
 */
object PhoneLocator {
    private val handler = Handler(Looper.getMainLooper())
    private var ringtone: android.media.Ringtone? = null
    private var prevVolume = -1
    private var autoStop: Runnable? = null
    private var interaction: BroadcastReceiver? = null
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
            // silence the moment the user picks up the phone (screen on / unlock)
            val app = ctx.applicationContext
            interaction?.let { try { app.unregisterReceiver(it) } catch (e: Exception) {} }
            interaction = object : BroadcastReceiver() {
                override fun onReceive(c: Context, i: Intent) { DiagLog.log("locate", "interaction (${i.action}) — silencing"); stop(ctx) }
            }.also {
                val filter = IntentFilter().apply { addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_USER_PRESENT) }
                if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(it, filter, Context.RECEIVER_NOT_EXPORTED)
                else app.registerReceiver(it, filter)
            }
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
            interaction?.let { try { ctx.applicationContext.unregisterReceiver(it) } catch (e: Exception) {} }; interaction = null
            ringtone?.let { if (it.isPlaying) it.stop() }; ringtone = null
            if (prevVolume >= 0) {
                ctx.getSystemService(AudioManager::class.java)?.setStreamVolume(AudioManager.STREAM_ALARM, prevVolume, 0)
                DiagLog.log("locate", "stopped — volume restored to $prevVolume")
                prevVolume = -1
            }
        } catch (e: Exception) { DiagLog.log("locate", "stop failed: $e") }
    }
}
