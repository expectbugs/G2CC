package com.g2cc.g2cc.service

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothDevice
import android.content.Context
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
import com.g2cc.g2cc.net.ServerMessage
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
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
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
    private var syncJob: Job? = null          // 80-00 sync_trigger keepalive (both lenses)
    private var watchdogJob: Job? = null      // glasses-response gap watchdog (silent-drop detector)
    private var renewalJob: Job? = null       // periodic re-takeover (the ~120s app-slot lifetime)
    private var coldLaunchJob: Job? = null    // the cold-launch coroutine — tracked so teardown cancels it
    private var testJob: Job? = null          // the Test Display sequence coroutine — tracked for teardown
    private var sessionGen = 0                // bumped on teardown; a stale coroutine re-checks it before mutating
    private var recovering = false            // auto-recovery in progress (guard against re-trigger)
    private var wasServerMode = false         // re-enter server mode after a recovery
    @Volatile private var lastRecoverMs = 0L  // rate-limit auto-recoveries (no thrashing)
    @Volatile private var lastNotifyMs = 0L   // last notify (incl e0-00 ack) from R lens
    private var syncSeq = 0x10
    private var syncMsgId = 0x20
    private var connection: ConnectionManager? = null
    private var audioStreamer: AudioStreamer? = null      // server-driven dictation (audio_request)
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
    private val _launched = MutableStateFlow(false)
    val launched = _launched.asStateFlow()
    private val _connecting = MutableStateFlow(false)
    val connecting = _connecting.asStateFlow()
    private val _serverMode = MutableStateFlow(false)
    val serverMode = _serverMode.asStateFlow()
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
        DiagLog.start(scope)
        startInForeground()
        acquireWakeLock()
        DiagLog.log("svc", "ConnectionService onCreate — server ${BuildConfig.SERVER_HOST}:${BuildConfig.SERVER_PORT}, token=${if (BuildConfig.AUTH_TOKEN.isEmpty()) "MISSING" else "set"}")
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Connect is driven via an action so it doesn't depend on the bind round-trip
        // (the Activity startForegroundService()s us, then binds only to observe).
        if (intent?.action == ACTION_CONNECT) connect()   // connect() is idempotent (guards launched/connecting)
        // START_STICKY: with the battery-opt exemption, Android relaunches us after a kill.
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        teardown()
        releaseWakeLock()
        DiagLog.stop()
        scope.cancel()
        super.onDestroy()
    }

    // ----------------------------------------------------------------- commands (binder)

    fun connect() {
        if (_launched.value || _connecting.value) return
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
        teardown()
        setStatus("Disconnected.")
        _scene.value = null
        stopForegroundAndSelf()
    }

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
     *  On connect → os_attach; on `render` → setScene; ring events → `input`. */
    fun enterServerMode() {
        if (!_launched.value || _serverMode.value) return
        _serverMode.value = true
        // Single serialized render pump: server scenes go through a CONFLATED channel and ONE
        // consumer renders them one at a time. Without this, rapid scrolls each spawned their own
        // setScene coroutine and the concurrent BLE writes INTERLEAVED — corrupting a tile
        // mid-update. Conflation also drops stale intermediate scrolls so nav stays responsive.
        val ch = Channel<WireScene>(Channel.CONFLATED)
        sceneCh = ch
        renderConsumerJob = scope.launch {
            for (wire in ch) {
                val r = renderer ?: continue
                val sceneObj = try {
                    SceneCodec.toScene(wire, latestClockText)
                } catch (e: IllegalArgumentException) {
                    // LOUD AND PROUD — a bad scene from the server is surfaced, not dropped.
                    DiagLog.log("os", "BAD render scene: ${e.message}")
                    setStatus("Bad scene from server: ${e.message}")
                    continue
                }
                DiagLog.log("os", "render → setScene (${sceneObj.regions.size} regions: ${sceneObj.regions.joinToString { it.name }})")
                val ok = awaitSetScene(r, sceneObj)
                _scene.value = r.currentScene
                DiagLog.log("os", "render result=${if (ok) "OK" else "FAIL"}")
            }
        }
        val url = "ws://${BuildConfig.SERVER_HOST}:${BuildConfig.SERVER_PORT}/ws"
        DiagLog.log("os", "server mode → connecting $url")
        setStatus("Server mode: connecting to PC…")
        val cm = ConnectionManager(
            initialEndpoints = listOf(url),
            authToken = BuildConfig.AUTH_TOKEN,
            httpClient = OkHttpClient(),
            onMessage = { msg -> scope.launch { onServerMessage(msg) } },
            onConnected = {
                DiagLog.log("os", "WS authed → sending os_attach")
                connection?.send(ClientMessage.OsAttach)
                scope.launch { setStatus("Server mode: PC connected. Use the ring.") }
            },
            onDisconnected = { DiagLog.log("os", "WS disconnected") },
        )
        connection = cm
        cm.connect()
    }

    private fun onServerMessage(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.Render -> {
                // Hand off to the serialized render pump. CONFLATED: a newer scene replaces an
                // unconsumed one, so a burst of scrolls renders only the latest.
                if (sceneCh?.trySend(msg.scene)?.isSuccess != true)
                    DiagLog.log("os", "render dropped — render queue not active (not in server mode?)")
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
                            DiagLog.log("os", "audio_request start — already streaming (ignored)")
                            return
                        }
                        // Fresh streamer per start: binds the CURRENT ConnectionManager (a WS
                        // reconnect creates a new one; a cached streamer would talk to the corpse).
                        val s = AudioStreamer(MicCapture(applicationContext), conn)
                        audioStreamer = s
                        DiagLog.log("os", "audio_request start → mic streaming")
                        s.start()
                    }
                    "stop" -> {
                        DiagLog.log("os", "audio_request stop")
                        audioStreamer?.stop()
                    }
                    else -> DiagLog.log("os", "audio_request unknown action '${msg.action}' — ignored (LOUD)")
                }
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
            DiagLog.log("recover", "$side dropped ($reason) during recovery")
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
        DiagLog.log("conn", "both lenses Ready — R link mtu=${r.lastMtu} phy=${r.lastPhy} conn=${r.lastConnParams}")
        val rend = G2Renderer(BleDisplaySink(r)) { msg -> DiagLog.log("render", msg) }
        renderer = rend
        val gen = sessionGen
        coldLaunchJob = scope.launch {
            setStatus("Cold-launching Hub session…")
            val splash = scene {
                text("clock", OsLayout.CLOCK_X, OsLayout.CLOCK_Y, OsLayout.CLOCK_WIDTH, OsLayout.CLOCK_HEIGHT,
                    nowClock(), scroll = false, id = OsLayout.CLOCK_ID)
                text("main", 0, OsLayout.CONTENT_Y, Display.WIDTH, OsLayout.CONTENT_HEIGHT,
                    "G2 OS v${OsLayout.OS_VERSION}\n\nConnected.\n\nTap  Test  for the renderer test,\nor  Server  to let the PC drive\nthe display.", scroll = false, id = 2)
            }
            val ok = awaitLaunch(rend, splash)
            // Bail if teardown ran while we were launching — don't re-arm jobs against a
            // torn-down session (that stale completion used to leave recovery stalled).
            if (gen != sessionGen) { DiagLog.log("conn", "cold-launch result ignored — session torn down"); return@launch }
            if (ok) {
                DiagLog.log("conn", "cold-launch OK")
                setStatus("Connected. Tap Test Display.")
                startKeepalive()
                startClock()
                startSyncTrigger()
                startWatchdog()
                startRenewal()
                _scene.value = rend.currentScene
                if (recovering) {
                    recovering = false
                    DiagLog.log("recover", "reconnect + cold-launch OK after silent drop")
                    if (wasServerMode) { wasServerMode = false; enterServerMode() }
                }
            } else {
                // Reset so the dead-end can't permanently block recovery.
                DiagLog.log("conn", "cold-launch FAILED — resetting (launched=false) so a reconnect can retry")
                _launched.value = false
                _connecting.value = false
                if (recovering) { recovering = false; wasServerMode = false }
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
     *  revives it. Force a full teardown + reconnect + cold-launch, then re-attach server mode. */
    private fun recoverSession() {
        if (recovering) return
        recovering = true
        needsRelaunch = false
        wasServerMode = _serverMode.value
        lastRecoverMs = System.currentTimeMillis()
        DiagLog.log("recover", "SILENT DROP — auto-recovering: teardown + reconnect + cold-launch${if (wasServerMode) " + re-attach server" else ""}")
        setStatus("Auto-recovering (silent drop)…")
        teardown()        // full BLE teardown (clears launched/serverMode, cancels jobs; keeps cached devices)
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
                when {
                    sc.region(OsLayout.CLOCK_NAME) != null -> { r.setText(OsLayout.CLOCK_NAME, t); _scene.value = r.currentScene; lastWritten = t }
                    sc.region("status") != null -> { r.setText("status", "G2CC  $t"); _scene.value = r.currentScene; lastWritten = t }
                }
            }
        }
    }

    // ----------------------------------------------------------------- teardown

    private fun teardown() {
        tearingDown = true   // our own shutdownBle() disconnects must NOT trigger auto-recovery
        renderer?.abort("teardown")   // release any parked image-chunk ack-wait so the pump can't wedge
        keepaliveJob?.cancel(); keepaliveJob = null
        clockJob?.cancel(); clockJob = null
        renderConsumerJob?.cancel(); renderConsumerJob = null
        sceneCh?.close(); sceneCh = null
        syncJob?.cancel(); syncJob = null
        watchdogJob?.cancel(); watchdogJob = null
        renewalJob?.cancel(); renewalJob = null
        coldLaunchJob?.cancel(); coldLaunchJob = null
        testJob?.cancel(); testJob = null
        sessionGen++   // invalidate any in-flight cold-launch/test coroutine that completes after this
        stateJobs.forEach { it.cancel() }; stateJobs.clear()
        audioStreamer?.stop(); audioStreamer = null   // mic OFF with the session (never left running)
        connection?.shutdown(); connection = null
        _serverMode.value = false
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
        } catch (e: Exception) {
            DiagLog.log("svc", "startForeground with mic type FAILED (${e.message}) — retrying connectedDevice-only (dictation unavailable this run)")
            startForeground(NOTIF_ID, buildNotification(_status.value), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
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

        /** Start the FG service and tell it to connect. Survives Activity unbind / background. */
        fun startAndConnect(context: Context) {
            val intent = Intent(context, ConnectionService::class.java).apply { action = ACTION_CONNECT }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else @Suppress("DEPRECATION") context.startService(intent)
        }
    }
}
