package com.g2cc.g2cc.net

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.min

/**
 * Kotlin port of /home/user/g2aria/app/src/connection.ts (lines 52-359).
 *
 * Five independent defences against the "stuck state" problem:
 *
 *   1. SERVER-SIDE PINGS + APP-LEVEL HB. Server sends `hb` every
 *      HEARTBEAT_INTERVAL_MS; we auto-reply with `client_hb` so the server
 *      detects our JS event-loop / Kotlin coroutine freeze (protocol pongs
 *      fire at the network layer even when the app is paused, so they can't
 *      be trusted as liveness).
 *
 *   2. LIVENESS WATCHDOG. A 5-s tick calls forceReconnect() if no INBOUND
 *      message in LIVENESS_TIMEOUT_MS. Race-safe via a generation counter
 *      (AtomicInteger): handlers bound to an older websocket ignore their
 *      events, so a late old-socket onClosed can't null out the new socket.
 *
 *   3. ENDPOINT ROTATION. On pre-auth failure, rotate through all known
 *      endpoints (Tailscale → LAN → ...) before backing off, so a LAN-IP
 *      change doesn't kill the Tailscale path.
 *
 *   4. ENDPOINT REFRESH. On each successful connect, re-fetch /endpoints
 *      from the bootstrap host (via EndpointFetcher) — always has current
 *      set.
 *
 *   5. LAST-RESORT CONNECTION-STACK REBUILD. If we've been offline for
 *      STUCK_RELOAD_MS despite all the above, fire onStuckTooLong. The owner
 *      (G2Pipeline.restartConnectionStack) tears down this ConnectionManager +
 *      streamer and builds a fresh stack from a clean state — re-reading token +
 *      endpoints from prefs and reconnecting from zero. "Offline duration" is
 *      measured from offlineSince, NOT lastAuthedAt (see ensureLivenessWatchdog).
 *
 * Constants below mirror /home/user/G2CC/shared/src/constants.ts.
 */
class ConnectionManager(
    initialEndpoints: List<String>,
    private val authToken: String,
    private val httpClient: OkHttpClient,
    /** Called when an inbound message arrives (after auth + non-hb). */
    private val onMessage: (ServerMessage) -> Unit,
    private val onConnected: () -> Unit = {},
    private val onDisconnected: () -> Unit = {},
    private val onAuthFailure: (consecutiveCount: Int) -> Unit = {},
    /** Defence #5 — invoked when offline past STUCK_RELOAD_MS. The owner rebuilds
     *  the connection stack from a clean state (G2Pipeline.restartConnectionStack). */
    private val onStuckTooLong: () -> Unit = {},
) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // 4th-pass pre-existing: @Volatile so reads from the OkHttp dispatcher
    // thread (onClosed/onFailure/onMessage) and from caller threads (send/
    // sendBinary) see consistent updates.
    @Volatile private var ws: WebSocket? = null
    private val wsGen = AtomicInteger(0)

    // Mutated from both the OkHttp dispatcher thread (onClosed / onFailure) and
    // from refreshEndpoints (scope.launch on Dispatchers.IO). @Volatile + the
    // safe-index pattern on read prevents IOOBE if endpoints shrinks between
    // a read of `endpoints` and `endpoints[currentEndpointIdx]`.
    @Volatile private var endpoints: List<String> = initialEndpoints
    @Volatile private var currentEndpointIdx = 0
    @Volatile private var endpointsTriedSinceSuccess = 0
    private var reconnectDelayMs = RECONNECT_BASE_MS
    private var consecutiveAuthFailures = 0
    // @Volatile: written by onMessage (OkHttp dispatcher thread); read by the
    // liveness-watchdog coroutine on Dispatchers.IO. Visibility-only — no
    // atomicity needed since the value is a monotonically increasing timestamp
    // and a single relaxed read+compare is fine.
    @Volatile private var lastMessageReceivedAt = System.currentTimeMillis()
    // @Volatile: written on OkHttp dispatcher threads (onMessage AuthResult / onClosed / onFailure),
    // read+written by the Dispatchers.IO liveness watchdog. Restores the happens-before edge so the
    // defence-#5 reset (reloadAttempted=false on re-auth) is visible and last-resort recovery can't
    // stay permanently disarmed. (Each site is a single read or single write; the only test-then-set,
    // reloadAttempted, is single-threaded within the watchdog coroutine.)
    @Volatile private var lastAuthedAt: Long? = null
    @Volatile private var offlineSince: Long? = null
    private var attemptCount = 0
    @Volatile private var reloadAttempted = false

    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    private val _events = MutableSharedFlow<ServerMessage>(extraBufferCapacity = 64)
    val events: SharedFlow<ServerMessage> = _events.asSharedFlow()

    private var livenessJob: Job? = null
    private var clientHbJob: Job? = null
    private var reconnectJob: Job? = null

    // 4th-pass review LOW (BLE bug 10): `endpoints` + `currentEndpointIdx`
    // mutations need atomicity so a concurrent rotation in onClosed/onFailure
    // doesn't race with a swap-out from setEndpoints. Without the lock, the
    // size-then-modulo read could land on a stale size after `endpoints`
    // already shrunk. The getOrNull safety net catches the IOOBE but the
    // diag log line for "rotating to endpoint X" reads "<unknown>".
    private val endpointsLock = Any()

    fun setEndpoints(newEndpoints: List<String>) {
        if (newEndpoints.isEmpty()) return
        synchronized(endpointsLock) {
            if (newEndpoints == endpoints) return
            endpoints = newEndpoints
            currentEndpointIdx = min(currentEndpointIdx, endpoints.size - 1)
            endpointsTriedSinceSuccess = 0
        }
    }

    fun connect() {
        // Bug fix #5: don't reconnect if we already have a healthy authed
        // socket. (g2aria's TS check on `readyState === OPEN` doesn't translate
        // directly — OkHttp's WebSocket doesn't expose readyState. Use our
        // `_connected` flag, which flips true on auth_result success.)
        if (ws != null && _connected.value) return
        // Defensive: close a superseded, not-yet-authed socket (reconnectJob vs forceReconnect race —
        // Job.cancel() can't abort connect()'s non-suspending body). The wsGen bump already neutralizes
        // its listener; closing prevents a transient half-open socket leak. Empty catch is OK here:
        // best-effort close of an already-superseded socket whose listener is dead.
        ws?.let { old -> try { old.close(4101, "superseded") } catch (_: Exception) {} }
        // 4th-pass-final review HIGH: read (endpoints, idx) pair inside the
        // same lock that gates setEndpoints/onClosed/onFailure rotations.
        // Without this lock, a concurrent setEndpoints could shrink the
        // list between the `endpoints` deref and the `currentEndpointIdx`
        // read, returning null/wrong endpoint despite well-formed state.
        // This DEFEATED the prior endpointsLock fix.
        val endpoint = synchronized(endpointsLock) {
            endpoints.getOrNull(currentEndpointIdx)
        } ?: run {
            Log.w(TAG, "connect: no endpoints configured")
            return
        }
        wsGen.incrementAndGet()
        val myGen = wsGen.get()
        val request = Request.Builder().url(endpoint).build()
        val listener = G2CCListener(myGen)
        Log.i(TAG, "connect[$myGen] -> $endpoint")
        ws = httpClient.newWebSocket(request, listener)
        ensureLivenessWatchdog()
    }

    fun disconnect() {
        reconnectJob?.cancel(); reconnectJob = null
        livenessJob?.cancel(); livenessJob = null
        clientHbJob?.cancel(); clientHbJob = null
        // NET-10: invalidate the old socket's listener (mirror forceReconnect) so
        // a late onClosed from this deliberate disconnect can't run its
        // attemptCount++/scheduleReconnect body and spawn an unwanted reconnect.
        wsGen.incrementAndGet()
        try { ws?.close(1000, "client disconnect") } catch (e: Exception) {
            Log.w(TAG, "close threw", e)
        }
        ws = null
        _connected.value = false
    }

    /** PIPE-6: returns true iff the message was accepted by the socket. Callers
     *  that strand the user on a "waiting" frame (e.g. Send-to-Claude) MUST check
     *  this — a tap during a reconnect blip used to drop the prompt silently.
     *  Statement callers can still ignore the result. */
    fun send(msg: ClientMessage): Boolean {
        // A-H3: loud-fail on send before the socket is ready. The brief window
        // between _connected.value=false and forceReconnect()'s new socket is a
        // real period where messages used to vanish invisibly.
        val w = ws ?: run {
            Log.w(TAG, "send(${msg::class.simpleName}) before socket ready — message dropped")
            return false
        }
        // Drop non-Auth messages sent before the server confirmed our Auth.
        // Without this guard, any diag emission (BT state change, BLE link
        // update, post-Ready watchdog log) firing in the brief window between
        // socket-open and AuthResult triggers the server's "Not authenticated"
        // error, which the phone then renders to the HUD verbatim. Auth itself
        // must always go through — that's what gets us to _connected=true.
        if (!_connected.value && msg !is ClientMessage.Auth) {
            Log.w(TAG, "send(${msg::class.simpleName}) before WS auth — dropping")
            return false
        }
        return try {
            val text = WsJson.codec.encodeToString(ClientMessage.serializer(), msg)
            // OkHttp's WebSocket.send() returns false when the message couldn't
            // be enqueued — buffer full (16 MiB cap) or socket closing. Used to
            // be silently dropped; surface loudly per LOUD AND PROUD.
            val accepted = w.send(text)
            if (!accepted) {
                Log.w(TAG, "OkHttp.send(${msg::class.simpleName}) returned false — message dropped (buffer full or closing)")
            }
            accepted
        } catch (e: Exception) {
            Log.w(TAG, "send threw", e)
            false
        }
    }

    /** Send binary frame (Phase 8 audio streaming between audio_start/audio_end).
     *  Returns true iff accepted by the socket (NET-6 enabler: lets the caller
     *  detect sustained uplink drops). */
    fun sendBinary(payload: ByteArray): Boolean {
        // A-H3: same loud-fail logic as send() — audio frames at ~50 Hz are
        // exactly the case where silent drops would be invisible until the
        // server reports "audio too short" with no clue why.
        val w = ws ?: run {
            Log.w(TAG, "sendBinary(${payload.size}B) before socket ready — frame dropped")
            return false
        }
        // 4th-pass review HIGH: same pre-auth guard as send(). Without this,
        // text send() drops AudioStart mid-handshake but sendBinary keeps
        // pushing PCM frames — server receives binary it can't decode
        // (missing format announcement), then AudioEnd. Net result: one
        // recording silently corrupted per WS-reconnect race. Drop binary
        // pre-auth so the audio_start/binary/audio_end triple stays
        // consistent: all-or-nothing.
        if (!_connected.value) {
            Log.w(TAG, "sendBinary(${payload.size}B) before WS auth — frame dropped")
            return false
        }
        return try {
            // NET-12: no spread (*payload) — ByteString.of(vararg) would copy the
            // whole array AGAIN on top of MicCapture's per-frame copyOf(). The
            // toByteString(offset, len) extension copies the range once.
            val accepted = w.send(payload.toByteString(0, payload.size))
            if (!accepted) {
                Log.w(TAG, "OkHttp.send(binary ${payload.size}B) returned false — frame dropped (buffer full or closing)")
            }
            accepted
        } catch (e: Exception) {
            Log.w(TAG, "sendBinary threw", e)
            false
        }
    }

    /** Tear down whatever we think we have and reconnect immediately. Race-safe
     *  via the wsGen bump BEFORE touching the old socket. */
    fun forceReconnect() {
        reconnectJob?.cancel(); reconnectJob = null
        wsGen.incrementAndGet()                       // BEFORE close → late events from old socket bail
        try { ws?.close(4099, "force-reconnect") } catch (e: Exception) {
            Log.w(TAG, "forceReconnect close threw", e)
        }
        ws = null
        _connected.value = false
        clientHbJob?.cancel(); clientHbJob = null
        if (offlineSince == null) offlineSince = System.currentTimeMillis()
        onDisconnected()
        reconnectDelayMs = RECONNECT_BASE_MS
        lastMessageReceivedAt = System.currentTimeMillis()
        connect()
    }

    /** Cleanup. */
    fun shutdown() {
        disconnect()
        scope.cancel()
    }

    private inner class G2CCListener(private val myGen: Int) : WebSocketListener() {
        private fun isStale(): Boolean = wsGen.get() != myGen

        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (isStale()) {
                // 4th-pass review LOW (bug 14): expected exception, still log
                // at DEBUG so audit-grep doesn't find a bare catch.
                try { webSocket.close(4100, "stale") } catch (e: Exception) { Log.d(TAG, "close threw on stale onOpen", e) }
                return
            }
            lastMessageReceivedAt = System.currentTimeMillis()
            // Send auth FIRST.
            send(ClientMessage.Auth(authToken))
            ensureLivenessWatchdog()
            ensureClientHbTimer()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (isStale()) return
            lastMessageReceivedAt = System.currentTimeMillis()
            val msg = try {
                WsJson.codec.decodeFromString(ServerMessage.serializer(), text)
            } catch (e: Exception) {
                Log.w(TAG, "onMessage parse failed: ${e.message}; raw=${text.take(120)}")
                // Loud-and-proud: this class only logs to logcat, so a dropped
                // inbound message is invisible over SSH — a fractional-double mtime
                // silently killing the directory_list_reply was exactly this. Echo
                // the decode failure to the server diag log (best-effort; the send
                // guard drops it pre-auth, which is fine).
                try {
                    send(ClientMessage.Diag("[ws-decode-FAIL] ${e.message}; raw=${text.take(160)}"))
                } catch (_: Exception) { /* never mask the original failure */ }
                return
            }
            when (msg) {
                is ServerMessage.AuthResult -> {
                    if (msg.success) {
                        _connected.value = true
                        consecutiveAuthFailures = 0
                        reconnectDelayMs = RECONNECT_BASE_MS
                        endpointsTriedSinceSuccess = 0
                        attemptCount = 0
                        offlineSince = null
                        lastAuthedAt = System.currentTimeMillis()
                        // 4th-pass review HIGH: reset reloadAttempted on
                        // every successful auth. Without this, after the
                        // first STUCK_RELOAD_MS fire the last-resort
                        // recovery is permanently disarmed for the process
                        // lifetime — subsequent stucks have no escape.
                        reloadAttempted = false
                        onConnected()
                        // 4th-pass-final review LOW: read endpoint inside the
                        // lock so concurrent setEndpoints can't make this log
                        // misreport.
                        val authedEndpoint = synchronized(endpointsLock) {
                            endpoints.getOrNull(currentEndpointIdx)
                        } ?: "<unknown>"
                        Log.i(TAG, "auth success endpoint=$authedEndpoint")
                    } else {
                        consecutiveAuthFailures++
                        onAuthFailure(consecutiveAuthFailures)
                        Log.w(TAG, "auth failed (#$consecutiveAuthFailures): ${msg.error}")
                        // Server closes us with 4003; let onClosed drive the reconnect.
                    }
                }
                is ServerMessage.Hb -> {
                    // Reply immediately so the server knows our event loop is alive.
                    send(ClientMessage.ClientHb(System.currentTimeMillis()))
                }
                else -> {
                    onMessage(msg)
                    // A-H4: tryEmit returns false when the SharedFlow buffer is
                    // full (extraBufferCapacity=64, BufferOverflow.SUSPEND default
                    // → tryEmit drops). Used to be silently dropped; downstream
                    // SharedFlow collectors that are slow would lose protocol
                    // messages invisibly. LOUD AND PROUD.
                    val accepted = _events.tryEmit(msg)
                    if (!accepted) {
                        Log.w(TAG, "SharedFlow buffer overflow — dropped ${msg::class.simpleName} (slow collector?)")
                    }
                }
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            // Phase 6 doesn't expect server→client binary frames; surface loudly if they appear.
            Log.w(TAG, "unexpected binary frame size=${bytes.size}")
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            // Acknowledge the close handshake. 4th-pass review LOW (bug 14):
            // log expected exception at DEBUG so audit-grep stays clean.
            try { webSocket.close(code, reason) } catch (e: Exception) { Log.d(TAG, "close in onClosing threw", e) }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (isStale()) return
            val wasConnected = _connected.value
            ws = null
            _connected.value = false
            clientHbJob?.cancel(); clientHbJob = null

            if (offlineSince == null) offlineSince = System.currentTimeMillis()
            attemptCount++

            onDisconnected()

            // Rotate endpoints if we never reached success on this attempt.
            // 4th-pass review LOW: snap endpoints + idx under the lock so
            // a concurrent setEndpoints can't shrink the list mid-modulo.
            val completedFullRotation = synchronized(endpointsLock) {
                if (!wasConnected && endpoints.size > 1) {
                    endpointsTriedSinceSuccess++
                    currentEndpointIdx = (currentEndpointIdx + 1) % endpoints.size
                }
                !wasConnected && endpointsTriedSinceSuccess >= endpoints.size
            }
            scheduleReconnect(immediate = !completedFullRotation && !wasConnected)
            Log.i(TAG, "closed code=$code reason=\"$reason\" wasConnected=$wasConnected attempt=$attemptCount")
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (isStale()) return
            Log.w(TAG, "onFailure ${t.message} response=${response?.code}")
            // onFailure does NOT trigger onClosed; replicate the close path.
            ws = null
            _connected.value = false
            clientHbJob?.cancel(); clientHbJob = null
            if (offlineSince == null) offlineSince = System.currentTimeMillis()
            attemptCount++
            onDisconnected()
            val moreToTry = synchronized(endpointsLock) {
                if (endpoints.size > 1) {
                    endpointsTriedSinceSuccess++
                    currentEndpointIdx = (currentEndpointIdx + 1) % endpoints.size
                }
                endpointsTriedSinceSuccess < endpoints.size
            }
            scheduleReconnect(immediate = moreToTry)
        }
    }

    private fun ensureLivenessWatchdog() {
        if (livenessJob?.isActive == true) return
        livenessJob = scope.launch {
            while (true) {
                delay(LIVENESS_CHECK_MS)
                // "Stuck" = OFFLINE for STUCK_RELOAD_MS, measured from when we
                // went offline (offlineSince), gated on having authed at least
                // once (lastAuthedAt != null — a never-connected socket is a
                // config problem a restart won't fix). The prior code measured
                // `now - lastAuthedAt`, which after a long healthy session is
                // already ≫ STUCK_RELOAD_MS the instant the socket drops, so the
                // last-resort recovery fired on the FIRST tick instead of after
                // 90s of failed reconnects — defeating the staged escalation.
                val offlineMs = offlineSince?.let { System.currentTimeMillis() - it } ?: 0L
                if (!_connected.value && lastAuthedAt != null && offlineSince != null
                    && offlineMs > STUCK_RELOAD_MS && !reloadAttempted) {
                    reloadAttempted = true
                    Log.w(TAG, "offline for ${offlineMs}ms despite reconnect attempts — invoking onStuckTooLong (last resort)")
                    onStuckTooLong()
                    continue
                }
                if (ws == null) continue
                val silent = System.currentTimeMillis() - lastMessageReceivedAt
                if (silent > LIVENESS_TIMEOUT_MS) {
                    Log.w(TAG, "silent for ${silent}ms — forcing reconnect")
                    forceReconnect()
                }
            }
        }
    }

    /** Proactive client heartbeat in addition to replying to server hbs.
     *  Guarantees app-level activity even if the server's hb is dropped. */
    private fun ensureClientHbTimer() {
        clientHbJob?.cancel()
        val myGen = wsGen.get()
        clientHbJob = scope.launch {
            while (wsGen.get() == myGen) {
                delay(HEARTBEAT_INTERVAL_MS)
                if (wsGen.get() != myGen) break
                send(ClientMessage.ClientHb(System.currentTimeMillis()))
            }
        }
    }

    private fun scheduleReconnect(immediate: Boolean) {
        reconnectJob?.cancel()
        val delayMs = if (immediate) 0L else reconnectDelayMs
        reconnectJob = scope.launch {
            if (delayMs > 0) delay(delayMs)
            if (!immediate) {
                reconnectDelayMs = (reconnectDelayMs.toDouble() * RECONNECT_MULTIPLIER)
                    .toLong().coerceAtMost(RECONNECT_MAX_MS)
            }
            connect()
        }
    }

    companion object {
        const val TAG = "G2CCConnection"

        // Mirrors /home/user/G2CC/shared/src/constants.ts.
        const val HEARTBEAT_INTERVAL_MS = 10_000L
        const val LIVENESS_TIMEOUT_MS = 30_000L
        const val LIVENESS_CHECK_MS = 5_000L
        const val STUCK_RELOAD_MS = 90_000L

        const val RECONNECT_BASE_MS = 1_000L
        const val RECONNECT_MAX_MS = 30_000L
        const val RECONNECT_MULTIPLIER = 1.5
    }
}
