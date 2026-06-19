package com.g2cc.g2cc.service

import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.g2cc.g2cc.harness.DiagLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Phone-notification mirror (upgrades.md Phase 9, READ-ONLY v1 — no inline
 * reply). Forwards non-ongoing notifications to the PC as additive
 * [com.g2cc.g2cc.net.ClientMessage.Notify]; the server maps package →
 * priority and routes into its notification layer (title flash / overlay /
 * blanked popup).
 *
 * Lifecycle facts (researched against current AOSP docs, 2026-06-11):
 *  - The SYSTEM owns binding; we never start/bind this ourselves.
 *  - `onListenerDisconnected` → `requestRebind` is the first-line recovery
 *    (API 24+; silent no-op when access isn't granted).
 *  - The classic ZOMBIE state (granted but never reconnects after a crash
 *    loop) needs the component-toggle kick — [kickIfZombie] runs it from
 *    HarnessActivity.onStart with a 10 s grace after a plain rebind attempt.
 *    The toggle does NOT revoke the user's grant.
 *  - Android 15 may REDACT OTP-bearing content for untrusted listeners
 *    ("Sensitive notification content hidden") — the proper fix is a CDM
 *    GLASSES association (out of scope v1; noted in docs).
 *
 * Shares the default process with [ConnectionService] (recommended practice;
 * state flows through [ConnectionService.forwardNotification], which
 * loud-drops when the bridge isn't up). Callbacks run on the MAIN thread —
 * keep them cheap and exception-proof (an uncaught throw here is what
 * produces the zombie state).
 */
class NotifyListener : NotificationListenerService() {

    /** C1 (review 2026-06-13): background scope for the MMS image decode/encode —
     *  a multi-MB photo must NOT be decoded on the NLS callback (main) thread (a
     *  slow/throwing callback is exactly what produces the zombie-listener state). */
    private val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** NEWEST-WINS per notification key (review 2026-06-13): Google Messages
     *  re-posts the same key with evolving TEXT while the RCS image URI stays
     *  constant — the content stamp differs each time, so without superseding,
     *  every re-post spawned ANOTHER 10 s decode loop for the SAME image
     *  (redundant multi-MB decodes + duplicate sends). One loop per key. */
    private val imgJobs = java.util.concurrent.ConcurrentHashMap<String, kotlinx.coroutines.Job>()

    override fun onDestroy() {
        super.onDestroy()
        ioScope.cancel()
        if (live === this) live = null
    }

    override fun onListenerConnected() {
        connected = true
        live = this   // for cancelByKey (dismiss sync, Adam 2026-06-13)
        DiagLog.log("notify", "listener CONNECTED")
    }

    override fun onListenerDisconnected() {
        connected = false
        if (live === this) live = null
        DiagLog.log("notify", "listener DISCONNECTED")
        // First-line recovery; only valid call in this state. No-op unless granted.
        try {
            if (isAccessGranted(this)) requestRebind(componentName(this))
        } catch (e: Exception) {
            DiagLog.log("notify", "requestRebind failed: $e")
        }
    }

    /** Dismiss-sync (Adam 2026-06-13): the user dismissed a notification WE
     *  forwarded → tell the server to mark the glasses copy seen, and drop it
     *  from the dedup map so a genuine re-post forwards fresh. */
    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        try {
            val key = sbn.key ?: return
            if (key == navKey) { navKey = null; ConnectionService.forwardNavClear(); return }   // Phase 6: navigation ended
            val wasForwarded = synchronized(seen) { seen.remove(key) != null }
            if (wasForwarded) {
                imgJobs.remove(key)?.cancel()   // a removed notification's image loop is moot
                ConnectionService.notificationDismissed(key)
            }
        } catch (e: Exception) {
            DiagLog.log("notify", "onNotificationRemoved threw: $e")
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        try {
            forward(sbn)
        } catch (e: Exception) {
            // An uncaught throw on the main thread = crash loop = zombie
            // listener. Loud, never fatal.
            DiagLog.log("notify", "onNotificationPosted threw: $e")
        }
    }

    private fun forward(sbn: StatusBarNotification) {
        val n = sbn.notification ?: return
        if (sbn.packageName == packageName) return                                    // our own FGS notification

        // Phase 6: Google Maps live-navigation notification → a PINNED nav line
        // (it's ongoing, so the ongoing-drop below would otherwise kill it).
        // Allow-listed by package; updates in place; nav_clear on removal.
        if (sbn.packageName == MAPS_PKG && sbn.isOngoing) {
            val e = n.extras
            val navTitle = e.getCharSequence(android.app.Notification.EXTRA_TITLE)?.toString()?.trim() ?: ""
            val navText = e.getCharSequence(android.app.Notification.EXTRA_TEXT)?.toString()?.trim() ?: ""
            if (navTitle.isNotEmpty() || navText.isNotEmpty()) {
                navKey = sbn.key
                val line = if (navTitle.isNotEmpty()) navTitle else navText
                val eta = if (navTitle.isNotEmpty() && navText.isNotEmpty()) navText else null
                ConnectionService.forwardNavUpdate(line, eta)
            }
            return
        }
        // CATEGORY_CALL passes the ongoing/FGS gates (review 2026-06-11b): an
        // INCOMING call's notification is CallStyle = ongoing + posted by the
        // dialer's InCallService FGS — both filters dropped it, so the server's
        // dialer→'call' priority (the top of Adam's ladder, the wake-the-
        // blanked-screen popup) could never fire for a live call; only the
        // after-the-fact missed-call notification got through. [U] needs the
        // on-glass verification batch (ring the phone).
        val isCall = n.category == android.app.Notification.CATEGORY_CALL
        if (sbn.isOngoing && !isCall) return                                          // ongoing/FGS-shaped
        if (!isCall && n.flags and android.app.Notification.FLAG_FOREGROUND_SERVICE != 0) return
        if (n.flags and android.app.Notification.FLAG_GROUP_SUMMARY != 0) return      // children carry the content

        val extras = n.extras
        val title = extras.getCharSequence(android.app.Notification.EXTRA_TITLE)?.toString() ?: ""
        val text = extras.getCharSequence(android.app.Notification.EXTRA_BIG_TEXT)?.toString()
            ?: extras.getCharSequence(android.app.Notification.EXTRA_TEXT)?.toString()
            ?: extras.getCharSequenceArray(android.app.Notification.EXTRA_TEXT_LINES)?.joinToString("\n")
            ?: ""
        if (title.isBlank() && text.isBlank()) {
            DiagLog.log("notify", "skipped ${sbn.packageName} — no extractable title/text")
            return
        }

        // Debounce: key → CONTENT hash only (review 2026-06-11b). postTime
        // used to be part of the stamp, but media/progress apps re-post the
        // same key with a FRESH postTime and identical text many times a
        // minute — every re-post minted a new stamp, so the debounce never
        // suppressed exactly the case it was added for (each re-post = a DB
        // row + a ⚠ flash on glass). Content CHANGES still forward; the
        // 64-entry LRU ages suppressed keys out.
        val imgRef = imageRef(n, extras)
        val hasReply = findReplyAction(n) != null                                     // Phase 4a: inline reply available?
        val stamp = "${(title + "\u0000" + text + "\u0000" + imgRef).hashCode()}"
        synchronized(seen) {
            if (seen[sbn.key] == stamp) return
            seen[sbn.key] = stamp
            if (seen.size > SEEN_CAP) {
                val it = seen.keys.iterator()
                it.next(); it.remove()   // LinkedHashMap insertion order = oldest first
            }
        }

        // No image → forward immediately (cheap, stays on the main thread).
        if (imgRef.isEmpty()) {
            ConnectionService.forwardNotification(
                pkg = sbn.packageName, title = title, text = text,
                postedAt = sbn.postTime, key = sbn.key, imageB64 = null, hasReply = hasReply,
            )
            return
        }
        // C1 (review 2026-06-13): an image rides this notification — decode +
        // JPEG-encode it OFF the main thread (a multi-MB MMS photo blocked the NLS
        // callback → zombie-listener risk), then forward text+image together. The
        // dedup stamp above already ran on the main thread, so only the FIRST
        // occurrence per image reaches this expensive path.
        imgJobs[sbn.key]?.cancel()   // newest-wins: supersede an in-flight loop for this key
        val job = ioScope.launch {
            // Phase 1 (MMS retry, review 2026-06-12 evidence): Google Messages
            // posts the conversation notification, but the RCS attachment file
            // often isn't fully written/servable at notification time — the URI
            // exists yet openInputStream yields nothing. The notification stays
            // posted (the listener URI grant holds), so RETRY the decode at
            // 0/2/5/10 s; first success wins, after the window forward imageless
            // + LOUD. Bounded supervision retries (a resource cap), NOT a timeout.
            var img: String? = null
            for ((i, wait) in listOf(0L, 2000L, 5000L, 10000L).withIndex()) {
                if (wait > 0L) delay(wait)
                val bmp = try {
                    loadPicture(n, extras)
                } catch (e: Exception) {
                    DiagLog.log("notify", "image decode attempt ${i + 1} threw: $e"); null
                }
                if (bmp != null) {
                    img = try { encodeJpegB64(bmp) } catch (e: Exception) { DiagLog.log("notify", "jpeg encode threw: $e"); null }
                    if (img != null) { if (i > 0) DiagLog.log("notify", "MMS image readable on retry ${i + 1}"); break }
                }
            }
            if (!isActive) return@launch   // superseded by a newer re-post — don't double-forward
            if (img == null) DiagLog.log("notify", "MMS image NEVER readable after 4 attempts — forwarding imageless (LOUD)")
            ConnectionService.forwardNotification(
                pkg = sbn.packageName, title = title, text = text,
                postedAt = sbn.postTime, key = sbn.key, imageB64 = img, hasReply = hasReply,
            )
        }
        // Put BEFORE registering completion: if the job finishes before this line,
        // invokeOnCompletion runs immediately and remove(key, job) must find it
        // mapped (else a dead job leaks until the next post for that key).
        imgJobs[sbn.key] = job
        job.invokeOnCompletion { imgJobs.remove(sbn.key, job) }
    }

    /** CHEAP image identity for the dedup stamp (no decode): the MessagingStyle
     *  data URI (Google Messages MMS — the actual case on Adam's Pixel), else a
     *  presence marker for BigPictureStyle. Empty = no image. */
    private fun imageRef(n: android.app.Notification, extras: android.os.Bundle): String {
        try {
            val style = androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)
            val uri = style?.messages?.lastOrNull { it.dataMimeType?.startsWith("image/") == true && it.dataUri != null }?.dataUri
            if (uri != null) return uri.toString()
        } catch (e: Exception) {
            DiagLog.log("notify", "MessagingStyle probe failed: $e")
        }
        return if (extras.containsKey(android.app.Notification.EXTRA_PICTURE) ||
            (Build.VERSION.SDK_INT >= 31 && extras.containsKey(android.app.Notification.EXTRA_PICTURE_ICON))) "pic" else ""
    }

    /** Load the notification's picture as a Bitmap (Adam 2026-06-12, fixed
     *  same-day: Google Messages MMS uses MessagingStyle — the image rides a
     *  message DATA URI in EXTRA_MESSAGES, NOT the EXTRA_PICTURE bitmap, which
     *  is why "it just says Image" with no picture page; the system grants
     *  approved listeners read access to notification content URIs). Order:
     *  MessagingStyle data URI → EXTRA_PICTURE bitmap → EXTRA_PICTURE_ICON. */
    private fun loadPicture(n: android.app.Notification, extras: android.os.Bundle): android.graphics.Bitmap? {
        // 1. MessagingStyle (newest image message wins)
        try {
            val style = androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)
            val msg = style?.messages?.lastOrNull { it.dataMimeType?.startsWith("image/") == true && it.dataUri != null }
            if (msg != null) {
                val bmp = loadBitmapSampled(msg.dataUri!!)
                if (bmp != null) return bmp
                DiagLog.log("notify", "MessagingStyle image uri unreadable (${msg.dataUri}) — trying the bitmap extras")
            }
        } catch (e: Exception) {
            DiagLog.log("notify", "MessagingStyle image load failed: $e")
        }
        // 2. BigPictureStyle bitmap
        try {
            val bmp = if (Build.VERSION.SDK_INT >= 33) {
                extras.getParcelable(android.app.Notification.EXTRA_PICTURE, android.graphics.Bitmap::class.java)
            } else {
                @Suppress("DEPRECATION")
                extras.getParcelable<android.graphics.Bitmap>(android.app.Notification.EXTRA_PICTURE)
            }
            if (bmp != null) return bmp
        } catch (e: Exception) {
            DiagLog.log("notify", "EXTRA_PICTURE read failed: $e")
        }
        // 3. BigPictureStyle Icon variant (API 31+)
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                val icon = extras.getParcelable(android.app.Notification.EXTRA_PICTURE_ICON, android.graphics.drawable.Icon::class.java)
                val d = icon?.loadDrawable(this)
                if (d is android.graphics.drawable.BitmapDrawable) return d.bitmap
            } catch (e: Exception) {
                DiagLog.log("notify", "EXTRA_PICTURE_ICON read failed: $e")
            }
        }
        return null
    }

    /** Content-URI → Bitmap with a bounds pass + inSampleSize (an MMS photo can
     *  be many MB — never decode it full-size on the listener thread). */
    private fun loadBitmapSampled(uri: android.net.Uri): android.graphics.Bitmap? {
        return try {
            val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            // Phase 1: split the unreadable diagnostics so the next failure
            // self-identifies (stream-null vs zero-bounds vs the catch's exception).
            val s = contentResolver.openInputStream(uri)
            if (s == null) { DiagLog.log("notify", "image uri stream NULL — not yet servable: $uri"); return null }
            s.use { android.graphics.BitmapFactory.decodeStream(it, null, bounds) }
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                DiagLog.log("notify", "image uri zero-bounds (${bounds.outWidth}x${bounds.outHeight}) — partial write?: $uri"); return null
            }
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 960) sample *= 2
            val opts = android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }
            contentResolver.openInputStream(uri)?.use {
                android.graphics.BitmapFactory.decodeStream(it, null, opts)
            }
        } catch (e: Exception) {
            DiagLog.log("notify", "image uri decode failed ($uri): $e")
            null
        }
    }

    /** Bitmap → downscaled JPEG base64 (Adam 2026-06-12 — MMS images on
     *  glass; the server renders it through the Files image pipeline).
     *  Best-effort: any failure logs + forwards the notification imageless.
     *  Downscale to ≤480 px (the glasses' content pane), JPEG q70 → q50 if
     *  still over the ~400 KB raw cap (the server hard-rejects ~600 KB). */
    private fun encodeJpegB64(bmp: android.graphics.Bitmap): String? {
        return try {
            val maxDim = 480
            val scale = maxDim.toFloat() / maxOf(bmp.width, bmp.height)
            val scaled = if (scale < 1f) {
                android.graphics.Bitmap.createScaledBitmap(
                    bmp, (bmp.width * scale).toInt().coerceAtLeast(1), (bmp.height * scale).toInt().coerceAtLeast(1), true)
            } else bmp
            var quality = 70
            var bytes: ByteArray
            do {
                val out = java.io.ByteArrayOutputStream()
                scaled.compress(android.graphics.Bitmap.CompressFormat.JPEG, quality, out)
                bytes = out.toByteArray()
                quality -= 20
            } while (bytes.size > 400_000 && quality >= 30)
            if (bytes.size > 400_000) {
                DiagLog.log("notify", "picture still ${bytes.size} B at q$quality — dropped (notification forwards imageless)")
                return null
            }
            DiagLog.log("notify", "picture ${bmp.width}x${bmp.height} → ${scaled.width}x${scaled.height} JPEG ${bytes.size} B")
            android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        } catch (e: Exception) {
            DiagLog.log("notify", "picture encode failed (forwarding imageless): $e")
            null
        }
    }

    /** Phase 4a: the notification's first action carrying a free-form-input
     *  RemoteInput (the inline-reply action). null = not replyable. */
    private fun findReplyAction(n: android.app.Notification): android.app.Notification.Action? {
        val actions = n.actions ?: return null
        return actions.firstOrNull { a -> a.remoteInputs?.any { it.allowFreeFormInput } == true }
    }

    /** Phase 4a: fill the reply action's RemoteInput with `text` + fire its
     *  PendingIntent. Reports the outcome to the server (loud either way). Only
     *  a still-live notification can be replied to. */
    private fun doReply(key: String, text: String) {
        try {
            val sbn = activeNotifications?.firstOrNull { it.key == key }
            if (sbn == null) { ConnectionService.forwardReplyResult(key, false, "notification no longer posted on the phone"); return }
            if (fillAndFire(sbn, text)) {
                ConnectionService.forwardReplyResult(key, true, null)
                DiagLog.log("notify", "inline reply sent for $key (${text.length} chars)")
            } else ConnectionService.forwardReplyResult(key, false, "no inline-reply action on this notification")
        } catch (e: Exception) {
            DiagLog.log("notify", "doReply($key) threw: $e")
            ConnectionService.forwardReplyResult(key, false, "send failed: ${e.message}")
        }
    }

    /** Fill a notification's free-form reply RemoteInput with `text` + fire its
     *  PendingIntent. true on success. Free-form ONLY (a choice-list RemoteInput
     *  would fill the wrong key with arbitrary text). Shared by 4a Notices-reply
     *  and the 4b SMS RemoteInput-when-live path. */
    private fun fillAndFire(sbn: StatusBarNotification, text: String): Boolean {
        val action = findReplyAction(sbn.notification) ?: return false
        val remoteInput = action.remoteInputs?.firstOrNull { it.allowFreeFormInput } ?: return false
        val pi = action.actionIntent ?: return false
        val intent = android.content.Intent()
        val results = android.os.Bundle().apply { putCharSequence(remoteInput.resultKey, text) }
        android.app.RemoteInput.addResultsToIntent(arrayOf(remoteInput), intent, results)
        pi.send(this, 0, intent)
        return true
    }

    /** Phase 4b (Adam 2026-06-18): prefer replying through the DEFAULT SMS app's
     *  LIVE conversation notification (keeps an RCS thread on RCS) over SmsManager
     *  (which downgrades to plain SMS). Matches the default-SMS package + an exact
     *  contact-name title + a free-form RemoteInput, and ONLY on a single
     *  unambiguous match — else false so the caller falls back to SmsManager. The
     *  package restriction means it never mis-routes to another app (WhatsApp etc.). */
    private fun doReplySmsThread(address: String, text: String): Boolean {
        return try {
            val pkg = android.provider.Telephony.Sms.getDefaultSmsPackage(this) ?: return false
            val name = SmsProvider.resolveName(this, address).trim()
            if (name.isEmpty()) return false
            val matches = (activeNotifications ?: emptyArray()).filter { sbn ->
                if (sbn.packageName != pkg) return@filter false
                val title = sbn.notification.extras?.getCharSequence(android.app.Notification.EXTRA_TITLE)?.toString()?.trim() ?: ""
                title.equals(name, ignoreCase = true) && findReplyAction(sbn.notification) != null
            }
            if (matches.size != 1) { DiagLog.log("sms", "RemoteInput: ${matches.size} live $pkg notif(s) match \"$name\" — using SmsManager"); return false }
            val ok = fillAndFire(matches[0], text)
            if (ok) DiagLog.log("sms", "replied to \"$name\" via the live notification (RCS-capable)")
            ok
        } catch (e: Exception) { DiagLog.log("sms", "RemoteInput reply failed → SmsManager: $e"); false }
    }

    companion object {
        private const val SEEN_CAP = 64
        private val seen = LinkedHashMap<String, String>()
        private const val MAPS_PKG = "com.google.android.apps.maps"
        /** Phase 6: the key of the live Maps nav notification (cleared on removal). */
        @Volatile
        private var navKey: String? = null

        /** Phase 4a: server → client — fill + fire a forwarded notification's
         *  inline-reply RemoteInput. Routed to the live listener instance. */
        fun replyByKey(key: String, text: String) {
            val inst = live
            if (inst == null) { ConnectionService.forwardReplyResult(key, false, "no live notification listener — open the app once"); return }
            inst.doReply(key, text)
        }

        /** Phase 4b: try the live-notification RemoteInput for an SMS thread; false
         *  (no live listener / no match) → the caller uses SmsManager. */
        fun replyToSmsThread(address: String, text: String): Boolean = live?.doReplySmsThread(address, text) ?: false

        /** Liveness: set in onListenerConnected, cleared on disconnect. */
        @Volatile
        var connected: Boolean = false
            private set

        /** The bound listener instance (for cancelByKey — dismiss sync). */
        @Volatile
        private var live: NotifyListener? = null

        /** Dismiss a notification on the PHONE by key (server → client, read on
         *  glass / MkAll). A key we no longer hold is a harmless no-op. */
        fun cancelByKey(key: String) {
            try {
                live?.cancelNotification(key)
                    ?: DiagLog.log("notify", "cancelByKey($key) — no live listener")
            } catch (e: Exception) {
                DiagLog.log("notify", "cancelNotification($key) failed: $e")
            }
        }

        private fun componentName(ctx: Context) = ComponentName(ctx, NotifyListener::class.java)

        fun isAccessGranted(ctx: Context): Boolean = try {
            ctx.getSystemService(NotificationManager::class.java)
                ?.isNotificationListenerAccessGranted(componentName(ctx)) == true
        } catch (e: Exception) {
            DiagLog.log("notify", "isAccessGranted check failed: $e")
            false
        }

        /** The one-time Settings grant deep link (HarnessActivity row). API 30+
         *  opens our app's own detail screen; 29 falls back to the list. */
        fun settingsIntent(ctx: Context): Intent =
            if (Build.VERSION.SDK_INT >= 30) {
                Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                    .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, componentName(ctx).flattenToString())
            } else {
                @Suppress("DEPRECATION")
                Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
            }

        /** Zombie-listener recovery (HarnessActivity.onStart): granted but not
         *  connected → requestRebind; still dead after 10 s → the component
         *  toggle kick (forces NotificationManagerService to rebuild the
         *  service record; does NOT revoke the grant) + rebind again. */
        fun kickIfZombie(ctx: Context) {
            if (connected || !isAccessGranted(ctx)) return
            val app = ctx.applicationContext
            DiagLog.log("notify", "granted but not connected — requestRebind")
            try {
                requestRebind(componentName(app))
            } catch (e: Exception) {
                DiagLog.log("notify", "requestRebind failed: $e")
            }
            Handler(Looper.getMainLooper()).postDelayed({
                if (connected || !isAccessGranted(app)) return@postDelayed
                DiagLog.log("notify", "still dead after rebind — component-toggle kick")
                try {
                    val cn = componentName(app)
                    app.packageManager.setComponentEnabledSetting(
                        cn, PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
                    app.packageManager.setComponentEnabledSetting(
                        cn, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
                    requestRebind(cn)
                } catch (e: Exception) {
                    DiagLog.log("notify", "component-toggle kick failed: $e")
                }
            }, 10_000)
        }
    }
}
