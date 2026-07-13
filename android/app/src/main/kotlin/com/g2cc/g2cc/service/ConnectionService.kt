package com.g2cc.g2cc.service

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothDevice
import android.content.Context
import android.telephony.SmsManager
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.g2cc.g2cc.BuildConfig
import com.g2cc.g2cc.G2CCApp
import com.g2cc.g2cc.R
import com.g2cc.g2cc.audio.AudioStreamer
import com.g2cc.g2cc.audio.MicCapture
import com.g2cc.g2cc.ble.BleScanner
import com.g2cc.g2cc.ble.ConnectionState
import com.g2cc.g2cc.ble.EvenHub
import com.g2cc.g2cc.ble.EventParser
import com.g2cc.g2cc.ble.G2BleClient
import com.g2cc.g2cc.ble.G2Constants
import com.g2cc.g2cc.ble.G2Frame
import com.g2cc.g2cc.ble.Side
import com.g2cc.g2cc.ble.Varint
import com.g2cc.g2cc.harness.DiagLog
import com.g2cc.g2cc.harness.DisplayTestSequence
import com.g2cc.g2cc.harness.HarnessActivity
import com.g2cc.g2cc.harness.TestHarness
import com.g2cc.g2cc.net.ClientMessage
import com.g2cc.g2cc.net.ConnectionManager
import com.g2cc.g2cc.net.MediaInfo
import com.g2cc.g2cc.net.ServerMessage
import com.g2cc.g2cc.net.SmsMessage
import com.g2cc.g2cc.net.SmsThread
import com.g2cc.g2cc.net.WireScene
import com.g2cc.g2cc.os.OsLayout
import com.g2cc.g2cc.os.SceneCodec
import com.g2cc.g2cc.render.BleDisplaySink
import com.g2cc.g2cc.render.Display
import com.g2cc.g2cc.render.DisplayProto
import com.g2cc.g2cc.render.G2Renderer
import com.g2cc.g2cc.render.Scene
import com.g2cc.g2cc.render.scene
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.OkHttpClient
import kotlin.coroutines.resume

/**
 * Foreground service that OWNS the G2 connection loop — the all-day backbone.
 *
 * Why this exists (recovery fix, 2026-06-06): the loop used to live in
 * [HarnessActivity.lifecycleScope]. When the harness wasn't the foreground app
 * (phone pocketed, screen off, or Adam in the SSH/terminal app) Android froze
 * the process / restricted background BLE, so the keepalive, watchdog AND
 * auto-recovery all stopped — the glasses reclaimed the Hub slot and nothing
 * noticed or recovered until the Activity came back. Moving the loop into a
 * [FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE] service keeps the process alive and
 * BLE permitted in the background.
 *
 * The wake lock is NOT optional: per the parked G2CCService's hard-won note, an
 * FG service stops process-kill but NOT Doze CPU-throttling — Adam's factory
 * diag showed coroutine `delay()` ticks gapping 13-28 s on a 10 s cadence, which
 * blew past the firmware session timeout. A PARTIAL_WAKE_LOCK makes `delay()`
 * fire on schedule.
 *
 * The loop here is a behavior-preserving REHOME of the proven HarnessActivity
 * loop (cold-launch + keepalive + 80-00 sync + watchdog + ~80 s renewal + clock
 * + the conflated render pump + server-mode WS + auto-recovery). UI lives in
 * [HarnessActivity], which binds and observes the [StateFlow]s below. Recovery
 * hardening (direct reconnect, re-launch-on-reconnect, faster detection) is a
 * separate pass tracked apart from this move.
 *
 * Hard rules: NO timeouts on BLE/WS/render I/O (the delays are pacing); NO
 * silent failures (everything surfaces to DiagLog / the status flow); NO
 * truncation. msgId stays a single byte (the renderer + [nextSyncTrigger] both
 * wrap at 0xFF).
 */
class ConnectionService : Service(), TestHarness {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var wakeLock: PowerManager.WakeLock? = null

    private var scanner: BleScanner? = null
    private var left: G2BleClient? = null
    private var right: G2BleClient? = null
    private var renderer: G2Renderer? = null
    private val stateJobs = mutableListOf<Job>()
    private var keepaliveJob: Job? = null
    private var clockJob: Job? = null
    private var renderConsumerJob: Job? = null       // single serialized consumer of server-pushed scenes
    private var sceneCh: Channel<WireScene>? = null   // CONFLATED → latest scene wins (no scroll-render pileup/interleave)
    private var mirrorClockJob: Job? = null           // BLE-less mirror clock tick (control mode — renderer == null)
    private var lastWire: WireScene? = null           // last good server scene, re-decoded by the mirror clock (main scope only)
    private var syncJob: Job? = null          // 80-00 sync_trigger keepalive (both lenses)
    private var watchdogJob: Job? = null      // glasses-response gap watchdog (silent-drop detector)
    private var renewalJob: Job? = null       // periodic re-takeover (the ~120s app-slot lifetime)
    private var coldLaunchJob: Job? = null    // the cold-launch coroutine — tracked so teardown cancels it
    private var testJob: Job? = null          // the Test Display sequence coroutine — tracked for teardown (parked: no UI producer since v1.7)
    private var sessionGen = 0                // bumped on teardown; a stale coroutine re-checks it before mutating
    private var recovering = false            // auto-recovery in progress (guard against re-trigger)
    // v1.7: `wasServerMode` is GONE — server mode is now unconditionally the
    // post-cold-launch state (Adam 2026-06-11: Connect = straight into the DE),
    // so recovery doesn't need to remember whether to re-enter it.
    @Volatile private var lastRecoverMs = 0L  // rate-limit auto-recoveries (no thrashing)
    /** Latest glasses battery % from a 09-00/09-01 device-info frame (Adam
     *  2026-06-12; null until one arrives). [U] on-glass pending. */
    @Volatile private var g2Battery: Int? = null
    private var batteryPollJob: Job? = null
    @Volatile private var lastNotifyMs = 0L   // last notify (incl e0-00 ack) from R lens
    private var syncSeq = 0x10
    private var syncMsgId = 0x20
    @Volatile private var connection: ConnectionManager? = null   // read off the NLS ioScope (C1) — publish writes
    private var audioStreamer: AudioStreamer? = null      // server-driven dictation (audio_request)
    // Did startForeground succeed WITH the microphone FGS type? When the mic-typed start
    // is denied (background START_STICKY restart on Android 12+/14) we fall back to
    // connectedDevice-only — and Android 14+ then feeds AudioRecord SILENCE instead of
    // throwing. Gate audio_request on this so the server gets a loud refusal, not a
    // well-formed stream of zeros that STT "transcribes" to nothing.
    @Volatile private var micFgsGranted = false
    private var lastLeftDevice: BluetoothDevice? = null   // cached so recovery can reconnect directly (no rescan)
    private var lastRightDevice: BluetoothDevice? = null
    @Volatile private var tearingDown = false             // suppress auto-recovery during intentional teardown
    private var needsRelaunch = false                     // a lens dropped while launched → re-launch Hub on return

    // Latest HH:MM:SS — ticked into the app-owned clock region every second and
    // reused whenever a server scene is (re)built so the clock is never blank.
    private var latestClockText = OsLayout.clockText()
    private fun nowClock(): String { latestClockText = OsLayout.clockText(); return latestClockText }

    // ---- observable state for the bound UI (HarnessActivity) -----------------
    private val _status = MutableStateFlow("Disconnected")
    val status = _status.asStateFlow()
    /** Server `error` messages for the CONTROL UI (re-review R2: the typed-text
     *  delivery discard used to die in the Diag log while ControlActivity had
     *  already cleared the input field — silent data loss from the typist's
     *  chair). Buffered so a burst can't suspend the WS reader. */
    private val _serverErrors = MutableSharedFlow<String>(extraBufferCapacity = 8, onBufferOverflow = kotlinx.coroutines.channels.BufferOverflow.DROP_OLDEST)
    val serverErrors = _serverErrors.asSharedFlow()
    private val _launched = MutableStateFlow(false)
    val launched = _launched.asStateFlow()
    private val _connecting = MutableStateFlow(false)
    val connecting = _connecting.asStateFlow()
    private val _serverMode = MutableStateFlow(false)
    val serverMode = _serverMode.asStateFlow()
    // Control mode (multi-surface 2026-07-13): the phone screen is a display+input
    // surface of its own — the WS may run with NO glasses/BLE at all. Persisted in
    // SharedPreferences so the START_STICKY relaunch re-enters it; cleared only by
    // a manual disconnect().
    private val _controlMode = MutableStateFlow(false)
    val controlMode = _controlMode.asStateFlow()
    private val _testing = MutableStateFlow(false)
    val testing = _testing.asStateFlow()
    private val _scene = MutableStateFlow<Scene?>(null)
    val sceneFlow = _scene.asStateFlow()   // NOT `scene` — that name is the render-package scene{} builder

    private val binder = LocalBinder()
    inner class LocalBinder : Binder() {
        val service: ConnectionService get() = this@ConnectionService
    }

    // ----------------------------------------------------------------- lifecycle

    override fun onCreate() {
        super.onCreate()
        running = true
        instance = this
        DiagLog.start(scope)
        startInForeground()
        acquireWakeLock()
        // BT-adapter watcher (review 2026-06-11b): a BT toggle / stack restart
        // mid-session used to dead-end PERMANENTLY — Nordic fail-fasts the
        // reconnect while the adapter is off, the Error branch stranded
        // `_connecting`, and nothing listened for the adapter coming back
        // (the old BluetoothStateReceiver was wired only to the parked
        // G2CCService). "Phone Bluetooth toggled" is a required recovery
        // scenario (project CLAUDE.md).
        val filter = android.content.IntentFilter(android.bluetooth.BluetoothAdapter.ACTION_STATE_CHANGED)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(btStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(btStateReceiver, filter)
        }
        DiagLog.log("svc", "ConnectionService onCreate — server ${BuildConfig.SERVER_HOST}:${BuildConfig.SERVER_PORT}, token=${if (BuildConfig.AUTH_TOKEN.isEmpty()) "MISSING" else "set"}")
    }

    /** Adapter ON while we're idle (not launched, not connecting, not mid-
     *  recovery) → reconnect: direct to the cached lenses, else a fresh scan.
     *  A dead-while-launched link is the watchdog's job (silent-drop recovery
     *  fires within ~9 s of the acks stopping). */
    private val btStateReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) {
            if (i?.action != android.bluetooth.BluetoothAdapter.ACTION_STATE_CHANGED) return
            val st = i.getIntExtra(android.bluetooth.BluetoothAdapter.EXTRA_STATE, -1)
            DiagLog.log("conn", "bluetooth adapter state → $st")
            if (st == android.bluetooth.BluetoothAdapter.STATE_OFF &&
                !_launched.value && _connecting.value && left == null
            ) {
                // Adapter died during the pure SCAN phase (review 2026-07-05):
                // no lens client exists yet, so no Error callback will ever
                // release `_connecting` — it strands true and the STATE_ON
                // auto-recovery below gates itself off FOREVER (the "scanning
                // forever" class). Kill the scan + release the flag so the
                // ON edge re-runs a fresh scan. Mirrors the lens-client
                // Error-branch release; no timeout involved.
                DiagLog.log("recover", "bluetooth OFF mid-scan — releasing _connecting so the ON edge can rescan")
                scanner?.stop(); scanner = null
                _connecting.value = false
            }
            if (st == android.bluetooth.BluetoothAdapter.STATE_ON &&
                !_launched.value && !_connecting.value && !recovering
            ) {
                DiagLog.log("recover", "bluetooth back ON while idle — reconnecting")
                reconnect()
            }
        }
    }

    /** Phone battery % via BatteryManager (Phase 9). Null on any failure —
     *  the hb field is optional and a missing read must never break the hb. */
    private fun readBatteryPct(): Int? = try {
        val bm = getSystemService(android.os.BatteryManager::class.java)
        val pct = bm?.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
        if (pct != null && pct in 0..100) pct else null
    } catch (e: Exception) {
        DiagLog.log("svc", "battery read failed: $e")
        null
    }

    // Control-mode persistence (multi-surface 2026-07-13): the START_STICKY
    // null-intent relaunch must re-enter control mode after a system kill —
    // in-memory state doesn't survive the process.
    private fun controlPrefs() = getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
    private fun readControlModePref(): Boolean = controlPrefs().getBoolean(KEY_CONTROL_MODE, false)
    private fun writeControlModePref(v: Boolean) { controlPrefs().edit().putBoolean(KEY_CONTROL_MODE, v).apply() }
    /** Was the BLE bridge active? (review 2026-07-13 F9: the sticky/boot
     *  relaunch used to hunt BLE unconditionally — a battery-draining forever-
     *  scan when the service was running in pure glasses-less control mode.)
     *  Default TRUE: pre-pref installs behave exactly like today (bridge daily
     *  = auto-reconnect); a manual disconnect() clears both prefs. */
    private fun readBridgingPref(): Boolean = controlPrefs().getBoolean(KEY_BRIDGING, true)
    private fun writeBridgingPref(v: Boolean) { controlPrefs().edit().putBoolean(KEY_BRIDGING, v).apply() }

    /** Phase 9: forward a phone notification (from [com.g2cc.g2cc.service.NotifyListener])
     *  to the server. Loud no-op when the WS isn't up — missed phone
     *  notifications stay on the phone; the server only mirrors live ones. */
    fun sendNotify(pkg: String, title: String, text: String, postedAt: Long, key: String, imageB64: String? = null, hasReply: Boolean = false) {
        val conn = connection
        if (conn == null) {
            DiagLog.log("notify", "dropped $pkg \"$title\" — no WS connection")
            return
        }
        val sent = conn.send(ClientMessage.Notify(pkg = pkg, title = title, text = text, postedAt = postedAt, key = key, imageB64 = imageB64, hasReply = if (hasReply) true else null))
        DiagLog.log("notify", "$pkg \"$title\"${if (imageB64 != null) " +img(${imageB64.length})" else ""}${if (hasReply) " +reply" else ""} → ${if (sent) "sent" else "DROPPED (ws not ready)"}")
    }

    /** Dismiss sync (Adam 2026-06-13): the phone dismissed a forwarded
     *  notification → tell the server to mark the glasses copy seen. */
    fun sendNotificationDismissed(key: String) {
        val sent = connection?.send(ClientMessage.NotificationDismissed(key)) ?: false
        DiagLog.log("notify", "phone dismissed $key → ${if (sent) "told server" else "no WS (server re-syncs on reconnect)"}")
    }

    /** Phase 4a: report an inline-reply outcome to the server (loud either way). */
    fun sendNotificationReplyResult(key: String, ok: Boolean, error: String?) {
        connection?.send(ClientMessage.NotificationReplyResult(key, ok, error))
        DiagLog.log("notify", "reply result $key ok=$ok${if (error != null) " err=$error" else ""}")
    }

    /** Phase 7: push a now-playing snapshot. */
    fun sendMediaState(info: MediaInfo) { connection?.send(ClientMessage.MediaState(info)) }

    /** Phase 6: forward / clear the Maps nav line. */
    fun sendNavUpdate(text: String, eta: String?) { connection?.send(ClientMessage.NavUpdate(text, eta)) }
    fun sendNavClear() { connection?.send(ClientMessage.NavClear) }

    /** Phase 4b: answer an SMS thread-list / single-thread query. */
    fun sendSmsThreadsReply(threads: List<SmsThread>, offset: Int, total: Int, error: String?) {
        connection?.send(ClientMessage.SmsThreadsReply(threads, offset, total, error))
        DiagLog.log("sms", "threads reply: ${threads.size} of $total${if (error != null) " err=$error" else ""}")
    }
    fun sendSmsThreadReply(threadId: String, name: String, address: String, messages: List<SmsMessage>, page: Int, totalPages: Int, error: String?) {
        connection?.send(ClientMessage.SmsThreadReply(threadId, name, address, messages, page, totalPages, error))
        DiagLog.log("sms", "thread $threadId reply: ${messages.size} msgs${if (error != null) " err=$error" else ""}")
    }

    /** D6: report the real (sentIntent-backed) SMS send outcome to the server —
     *  it updates the result card in place. Never fabricated: only fired when
     *  the platform actually reported per-part results (or the send threw). */
    private fun sendSmsSendResult(address: String, ok: Boolean, error: String?) {
        connection?.send(ClientMessage.SmsSendResult(address, ok, error))
        DiagLog.log("sms", "send result → server: $address ok=$ok${if (error != null) " err=$error" else ""}")
    }

    private val smsSendSeq = java.util.concurrent.atomic.AtomicInteger(0)

    private fun smsResultName(rc: Int?): String = when (rc) {
        android.app.Activity.RESULT_OK -> "OK"
        SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "GENERIC_FAILURE"
        SmsManager.RESULT_ERROR_RADIO_OFF -> "RADIO_OFF"
        SmsManager.RESULT_ERROR_NULL_PDU -> "NULL_PDU"
        SmsManager.RESULT_ERROR_NO_SERVICE -> "NO_SERVICE"
        SmsManager.RESULT_ERROR_LIMIT_EXCEEDED -> "LIMIT_EXCEEDED"
        null -> "NO_RESULT"
        else -> "code=$rc"
    }

    /** Phase 4b: send an SMS via SmsManager (needs SEND_SMS). Loud diag; the sent
     *  message shows on the next thread refresh (the provider records it).
     *  D6 (queue 2026-07-05): SmsManager sends register one sentIntent per part
     *  and report ONE aggregated sms_send_result (ok = every part RESULT_OK).
     *  The RemoteInput/RCS path has no per-message result — no report there,
     *  and the server's 'unverified' card is the honest terminal state. If the
     *  OS never delivers a result, nothing is sent (no timeout — same). */
    private fun sendSms(address: String, text: String) {
        // Prefer the live conversation notification's RemoteInput (keeps RCS as RCS;
        // Adam 2026-06-18). Falls through to SmsManager when there's no live match.
        if (NotifyListener.replyToSmsThread(address, text)) return
        try {
            val sm = if (Build.VERSION.SDK_INT >= 31) getSystemService(SmsManager::class.java)
                     else @Suppress("DEPRECATION") SmsManager.getDefault()
            if (sm == null) {
                DiagLog.log("sms", "no SmsManager — send to $address dropped")
                sendSmsSendResult(address, false, "no SmsManager on this device")
                return
            }
            val parts = sm.divideMessage(text)
            val n = parts.size
            // Unique action per send — concurrent sends can't cross-deliver.
            val action = "com.g2cc.g2cc.SMS_SENT_${smsSendSeq.incrementAndGet()}"
            val receiver = object : android.content.BroadcastReceiver() {
                private val outcomes = arrayOfNulls<Int>(n)
                private var received = 0
                override fun onReceive(context: Context?, intent: Intent?) {
                    val part = intent?.getIntExtra("part", -1) ?: -1
                    val done = synchronized(this) {
                        if (part in 0 until n && outcomes[part] == null) {
                            outcomes[part] = resultCode
                            received++
                        }
                        received >= n
                    }
                    if (!done) return
                    try { unregisterReceiver(this) } catch (e: Exception) { DiagLog.log("sms", "sentIntent receiver unregister: $e") }
                    val bad = outcomes.withIndex().filter { it.value != android.app.Activity.RESULT_OK }
                    val ok = bad.isEmpty()
                    val error = if (ok) null
                                else "part${if (bad.size > 1) "s" else ""} ${bad.joinToString { "${it.index + 1}/${n}:${smsResultName(it.value)}" }}"
                    sendSmsSendResult(address, ok, error)
                }
            }
            // PhoneLocator's registration convention (RECEIVER_NOT_EXPORTED on 33+).
            val filter = android.content.IntentFilter(action)
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            else registerReceiver(receiver, filter)
            val sentIntents = ArrayList<PendingIntent>(n)
            for (i in 0 until n) {
                sentIntents.add(PendingIntent.getBroadcast(
                    this, i,
                    Intent(action).putExtra("part", i).setPackage(packageName),
                    PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE))
            }
            if (n > 1) sm.sendMultipartTextMessage(address, null, parts, sentIntents, null)
            else sm.sendTextMessage(address, null, text, sentIntents[0], null)
            DiagLog.log("sms", "sent to $address (${text.length} chars, $n part(s)) — awaiting sentIntent result${if (n > 1) "s" else ""}")
        } catch (e: SecurityException) {
            DiagLog.log("sms", "send DENIED (SEND_SMS not granted): $e")
            sendSmsSendResult(address, false, "SEND_SMS not granted")
        } catch (e: Exception) {
            DiagLog.log("sms", "send to $address FAILED: $e")
            sendSmsSendResult(address, false, e.toString())
        }
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // A mic-FGS type denied at a background service start is re-grantable once
        // the app is foregrounded. NOTE (review 2026-06-11b): onStartCommand ALSO
        // fires for the START_STICKY null-intent relaunch and the boot receiver —
        // both background, where this retry just fails again into the same
        // connectedDevice-only fallback (harmless; the log explains itself). The
        // retry that actually succeeds is the one from the Activity's
        // startForegroundService (user present; review 2026-06-11).
        if (!micFgsGranted) {
            DiagLog.log("svc", "retrying mic-FGS startForeground (was denied earlier; succeeds only when started from the foreground)")
            startInForeground()
        }
        // Connect is driven via an action so it doesn't depend on the bind round-trip
        // (the Activity startForegroundService()s us, then binds only to observe).
        // intent == null IS the START_STICKY relaunch after a system kill — the whole
        // point of sticky + the battery-opt exemption is to come back CONNECTED, but the
        // old guard only connected on ACTION_CONNECT, so the relaunched service idled in
        // foreground doing nothing until Adam opened the app (review 2026-06-11).
        when {
            // Control mode (multi-surface): phone-screen surface, NO BLE connect —
            // this path must work with the glasses absent entirely.
            intent?.action == ACTION_CONTROL -> enterControlMode()
            // Sticky relaunch AND boot/update resume share the same dual-pref
            // re-entry (review 2026-07-13 F9): re-enter exactly the mode(s)
            // that were active — pure control mode must NOT start a BLE hunt
            // for glasses that are at home in the case.
            intent == null || intent.action == ACTION_RESUME -> {
                val ctl = readControlModePref()
                val bridge = readBridgingPref()
                DiagLog.log("svc", "resume relaunch: control=$ctl bridge=$bridge")
                if (ctl) enterControlMode()
                if (bridge) connect()
                if (!ctl && !bridge) DiagLog.log("svc", "resume with neither mode persisted — idling in foreground (open the app to connect)")
            }
            intent.action == ACTION_CONNECT -> connect()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        instance = null
        try { unregisterReceiver(btStateReceiver) } catch (e: Exception) {
            DiagLog.log("svc", "btStateReceiver unregister failed: $e")
        }
        teardown()
        releaseWakeLock()
        DiagLog.stop()
        scope.cancel()
        super.onDestroy()
    }

    // ----------------------------------------------------------------- commands (binder)

    fun connect() {
        if (_launched.value || _connecting.value) return
        writeBridgingPref(true)   // F9: the sticky/boot resume re-enters BLE only when it was active
        _connecting.value = true
        setStatus("Scanning for Even G2…")
        DiagLog.log("conn", "scan start")
        val sc = BleScanner(this)
        scanner = sc
        // BleScanner.start surfaces Event.Failure (incl. missing permissions) — the
        // Activity requests permissions + battery-opt before calling connect().
        sc.start { ev -> scope.launch { onScanResult(ev) } }
    }

    fun disconnect() {
        DiagLog.log("conn", "disconnect requested (MANUAL)")
        // Manual disconnect exits control mode too (and its sticky-restart pref) —
        // "Disconnect" means ALL the way down, not "…but come back as control".
        _controlMode.value = false
        writeControlModePref(false)
        writeBridgingPref(false)   // F9: nor "…but come back scanning"
        teardown()
        setStatus("Disconnected.")
        _scene.value = null
        stopForegroundAndSelf()
    }

    // PARKED, NO UI PRODUCER since v1.7 (the harness Test button died with the
    // straight-into-DE change — Adam 2026-06-11). Kept wired for bench
    // debugging via the binder; DisplayTestSequence stays in-tree.
    fun runTest() {
        if (!_launched.value || _testing.value) return
        _testing.value = true
        testJob = scope.launch {
            DiagLog.log("test", "═══ Test Display sequence START ═══")
            try {
                DisplayTestSequence.run(this@ConnectionService)
                if (_launched.value) setStatus("Tests complete. Tap Test Display to repeat.")
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e   // never swallow structured-concurrency cancellation
            } catch (e: Exception) {
                DiagLog.log("test", "sequence error: $e")
                setStatus("Test error: ${e.message}")
            }
            DiagLog.log("test", "═══ Test Display sequence END ═══")
            _testing.value = false
        }
    }

    /** Glasses-OS Slice 1: open a WS to the PC and let the server drive the display.
     *  BLE must already be up (we reuse the cold-launched session, keepalive + clock).
     *  On connect → os_attach; on `render` → setScene; ring events → `input`.
     *  Multi-surface (2026-07-13): the guard is unchanged (the BLE path stays
     *  byte-identical); the body moved to [startServerWs] so control mode can
     *  start the WS with NO glasses. */
    fun enterServerMode() {
        if (!_launched.value || _serverMode.value) return
        startServerWs()
    }

    /** Control mode (multi-surface 2026-07-13): the phone SCREEN becomes a
     *  display+input surface — landscape mirror + touch + keyboard — with the
     *  glasses optional. Persisted so the sticky relaunch re-enters it; a later
     *  BLE cold-launch joins the SAME WS (see [maybeColdLaunch]'s re-attach). */
    fun enterControlMode() {
        _controlMode.value = true
        writeControlModePref(true)
        if (_serverMode.value) {
            DiagLog.log("os", "control mode ON — WS already live (server mode); reusing it")
            return
        }
        DiagLog.log("os", "control mode ON — starting the server WS (no BLE required)")
        startServerWs()
    }

    /** The WS + render-pump half of server mode, callable WITHOUT glasses
     *  (control mode). Everything below is the historical enterServerMode()
     *  body except: the pump decodes BEFORE the renderer check (so a
     *  renderer-less phone still mirrors), the mirror clock job, and
     *  os_attach carrying `surface:"phone"`. */
    private fun startServerWs() {
        _serverMode.value = true
        // Single serialized render pump: server scenes go through a CONFLATED channel and ONE
        // consumer renders them one at a time. Without this, rapid scrolls each spawned their own
        // setScene coroutine and the concurrent BLE writes INTERLEAVED — corrupting a tile
        // mid-update. Conflation also drops stale intermediate scrolls so nav stays responsive.
        //
        // PREEMPTION (Adam 2026-06-10): while a scene render is in flight (a 4-tile push can
        // take ~4 s ack-gated), a NEWER scene arriving — a menu tap's response — preempts it:
        // the renderer stops at the next region boundary (skipped regions re-send via the
        // next diff) and the newer scene renders immediately instead of queueing behind tiles.
        val ch = Channel<WireScene>(Channel.CONFLATED)
        sceneCh = ch
        renderConsumerJob = scope.launch {
            var next: WireScene? = null
            while (isActive) {
                // Drain anything newer that landed while we were preempting — `next` may
                // already be stale and rendering it first burns a full region of BLE time
                // on a scene known to be superseded (review 2026-06-11).
                next = ch.tryReceive().getOrNull() ?: next
                val wire = next ?: ch.receiveCatching().getOrNull() ?: break
                next = null
                // Decode FIRST (multi-surface 2026-07-13) so a renderer-less phone
                // (control mode / mid-soft-reset) still mirrors; the loud-fail is
                // unchanged and the renderer path below stays order-identical.
                val sceneObj = try {
                    SceneCodec.toScene(wire, latestClockText)
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // LOUD AND PROUD — a bad scene from the server is surfaced, not dropped.
                    // Exception (not just IAE): a corrupt payload's ArrayIndexOutOfBounds
                    // must not kill the whole bridge process (review 2026-06-11).
                    DiagLog.log("os", "BAD render scene: ${e::class.simpleName}: ${e.message}")
                    setStatus("Bad scene from server: ${e.message}")
                    continue
                }
                lastWire = wire   // good scene — the mirror clock re-decodes this on minute ticks
                val r = renderer
                if (r == null) {
                    // BLE-less: no glasses to drive — the decoded scene IS the display
                    // (ControlActivity's mirror renders it). Was `continue`-and-drop.
                    _scene.value = sceneObj
                    continue
                }
                DiagLog.log("os", "render → setScene (${sceneObj.regions.size} regions: ${sceneObj.regions.joinToString { it.name }})")
                val done = CompletableDeferred<Boolean>()
                r.setScene(sceneObj) { ok -> done.complete(ok) }
                // Wait for completion — but a newer scene preempts the in-flight push.
                while (!done.isCompleted) {
                    select<Unit> {
                        done.onAwait { /* finished (or preempted/failed) */ }
                        ch.onReceiveCatching { res ->
                            val newer = res.getOrNull() ?: return@onReceiveCatching
                            next = newer            // conflated: the latest scene wins
                            DiagLog.log("os", "newer scene while rendering — preempting the in-flight push")
                            r.preempt()
                        }
                    }
                }
                _scene.value = r.currentScene
                DiagLog.log("os", "render result=${if (done.await()) "OK" else "PREEMPTED/FAIL"}")
            }
        }
        // BLE-less mirror clock (multi-surface 2026-07-13): with a renderer, startClock()
        // owns the on-glass clock and refreshes `_scene` after each confirmed write; with
        // NO renderer nothing would tick the control-mode mirror's clock. This 1 s pacer
        // (same Main.immediate scope as the pump → no `_scene`/`lastWire` races) re-decodes
        // the last good wire scene with fresh clock text when the minute string changes.
        // It also keeps `latestClockText` ≤1 s fresh for the pump's own decodes — in pure
        // control mode nothing else calls nowClock(). Lives/dies with the WS (full
        // teardown), NOT with the BLE session (keepWs teardown keeps it).
        mirrorClockJob = scope.launch {
            var lastShown: String? = null
            while (isActive) {
                delay(1000)
                val t = nowClock()
                if (renderer != null) { lastShown = null; continue }   // BLE clock owns the display
                val wire = lastWire ?: continue
                if (t == lastShown) continue
                val sceneObj = try {
                    SceneCodec.toScene(wire, t)
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // The wire decoded fine when it arrived; a failure here is real news.
                    DiagLog.log("os", "mirror clock re-decode FAILED: ${e::class.simpleName}: ${e.message} — keeping the old frame")
                    continue
                }
                lastShown = t
                _scene.value = sceneObj
            }
        }
        val url = "ws://${BuildConfig.SERVER_HOST}:${BuildConfig.SERVER_PORT}/ws"
        DiagLog.log("os", "server mode → connecting $url")
        setStatus("Server mode: connecting to PC…")
        val cm = ConnectionManager(
            initialEndpoints = listOf(url),
            authToken = BuildConfig.AUTH_TOKEN,
            httpClient = OkHttpClient(),
            batteryPct = { readBatteryPct() },   // Phase 9: battery rides client_hb
            g2BatteryPct = { g2Battery },        // Adam 2026-06-12: glasses battery [U]
            // Multi-surface: report whether the glasses are BLE-live. R lens Ready is
            // THE display-path signal — the renderer writes through the R lens only,
            // and maybeColdLaunch gates on the same ConnectionState.Ready.
            g2Connected = { right?.state?.value is ConnectionState.Ready },
            onMessage = { msg -> scope.launch { onServerMessage(msg) } },
            onConnected = {
                DiagLog.log("os", "WS authed → sending os_attach (surface=phone)")
                connection?.send(ClientMessage.OsAttach(surface = "phone"))
                scope.launch { setStatus("Server mode: PC connected. Use the ring.") }
            },
            onDisconnected = {
                DiagLog.log("os", "WS disconnected")
                // Marshal to the main scope like onMessage (review 2026-06-11b):
                // this callback runs on the OkHttp socket thread, and mutating
                // `audioStreamer` there raced the main-thread assignment in
                // audio_request — a delayed disconnect could null/stop a NEW
                // streamer created after reconnect.
                scope.launch {
                    // The mic must die with the WS (review 2026-06-11): the server that knew
                    // about this dictation is gone — after re-auth the NEW connection/WM has
                    // no dictation in flight, so no audio_request stop will ever come, and
                    // the streamer would pump dead frames (and block future dictations) for
                    // hours. stop() is an idempotent no-op when not streaming.
                    audioStreamer?.stop()
                    audioStreamer = null
                }
            },
        )
        connection = cm
        cm.connect()
    }

    // ------------------------------------------------- control mode (binder commands)

    /** Control-mode input (touch on the phone mirror). Returns false + loud log
     *  when there's no live WS — the Activity paints a red status line. */
    fun sendControlInput(input: ClientMessage.Input): Boolean {
        val conn = connection
        if (conn == null) {
            DiagLog.log("os", "control input '${input.event}' DROPPED — no WS connection (control/server mode not active?)")
            return false
        }
        val sent = conn.send(input)
        if (!sent) DiagLog.log("os", "control input '${input.event}' DROPPED — WS not ready (reconnecting)")
        return sent
    }

    /** A whole typed line from the control keyboard → `input{event:'text'}`.
     *  Sent WHOLE, never truncated (the no-truncation rule) — only the length
     *  is logged. False = not delivered (caller keeps the text + goes red). */
    fun sendTextInput(text: String): Boolean {
        val ok = sendControlInput(ClientMessage.Input(event = "text", text = text))
        DiagLog.log("os", "typed text (${text.length} chars) → ${if (ok) "sent" else "NOT sent"}")
        return ok
    }

    /** Soft Reset (Workstream 5) — refresh the GLASSES connection, KEEPING the
     *  WebSocket: the recoverSession-style BLE recovery with keepWs=true.
     *  Reconnect → cold-launch → [maybeColdLaunch]'s re-attach repaints the new
     *  renderer from the server. Works with no prior BLE session too (just
     *  starts a connect). Also invoked by the server's `glasses_reset`. */
    fun softReset() {
        if (recovering) {
            DiagLog.log("recover", "soft reset ignored — a recovery is already in progress")
            setStatus("Soft reset ignored — recovery already in progress.")
            return
        }
        if (left == null && right == null && !_launched.value) {
            // Glasses were never connected this run — nothing to tear down.
            if (_connecting.value) {
                DiagLog.log("recover", "soft reset: a scan is already hunting for the glasses — letting it run")
                setStatus("Soft reset: already scanning for glasses…")
                return
            }
            DiagLog.log("recover", "SOFT RESET with no BLE session — starting a fresh connect")
            setStatus("Soft reset: connecting to glasses…")
            reconnect()   // direct to cached lenses if we have them, else a fresh scan
            return
        }
        recovering = true
        needsRelaunch = false
        lastRecoverMs = System.currentTimeMillis()
        DiagLog.log("recover", "SOFT RESET — BLE-only teardown + reconnect + cold-launch (WS kept)")
        setStatus("Soft reset: refreshing the glasses connection…")
        teardown(keepWs = true)
        reconnect()   // status narration continues via startClients/maybeColdLaunch
    }

    /** Hard Reset (Workstream 5) — ask the SERVER to clean-slate the entire
     *  system; it broadcasts `hard_reset` back to every surface (including us —
     *  [hardResetLocal] runs from that broadcast). If the WS is down the server
     *  can't orchestrate: do the LOCAL half only, loudly labelled as such —
     *  the reconnect loop finds the server whenever it's back. */
    fun requestHardReset() {
        val sent = connection?.send(ClientMessage.Reset(kind = "hard")) ?: false
        if (sent) {
            DiagLog.log("os", "hard reset requested — awaiting the server's hard_reset broadcast")
            setStatus("Hard reset requested — server restarting…")
            return
        }
        DiagLog.log("os", "hard reset: WS DOWN — LOCAL-ONLY teardown + mode re-entry (the server was NOT reached)")
        setStatus("Hard reset: server unreachable — resetting locally…")
        hardResetLocal("local-only, WS down")
    }

    /** The local half of a Hard Reset: FULL teardown (BLE + WS), then auto
     *  re-enter the mode(s) that were active. Sequencing mirrors
     *  [recoverSession]: teardown() shuts the old ConnectionManager down
     *  (killing its reconnect loop) BEFORE re-entry builds a fresh one — so the
     *  server terminating the socket right after broadcasting can't race a
     *  zombie reconnect; exactly one manager owns the retry loop. */
    private fun hardResetLocal(origin: String) {
        // Capture BEFORE teardown. Control mode is not cleared by teardown (only a
        // manual disconnect clears it) but read it up front with the BLE state.
        val control = _controlMode.value
        val wasBridging = _launched.value || _connecting.value || left != null || right != null
        DiagLog.log("os", "═══ HARD RESET ($origin) — full teardown; re-enter: control=$control bridging=$wasBridging ═══")
        setStatus("Hard reset — tearing down…")
        teardown()
        _scene.value = null   // clean slate on the mirror until the fresh attach paints
        when {
            control -> {
                enterControlMode()
                // The previous mode was BOTH (glasses BLE-live while control mode was
                // on) → bring the BLE bridge back too; its cold-launch re-attaches to
                // the control WS (plan W5 lists the two re-entries independently).
                if (wasBridging) connect()
            }
            wasBridging -> connect()
            else -> {
                DiagLog.log("os", "hard reset: no mode was active — staying idle")
                setStatus("Hard reset done — idle.")
            }
        }
    }

    private fun onServerMessage(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.Render -> {
                // Hand off to the serialized render pump. CONFLATED: a newer scene replaces an
                // unconsumed one, so a burst of scrolls renders only the latest.
                if (sceneCh?.trySend(msg.scene)?.isSuccess != true)
                    DiagLog.log("os", "render dropped — render queue not active (not in server mode?)")
            }
            is ServerMessage.DisplayReload -> {
                // DE 'Reload': recover a possibly-stuck display. Abort releases a wedged
                // image ack-wait + drops queued ops; then re-run the COLD_INIT re-takeover
                // with the current scene (the proven ~80 s renewal path) — full re-push.
                val r = renderer
                val sc = r?.currentScene
                if (r == null || sc == null) {
                    DiagLog.log("os", "display_reload but no live renderer/scene — ignored (LOUD)")
                    return
                }
                DiagLog.log("os", "display_reload → abort + COLD_INIT re-takeover (${sc.regions.size} regions)")
                r.abort("display_reload")
                r.launch(DisplayProto.LAUNCH_TOKEN, sc, EvenHub.COLD_INIT) { ok ->
                    DiagLog.log("os", "display_reload re-takeover result=${if (ok) "OK" else "FAIL"}")
                }
            }
            is ServerMessage.AudioRequest -> {
                // DE dictation: the server (menu 'Dictate'/'Ask') drives the phone mic.
                // AudioStreamer owns audio_start/binary/audio_end; MicCapture failures
                // surface through its log + the streamer's loud failure path. We also diag
                // both edges so the server log shows the round-trip.
                val conn = connection
                if (conn == null) {
                    DiagLog.log("os", "audio_request ${msg.action} but no WS connection — ignored")
                    return
                }
                when (msg.action) {
                    "start" -> {
                        if (audioStreamer?.isStreaming == true) {
                            // Surface to the SERVER, not just the diag log — its dictation
                            // state machine is waiting for an audio_start that will never
                            // come (review 2026-06-11).
                            DiagLog.log("os", "audio_request start — already streaming (refused)")
                            conn.send(ClientMessage.Diag("[audio-error] audio_request start refused: a previous capture is still streaming — Reload to clear it"))
                            return
                        }
                        if (!micFgsGranted) {
                            // Android 14+ would feed AudioRecord SILENCE here (no exception) —
                            // refuse loudly so the server's dictation state machine unwinds
                            // instead of "transcribing" a stream of zeros.
                            val reason = "mic FGS type was denied at service start (background restart?) — reopen the app once to restore dictation"
                            DiagLog.log("os", "audio_request start REFUSED: $reason")
                            conn.send(ClientMessage.Diag("[audio-error] $reason"))
                            return
                        }
                        // Fresh streamer per start: binds the CURRENT ConnectionManager (a WS
                        // reconnect creates a new one; a cached streamer would talk to the corpse).
                        // Capture failures go back to the server as an [audio-error] diag —
                        // logcat-only failures left the server waiting forever (review 2026-06-10).
                        val handsfree = msg.mode == "handsfree"
                        val s = AudioStreamer(MicCapture(applicationContext), conn, onFailure = { reason ->
                            DiagLog.log("os", "audio capture FAILED: $reason")
                            conn.send(ClientMessage.Diag("[audio-error] $reason"))
                        }, handsfree = handsfree)
                        audioStreamer = s
                        DiagLog.log("os", "audio_request start → mic streaming${if (handsfree) " (handsfree)" else ""}")
                        s.start()
                    }
                    "stop" -> {
                        DiagLog.log("os", "audio_request stop")
                        audioStreamer?.stop()
                    }
                    else -> DiagLog.log("os", "audio_request unknown action '${msg.action}' — ignored (LOUD)")
                }
            }
            is ServerMessage.NotificationCancel -> {
                // Read on glass / MkAll'd → dismiss the phone's copy (Adam
                // 2026-06-13 dismiss sync). cancelByKey is idempotent.
                NotifyListener.cancelByKey(msg.key)
            }
            is ServerMessage.NotificationReply -> {
                // Phase 4a: fill the forwarded notification's RemoteInput + fire it.
                NotifyListener.replyByKey(msg.key, msg.text)
            }
            is ServerMessage.MediaCmd -> {
                // Phase 7: transport / subscription for the active MediaSession.
                when (msg.cmd) {
                    "subscribe" -> MediaBridge.subscribe(applicationContext) { info -> sendMediaState(info) }
                    "unsubscribe" -> MediaBridge.unsubscribe()
                    else -> MediaBridge.command(msg.cmd)
                }
            }
            is ServerMessage.SmsThreadsRequest -> {
                // Phase 4b: query the SMS provider OFF the main thread; reply async.
                scope.launch(Dispatchers.IO) {
                    val r = SmsProvider.queryThreads(applicationContext, msg.offset, msg.limit)
                    sendSmsThreadsReply(r.threads, msg.offset, r.total, r.error)
                }
            }
            is ServerMessage.SmsThreadRequest -> {
                scope.launch(Dispatchers.IO) {
                    val r = SmsProvider.queryThread(applicationContext, msg.threadId, msg.page)
                    sendSmsThreadReply(r.threadId, r.name, r.address, r.messages, r.page, r.totalPages, r.error)
                }
            }
            is ServerMessage.SmsSend -> {
                // Phase 4b: send via SmsManager (needs SEND_SMS). Off the main thread.
                scope.launch(Dispatchers.IO) { sendSms(msg.address, msg.text) }
            }
            is ServerMessage.PhoneLocate -> {
                // Phase 15: ring / silence the phone.
                if (msg.action == "stop") PhoneLocator.stop(applicationContext)
                else PhoneLocator.start(applicationContext)
            }
            is ServerMessage.GlassesReset -> {
                // Soft Reset, server-orchestrated (the PC page's button): refresh the
                // glasses BLE session KEEPING this WebSocket. softReset() guards
                // re-entry and narrates via the status flow.
                DiagLog.log("os", "glasses_reset from server → soft reset (BLE recovery, WS kept)")
                softReset()
            }
            is ServerMessage.HardReset -> {
                // The server is about to clean-slate itself and terminate every
                // socket. Full local teardown, then auto re-enter the previous
                // mode(s) — the fresh ConnectionManager's reconnect loop finds the
                // rebuilt server.
                DiagLog.log("os", "═══ HARD RESET broadcast from server ═══")
                hardResetLocal("server broadcast")
            }
            is ServerMessage.Error -> {
                // The MESSAGE TEXT must surface (review 2026-06-11b): the old
                // catch-all logged only the class name, discarding the server's
                // explanation — against loud-and-proud. R2: it ALSO flows to the
                // control UI (typed-text discards restore the input field there).
                DiagLog.log("os", "server error: ${msg.message}")
                _serverErrors.tryEmit(msg.message)
            }
            else -> {
                // config_snapshot / dispatch_target_list / etc. — not used in OS mode.
                DiagLog.log("os", "ignored server msg ${msg::class.simpleName}")
            }
        }
    }

    // ----------------------------------------------------------------- connect flow

    private fun onScanResult(ev: BleScanner.Event) {
        when (ev) {
            is BleScanner.Event.FoundPair -> {
                DiagLog.log("conn", "found pair L=${ev.left.address} R=${ev.right.address}")
                startClients(ev.left, ev.right)
            }
            is BleScanner.Event.Failure -> {
                DiagLog.log("conn", "scan FAILED: ${ev.reason}")
                setStatus("Scan failed: ${ev.reason}")
                _connecting.value = false
                // Don't strand auto-recovery if the recovery RESCAN itself failed.
                if (recovering) {
                    recovering = false
                    DiagLog.log("recover", "scan failed during recovery — cleared `recovering` so the next drop can retry")
                }
            }
        }
    }

    /** Create + observe + connect both lens clients, caching the devices so a later recovery
     *  can reconnect DIRECTLY (skips the scan + its can-stall-in-RF-noise hole). */
    private fun startClients(leftDev: BluetoothDevice, rightDev: BluetoothDevice) {
        // Never STACK a second client pair over live ones (review 2026-06-11b):
        // after a cold-launch failure the links deliberately stay up for the
        // next-Ready retry, but a manual Connect (or the BT-on reconnect) then
        // landed here and overwrote left/right without close() — leaked gatt
        // slots + ever-growing stateJobs collecting into dead flows.
        if (left != null || right != null) {
            DiagLog.log("conn", "startClients: releasing the previous BLE client pair first (no stacking)")
            stateJobs.forEach { it.cancel() }
            stateJobs.clear()
            left?.shutdownBle()
            right?.shutdownBle()
            left = null
            right = null
        }
        lastLeftDevice = leftDev
        lastRightDevice = rightDev
        val lc = G2BleClient(applicationContext, Side.Left)
        val rc = G2BleClient(applicationContext, Side.Right)
        left = lc; right = rc
        observe(lc, Side.Left)
        observe(rc, Side.Right)
        setStatus("Connecting + authenticating both lenses…")
        lc.connectTo(leftDev)
        rc.connectTo(rightDev)
    }

    /** Recovery reconnect: straight to the cached lens addresses if we have them (skips the scan);
     *  fall back to a fresh scan otherwise. */
    private fun reconnect() {
        val l = lastLeftDevice
        val r = lastRightDevice
        if (l != null && r != null) {
            DiagLog.log("recover", "direct reconnect to cached L=${l.address} R=${r.address} (no rescan)")
            _connecting.value = true
            startClients(l, r)
        } else {
            DiagLog.log("recover", "no cached devices — falling back to scan")
            connect()
        }
    }

    private fun observe(client: G2BleClient, side: Side) {
        stateJobs += scope.launch {
            client.state.collect { st ->
                DiagLog.log("ble", "$side → ${st::class.simpleName}${stateDetail(st)}")
                when (st) {
                    is ConnectionState.Ready -> onLensReady()
                    is ConnectionState.Error -> {
                        setStatus("$side error: ${st.message}")
                        // A connect/auth failure DURING recovery (before we relaunch) would otherwise
                        // strand `recovering`; clear it so the next drop/watchdog can retry.
                        if (recovering && !_launched.value) {
                            recovering = false
                            DiagLog.log("recover", "$side error during recovery — cleared `recovering`")
                        }
                        // A pre-launch connect failure (adapter off → Nordic
                        // fail-fast, auth failure, out of range) must also
                        // release `_connecting` — stuck true it disabled the
                        // harness Connect button AND blocked every auto-retry
                        // path forever (review 2026-06-11b).
                        if (!_launched.value && _connecting.value) {
                            _connecting.value = false
                            DiagLog.log("conn", "$side error pre-launch — cleared `connecting` so retries can run")
                        }
                    }
                    is ConnectionState.Disconnected -> onLensDisconnected(side, st.reason)
                    else -> {}
                }
            }
        }
        stateJobs += scope.launch {
            client.events.collect { ev ->
                if (side == Side.Right) {
                    lastNotifyMs = System.currentTimeMillis()  // liveness for the watchdog
                    // Feed e0-00 acks to the renderer's image ack-gate (it matches only the parked
                    // image-chunk msgId; other acks just advance its liveness marker).
                    if (ev is EventParser.Event.HubAck) renderer?.onImageAck(ev.msgId)
                }
                // Glasses battery (Adam 2026-06-12): 09-00 poll responses +
                // unsolicited 09-01 updates, either lens. Rides client_hb.
                if (ev is EventParser.Event.DeviceInfo && ev.battery != null) {
                    if (g2Battery != ev.battery) DiagLog.log("batt", "glasses battery → ${ev.battery}%")
                    g2Battery = ev.battery
                }
                DiagLog.log("input", "$side $ev")
                // Forward ring input to the PC when the server is driving the display.
                if (_serverMode.value && side == Side.Right) {
                    SceneCodec.toInput(ev)?.let { input ->
                        val sent = connection?.send(input) ?: false
                        DiagLog.log("os", "input $ev → ${if (sent) "sent" else "DROPPED"}")
                    }
                }
            }
        }
    }

    private fun stateDetail(st: ConnectionState): String = when (st) {
        is ConnectionState.Error -> " (${st.message})"
        is ConnectionState.Disconnected -> " (${st.reason})"
        else -> ""
    }

    /** Both lenses reached Ready. Initial connect → cold-launch; a re-Ready after a drop
     *  (needsRelaunch) → revive the Hub slot without a full teardown. */
    private fun onLensReady() {
        if (!_launched.value) { maybeColdLaunch(); return }   // initial (maybeColdLaunch re-checks both-ready)
        if (needsRelaunch) {
            val l = left ?: return
            val r = right ?: return
            if (l.state.value !is ConnectionState.Ready || r.state.value !is ConnectionState.Ready) return
            needsRelaunch = false
            relaunchAfterReconnect()
        }
    }

    /** A lens dropped. Our own teardown → ignore. Dropped while live → the hijacked Hub slot is
     *  gone; flag a re-launch and let autoConnect bring the link back (lightweight, no rescan).
     *  The SILENT drop (link up, acks stop) is still covered by the watchdog. */
    private fun onLensDisconnected(side: Side, reason: String) {
        if (tearingDown) return
        if (_launched.value) {
            needsRelaunch = true
            DiagLog.log("recover", "$side dropped ($reason) while live — re-launch Hub when the link returns")
        } else if (recovering) {
            // C2 (review 2026-06-13): a lens that reached GattConnected then
            // Disconnected mid-recovery would STRAND `recovering` (teardown
            // already cancelled the watchdog/sync/clock jobs), leaving recovery
            // dependent solely on autoConnect re-firing Ready. Mirror the Error
            // branch: clear `recovering`/`_connecting` so the watchdog or the
            // next drop can re-trigger a fresh recoverSession().
            DiagLog.log("recover", "$side dropped ($reason) during recovery — clearing `recovering` so the next drop/watchdog can retry")
            recovering = false
            if (_connecting.value) _connecting.value = false
        }
    }

    /** A dropped lens reconnected (autoConnect re-authed it to Ready). The Hub slot died with the
     *  drop, so re-run COLD_INIT with the current scene to revive it. The keepalive/sync/watchdog/
     *  renewal jobs kept running and resume against the live link — no need to restart them. */
    private fun relaunchAfterReconnect() {
        val r = renderer ?: return
        val sc = r.currentScene ?: return
        lastNotifyMs = System.currentTimeMillis()    // fresh link — don't let the watchdog insta-fire
        DiagLog.log("recover", "lens reconnected — re-launching Hub (COLD_INIT) to revive the slot")
        setStatus("Link back — re-launching…")
        r.launch(DisplayProto.LAUNCH_TOKEN, sc, EvenHub.COLD_INIT) { ok ->
            DiagLog.log("recover", "re-launch result=${if (ok) "OK" else "FAIL"}")
            if (ok) setStatus("Reconnected.")
        }
    }

    private fun maybeColdLaunch() {
        if (_launched.value) return
        val l = left ?: return
        val r = right ?: return
        if (l.state.value !is ConnectionState.Ready || r.state.value !is ConnectionState.Ready) return
        _launched.value = true
        _connecting.value = false   // C3 (review 2026-06-13): connecting → launched; clear the (masked) stuck flag
        DiagLog.log("conn", "both lenses Ready — R link mtu=${r.lastMtu} phy=${r.lastPhy} conn=${r.lastConnParams}")
        val rend = G2Renderer(BleDisplaySink(r), diag = { msg -> DiagLog.log("render", msg) })
        renderer = rend
        val gen = sessionGen
        coldLaunchJob = scope.launch {
            setStatus("Cold-launching Hub session…")
            val splash = scene {
                text("clock", OsLayout.CLOCK_X, OsLayout.CLOCK_Y, OsLayout.CLOCK_WIDTH, OsLayout.CLOCK_HEIGHT,
                    nowClock(), scroll = false, id = OsLayout.CLOCK_ID)
                text("main", 0, OsLayout.CONTENT_Y, Display.WIDTH, OsLayout.CONTENT_HEIGHT,
                    "G2 OS v${OsLayout.OS_VERSION}\n\nConnected — entering the DE…", scroll = false, id = 2)
            }
            val ok = awaitLaunch(rend, splash)
            // Bail if teardown ran while we were launching — don't re-arm jobs against a
            // torn-down session (that stale completion used to leave recovery stalled).
            if (gen != sessionGen) { DiagLog.log("conn", "cold-launch result ignored — session torn down"); return@launch }
            if (ok) {
                DiagLog.log("conn", "cold-launch OK")
                setStatus("Connected — server mode.")
                startKeepalive()
                startClock()
                startSyncTrigger()
                startWatchdog()
                startRenewal()
                startBatteryPoll()
                _scene.value = rend.currentScene
                if (recovering) {
                    recovering = false
                    DiagLog.log("recover", "reconnect + cold-launch OK after silent drop")
                }
                // Multi-surface (2026-07-13): the WS may ALREADY be live — control
                // mode running glasses-less, or a keepWs soft reset. enterServerMode()
                // below no-ops on its guard then, so re-send os_attach here: the
                // server answers ANY os_attach with a full re-render (idempotent
                // re-attach), painting the brand-new renderer instead of leaving the
                // splash up until the next organic render.
                if (_serverMode.value) {
                    val sent = connection?.send(ClientMessage.OsAttach(surface = "phone")) ?: false
                    DiagLog.log("os", "glasses joined a live WS → re-attach os_attach ${if (sent) "sent" else "DROPPED (ws not ready — onConnected attach will cover it)"}")
                }
                // v1.7 (Adam 2026-06-11): Connect = straight into the DE. The
                // splash above is momentary; the server scene replaces it as
                // soon as the WS auths. enterServerMode() is idempotent
                // (guards _serverMode), so the recovery path — where server
                // mode may still be live across a needsRelaunch revive — is
                // unaffected, and a full-teardown recovery re-enters here.
                enterServerMode()
            } else {
                // Reset so the dead-end can't permanently block recovery.
                DiagLog.log("conn", "cold-launch FAILED — resetting (launched=false) so a reconnect can retry")
                _launched.value = false
                _connecting.value = false
                if (recovering) recovering = false
                setStatus("Cold-launch failed — see Diag log. Will retry on next reconnect.")
            }
        }
    }

    private fun startKeepalive() {
        keepaliveJob?.cancel()
        keepaliveJob = scope.launch {
            while (isActive) {
                delay(4000)                              // session keepalive cadence (pacing)
                val r = right ?: break
                val rend = renderer ?: break
                r.sendPacket(rend.keepaliveFrame(), "HB:f1=12") { ok ->
                    DiagLog.log("hb", "keepalive write=${if (ok) "OK" else "FAIL"}")
                }
            }
        }
    }

    private fun nextSyncTrigger(): ByteArray {
        // sync_trigger: service 0x80-00, type 14 — payload `08 0E 10 <msgId-varint> 6A 00`.
        // Verbatim from the native Chess BTSnoop. SESSION keepalive, NOT teleprompter mode.
        val payload = byteArrayOf(0x08, 0x0E, 0x10) + Varint.encode(syncMsgId) + byteArrayOf(0x6A, 0x00)
        val f = G2Frame.command(syncSeq, G2Constants.Services.AUTH_CONTROL, payload)
        syncSeq = if (syncSeq >= 0xFF) 0x10 else syncSeq + 1
        syncMsgId = (syncMsgId + 1) and 0xFF        // 1-byte wrap (same constraint as G2Renderer.nextMsgId)
        return f
    }

    /** Device-info query `09-20` type 2 → the glasses reply `09-00` with
     *  battery in f4.f12 (G2_BLE_PROTOCOL.md §10 + init-table row 12). Payload
     *  `08 02 10 <msgId>` follows the proven request convention (f1=type,
     *  f2=msgId — the same shape as the BTSnoop-verbatim sync_trigger; the
     *  imagestatus capture that carried the original exchange is no longer on
     *  disk, so the exact trailing bytes are [U] — worst case the firmware
     *  ignores the query and the battery slot stays '--'; the unsolicited
     *  09-01 updates are a second, listen-only source). */
    private fun nextDeviceInfoQuery(): ByteArray {
        val payload = byteArrayOf(0x08, 0x02, 0x10) + Varint.encode(syncMsgId)
        val f = G2Frame.command(syncSeq, G2Constants.Services.DEVICE_INFO_QUERY, payload)
        syncSeq = if (syncSeq >= 0xFF) 0x10 else syncSeq + 1
        syncMsgId = (syncMsgId + 1) and 0xFF
        return f
    }

    /** Poll the glasses battery every ~60 s (pacing cadence) on the R lens —
     *  the primary command channel; the 09-00 response (and any unsolicited
     *  09-01) lands in the events collector above. */
    private fun startBatteryPoll() {
        batteryPollJob?.cancel()
        batteryPollJob = scope.launch {
            while (isActive) {
                val r = right ?: break
                r.sendPacket(nextDeviceInfoQuery(), "BATT:09-20") { ok ->
                    if (!ok) DiagLog.log("batt", "device-info query write FAILED")
                }
                delay(60_000)
            }
        }
    }

    /** sync_trigger (service 80-00, type 14) to BOTH lenses every ~15 s, staggered ~2 s —
     *  exactly as native Chess does. The glasses use this 80-00 packet for their
     *  session-extend logic; without it they reclaim our app. */
    private fun startSyncTrigger() {
        syncJob?.cancel()
        syncJob = scope.launch {
            while (isActive) {
                delay(13000)
                left?.sendPacket(nextSyncTrigger(), "SYNC:80-00:L") { ok -> DiagLog.log("sync", "L write=${if (ok) "OK" else "FAIL"}") }
                delay(2000)                                  // L→R stagger ~2s (Chess pattern)
                right?.sendPacket(nextSyncTrigger(), "SYNC:80-00:R") { ok -> DiagLog.log("sync", "R write=${if (ok) "OK" else "FAIL"}") }
            }
        }
    }

    /** Glasses-response watchdog. The glasses ack our writes (~1/s on e0-00). If those
     *  responses STOP while we keep writing, the EvenHub app slot was likely SILENTLY dropped
     *  (link stays up, no BLE event). Sustained gap → auto-recover. */
    private fun startWatchdog() {
        watchdogJob?.cancel()
        lastNotifyMs = System.currentTimeMillis()
        watchdogJob = scope.launch {
            var lastWarn = 0L
            var bad = 0
            while (isActive) {
                delay(1000)
                val gap = System.currentTimeMillis() - lastNotifyMs
                if (gap > 3000) {
                    bad++
                    if (System.currentTimeMillis() - lastWarn > 2000) {
                        DiagLog.log("watch", "NO glasses response for ${gap}ms (bad=$bad) — possible SILENT app-drop")
                        lastWarn = System.currentTimeMillis()
                    }
                    // Sustained no-acks → auto-recover (silent drop: link up, slot dead). Threshold
                    // stays above the ~6 s heavy-render ack pause to avoid false fires; tune from diag.
                    if (bad >= WATCHDOG_BAD_THRESHOLD && !recovering &&
                        System.currentTimeMillis() - lastRecoverMs > RECOVERY_RATELIMIT_MS) {
                        recoverSession()
                    }
                } else {
                    bad = 0
                }
            }
        }
    }

    /** Auto-recovery. The silent app-drop leaves the BLE link "up"; only a FRESH BLE session
     *  revives it. Force a teardown + reconnect + cold-launch; server mode re-enters
     *  unconditionally with the cold-launch (v1.7 — no remembered flag needed).
     *  Control mode (multi-surface 2026-07-13): keep the WS across the recovery —
     *  the phone mirror stays live while BLE rebuilds, and the cold-launch's
     *  re-attach repaints the fresh renderer. Without control mode the teardown
     *  is the historical full one, provably unchanged. */
    private fun recoverSession() {
        if (recovering) return
        recovering = true
        needsRelaunch = false
        lastRecoverMs = System.currentTimeMillis()
        val keepWs = _controlMode.value
        DiagLog.log("recover", "SILENT DROP — auto-recovering: teardown${if (keepWs) " (BLE only — control mode keeps the WS)" else ""} + reconnect + cold-launch + server mode")
        setStatus("Auto-recovering (silent drop)…")
        teardown(keepWs = keepWs)   // BLE teardown (cancels jobs; keeps cached devices; keepWs spares the WS/pump)
        reconnect()       // DIRECT reconnect to cached lenses (no rescan) -> Ready -> maybeColdLaunch (clears `recovering`)
    }

    /** Session RENEWAL — the hijacked EvenHub app slot has a ~120 s lifetime. Native Chess
     *  renews it by re-running the full COLD_INIT launch + re-pushing the current frame every
     *  ~113-118 s. We do the same at ~80 s (margin under expiry). */
    private fun startRenewal() {
        renewalJob?.cancel()
        renewalJob = scope.launch {
            while (isActive) {
                delay(80_000)                                // ~80s, margin under the ~120s app-slot lifetime
                val r = renderer ?: break
                val sc = r.currentScene ?: continue
                DiagLog.log("renew", "re-takeover (COLD_INIT) — resubmit current frame (${sc.regions.size} regions)")
                r.launch(DisplayProto.LAUNCH_TOKEN, sc, EvenHub.COLD_INIT) { ok ->
                    DiagLog.log("renew", "re-takeover result=${if (ok) "OK" else "FAIL"}")
                }
            }
        }
    }

    /** Tick the app-owned clock ("1:04 PM"). The loop still wakes every second (cheap, and
     *  keeps the tick aligned to the minute boundary) but only WRITES when the formatted
     *  text actually changes — one BLE write per minute instead of sixty (the v0.8 "clock
     *  janky during image push" factor + a hat power win; docs/DE_DESIGN.md §1). Session
     *  liveness does NOT depend on this: the 4 s f1=12 keepalive acks feed the watchdog. */
    private fun startClock() {
        clockJob?.cancel()
        clockJob = scope.launch {
            var lastWritten: String? = null
            while (isActive) {
                delay(1000)
                val r = renderer ?: break
                val sc = r.currentScene ?: continue
                val t = nowClock()
                if (t == lastWritten) continue
                // Mark the minute written only on a CONFIRMED write — a failed tick (transient
                // body-block) retries next second instead of leaving the clock a minute stale
                // (there's no 1 Hz self-heal anymore). Write failures are logged by the sink.
                when {
                    sc.region(OsLayout.CLOCK_NAME) != null ->
                        r.setText(OsLayout.CLOCK_NAME, t) { ok -> if (ok) lastWritten = t; _scene.value = r.currentScene }
                    sc.region("status") != null ->
                        r.setText("status", "G2CC  $t") { ok -> if (ok) lastWritten = t; _scene.value = r.currentScene }
                }
            }
        }
    }

    // ----------------------------------------------------------------- teardown

    /** Teardown. keepWs=false (the default) is line-for-line the historical FULL
     *  teardown — BLE + WS + everything. keepWs=true (multi-surface 2026-07-13)
     *  is the BLE-ONLY teardown for control mode / Soft Reset: the WS, render
     *  pump, mirror clock, audio/media/locator wiring and `_serverMode` all
     *  survive so the phone mirror keeps working while the glasses session is
     *  rebuilt; every BLE job still dies, the renderer is aborted and nulled,
     *  and `_launched`/`_connecting` drop so a reconnect can cold-launch. */
    private fun teardown(keepWs: Boolean = false) {
        tearingDown = true   // our own shutdownBle() disconnects must NOT trigger auto-recovery
        renderer?.abort("teardown", force = true)   // BLE dies next — release every park + queued op
        keepaliveJob?.cancel(); keepaliveJob = null
        clockJob?.cancel(); clockJob = null
        if (!keepWs) {
            renderConsumerJob?.cancel(); renderConsumerJob = null
            sceneCh?.close(); sceneCh = null
            mirrorClockJob?.cancel(); mirrorClockJob = null
            lastWire = null
        }
        syncJob?.cancel(); syncJob = null
        watchdogJob?.cancel(); watchdogJob = null
        renewalJob?.cancel(); renewalJob = null
        batteryPollJob?.cancel(); batteryPollJob = null
        coldLaunchJob?.cancel(); coldLaunchJob = null
        testJob?.cancel(); testJob = null
        sessionGen++   // invalidate any in-flight cold-launch/test coroutine that completes after this
        stateJobs.forEach { it.cancel() }; stateJobs.clear()
        if (!keepWs) {
            audioStreamer?.stop(); audioStreamer = null   // mic OFF with the session (never left running)
            MediaBridge.unsubscribe()                     // release the MediaController callback (don't outlive the session)
            PhoneLocator.stop(applicationContext)         // silence any in-progress find-my-phone ring
            connection?.shutdown(); connection = null
            _serverMode.value = false
        }
        _testing.value = false
        scanner?.stop(); scanner = null
        left?.shutdownBle(); right?.shutdownBle()
        left = null; right = null; renderer = null
        _launched.value = false; _connecting.value = false
        needsRelaunch = false
        tearingDown = false
    }

    // ----------------------------------------------------------------- TestHarness

    override suspend fun render(label: String, scene: Scene): Boolean {
        step(label)
        val r = renderer ?: return false
        DiagLog.log("test", "→ setScene (${scene.regions.size} regions: ${scene.regions.joinToString { it.name }})")
        val ok = awaitSetScene(r, scene)
        _scene.value = r.currentScene
        DiagLog.log("test", "  result=${if (ok) "OK" else "FAIL"}")
        return ok
    }

    override suspend fun renderImage(label: String, region: String, bmp: ByteArray): Boolean {
        step(label)
        val r = renderer ?: return false
        DiagLog.log("test", "→ setImage('$region', ${bmp.size} B)")
        val ok = awaitSetImage(r, region, bmp)
        _scene.value = r.currentScene
        DiagLog.log("test", "  result=${if (ok) "OK" else "FAIL"}")
        return ok
    }

    override suspend fun renderText(label: String, region: String, text: String): Boolean {
        step(label)
        val r = renderer ?: return false
        DiagLog.log("test", "→ setText('$region', ${text.length} chars)")
        val ok = awaitSetText(r, region, text)
        _scene.value = r.currentScene
        DiagLog.log("test", "  result=${if (ok) "OK" else "FAIL"}")
        return ok
    }

    override fun note(msg: String) {
        DiagLog.log("test", msg)
    }

    override suspend fun pause(ms: Long) {
        delay(ms)
    }

    private fun step(label: String) {
        setStatus(label)
        DiagLog.log("test", "STEP $label")
    }

    // ----------------------------------------------------------------- await helpers

    private suspend fun awaitLaunch(r: G2Renderer, s: Scene): Boolean =
        suspendCancellableCoroutine { c -> r.launch(DisplayProto.LAUNCH_TOKEN, s, EvenHub.COLD_INIT) { if (c.isActive) c.resume(it) } }

    private suspend fun awaitSetScene(r: G2Renderer, s: Scene): Boolean =
        suspendCancellableCoroutine { c -> r.setScene(s) { if (c.isActive) c.resume(it) } }

    private suspend fun awaitSetImage(r: G2Renderer, name: String, bmp: ByteArray): Boolean =
        suspendCancellableCoroutine { c -> r.setImage(name, bmp) { if (c.isActive) c.resume(it) } }

    private suspend fun awaitSetText(r: G2Renderer, name: String, text: String): Boolean =
        suspendCancellableCoroutine { c -> r.setText(name, text) { if (c.isActive) c.resume(it) } }

    // ----------------------------------------------------------------- status / notification / wake lock

    private fun setStatus(s: String) {
        _status.value = s
        updateNotification(s)
    }

    private fun startInForeground() {
        // minSdk 29 → the 3-arg startForeground with a type is always available.
        // connectedDevice + microphone combined: Android 14+ SecurityException-s if
        // AudioRecord opens from a FG service without microphone in the type mask, and the
        // mask is FIXED at startForeground — it can't be upgraded when dictation starts
        // later (the parked G2CCService's hard-won note). The mic is only ACTUALLY used on
        // a server audio_request. NET-7: a background-initiated start with a mic type can
        // throw on Android 12+/14 — log loudly and stop cleanly, never crash silent.
        try {
            val typeMask = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            } else {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            }
            startForeground(NOTIF_ID, buildNotification(_status.value), typeMask)
            micFgsGranted = true
        } catch (e: Exception) {
            DiagLog.log("svc", "startForeground with mic type FAILED (${e.message}) — retrying connectedDevice-only (dictation unavailable this run)")
            micFgsGranted = false
            // C4 (review 2026-06-13): the fallback start can ALSO throw (e.g.
            // ForegroundServiceStartNotAllowedException on a background-initiated
            // start) — an uncaught second throw crashes the service start. Stop
            // cleanly instead; the service revives on the next foreground trigger.
            try {
                startForeground(NOTIF_ID, buildNotification(_status.value), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
            } catch (e2: Exception) {
                DiagLog.log("svc", "startForeground connectedDevice-only ALSO failed (${e2.message}) — stopping service cleanly (no crash)")
                stopSelf()
            }
        }
    }

    private fun buildNotification(text: String): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, HarnessActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, G2CCApp.CHANNEL_ID)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.fg_title))
            .setContentText(text)
            .setContentIntent(pi)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.notify(NOTIF_ID, buildNotification(text))
    }

    private fun acquireWakeLock() {
        // PARTIAL_WAKE_LOCK so the keepalive/sync/watchdog delay() loops fire on schedule.
        // FG type stops process-kill, NOT Doze CPU-throttling (parked G2CCService's factory
        // finding: 13-28 s tick gaps on a 10 s cadence without this).
        try {
            val pm = getSystemService(PowerManager::class.java)
            wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "G2CC:ConnectionWakeLock")?.apply {
                setReferenceCounted(false)
                acquire()
            }
            DiagLog.log("svc", "wake lock acquired: held=${wakeLock?.isHeld}")
        } catch (e: Exception) {
            // LOUD AND PROUD — surface, don't swallow. A throttled keepalive would blank the HUD.
            DiagLog.log("svc", "wake lock acquisition FAILED; delay() may be throttled: $e")
        }
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (e: Exception) {
            DiagLog.log("svc", "wake lock release failed: $e")
        }
        wakeLock = null
    }

    private fun stopForegroundAndSelf() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION") stopForeground(true)
        }
        stopSelf()
    }

    companion object {
        const val NOTIF_ID = 0xCC2C
        const val ACTION_CONNECT = "com.g2cc.g2cc.action.CONNECT"
        /** Enter phone-screen CONTROL mode (multi-surface 2026-07-13) — WS only,
         *  NO BLE connect. The glasses may join later via a normal Connect. */
        const val ACTION_CONTROL = "com.g2cc.g2cc.action.CONTROL"
        /** Re-enter exactly the persisted mode(s) — control and/or BLE bridge
         *  (F9). Used by BootReceiver; the START_STICKY null-intent relaunch
         *  runs the same branch. */
        const val ACTION_RESUME = "com.g2cc.g2cc.action.RESUME"
        private const val PREFS_FILE = "g2cc-service"
        private const val KEY_CONTROL_MODE = "controlMode"
        private const val KEY_BRIDGING = "bridging"

        // Recovery tunables (tune from factory diag). WATCHDOG_BAD_THRESHOLD counts 1 s ticks of
        // no R-lens acks AFTER the gap already exceeds 3 s, so 6 ≈ ~9 s of silence before a silent-
        // drop recovery (was effectively ~14 s). Kept above the ~6 s heavy-render ack pause.
        const val WATCHDOG_BAD_THRESHOLD = 6
        const val RECOVERY_RATELIMIT_MS = 10_000L   // min between watchdog-triggered recoveries (was 30 s)

        // Process-level liveness flag so the Activity can decide whether to bind-to-observe
        // an already-running (background) service on reopen. @Volatile: read off the main
        // thread is possible; cleared in onDestroy.
        @Volatile
        var running: Boolean = false
            private set
        val isRunning: Boolean get() = running

        // Phase 9: process-local handle for NotifyListener (both services share
        // the default process). Set in onCreate, cleared in onDestroy — the
        // listener loud-drops when the connection service isn't up.
        @Volatile
        private var instance: ConnectionService? = null

        /** NotifyListener → server forwarding entry point. */
        fun forwardNotification(pkg: String, title: String, text: String, postedAt: Long, key: String, imageB64: String? = null, hasReply: Boolean = false) {
            val svc = instance
            if (svc == null) {
                DiagLog.log("notify", "dropped $pkg \"$title\" — ConnectionService not running")
                return
            }
            svc.sendNotify(pkg, title, text, postedAt, key, imageB64, hasReply)
        }

        /** NotifyListener → server: a forwarded notification was dismissed on the
         *  phone (Adam 2026-06-13 dismiss sync). No-op if the service is down. */
        fun notificationDismissed(key: String) {
            instance?.sendNotificationDismissed(key)
        }

        /** NotifyListener → server: a Phase-4a inline-reply outcome. */
        fun forwardReplyResult(key: String, ok: Boolean, error: String?) {
            instance?.sendNotificationReplyResult(key, ok, error)
                ?: DiagLog.log("notify", "reply result dropped ($key ok=$ok) — service down")
        }

        /** NotifyListener → server: the Maps nav line (Phase 6). */
        fun forwardNavUpdate(text: String, eta: String?) { instance?.sendNavUpdate(text, eta) }
        fun forwardNavClear() { instance?.sendNavClear() }

        /** Start the FG service and tell it to connect. Survives Activity unbind / background. */
        fun startAndConnect(context: Context) {
            val intent = Intent(context, ConnectionService::class.java).apply { action = ACTION_CONNECT }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else @Suppress("DEPRECATION") context.startService(intent)
        }

        /** Start the FG service in phone-screen CONTROL mode (multi-surface
         *  2026-07-13) — the WS + mirror with NO BLE required. ControlActivity
         *  calls this from onStart so control works with the glasses absent. */
        fun startForControl(context: Context) {
            val intent = Intent(context, ConnectionService::class.java).apply { action = ACTION_CONTROL }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else @Suppress("DEPRECATION") context.startService(intent)
        }

        /** Start the FG service and re-enter the persisted mode(s) — control
         *  and/or bridge (F9). BootReceiver's path: a boot after a pure
         *  control-mode evening must NOT hunt BLE for glasses in the case. */
        fun startAndResume(context: Context) {
            val intent = Intent(context, ConnectionService::class.java).apply { action = ACTION_RESUME }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else @Suppress("DEPRECATION") context.startService(intent)
        }
    }
}
