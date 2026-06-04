package com.g2cc.g2cc

import android.content.Context
import android.util.Log
import com.g2cc.g2cc.audio.AudioStreamer
import com.g2cc.g2cc.audio.MicCapture
import com.g2cc.g2cc.ble.BleScanner
import com.g2cc.g2cc.ble.EventParser
import com.g2cc.g2cc.ble.G2BleClient
import com.g2cc.g2cc.ble.PairingState
import com.g2cc.g2cc.ble.Side
import com.g2cc.g2cc.hud.ConfirmationFlow
import com.g2cc.g2cc.hud.EvenHud
import com.g2cc.g2cc.hud.Hud
import com.g2cc.g2cc.hud.MenuController
import com.g2cc.g2cc.hud.RootMenu
import com.g2cc.g2cc.hud.SttConfirmationFlow
import com.g2cc.g2cc.net.ClientMessage
import com.g2cc.g2cc.net.ConnectionManager
import com.g2cc.g2cc.net.EndpointFetcher
import com.g2cc.g2cc.net.ServerMessage
import com.g2cc.g2cc.state.AppState
import com.g2cc.g2cc.state.StateMachine
import com.g2cc.g2cc.storage.Prefs
import com.g2cc.g2cc.ble.ConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.time.Duration
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Top-level Phase 6 integration: ConnectionManager ↔ HUD ↔ BLE clients.
 *
 * Lifecycle is driven by the foreground service (G2CCService). This class
 * owns the WebSocket connection and the HUD renderer; the BLE clients are
 * passed in (the service decides when to scan + connect to glasses, which
 * is a hardware-gated step per Phase 5 README).
 *
 * Phase 6 ships the message pipeline:
 *   - ConnectionManager.events → if Output/TextDelta → hud.render()
 *   - ConnectionManager.events → if DispatchTargetList → menu.dispatchTargets = ...
 *   - ConnectionManager.events → if DirectoryListReply → menu.directories = ...
 *   - ConnectionManager.events → if ConfirmOnHud → render + await tap (Phase 7)
 *
 * Phase 7 wires the confirm-on-hud round-trip; the BLE ack is sent inline
 * from ConfirmationFlow.onConfirmRequest after hud.render drains (the prior
 * AckEmitter stub was obsoleted and deleted in the third-pass cleanup).
 * Phase 8 wires the audio capture path.
 */
class G2Pipeline(
    private val context: Context,
    private val prefs: Prefs,
    private val pairing: PairingState,
    private val httpClient: OkHttpClient = defaultHttpClient(),
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val state = StateMachine()

    // Visible BLE state for the foreground-service notification + diagnostics.
    // Updated from observeBleHealth as the per-lens ConnectionState flows
    // change. Without this, the only signal of BLE state is the per-lens flows
    // (not collected by anything except observeBleHealth itself) — Adam has no
    // way to tell if pairing succeeded.
    //
    // Also: a coroutine started in start() forwards every change here to the
    // server as a DiagMsg, so the notification doesn't have to be the only
    // observable surface (it updates too fast for a human to read by eye).
    private val _bleStatus = MutableStateFlow("scanning")
    val bleStatus: StateFlow<String> = _bleStatus.asStateFlow()

    var leftBle: G2BleClient? = null
    var rightBle: G2BleClient? = null
    private var hud: Hud? = null
    private var menu: MenuController? = null
    private var confirmation: ConfirmationFlow? = null
    private var sttConfirmation: SttConfirmationFlow? = null
    private var connection: ConnectionManager? = null
    private var streamer: AudioStreamer? = null

    private var rootMenu: RootMenu? = null
    private var evenHud: EvenHud? = null
    // AtomicReference so writes from the BLE handler thread (scan callback) are
    // visible from the main thread (stop()) without a torn-reference race.
    private val bleScannerRef = AtomicReference<BleScanner?>(null)
    // Collector job handles — stored so installBleClients can cancel before
    // re-launching on a re-install (e.g. post-reconnect after BLE disconnect).
    // Without this, every re-install leaks a coroutine that keeps firing
    // onTap/onDoubleTap from the OLD flow.
    private var leftCollectorJob: Job? = null
    private var rightCollectorJob: Job? = null
    // 4th-pass review HIGH (BLE bug 8): observeBleHealth also leaks its outer
    // launch + the two nested per-side state.collect launches on every
    // installBleClients call. Each post-Ready watchdog rescan stacked another
    // observer pair. Stored here so installBleClients can cancel the prior
    // observer set before launching a new one.
    private var bleHealthJob: Job? = null
    // Forwards bleStatus → server diag. Tracked so the defence-#5 connection
    // rebuild (restartConnectionStack) can cancel it before start() relaunches
    // it, instead of stacking a second collector per rebuild.
    private var bleStatusJob: Job? = null

    // Heartbeat job — keeps the teleprompter HUD session alive against the
    // ~10-second firmware idle timeout (confirmed 2026-06-01: render
    // succeeded, text displayed, session terminated 10 s later with no
    // intervening packets). Periodically re-issues sync_trigger which is the
    // lightest known teleprompter-flow packet. Allowed under the no-timeouts
    // rule (annotated as HB pacing, not a clock-kill).
    private var heartbeatJob: Job? = null
    private val heartbeatTickCount = java.util.concurrent.atomic.AtomicInteger(0)

    // Post-Ready BLE watchdog. If a side drops post-Ready and Nordic's
    // useAutoConnect(true) fails to bring it back within a grace window,
    // tear down the BleManager and full-rescan. Catches stale GATT / bond
    // edge cases and "glasses powered off long enough to drop bond".
    //
    // Iter 2 (2026-06-02): was 45_000 — way too long. With 5s BLE
    // supervision timeout already burned by the time we get the
    // Disconnected event, an additional 45s wait pushed total recovery
    // to ~60s after body-block (matches Adam's "took over a minute"
    // report). Nordic's passive autoConnect is slow; if it hasn't
    // recovered within 5s of the supervision timeout firing, it
    // probably won't for tens of seconds. Force-rescan aggressively.
    private var postReadyWatchdogJob: Job? = null
    private val POST_READY_RECOVERY_MS = 5_000L

    // Session-scoped "has this pipeline EVER successfully rendered the HUD?"
    // flag. Outlives individual BLE client rebuilds (post-Ready watchdog
    // force-rescans null leftBle/rightBle and creates new clients) so the
    // next Ready edge can take the fast-render path instead of treating
    // every full-rebuild as a brand-new install. Reset only by stop().
    private val sessionHasRenderedOnce = java.util.concurrent.atomic.AtomicBoolean(false)

    // Pending HUD content. Display-independence audit finding #3 (CRITICAL):
    // when ServerMessage.Output arrives but HUD is unavailable (hud null,
    // BLE down, body-blocked), we previously dropped the text on the floor.
    // CC server-side scrollback holds it but the client never auto-replays.
    // This buffer holds the most recent intent so onBothReadyEdge can show
    // it as soon as BLE comes back. Always shadows Hud.lastRenderedText.
    @Volatile private var pendingHudText: String? = null

    // Phase Ω: tracks whether the most recent DispatchTargetSelect/DirectoryList
    // was initiated by the RootMenu flow. When true, the next DirectoryListReply
    // replaces the menu's current "Loading directories…" frame with a list of
    // real Action items. When false, DirectoryListReply still feeds MenuController
    // (the legacy teleprompter-mode menu) for backwards compat. Set true by the
    // Claude Code action; cleared once the reply lands or a CcError aborts.
    @Volatile private var menuAwaitingDirectoryList: Boolean = false

    // Phase Ω: tracks whether the next SessionInfo should land in the menu's
    // current frame (replacing a "Spawning…" placeholder). Set true when the
    // user taps a directory entry in the menu's directory submenu; cleared
    // when SessionInfo or CcError arrives.
    @Volatile private var menuAwaitingSessionInfo: Boolean = false

    // M4: tracks the active CC session's project name (or null if no session
    // is active). Set when SessionInfo arrives, cleared on switch-project
    // / exit-session. Drives whether "Claude Code" in the root menu shows
    // the directory picker (no session) or the active-session menu
    // (Record prompt / Switch project / Exit).
    @Volatile private var activeCcProjectName: String? = null

    // === EvenHub display path (the proven DocuLens-hijack, probe v12) ===
    //
    // When true (default), the pipeline drives the glasses via the EvenHub
    // `e0-20` channel: cold-launch the DocuLens slot, render the g2code-style
    // two-region UI (menu-header status bar + menu-list / main content) through
    // EvenHud, hold the session with the `f1=12` keepalive (every ~4 s), and take
    // input from the firmware's native `e0-01` selection events. This is Adam's
    // chosen primary path ("build the whole thing on the hijack", 2026-06-04).
    // The teleprompter path (the else-branches below) stays as the escape hatch:
    // set this false to revert to the Phase-D-proven teleprompter renderer.
    private val EVENHUB_ENABLED: Boolean = true

    // True once cold-launch has established the EvenHub session — so the menu
    // render callback knows the first frame already shipped (via coldLaunch) and
    // subsequent frames are plain content-updates. Reset on every BLE drop.
    private val evenHubLaunched = java.util.concurrent.atomic.AtomicBoolean(false)

    // Latest server `status` fields, folded into the EvenHub status bar on the
    // NEXT render (we don't re-render on a status change alone — that would
    // flicker the whole screen; g2code-style flicker-free per-field upgrade is a
    // later refinement).
    @Volatile private var statusMode: String = ""
    @Volatile private var statusContextPct: Int = 0
    @Volatile private var statusProcessing: Boolean = false

    // Pipeline start timestamp + run ID for diag correlation. Every diag()
    // emission is prefixed with [T+s] so we can tell when each event
    // happened on the client side (server-side timestamp can lag due to WS
    // buffering / network delay). The runId is a short random ID stamped
    // at pipeline construction so we can tell multiple test runs apart in
    // the same server log.
    private val pipelineStartMs: Long = System.currentTimeMillis()
    private val runId: String = "%04x".format((pipelineStartMs and 0xFFFF).toInt())

    /** Emit a diag with timestamp + run-ID prefix. All client-side
     *  diagnostics should go through this rather than connection?.send()
     *  directly so we always get consistent timestamping. */
    private fun diag(text: String) {
        val ts = "%.1f".format((System.currentTimeMillis() - pipelineStartMs) / 1000.0)
        connection?.send(ClientMessage.Diag("[$runId T+${ts}s] $text"))
    }

    /** Public diag entry-point for receivers / external callers. Same format
     *  as the private diag() — timestamp + run-ID prefix — so all diag lines
     *  in the server log are correlatable. */
    fun emitDiag(text: String) = diag(text)

    /** Build the root menu. "Claude Code" routes to either the directory
     *  picker (no active session) or the active-session submenu via
     *  [enterCcMenu]. Other items remain placeholders pending their own
     *  feature module implementations.
     *
     *  M1: instantiated unconditionally now (was Phase Y-gated). The
     *  RootMenu is the primary user input surface in teleprompter mode. */
    private fun buildRootMenuItems(): List<RootMenu.MenuItem> = listOf(
        RootMenu.MenuItem.Action("Claude Code") {
            enterCcMenu()
        },
        RootMenu.MenuItem.Action("Aria") {
            diag("rootMenu: tap → Aria (placeholder)")
        },
        RootMenu.MenuItem.Action("SMS") {
            diag("rootMenu: tap → SMS (placeholder)")
        },
        RootMenu.MenuItem.Action("Email") {
            diag("rootMenu: tap → Email (placeholder)")
        },
        RootMenu.MenuItem.Action("Calendar") {
            diag("rootMenu: tap → Calendar (placeholder)")
        },
        RootMenu.MenuItem.Action("Settings") {
            diag("rootMenu: tap → Settings (placeholder)")
        },
    )

    /** M4: route the user into the right CC submenu based on whether a CC
     *  session is already active. No session → directory picker flow.
     *  Active session → Record prompt / Switch project / Exit. */
    private fun enterCcMenu() {
        val rm = rootMenu ?: return
        val activeName = activeCcProjectName
        if (activeName == null) {
            startCcDispatchFromMenu()
        } else {
            rm.pushSubmenu(
                title = "Claude Code: $activeName",
                items = buildActiveCcMenuItems(activeName),
            )
        }
    }

    /** M4: the active-CC submenu items. "Record prompt" toggles the audio
     *  streamer; the recording-in-progress state replaces this frame with
     *  a "(recording — tap to stop)" item via [toggleRecording]. */
    private fun buildActiveCcMenuItems(projectName: String): List<RootMenu.MenuItem> = listOf(
        RootMenu.MenuItem.Action("Record prompt") {
            toggleRecording()
        },
        RootMenu.MenuItem.Action("Switch project") {
            activeCcProjectName = null
            startCcDispatchFromMenu()
        },
        RootMenu.MenuItem.Action("Exit session") {
            // Server-side session close not yet wired from this entry point;
            // for now, just drop client-side tracking. Server keeps the
            // process alive until next switch.
            activeCcProjectName = null
            rootMenu?.popToRoot()
            diag("rootMenu: exit session → cleared local activeCcProjectName")
        },
    )

    /** M4: toggle recording. Recursive in spirit — the in-recording frame's
     *  tap-to-stop Action calls this same method again, which sees
     *  isStreaming=true and stops. */
    private fun toggleRecording() {
        val s = streamer ?: run {
            diag("toggleRecording: streamer not initialized")
            return
        }
        val rm = rootMenu ?: return
        if (s.isStreaming) {
            s.stop()
            // While the server is transcribing, show a transient "wait"
            // frame so the user knows something is happening. SttResult
            // arrival will replace this with the confirmation submenu.
            rm.replaceCurrentFrame(
                title = "Processing",
                items = listOf(RootMenu.MenuItem.Action("(transcribing…)") {}),
            )
            state.transition(AppState.AWAITING_TRANSCRIPT)
            diag("toggleRecording: stopped streamer; showing transcribing frame")
        } else {
            s.start()
            rm.replaceCurrentFrame(
                title = "Recording",
                items = listOf(
                    RootMenu.MenuItem.Action("(recording — tap to stop)") {
                        toggleRecording()
                    },
                ),
            )
            state.transition(AppState.AWAITING_TRANSCRIPT)
            diag("toggleRecording: started streamer; showing recording frame")
        }
    }

    /** Tapping a directory entry in the menu's directory submenu fires this —
     *  sends DirectorySelect(path) which the server responds to with a
     *  SessionInfo (success) or CcError (failure). Replaces the current
     *  frame with a "Spawning…" placeholder so the user sees the request
     *  is in flight; dispatchInbound's SessionInfo/CcError handlers update
     *  the frame to success/error. */
    private fun selectDirectoryFromMenu(path: String, displayName: String) {
        val rm = rootMenu
        val cm = connection
        if (rm == null || cm == null) {
            diag("rootMenu: directory_select — rootMenu=${rm != null} connection=${cm != null} — abort")
            return
        }
        diag("rootMenu: tap → directory '$displayName' ($path) — requesting CC spawn")
        menuAwaitingSessionInfo = true
        cm.send(ClientMessage.DirectorySelect(path))
        // R6-MEDIUM: addBack=true so user can bail out if spawn is slow or
        // wedged (per no-timeouts rule there is no server-side cap, so the
        // user needs an explicit escape).
        rm.replaceCurrentFrame("Claude Code", listOf(
            RootMenu.MenuItem.Action("(spawning $displayName…)") {},
        ), addBack = true)
    }

    /** Phase Ω: first feature-module wiring. Tapping "Claude Code" in the
     *  root menu fires this — sends DispatchTargetSelect("cc") which the
     *  server responds to with both DispatchTargetSet AND DirectoryListReply
     *  (the auto-push behavior is ws-handler.ts:253-255). Pushes a transient
     *  "Loading directories…" frame so the user gets immediate feedback;
     *  dispatchInbound replaces it with the real list when the reply lands. */
    private fun startCcDispatchFromMenu() {
        val rm = rootMenu
        val cm = connection
        if (rm == null || cm == null) {
            diag("rootMenu: CC dispatch — rootMenu=${rm != null} connection=${cm != null} — abort")
            return
        }
        diag("rootMenu: tap → Claude Code — requesting dispatch + directory list")
        menuAwaitingDirectoryList = true
        cm.send(ClientMessage.DispatchTargetSelect("cc"))
        rm.pushSubmenu("Claude Code", listOf(
            RootMenu.MenuItem.Action("(loading directories…)") {
                // Tap on the loading row is a no-op visually; user can use
                // "← Back" (auto-prepended by pushSubmenu) to abort.
            },
        ))
    }

    /** Scan or directed-connect to the G2 lens pair, then install BLE clients.
     *  Idempotent — calling twice is a no-op if BLE clients are already installed.
     *
     *  Spec compliance fix: if a saved pair exists in PairingState (CLAUDE.md
     *  "BLE bonding state survives across app restarts"), do a DIRECTED connect
     *  via BluetoothAdapter.getRemoteDevice() and skip the scan entirely.
     *  Falls back to scan only if the directed connect throws (e.g. invalid
     *  saved address, BT not enabled). Saves battery + reconnect latency on
     *  every wake-from-Doze.
     */
    @android.annotation.SuppressLint("MissingPermission")
    fun scanAndConnect() {
        if (leftBle != null && rightBle != null) {
            Log.i(TAG, "scanAndConnect: BLE already installed")
            return
        }
        if (bleScannerRef.get() != null) {
            Log.i(TAG, "scanAndConnect: scan already in progress")
            return
        }

        // Directed-connect path: skip scan if we know the addresses.
        if (pairing.hasPair) {
            try {
                val btMgr = context.getSystemService(Context.BLUETOOTH_SERVICE)
                    as? android.bluetooth.BluetoothManager
                val adapter = btMgr?.adapter
                if (adapter != null && adapter.isEnabled) {
                    val leftDevice = adapter.getRemoteDevice(pairing.leftAddress!!)
                    val rightDevice = adapter.getRemoteDevice(pairing.rightAddress!!)
                    val leftClient = G2BleClient(context, Side.Left)
                    val rightClient = G2BleClient(context, Side.Right)
                    leftClient.connectTo(leftDevice)
                    rightClient.connectTo(rightDevice)
                    Log.i(TAG, "scanAndConnect: directed connect L=${pairing.leftAddress} R=${pairing.rightAddress}")
                    installBleClients(leftClient, rightClient)
                    return
                } else {
                    Log.w(TAG, "scanAndConnect: BT adapter unavailable for directed connect, falling back to scan")
                }
            } catch (e: Exception) {
                Log.w(TAG, "scanAndConnect: directed-connect threw, falling back to scan", e)
            }
        }

        // Scan path (no saved pair OR directed-connect failed).
        _bleStatus.value = "scanning"
        val scanner = BleScanner(context)
        bleScannerRef.set(scanner)
        scanner.start { event ->
            when (event) {
                is BleScanner.Event.FoundPair -> {
                    bleScannerRef.set(null)            // scanner self-stopped; drop reference
                    _bleStatus.value = "found pair"
                    val leftClient = G2BleClient(context, Side.Left)
                    val rightClient = G2BleClient(context, Side.Right)
                    leftClient.connectTo(event.left)
                    rightClient.connectTo(event.right)
                    val leftName = try { event.left.name ?: "" } catch (e: SecurityException) { "" }
                    val rightName = try { event.right.name ?: "" } catch (e: SecurityException) { "" }
                    pairing.setForSide(Side.Left, event.left.address, leftName)
                    pairing.setForSide(Side.Right, event.right.address, rightName)
                    installBleClients(leftClient, rightClient)
                }
                is BleScanner.Event.Failure -> {
                    bleScannerRef.set(null)            // scanner self-stopped on failure
                    Log.w(TAG, "scan failure: ${event.reason}")
                    _bleStatus.value = "scan failed: ${event.reason}"
                    state.transition(AppState.ERROR)
                }
            }
        }
    }

    /** Install the connected BLE clients (one per lens). Wires:
     *   - Hud + MenuController + ConfirmationFlow against the new clients
     *   - BLE input events from BOTH lenses, debounced to dedup paired emissions
     *
     *  Phase 7 fix #10: subscribe to BOTH sides. PROTOCOL_NOTES.md §"Open
     *  research items" #3 notes we don't yet know whether both lenses emit
     *  the same input event or only one — debounce by EVENT_DEBOUNCE_MS so a
     *  paired emission doesn't fire onTap twice. */
    fun installBleClients(left: G2BleClient, right: G2BleClient) {
        leftBle = left
        rightBle = right
        val newHud = Hud(left, right)
        hud = newHud
        // R1-CRITICAL fix: wire HUD-dependent flows now that hud is non-null.
        // start() runs BEFORE scanAndConnect() in the service lifecycle, so
        // its `hud?.let { ... }` block was skipped — leaving menu /
        // confirmation / sttConfirmation null forever and the Phase 8 STT
        // confirmation gate (this commit's headline feature) inert in
        // production. Re-wire here and on every BLE rebuild (post-Ready
        // force-rescan, BT-cycle reconnect) so the flows track the live Hud.
        val cm = connection
        if (cm != null) {
            // R4-CRITICAL1: if a server-initiated confirm-on-hud was pending
            // on the OLD ConfirmationFlow, the server is blocked forever
            // (no-timeouts rule). Reject it explicitly before we drop the
            // old instance so the CC subprocess unblocks. Cheap on first
            // install (pending will be null).
            confirmation?.onDisconnected()
            // R4-CRITICAL2: preserve the user's pending STT transcript
            // across BLE rebuild. Without this, every post-Ready watchdog
            // rescan / BT-cycle silently discards a transcript the user is
            // about to confirm.
            val priorSttPending = sttConfirmation?.takePendingForHandoff()
            menu = MenuController(newHud, cm)
            confirmation = ConfirmationFlow(newHud, cm)
            sttConfirmation = SttConfirmationFlow.forProduction(newHud, cm)
            if (priorSttPending != null) {
                diag("installBleClients: re-applying ${priorSttPending.length}c STT pending to new flow")
                sttConfirmation?.onSttResult(priorSttPending)
            }
        } else {
            Log.w(TAG, "installBleClients: connection null — start() must run first; flows remain unset")
        }
        // RootMenu is the live input/content surface, preserved across BLE
        // rebuild — its stack state + pending feature-module work survive a
        // rescan. The render callback looks up `this.hud` / `this.evenHud` at
        // call time so it always hits the CURRENT instances after a rebuild.
        // EvenHub renderer — rebuilt against the current clients on every install
        // (post-reconnect, BT-cycle). null when EVENHUB_ENABLED is off (teleprompter).
        evenHud = if (EVENHUB_ENABLED) EvenHud(left, right) else null
        if (rootMenu == null) {
            rootMenu = RootMenu(rootItems = buildRootMenuItems()) { title, body ->
                if (EVENHUB_ENABLED) {
                    // Native EvenHub render: pull the structured frame and draw a
                    // menu-list (+ status header), or a confirm screen when the
                    // frame carries a read-only displayHeader (STT transcript).
                    // Gated on evenHubLaunched — the cold-launch ships the first
                    // frame itself; renders arriving before the session is up are
                    // no-ops here (cold-launch / reconnect repaints the frame).
                    val eh = evenHud
                    val rm = rootMenu
                    if (eh != null && rm != null && evenHubLaunched.get()) {
                        renderModelViaEvenHub(eh, rm.currentRenderModel())
                    }
                } else {
                    // Teleprompter escape hatch (EVENHUB_ENABLED=false).
                    val combined = if (body.isNotEmpty()) "$title\n$body" else title
                    hud?.render(combined) { ok ->
                        if (!ok) diag("rootMenu: BLE render failed for '${title.take(20)}'")
                    }
                }
            }
        }
        // Force re-render on the new Hud so the user sees the menu come
        // back up after BLE rebuild. Deferred until after onBothReadyEdge
        // fires (which is when render actually has a chance of succeeding).
        // Cancel any prior collectors so a re-install (e.g. after BLE disconnect
        // + reconnect) doesn't stack a second pair, double-firing every onTap.
        leftCollectorJob?.cancel()
        rightCollectorJob?.cancel()
        // 4th-pass review HIGH (BLE bug 8): cancel the prior observeBleHealth
        // before launching a new one. Without this, a force-rescan from the
        // post-Ready watchdog stacks observers — each one still holds a
        // closure on the OLD G2BleClient (its state flow continues to drive
        // ready flags + heartbeat starts), but G2Pipeline.leftBle/rightBle
        // fields point at the NEW clients. Result: double-fire Ready edges,
        // heartbeat against null/dead clients, confused diag stream.
        bleHealthJob?.cancel()
        leftCollectorJob = scope.launch { collectEventsDebounced(left.events) }
        rightCollectorJob = scope.launch { collectEventsDebounced(right.events) }
        // 4th-pass F1 (Android): observe both lenses' ConnectionState. The prior
        // implementation called connectTo(...) + returned without watching for
        // async connect failures — if a saved address was stale (glasses off,
        // out of range, mac changed), getRemoteDevice would succeed but Nordic
        // would emit onDeviceFailedToConnect → state flow → ConnectionState.Error
        // with no observer, leaving the pipeline stuck in "leftBle/rightBle
        // installed" state forever. Now: if either side hits Error or
        // Disconnected without ever reaching Ready, tear down + retry.
        observeBleHealth(left, right)
    }

    private fun observeBleHealth(left: G2BleClient, right: G2BleClient) {
        bleHealthJob = scope.launch {
            var leftReady = false
            var rightReady = false
            var lastBothReady = false   // edge-tracking: did both go Ready last cycle?
            _bleStatus.value = "connecting L+R"

            fun updateStatus(side: String, s: ConnectionState) {
                val lStr = if (leftReady) "L✓" else "L:${stateLabel(s.takeIf { side == "L" } ?: left.state.value)}"
                val rStr = if (rightReady) "R✓" else "R:${stateLabel(s.takeIf { side == "R" } ?: right.state.value)}"
                _bleStatus.value = if (leftReady && rightReady) "ready" else "$lStr $rStr"
            }
            /** Fires on every RISING edge of (leftReady && rightReady).
             *  This includes both the initial pair-up AND every reconnect
             *  after a BLE drop, so the HUD never sits blank past a
             *  reconnect. Re-rendering on every Ready edge replays whatever
             *  text was last on screen (or the hello frame if nothing has
             *  been rendered yet). Heartbeat is always restarted from
             *  scratch — the prior heartbeat coroutine self-exits on
             *  leftBle/rightBle == null OR is killed by stopHeartbeat()
             *  below, so we never stack two. */
            fun onBothReadyEdge() {
                val h = hud
                val l = leftBle
                val r = rightBle
                val rm = rootMenu
                if (h == null) {
                    diag("hud: NULL on Ready edge! cannot render")
                    return
                }
                stopPostReadyWatchdog()
                stopHeartbeat()
                // EvenHub path (default): cold-launch the DocuLens slot, render
                // the current menu, then start the f1=12 keepalive. Fires on the
                // initial pair-up AND every reconnect (self-heal — the Hub session
                // is lost when BLE drops, so we re-launch). RootMenu stack state is
                // preserved across the BLE rebuild, so the current frame repaints.
                if (EVENHUB_ENABLED) {
                    val eh = evenHud
                    if (rm == null || eh == null) {
                        diag("evenHub: rootMenu=${rm != null} evenHud=${eh != null} NULL on Ready — cannot cold-launch")
                    } else {
                        evenHubLaunched.set(false)
                        val model = rm.currentRenderModel()
                        diag("evenHub: cold-launch on Ready (${model.items.size} items)")
                        eh.coldLaunch(composeStatus(model.title), model.items) { ok ->
                            diag("evenHub: cold-launch done ok=$ok")
                            if (ok) {
                                evenHubLaunched.set(true)
                                sessionHasRenderedOnce.set(true)
                                pendingHudText = null
                                startHeartbeat()
                            } else {
                                // Launch write failed — let the post-Ready watchdog
                                // tear down + rescan rather than sit on a dead session.
                                startPostReadyWatchdog()
                            }
                        }
                        return
                    }
                }
                // Teleprompter path priority chain (EVENHUB_ENABLED=false fallback):
                //   1. pendingHudText — CC streamed Output during outage;
                //      render via hud so user catches up
                //   2. STT confirmation pending — render the legacy STT prompt
                //   3. RootMenu — default content (M1)
                //   4. Hud.lastRenderedText — defensive replay
                //   5. Hello frame — fresh-install fallback
                val explicitText = pendingHudText
                    ?: sttConfirmation?.getPendingPrompt()
                val notifyBefore = "L=${l?.notifyCount?.get() ?: -1} R=${r?.notifyCount?.get() ?: -1}"
                diag(
                    "ble-link: L mtu=${l?.lastMtu ?: -1} phy=${l?.lastPhy ?: "?"} ${l?.lastConnParams ?: "?"} | " +
                    "R mtu=${r?.lastMtu ?: -1} phy=${r?.lastPhy ?: "?"} ${r?.lastConnParams ?: "?"}"
                )
                val isReconnect = sessionHasRenderedOnce.get() || heartbeatTickCount.get() > 0
                if (explicitText != null) {
                    diag("hud: ${if (isReconnect) "RECONNECT" else "initial"}-render explicit | notify-before $notifyBefore")
                    h.render(explicitText, fastReRender = false) { ok ->
                        diag("hud: render-done ok=$ok mode=${if (isReconnect) "RECONNECT-explicit" else "initial-explicit"}")
                        if (ok) {
                            sessionHasRenderedOnce.set(true)
                            pendingHudText = null
                            startHeartbeat()
                        }
                    }
                } else if (rm != null) {
                    // Default: render the menu. RootMenu's onRender callback
                    // is wired to hud.render(combined) above. Start heartbeat
                    // immediately — heartbeat re-renders on its cadence so
                    // even if the menu's first render is in flight, the next
                    // tick replays. sessionHasRenderedOnce set on render
                    // dispatch since RootMenu's onRender doesn't surface
                    // success/failure to this level (covered by the diag in
                    // the menu's render callback closure).
                    diag("hud: ${if (isReconnect) "RECONNECT" else "initial"}-render menu | notify-before $notifyBefore")
                    rm.render()
                    sessionHasRenderedOnce.set(true)
                    startHeartbeat()
                } else {
                    val fallback = h.lastRenderedText ?: "G2CC paired\nL+R authed\n(idle)"
                    diag("hud: ${if (isReconnect) "RECONNECT" else "initial"}-render fallback | notify-before $notifyBefore")
                    h.render(fallback, fastReRender = false) { ok ->
                        diag("hud: render-done ok=$ok mode=fallback")
                        if (ok) {
                            sessionHasRenderedOnce.set(true)
                            startHeartbeat()
                        }
                    }
                }
            }
            /** Fires on every FALLING edge of (leftReady && rightReady) —
             *  i.e. we WERE both-ready and now at least one side dropped.
             *  Stop heartbeat so it doesn't fire against a dead lens, and
             *  rely on Nordic's autoConnect to bring the dropped side back.
             *  If autoConnect fails (stale GATT / bond, MAC re-randomized,
             *  glasses powered off long enough), the watchdog (see below)
             *  will detect the persistent disconnect and force a re-scan. */
            fun onDroppedEdge(side: String, reason: String) {
                stopHeartbeat()
                // EvenHub Hub session is lost when BLE drops — require a fresh
                // cold-launch on the next Ready edge. Renders during the outage
                // buffer to pendingHudText instead of writing to a dead session.
                evenHubLaunched.set(false)
                // Include the BLE-level disconnect reason from each side so we
                // can decode the failure: 0x08 = supervision timeout (body
                // block / out of range), 0x13 = remote user terminated, 0x16
                // = local user terminated, 0x22 = LL response timeout, etc.
                // GATT status codes per BluetoothGatt source.
                val lr = left.lastDisconnectReason
                val rr = right.lastDisconnectReason
                diag(
                    "hud: $side dropped post-Ready ($reason) — Lreason=0x${"%02x".format(lr)} Rreason=0x${"%02x".format(rr)} — heartbeat stopped, awaiting Nordic auto-reconnect"
                )
            }
            fun recomputeEdges() {
                val bothNow = leftReady && rightReady
                if (bothNow && !lastBothReady) onBothReadyEdge()
                if (!bothNow && lastBothReady) {
                    // The transition happened — figure out which side dropped.
                    val side = if (!leftReady && !rightReady) "BOTH" else if (!leftReady) "L" else "R"
                    onDroppedEdge(side, "leftReady=$leftReady rightReady=$rightReady")
                }
                lastBothReady = bothNow
            }

            // Per-side watcher. Ready flips the ready flag true; Error /
            // Disconnected flips it false. Both paths converge to
            // recomputeEdges() which fires the right edge handler. The
            // pre-Ready failure path still routes through onInstallFailure
            // so a glasses-off scenario at first connect rebuilds via scan.
            launch {
                left.state.collect { s ->
                    when (s) {
                        is ConnectionState.Ready -> {
                            leftReady = true; updateStatus("L", s); recomputeEdges()
                        }
                        is ConnectionState.Error,
                        is ConnectionState.Disconnected -> {
                            if (!lastBothReady && !leftReady) {
                                _bleStatus.value = "L fail: ${left.lastDiagnostic}"
                                onInstallFailure("L", s)
                            } else {
                                leftReady = false; updateStatus("L", s); recomputeEdges()
                                startPostReadyWatchdog()
                            }
                        }
                        else -> { updateStatus("L", s) }
                    }
                }
            }
            launch {
                right.state.collect { s ->
                    when (s) {
                        is ConnectionState.Ready -> {
                            rightReady = true; updateStatus("R", s); recomputeEdges()
                        }
                        is ConnectionState.Error,
                        is ConnectionState.Disconnected -> {
                            if (!lastBothReady && !rightReady) {
                                _bleStatus.value = "R fail: ${right.lastDiagnostic}"
                                onInstallFailure("R", s)
                            } else {
                                rightReady = false; updateStatus("R", s); recomputeEdges()
                                startPostReadyWatchdog()
                            }
                        }
                        else -> { updateStatus("R", s) }
                    }
                }
            }
        }
    }

    private fun stateLabel(s: ConnectionState): String = when (s) {
        is ConnectionState.Idle -> "idle"
        is ConnectionState.Scanning -> "scan"
        is ConnectionState.Connecting -> "conn"
        is ConnectionState.GattConnected -> "gatt"
        is ConnectionState.Authenticating -> "auth"
        is ConnectionState.Ready -> "ok"
        is ConnectionState.Disconnected -> "disc"
        is ConnectionState.Error -> "err"
    }

    /** Keep the teleprompter HUD session alive. Without periodic packets the
     *  G2 firmware ends the session ~22 s after the last activity, blanks the
     *  screen, and the "connection lost" toast appears on the glasses
     *  (confirmed 2026-06-01 on Adam's pair).
     *
     *  Empirical findings 2026-06-01:
     *  - sync_trigger every 5 s does NOT keep session alive. Glasses ack each
     *    one (notify counts climb) but still time out at 22 s.
     *  - content_page (re-send page 0 with fresh seq/msgId) every 8 s also
     *    does NOT keep session alive. R lens acks ~3 notifies per packet but
     *    L lens goes silent (stuck at notify count=4 after initial render).
     *    Still times out at ~22 s.
     *  - **Trying full re-render every 15 s.** This is heavy (~2.6 s wire
     *    time per cycle) but it's the EXACT sequence proven to create a
     *    fresh teleprompter session. If anything keeps the session alive,
     *    a full re-render will.
     *
     *  HB annotation: per CLAUDE.md "no-timeouts rule" exception list,
     *  heartbeat pacing is allowed (it's not a clock-kill on an operation).
     *  Cadence chosen well under the observed 22 s timeout for margin. */
    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatTickCount.set(0)
        heartbeatJob = scope.launch {
            // Keepalive branches by display path:
            //   - EvenHub (default): e0-20 f1=12 to R every ~4s (probe v12 — THE
            //     keepalive that holds the Hub session).
            //   - teleprompter (EVENHUB_ENABLED=false fallback): full re-render via
            //     hud.render(lastText, fastReRender=true) every 10s. The
            //     teleprompter firmware session dies ~22s after the last full
            //     render even while the BLE link stays alive, so a sync_trigger-only
            //     beat is NOT enough — the re-render re-establishes the session.
            val cadenceMs: Long = if (EVENHUB_ENABLED) 4_000L else 10_000L
            val hbMode = if (EVENHUB_ENABLED) "evenHub-f1=12" else "teleprompter-full-rerender"
            diag("hb: started (mode=$hbMode, cadence=${cadenceMs}ms)")
            // Track expected-vs-actual delay so we can detect OS scheduler /
            // Doze throttling. With wake lock held in G2CCService this
            // should be ~0; if we still see gap drift, the wake lock isn't
            // enough and we need AlarmManager-based scheduling.
            var lastTickAtMs = System.currentTimeMillis()
            try {
                while (kotlinx.coroutines.currentCoroutineContext()[Job]?.isActive == true) {
                    kotlinx.coroutines.delay(cadenceMs)
                    // Detect scheduler throttling: if delay() came back
                    // significantly later than cadenceMs, the OS suspended
                    // our coroutine despite the wake lock. Log loudly so
                    // we can SEE it in diag.
                    val now = System.currentTimeMillis()
                    val actualGap = now - lastTickAtMs
                    lastTickAtMs = now
                    if (actualGap > cadenceMs + 5_000L) {
                        diag("hb: WARN delay throttled (expected ${cadenceMs}ms got ${actualGap}ms) — wake lock not holding?")
                    }
                    leftBle ?: break    // both lenses must be up before we keep the session alive
                    val r1 = rightBle ?: break
                    val tick = heartbeatTickCount.incrementAndGet()

                    if (EVENHUB_ENABLED) {
                        // EvenHub session keepalive: e0-20 f1=12 to R every ~4s
                        // (probe v12 — THE keepalive). Skipped until cold-launch
                        // establishes the session.
                        val eh = evenHud
                        if (eh == null || !evenHubLaunched.get()) {
                            diag("hb: tick=$tick — evenHub session not ready, skipping")
                            continue
                        }
                        r1.sendPacket(eh.keepaliveFrame(), "HB:e0-f1=12")
                        diag("hb: tick=$tick (e0 f1=12 keepalive) | R notify=${r1.notifyCount.get()}")
                    } else {
                        // Teleprompter: full re-render via Hud.render.
                        // Re-establishes the firmware-side teleprompter
                        // session that times out ~22s after last render.
                        val h = hud
                        if (h == null) {
                            diag("hb: tick=$tick — hud null, skipping render")
                            continue
                        }
                        val textToRender = pendingHudText ?: h.lastRenderedText
                            ?: "G2CC paired\nL+R authed\n(idle)"
                        val rBefore = r1.notifyCount.get()
                        val renderStartMs = System.currentTimeMillis()
                        h.render(textToRender, fastReRender = true) { ok ->
                            val durMs = System.currentTimeMillis() - renderStartMs
                            val rAfter = r1.notifyCount.get()
                            diag("hb: tick=$tick ok=$ok dur=${durMs}ms | R notify $rBefore→$rAfter (rΔ=${rAfter - rBefore})")
                        }
                    }
                }
            } finally {
                diag("hb: stopped after ${heartbeatTickCount.get()} ticks")
            }
        }
    }

    private fun stopHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = null
    }

    /** Start (or restart) the post-Ready BLE watchdog. Called on every
     *  post-Ready drop. If we don't get back to both-Ready within
     *  POST_READY_RECOVERY_MS, tear down + re-scan. Allowed under the
     *  no-timeouts rule: this is a recovery deadline for an external
     *  device, not a clock-kill on an operation. */
    private fun startPostReadyWatchdog() {
        postReadyWatchdogJob?.cancel()
        postReadyWatchdogJob = scope.launch {
            kotlinx.coroutines.delay(POST_READY_RECOVERY_MS)
            val l = leftBle
            val r = rightBle
            val lReady = l?.state?.value is ConnectionState.Ready
            val rReady = r?.state?.value is ConnectionState.Ready
            if (lReady && rReady) {
                diag("ble-wd: recovered before deadline — no action")
                return@launch
            }
            diag(
                "ble-wd: ${POST_READY_RECOVERY_MS / 1000}s elapsed without both-Ready " +
                "(L=${l?.state?.value?.let { stateLabel(it) } ?: "null"} " +
                "R=${r?.state?.value?.let { stateLabel(it) } ?: "null"}) — forcing rescan"
            )
            stopHeartbeat()
            leftBle?.shutdownBle(); rightBle?.shutdownBle()
            leftBle = null; rightBle = null
            hud = null     // R4-HIGH6: same reasoning as onBluetoothStateOn.
            leftCollectorJob?.cancel(); leftCollectorJob = null
            rightCollectorJob?.cancel(); rightCollectorJob = null
            bleHealthJob?.cancel(); bleHealthJob = null
            scanAndConnect()
        }
    }

    private fun stopPostReadyWatchdog() {
        postReadyWatchdogJob?.cancel()
        postReadyWatchdogJob = null
    }

    /** Called by BluetoothStateReceiver on STATE_ON. Drops any stale BLE
     *  clients (their BluetoothDevice handles are invalid post-cycle) and
     *  re-scans. Idempotent — if clients are already null, scanAndConnect
     *  just runs from scratch. */
    fun onBluetoothStateOn() {
        stopHeartbeat()
        stopPostReadyWatchdog()
        // 4th-pass-final review MEDIUM: clear pendingHudText too — stale
        // server-output from before the BT cycle shouldn't replay over the
        // fresh reconnect. Source-of-truth is Hud.lastRenderedText.
        pendingHudText = null
        leftBle?.shutdownBle(); rightBle?.shutdownBle()
        leftBle = null; rightBle = null
        // R4-HIGH6: null the hud reference so any ServerMessage.Output arriving
        // during the rebuild window falls into the pendingHudText buffer
        // instead of being silently lost on writes to a dead Hud.
        // sttConfirmation is kept alive — its pending transcript is preserved
        // via takePendingForHandoff() in installBleClients, so the STT prompt
        // re-renders on the new Hud after BLE comes back.
        hud = null
        leftCollectorJob?.cancel(); leftCollectorJob = null
        rightCollectorJob?.cancel(); rightCollectorJob = null
        bleHealthJob?.cancel(); bleHealthJob = null
        scanAndConnect()
    }

    /** Called by BluetoothStateReceiver on STATE_OFF. Tears down so when
     *  STATE_ON fires we get a clean slate. Pipeline notification will read
     *  "scanning" while BT is off — accurate (BLE scan can't start) and not
     *  worth a separate "BT off" status flavor. */
    fun onBluetoothStateOff() {
        stopHeartbeat()
        stopPostReadyWatchdog()
        pendingHudText = null
        bleScannerRef.getAndSet(null)?.stop()
        leftBle?.shutdownBle(); rightBle?.shutdownBle()
        leftBle = null; rightBle = null
        hud = null         // R4-HIGH6: same reasoning as onBluetoothStateOn.
        leftCollectorJob?.cancel(); leftCollectorJob = null
        rightCollectorJob?.cancel(); rightCollectorJob = null
        bleHealthJob?.cancel(); bleHealthJob = null
        _bleStatus.value = "BT off"
    }

    private fun onInstallFailure(side: String, state: ConnectionState) {
        Log.w(TAG, "[$side] connect failed before Ready (state=$state) — tearing down and retrying via scan")
        stopHeartbeat()
        stopPostReadyWatchdog()
        // Tear down current install so scanAndConnect() can rebuild.
        leftBle?.shutdownBle()
        rightBle?.shutdownBle()
        leftBle = null
        rightBle = null
        hud = null         // R4-HIGH6: same reasoning as onBluetoothStateOn.
        leftCollectorJob?.cancel(); leftCollectorJob = null
        rightCollectorJob?.cancel(); rightCollectorJob = null
        bleHealthJob?.cancel(); bleHealthJob = null
        // Clear stale PairingState — directed-connect just failed against it,
        // and the next scanAndConnect will fall through to scan + re-learn.
        pairing.clear()
        // Schedule the retry (don't recurse into scanAndConnect synchronously —
        // we're inside a state.collect on the lens, holding its coroutine).
        scope.launch {
            // The state.collect coroutines will naturally drift away from the
            // freshly-nulled leftBle/rightBle; nothing to cancel explicitly.
            this@G2Pipeline.state.transition(AppState.CONNECTING)
            scanAndConnect()
        }
    }

    // AtomicLong + CAS gives us atomic check-then-set so two collectors firing
    // a paired-emission near-simultaneously don't both pass the debounce check.
    // @Volatile alone only provides visibility, not atomicity for the if/set.
    private val lastTapAt = AtomicLong(0L)
    private val lastDoubleTapAt = AtomicLong(0L)
    private val lastScrollUpAt = AtomicLong(0L)
    private val lastScrollDownAt = AtomicLong(0L)

    private suspend fun collectEventsDebounced(events: kotlinx.coroutines.flow.Flow<EventParser.Event>) {
        events.collect { event ->
            val now = System.currentTimeMillis()
            when (event) {
                is EventParser.Event.Tap -> {
                    val prev = lastTapAt.get()
                    if (now - prev >= EVENT_DEBOUNCE_MS && lastTapAt.compareAndSet(prev, now)) {
                        onTap()
                    }
                }
                is EventParser.Event.DoubleTap -> {
                    val prev = lastDoubleTapAt.get()
                    if (now - prev >= EVENT_DEBOUNCE_MS && lastDoubleTapAt.compareAndSet(prev, now)) {
                        onDoubleTap()
                    }
                }
                is EventParser.Event.ScrollUp -> {
                    val prev = lastScrollUpAt.get()
                    if (now - prev >= EVENT_DEBOUNCE_MS && lastScrollUpAt.compareAndSet(prev, now)) {
                        // Native-ring scroll-up (teleprompter fallback path) →
                        // RootMenu prev. On the EvenHub path the firmware scrolls
                        // the menu-list locally and reports the pick via e0-01
                        // HubSelect, so this handler is the teleprompter case.
                        rootMenu?.onScrollPrev()
                    }
                }
                is EventParser.Event.ScrollDown -> {
                    val prev = lastScrollDownAt.get()
                    if (now - prev >= EVENT_DEBOUNCE_MS && lastScrollDownAt.compareAndSet(prev, now)) {
                        // M2: route scroll-down to RootMenu (next item) ALWAYS.
                        rootMenu?.onScrollNext()
                    }
                }
                is EventParser.Event.ScrollFocus -> {
                    // Ring detected motion start. Trigger a menu re-render so
                    // a firmware-cleared display gets refreshed.
                    rootMenu?.render()
                }
                is EventParser.Event.InternalMenuEvent -> {
                    // Glasses' internal-menu event (decorated 0x12345678 channel).
                    // Already handled by firmware; not for our menu.
                }
                is EventParser.Event.Unknown -> {
                    // Auth acks, display config responses, etc. EventParser
                    // logs them at DEBUG; no further action here.
                }
                is EventParser.Event.HubSelect -> {
                    // EvenHub native menu-list selection (hijack path): the
                    // firmware reports the chosen index. Route straight to the
                    // menu — e0-01 is R-only, single emission, so no debounce.
                    diag("hub-input: select '${event.widgetType}' idx=${event.index}")
                    rootMenu?.selectIndex(event.index)
                }
                is EventParser.Event.HubGesture -> {
                    // Firmware handles menu-list scroll natively (draws the
                    // selection border); informational for bring-up diagnostics.
                    diag("hub-input: gesture code=${event.code}")
                }
                is EventParser.Event.Malformed -> {
                    Log.w(TAG, "malformed BLE event: ${event.reason}")
                }
            }
        }
    }

    /** Single-tap dispatch — priority order (M2 model):
     *   1. server-initiated confirm-on-hud pending → confirmed
     *   2. STT confirmation pending → send transcript as Prompt (legacy;
     *      will be subsumed into the menu's confirmation submenu in M5)
     *   3. RootMenu — the primary input surface. Tap selects the highlighted
     *      Action / drills into Submenu / pops Back. Recording start/stop
     *      lives as menu Actions, not as a special-case tap dispatch.
     *
     * The previous "tap = audio toggle" path is GONE — Adam's design has
     * the user navigate to "Record prompt" inside the CC submenu, and the
     * Action's onSelect lambda handles the streamer toggle. */
    fun onTap() {
        if (confirmation?.onTap() == true) return
        if (sttConfirmation?.onTap() == true) {
            state.transition(AppState.STREAMING)
            return
        }
        // M2: route taps to the menu. Returns true if a menu item was
        // selected. If the menu is empty / null we just diag and stop —
        // there's nothing else to do with a tap in the new model.
        if (rootMenu?.onTap() == true) return
        diag("onTap: no menu / unconsumed — ignoring")
    }

    /** Double-tap dispatch — usually firmware-intercepted (shows "End
     *  Feature?"). Kept for the rare event types that do reach the phone:
     *   1. server-initiated confirm-on-hud pending → rejected
     *   2. STT confirmation pending → discard (legacy)
     *  All other double-tap inputs are ignored in the M2 menu-primary model. */
    fun onDoubleTap() {
        if (confirmation?.onDoubleTap() == true) {
            return
        }
        if (sttConfirmation?.onDoubleTap() == true) {
            state.transition(AppState.IDLE)
            return
        }
        diag("onDoubleTap: no consumer — ignoring (firmware usually intercepts this)")
    }

    /** Phase 8 hookpoint: Tasker `START_RECORDING` / `STOP_RECORDING` intents land here. */
    fun startRecording() { streamer?.start() ; state.transition(AppState.AWAITING_TRANSCRIPT) }
    fun stopRecording() { streamer?.stop() ; state.transition(AppState.IDLE) }

    /** Start the WebSocket connection. Idempotent — re-calls re-use the same
     *  ConnectionManager. */
    fun start() {
        if (connection != null) return
        val url = prefs.serverUrl ?: run {
            Log.w(TAG, "start: no server URL configured")
            state.transition(AppState.ERROR)
            return
        }
        val token = prefs.authToken ?: run {
            Log.w(TAG, "start: no auth token configured")
            state.transition(AppState.ERROR)
            return
        }
        state.transition(AppState.CONNECTING)

        val cm = ConnectionManager(
            initialEndpoints = listOf(url),
            authToken = token,
            httpClient = httpClient,
            onMessage = ::dispatchInbound,
            onConnected = {
                state.transition(AppState.AUTHED)
                state.transition(AppState.IDLE)
                // Refresh the endpoint list defence #4.
                scope.launch { refreshEndpoints(cmRef = connection ?: return@launch) }
            },
            onDisconnected = {
                // R4-HIGH3: AppState.canTransitionTo does NOT allow
                // CONNECTING from MENU / AWAITING_TRANSCRIPT /
                // AWAITING_CONFIRMATION / STREAMING. A normal WS-drop from
                // any of those states would leave the machine wedged in
                // the old state forever (onConnected's IDLE transition
                // also rejects). Use forceSet so disconnect is unambiguous
                // regardless of prior state.
                state.forceSet(AppState.CONNECTING)
                // R5-HIGH1 / R4-HIGH4: stop the mic if recording is in
                // flight. Without this, AudioRecord keeps reading frames
                // that connection.sendBinary silently drops (battery drain),
                // and on reconnect the new socket has no audio_start so the
                // eventual audio_end is rejected as "without prior audio_start".
                streamer?.stop()
                confirmation?.onDisconnected()
                sttConfirmation?.onDisconnected()
            },
            onAuthFailure = { count ->
                Log.w(TAG, "auth failure #$count")
                state.transition(AppState.ERROR)
            },
            onStuckTooLong = {
                // Defence #5 (last resort): offline past STUCK_RELOAD_MS despite
                // pings, the liveness watchdog, endpoint rotation, and endpoint
                // refresh. Rebuild the whole connection stack from a clean state.
                // Launch on the PIPELINE scope — restartConnectionStack shuts down
                // the ConnectionManager (cancelling the very coroutine that fired
                // this callback), so it must not run on that scope.
                Log.w(TAG, "STUCK_RELOAD_MS exceeded — rebuilding connection stack (defence #5)")
                scope.launch { restartConnectionStack() }
            },
        )
        connection = cm
        // Forward every bleStatus change to the server as a DiagMsg so we have
        // a server-side scrolling log of BLE state during hardware bring-up
        // (the notification cycles too fast to read by eye).
        bleStatusJob?.cancel()
        bleStatusJob = scope.launch {
            bleStatus.collect { status ->
                diag("BLE: $status")
            }
        }
        // HUD-dependent flows (menu, confirmation, sttConfirmation) are wired
        // inside installBleClients() because start() always runs BEFORE the
        // first BLE pair-up — hud is null here. See R1-CRITICAL note in
        // installBleClients.
        // Phase 8: wire mic capture path. Streaming starts on user gesture
        // (or Tasker intent); the streamer just owns the audio_start/end +
        // binary-frame plumbing.
        streamer = AudioStreamer(MicCapture(context), cm)
        cm.connect()
    }

    fun stop() {
        bleScannerRef.getAndSet(null)?.stop()
        stopHeartbeat()
        stopPostReadyWatchdog()
        sessionHasRenderedOnce.set(false)
        evenHubLaunched.set(false)
        evenHud = null
        // 4th-pass-final review MEDIUM: clear pendingHudText on hard stop.
        pendingHudText = null
        // R4-HIGH5: explicitly stop the audio streamer so AudioRecord is
        // released. scope.cancel() only kills coroutines; AudioRecord is a
        // system handle and persists across coroutine cancellation. Without
        // this, a service-restart (STUCK_RELOAD_MS) leaves the mic pinned
        // and the new MicCapture init fails.
        streamer?.stop()
        streamer = null
        // Tear down GATT connections cleanly so the BLE stack doesn't leak
        // open handles across service restart cycles (foreground service
        // reload-on-stuck per the watchdog).
        leftBle?.shutdownBle()
        rightBle?.shutdownBle()
        leftBle = null
        rightBle = null
        leftCollectorJob?.cancel(); leftCollectorJob = null
        rightCollectorJob?.cancel(); rightCollectorJob = null
        bleHealthJob?.cancel(); bleHealthJob = null
        bleStatusJob?.cancel(); bleStatusJob = null
        connection?.shutdown()
        connection = null
        scope.cancel()
    }

    /** Defence #5 (last resort) — the ConnectionManager reported it's been
     *  offline past STUCK_RELOAD_MS despite every lighter recovery. Rebuild the
     *  connection stack from a clean state: shut down the wedged
     *  ConnectionManager + streamer, then start() a fresh one (re-reads
     *  prefs.serverUrl + authToken, opens a new socket, refreshes endpoints).
     *  BLE is left connected (the stuck condition is the WS/network side); if
     *  it's up we re-wire the HUD-dependent flows against the NEW connection via
     *  installBleClients — they captured the old one and would otherwise send to
     *  a dead socket.
     *
     *  MUST run on the pipeline scope (NOT the ConnectionManager scope): the
     *  shutdown() below cancels that scope. Idempotent-safe: a fresh
     *  ConnectionManager resets reloadAttempted, so this won't re-fire until the
     *  new connection itself stays offline another STUCK_RELOAD_MS. */
    private fun restartConnectionStack() {
        diag("stuck-recovery: rebuilding connection stack from clean state (defence #5)")
        Log.w(TAG, "stuck-recovery: rebuilding connection stack")
        streamer?.stop(); streamer = null
        bleStatusJob?.cancel(); bleStatusJob = null
        connection?.shutdown()
        connection = null
        // start() is guarded by `connection != null`; now null, it rebuilds the
        // ConnectionManager + streamer + bleStatus collector + dispatchInbound.
        start()
        // Re-wire menu / confirmation / sttConfirmation against the new
        // connection (they captured the old instance at install time).
        val l = leftBle
        val r = rightBle
        if (l != null && r != null) {
            diag("stuck-recovery: re-wiring HUD flows + re-rendering against new connection")
            installBleClients(l, r)
        }
    }

    /** ConnectionManager surface for outbound messages. */
    fun send(msg: ClientMessage) { connection?.send(msg) }

    /** Compose the g2code-style status-bar line for the menu-header. v1: a
     *  connection glyph + the section title + the latest server mode/ctx%
     *  (captured by the Status handler, applied on the next render). Flicker-free
     *  per-field upgrades like g2code's are a later refinement. */
    private fun composeStatus(title: String): String {
        val conn = if (leftBle != null && rightBle != null) "●" else "○"
        val sb = StringBuilder("$conn $title")
        if (statusMode.isNotEmpty() && statusMode != "default") sb.append(" | ").append(statusMode)
        if (statusContextPct > 0) sb.append(" | ctx:").append(statusContextPct).append('%')
        if (statusProcessing) sb.append(" | …")
        return sb.toString()
    }

    /** Render a RootMenu frame via EvenHud: a confirm screen when it carries a
     *  read-only displayHeader (STT transcript / confirm prompt), else a menu. */
    private fun renderModelViaEvenHub(eh: EvenHud, model: RootMenu.RenderModel) {
        if (model.displayHeader != null) {
            eh.renderConfirm(model.displayHeader, model.items) { ok ->
                if (!ok) diag("evenHub: confirm render failed ('${model.title}')")
            }
        } else {
            eh.renderMenu(composeStatus(model.title), model.items) { ok ->
                if (!ok) diag("evenHub: menu render failed ('${model.title}')")
            }
        }
    }

    /** Render free-form content (CC output, errors) to the active display path.
     *  EvenHub → status-bar + body text screen; teleprompter → hud.render. When
     *  the EvenHub session isn't up yet, buffer to pendingHudText for replay. */
    private fun renderContent(text: String) {
        if (EVENHUB_ENABLED) {
            val eh = evenHud
            if (eh != null && evenHubLaunched.get()) {
                eh.renderText(composeStatus("Claude Code"), text) { ok ->
                    if (!ok) diag("evenHub: text render failed (${text.length}c)")
                }
            } else {
                pendingHudText = text
                diag("evenHub: queued ${text.length}c content (session not launched)")
            }
            return
        }
        val h = hud
        if (h != null) {
            h.render(text)
        } else {
            pendingHudText = text
            diag("hud-buffer: queued ${text.length}-char content while HUD unavailable")
        }
    }

    /** EvenHub confirm_on_hud: push a selectable confirm frame (prompt as the
     *  read-only header; ✓ Confirm / ✗ Reject as menu-list options the firmware
     *  reports on e0-01). NOTE: unlike the teleprompter ConfirmationFlow this path
     *  sends no BLE delivery-ack, so the server's channel-router marks delivery
     *  'unverified' after its window (a status, not a failure). Backing out leaves
     *  the confirm pending until answered or the socket drops (server rejects all
     *  pending on close) — consistent with the no-timeouts rule. */
    private fun showHubConfirm(requestId: String, text: String) {
        val rm = rootMenu ?: return
        val cm = connection ?: return
        rm.pushSubmenu(
            title = "Confirm",
            items = listOf(
                RootMenu.MenuItem.Action("✓ Confirm") {
                    cm.send(ClientMessage.ConfirmOnHudResponse(requestId, "confirmed"))
                    rm.popToRoot()
                    state.transition(AppState.IDLE)
                },
                RootMenu.MenuItem.Action("✗ Reject") {
                    cm.send(ClientMessage.ConfirmOnHudResponse(requestId, "rejected"))
                    rm.popToRoot()
                    state.transition(AppState.IDLE)
                },
            ),
            displayHeader = text,
        )
    }

    private fun dispatchInbound(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.DispatchTargetList -> {
                menu?.dispatchTargets = msg.targets
            }
            is ServerMessage.DirectoryListReply -> {
                menu?.directories = msg.entries
                // Phase Ω: if the RootMenu flow requested this, replace the
                // current "(loading directories…)" frame with real Actions
                // — one per directory entry. Tapping an entry sends
                // DirectorySelect and pushes a "Spawning…" frame; the
                // matching SessionInfo or CcError replaces that one.
                if (menuAwaitingDirectoryList) {
                    menuAwaitingDirectoryList = false
                    val rm = rootMenu
                    if (rm != null) {
                        // R1-MEDIUM1: if the user tapped "← Back" out of the
                        // loading frame before the reply arrived, we're at
                        // depth 0 (root). Replacing the root frame with
                        // directory entries would clobber the entire G2CC
                        // root menu. Ignore the reply in that case.
                        if (rm.depth == 0) {
                            diag("rootMenu: directory_list_reply arrived after user backed out of CC flow — ignoring")
                            return
                        }
                        diag("rootMenu: directory_list_reply (${msg.entries.size} entries) — populating submenu")
                        val items: List<RootMenu.MenuItem> = msg.entries.map { entry ->
                            RootMenu.MenuItem.Action(entry.name) {
                                selectDirectoryFromMenu(entry.path, entry.name)
                            }
                        }
                        // R1-HIGH3: preserve a back-out gesture across the
                        // replace — without addBack=true the user has no
                        // way to escape this frame (firmware eats
                        // double-tap, and popToRoot isn't wired to a tap).
                        if (items.isEmpty()) {
                            rm.replaceCurrentFrame("Claude Code", listOf(
                                RootMenu.MenuItem.Action("(no directories under /home/user)") {},
                            ), addBack = true)
                        } else {
                            rm.replaceCurrentFrame("Pick directory", items, addBack = true)
                        }
                    }
                }
            }
            is ServerMessage.Output -> {
                if (state.current != AppState.STREAMING) state.transition(AppState.STREAMING)
                // 4th-pass review HIGH (BLE bug 7) fix: only buffer in
                // pendingHudText when the HUD is actually unavailable. If we
                // unconditionally set it on every Output, a later
                // ConfirmationFlow render updates Hud.lastRenderedText but
                // NOT pendingHudText — and on reconnect we'd replay the
                // stale Output, hiding the confirmation prompt the server is
                // waiting on (wedges per no-timeouts rule). The pendingHud
                // buffer is now purely a "missed update during outage" queue.
                renderContent(msg.text)
            }
            is ServerMessage.TextDelta -> {
                // Phase 6 doesn't yet stream incremental updates to the HUD —
                // we wait for Output messages with full pages. Phase 8 may
                // optimize for low-latency streaming.
            }
            is ServerMessage.ResponseComplete -> {
                state.transition(AppState.IDLE)
                // M6: CC finished streaming — replace whatever's on screen
                // (CC output text rendered via hud.render) with the active
                // CC menu so the user has the next action available.
                val rm = rootMenu
                val name = activeCcProjectName
                if (rm != null && name != null) {
                    rm.replaceCurrentFrame(
                        title = "Claude Code: $name",
                        items = buildActiveCcMenuItems(name),
                        addBack = true,
                    )
                    diag("rootMenu: response_complete → re-rendered active CC menu")
                }
            }
            is ServerMessage.SessionInfo -> {
                Log.i(TAG, "session_info project=${msg.projectPath} resumed=${msg.resumed} ccId=${msg.ccSessionId}")
                val projectName = msg.projectPath.substringAfterLast('/').ifEmpty { msg.projectPath }
                // M4: mark the session active so subsequent "Claude Code"
                // taps route into the active submenu instead of triggering
                // a new dispatch flow.
                activeCcProjectName = projectName
                // If the menu flow triggered this spawn, replace the
                // "Spawning…" frame with the active CC menu directly so
                // the user can immediately Record prompt.
                if (menuAwaitingSessionInfo) {
                    menuAwaitingSessionInfo = false
                    val rm = rootMenu
                    if (rm != null) {
                        if (rm.depth == 0) {
                            diag("rootMenu: session_info arrived after user backed out — ignoring")
                            return
                        }
                        val verb = if (msg.resumed) "Resumed" else "Started"
                        rm.replaceCurrentFrame(
                            title = "Claude Code: $projectName",
                            items = buildActiveCcMenuItems(projectName),
                            addBack = true,
                            displayHeader = "✓ $verb $projectName",
                        )
                        diag("rootMenu: session_info → active CC submenu ($projectName, resumed=${msg.resumed})")
                    }
                }
            }
            is ServerMessage.ConfirmOnHud -> {
                state.transition(AppState.AWAITING_CONFIRMATION)
                if (EVENHUB_ENABLED && rootMenu != null && connection != null) {
                    // Render the prompt as a selectable confirm frame so the user
                    // can answer with a tap (firmware reports the choice on e0-01).
                    diag("confirm: EvenHub confirm frame requestId=${msg.requestId}")
                    showHubConfirm(msg.requestId, msg.text)
                    return
                }
                val flow = confirmation
                if (flow == null) {
                    // Display-independence audit fix (CRITICAL finding #1):
                    // server's CC subprocess is blocked on this confirmation
                    // promise. If we don't reply, the promise hangs forever
                    // (per the no-timeouts rule the server can't bail itself
                    // out). Auto-reject immediately so CC unblocks instead of
                    // wedging the entire subprocess on a phone that has no
                    // way to render the prompt. Audit + diag so it's not
                    // silent. Phone-side fallback gesture (audit finding #2,
                    // NOTABLE) can override this later with an "approve"
                    // path that doesn't depend on the HUD.
                    Log.w(TAG, "confirm_on_hud arrived but ConfirmationFlow not initialized — auto-rejecting to unblock CC")
                    diag("confirm: auto-rejected (HUD unavailable) requestId=${msg.requestId}")
                    connection?.send(ClientMessage.ConfirmOnHudResponse(msg.requestId, "rejected"))
                    state.transition(AppState.IDLE)
                } else {
                    flow.onConfirmRequest(msg)
                }
            }
            is ServerMessage.CcError -> {
                state.transition(AppState.ERROR)
                renderContent("ERROR: ${msg.error}")
                // Phase Ω: if the menu flow triggered this, replace the
                // current frame with the error so the user isn't left
                // staring at "Spawning…" / "(loading directories…)" forever.
                // Clear both flags — either could have been live.
                if (menuAwaitingDirectoryList || menuAwaitingSessionInfo) {
                    menuAwaitingDirectoryList = false
                    menuAwaitingSessionInfo = false
                    val rm = rootMenu
                    if (rm != null && rm.depth > 0) {
                        // R1-HIGH2: NO TRUNCATION on user-facing strings — pass
                        // the full error text; firmware scrolls if it overflows.
                        // R1-HIGH3: addBack=true so the user can dismiss the
                        // error and return to the root menu.
                        // R6-MEDIUM: collapse newlines / CRs so the error
                        // doesn't break RootMenu's body-rendering invariant
                        // (each MenuItem.label occupies exactly one body line;
                        // an embedded \n would leave subsequent lines un-
                        // prefixed and break highlight tracking on HUD).
                        val sanitized = msg.error.replace('\r', ' ').replace('\n', ' ')
                        rm.replaceCurrentFrame("Claude Code", listOf(
                            RootMenu.MenuItem.Action("✗ $sanitized") {},
                        ), addBack = true)
                        diag("rootMenu: cc_error — replaced pending frame with error (${msg.error.length} chars)")
                    } else {
                        diag("rootMenu: cc_error arrived after user backed out — flags cleared, no replace")
                    }
                }
            }
            is ServerMessage.SttError -> {
                // M5: surface the error inside the menu so the user can
                // retry or back out cleanly. The "Retry recording" Action
                // re-triggers toggleRecording immediately.
                val rm = rootMenu
                val name = activeCcProjectName
                if (rm != null) {
                    rm.replaceCurrentFrame(
                        title = "STT error",
                        items = listOfNotNull(
                            RootMenu.MenuItem.Action("⟲ Retry recording") {
                                toggleRecording()
                            },
                            name?.let { projectName ->
                                RootMenu.MenuItem.Action("← Back to Claude Code") {
                                    rm.replaceCurrentFrame(
                                        title = "Claude Code: $projectName",
                                        items = buildActiveCcMenuItems(projectName),
                                        addBack = true,
                                    )
                                }
                            },
                        ),
                        displayHeader = msg.error,
                    )
                } else {
                    renderContent("STT ERROR: ${msg.error}\n\nTap to try again.")
                }
                state.transition(AppState.IDLE)
            }
            is ServerMessage.Error -> {
                // ServerMessage.Error carries protocol-level errors (auth race,
                // unknown msg type, etc.) that mean nothing to the user wearing
                // the glasses — rendering "ERROR: Not authenticated" to the HUD
                // during a transient reconnect is just noise. Log loudly +
                // forward to the diag stream so we can debug from the server
                // log, but DON'T take over the HUD or transition AppState.
                Log.w(TAG, "server error (not user-facing): ${msg.message}")
                diag("server-err: ${msg.message}")
            }
            // Bug fix #6: log loudly instead of silently dropping.
            is ServerMessage.Status -> {
                Log.i(TAG, "status: mode=${msg.mode} ctx=${msg.contextPct}% processing=${msg.isProcessing}")
                // Capture for the EvenHub status bar (applied on the next render).
                statusMode = msg.mode
                statusContextPct = msg.contextPct
                statusProcessing = msg.isProcessing
            }
            is ServerMessage.ToolUse -> Log.i(TAG, "tool_use: ${msg.tool} ${msg.description}")
            is ServerMessage.BackgroundAlertMsg -> Log.i(TAG, "bg_alert: ${msg.alertType} session=${msg.sessionId} ${msg.details ?: ""}")
            is ServerMessage.PermissionRequest -> Log.i(TAG, "permission_request: id=${msg.requestId} tool=${msg.tool}")
            is ServerMessage.SttResult -> {
                Log.i(TAG, "stt_result: \"${msg.text}\"")
                val transcript = msg.text
                val rm = rootMenu
                val cm = connection
                val name = activeCcProjectName
                if (rm != null && cm != null) {
                    // M5: menu-driven STT confirmation. The transcript goes
                    // in displayHeader (read-only, untruncated, scrollable).
                    // The user picks ✓ to send to CC, ⟲ to re-record (which
                    // immediately calls toggleRecording), or ✗ to cancel
                    // back to the active CC menu.
                    rm.replaceCurrentFrame(
                        title = "Confirm transcript",
                        items = listOfNotNull(
                            RootMenu.MenuItem.Action("✓ Send to Claude") {
                                cm.send(ClientMessage.Prompt(transcript))
                                rm.replaceCurrentFrame(
                                    title = "Sending…",
                                    items = listOf(
                                        RootMenu.MenuItem.Action("(waiting for Claude response)") {},
                                    ),
                                )
                                state.transition(AppState.STREAMING)
                            },
                            RootMenu.MenuItem.Action("⟲ Re-record") {
                                toggleRecording()
                            },
                            name?.let { projectName ->
                                RootMenu.MenuItem.Action("✗ Cancel") {
                                    rm.replaceCurrentFrame(
                                        title = "Claude Code: $projectName",
                                        items = buildActiveCcMenuItems(projectName),
                                        addBack = true,
                                    )
                                    state.transition(AppState.IDLE)
                                }
                            } ?: RootMenu.MenuItem.Action("✗ Cancel") {
                                rm.popToRoot()
                                state.transition(AppState.IDLE)
                            },
                        ),
                        displayHeader = transcript,
                    )
                    state.transition(AppState.AWAITING_CONFIRMATION)
                    return
                }
                // Fallback path: legacy SttConfirmationFlow render (kept for
                // safety while M5 stabilizes). Shouldn't fire in production.
                val flow = sttConfirmation
                if (flow != null) {
                    flow.onSttResult(transcript)
                    state.transition(AppState.AWAITING_CONFIRMATION)
                } else {
                    // Server transcribed but the client lacks a confirmation
                    // flow (HUD not initialized — happens before installBleClients
                    // has wired things up). Render directly so the transcript
                    // isn't silently dropped, and fall back to IDLE so the user
                    // can re-record if needed. No auto-send-to-CC because the
                    // user explicitly asked for a confirmation gate.
                    Log.w(TAG, "stt_result arrived without SttConfirmationFlow — rendering raw, no auto-send")
                    renderContent("STT (unconfirmed): \"${msg.text}\"")
                    state.transition(AppState.IDLE)
                }
            }
            is ServerMessage.SessionList -> Log.i(TAG, "session_list: ${msg.sessions.size} saved")
            is ServerMessage.ActiveSessionList -> Log.i(TAG, "active_session_list: ${msg.sessions.size} active")
            is ServerMessage.RewindResult -> Log.i(TAG, "rewind_result: success=${msg.success} ${msg.summary}")
            is ServerMessage.AuthResult, is ServerMessage.Hb -> {
                // Handled inside ConnectionManager — these don't surface to dispatchInbound.
            }
            is ServerMessage.ConfigSnapshot -> Log.i(TAG, "config_snapshot received")
            is ServerMessage.DispatchTargetSet -> Log.i(TAG, "dispatch_target_set: ${msg.targetId} flow=${msg.flow}")
        }
    }

    private suspend fun refreshEndpoints(cmRef: ConnectionManager) {
        val token = prefs.authToken ?: return
        val bootstrap = prefs.serverUrl ?: return
        val list = EndpointFetcher(httpClient).fetch(bootstrap, token)
        if (list != null && list.isNotEmpty()) {
            Log.i(TAG, "endpoint refresh: ${list.size} endpoints")
            cmRef.setEndpoints(list)
        }
    }

    // Phase 7's emitAck + AckEmitter stub were obsoleted: ConfirmationFlow.kt
    // now sends BleAckMsg inline from its hud.render onComplete callback. The
    // dead code (and AckEmitter.kt) was removed in the third-pass cleanup.

    companion object {
        const val TAG = "G2Pipeline"

        /** Debounce window for paired-lens BLE input events (Phase 7 fix #10). */
        const val EVENT_DEBOUNCE_MS = 300L

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(Duration.ofSeconds(10))
            .readTimeout(Duration.ofSeconds(10))
            // No callTimeout — that would be an I/O timeout on long operations.
            // OkHttp's connect/read are TCP-level transport limits, not I/O cuts.
            .build()
    }
}
