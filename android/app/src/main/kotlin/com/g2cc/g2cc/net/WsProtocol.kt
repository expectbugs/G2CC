package com.g2cc.g2cc.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Kotlin port of /home/user/G2CC/shared/src/protocol.ts.
 *
 * The TypeScript discriminated union `type` field maps to kotlinx.serialization's
 * `classDiscriminator = "type"`. Each variant gets `@SerialName(...)` matching
 * the TS string literal.
 *
 * If you add a message type to shared/src/protocol.ts, add it here too — the
 * compiler does not cross-check; PROTOCOL_NOTES.md lineage applies the same way.
 */

object WsJson {
    val codec: Json = Json {
        classDiscriminator = "type"
        ignoreUnknownKeys = true            // tolerate server adding fields
        explicitNulls = false                // TS `field?: T` ↔ Kotlin nullable with omit
        encodeDefaults = false
    }
}

// ============================================================
// Shared types
// ============================================================

@Serializable
enum class PermissionMode {
    @SerialName("default") Default,
    @SerialName("plan") Plan,
    @SerialName("acceptEdits") AcceptEdits,
    @SerialName("bypassPermissions") BypassPermissions,
}

@Serializable
data class SessionSummary(
    val id: String,
    val name: String? = null,
    val project: String,
    val lastActive: String,
)

@Serializable
data class ActiveSessionSummary(
    val id: String,
    val name: String,
    val project: String,
    val state: String,                                  // 'idle' | 'streaming' | 'permission' | 'processing'
    val contextPct: Int,
)

@Serializable
data class BackgroundAlert(
    val sessionId: String,
    val alertType: String,                              // 'permission' | 'complete' | 'error'
)

@Serializable
data class DispatchTarget(
    val id: String,
    val label: String,
    val flow: String? = null,                           // 'directory-picker' | 'immediate'
)

@Serializable
data class DirectoryEntry(
    val name: String,
    val path: String,
    val mtime: Long,
    val entryCount: Int? = null,
)

/** One SMS/MMS conversation summary (Phase 4b). Mirrors shared SmsThread. */
@Serializable
data class SmsThread(
    val id: String,
    val name: String,
    val address: String,
    val snippet: String,
    val unread: Boolean,
    val tsMs: Long,
)

/** One message in an SMS/MMS thread (Phase 4b). Mirrors shared SmsMessage. */
@Serializable
data class SmsMessage(
    val id: String,
    val body: String,
    val incoming: Boolean,
    val tsMs: Long,
    val imageB64: String? = null,
)

/** Now-playing snapshot (Phase 7). Mirrors shared MediaState (named MediaInfo
 *  here to avoid colliding with the ClientMessage.MediaState variant). */
@Serializable
data class MediaInfo(
    val playing: Boolean,
    val title: String? = null,
    val artist: String? = null,
    val album: String? = null,
    val durationMs: Long? = null,
    val positionMs: Long? = null,
    val app: String? = null,
    val artB64: String? = null,
)

// ---- Glasses-OS display contract (Phase 1) — mirrors shared/src/protocol.ts.
// SceneContent is modelled as ONE flat data class (not a sealed hierarchy) so
// it shares WsJson's `type` classDiscriminator-free: the polymorphism is the
// `kind` field, validated in os/SceneCodec.kt. Wire JSON is identical to the
// TS SceneTextContent | SceneImageContent union.

@Serializable
data class SceneContent(
    val kind: String,                 // "text" | "image" | "list"
    val text: String? = null,         // kind == "text"
    val scroll: Boolean? = null,      // kind == "text" (wire f11 = isEventCapture)
    val bmpBase64: String? = null,    // kind == "image" — base64 4bpp gray BMP
    val items: List<String>? = null,  // kind == "list" — native list rows
    val itemWidth: Int? = null,       // kind == "list" — 0/omit = auto
    val selectBorder: Boolean? = null, // kind == "list" — firmware selection ring (default true)
    val eventCapture: Boolean? = null, // kind == "list" — the page's single input region (wire f12)
)

/** Container border/padding styling (wire f5–f8). Zero-valued fields are
 *  omitted on the wire, so unstyled regions stay byte-identical to the
 *  proven lean schema. Mirrors shared/src/protocol.ts RegionStyle. */
@Serializable
data class WireRegionStyle(
    val borderWidth: Int? = null,
    val borderColor: Int? = null,
    val borderRadius: Int? = null,
    val padding: Int? = null,
)

@Serializable
data class SceneRegion(
    val id: Int,
    val name: String,
    val x: Int,
    val y: Int,
    val w: Int,
    val h: Int,
    val kind: String,                 // "text" | "image" | "list"
    val content: SceneContent? = null,
    // last (after content) so existing positional constructions stay valid
    val style: WireRegionStyle? = null,
)

@Serializable
data class WireScene(
    val regions: List<SceneRegion>,
)

// ============================================================
// Client → Server messages
// ============================================================

@Serializable
sealed interface ClientMessage {
    @Serializable @SerialName("auth")
    data class Auth(val token: String) : ClientMessage

    @Serializable @SerialName("client_hb")
    data class ClientHb(
        val now: Long,
        /** Phone battery % (Phase 9, APK v1.7+). Default null = omitted on the
         *  wire (encodeDefaults=false) so old servers see the v1.6 shape. */
        val battery: Int? = null,
        /** GLASSES battery % (Adam 2026-06-12, APK v1.9+) — decoded from the
         *  09-00/09-01 device-info frames (G2_BLE_PROTOCOL.md §10 f4.f12).
         *  Default null = omitted; old servers ignore it. [U] on-glass. */
        val g2Battery: Int? = null,
    ) : ClientMessage

    /** A phone notification forwarded by NotifyListener (Phase 9, READ-ONLY —
     *  no inline reply in v1). The server maps `package` → priority. */
    @Serializable @SerialName("notify")
    data class Notify(
        @SerialName("package") val pkg: String,
        val title: String,
        val text: String,
        val postedAt: Long,
        val key: String,
        /** Downscaled JPEG (base64) from EXTRA_PICTURE — MMS images on glass
         *  (Adam 2026-06-12, APK v1.9+). Default null = omitted on the wire. */
        val imageB64: String? = null,
        /** The post carries an inline-reply RemoteInput (Phase 4a) → Notices
         *  offers Reply. Default null/false; old servers ignore it. */
        val hasReply: Boolean? = null,
    ) : ClientMessage

    /** The phone dismissed a notification WE forwarded → tell the server to mark
     *  the glasses copy seen (Adam 2026-06-13 dismiss sync). */
    @Serializable @SerialName("notification_dismissed")
    data class NotificationDismissed(val key: String) : ClientMessage

    /** Audio format announcement. Defaults match the legacy 16 kHz mono int16
     *  path so older callers don't need to set anything. */
    @Serializable @SerialName("audio_start")
    data class AudioStart(
        val sampleRate: Int = 16_000,
        val channels: Int = 1,
        val encoding: String = "int16",          // "int16" | "float32"
        val source: String? = null,              // "phone-mic" | "dji-usb" | "dji-bt"
        val mode: String? = null,                // "dictate" (default) | "handsfree" (Phase 9)
    ) : ClientMessage

    @Serializable @SerialName("audio_end")
    data object AudioEnd : ClientMessage

    @Serializable @SerialName("prompt")
    data class Prompt(val text: String) : ClientMessage

    @Serializable @SerialName("command")
    data class Command(val command: String) : ClientMessage

    @Serializable @SerialName("interrupt")
    data object Interrupt : ClientMessage

    @Serializable @SerialName("permission_response")
    data class PermissionResponse(val approved: Boolean) : ClientMessage

    @Serializable @SerialName("set_mode")
    data class SetMode(val mode: PermissionMode) : ClientMessage

    @Serializable @SerialName("get_page")
    data class GetPage(val page: Int) : ClientMessage

    @Serializable @SerialName("list_dispatch_targets")
    data object ListDispatchTargets : ClientMessage

    @Serializable @SerialName("dispatch_target_select")
    data class DispatchTargetSelect(val targetId: String) : ClientMessage

    @Serializable @SerialName("directory_list")
    data object DirectoryList : ClientMessage

    @Serializable @SerialName("directory_select")
    data class DirectorySelect(val path: String) : ClientMessage

    @Serializable @SerialName("session_resume")
    data class SessionResume(val sessionId: String) : ClientMessage

    @Serializable @SerialName("session_switch")
    data class SessionSwitch(val sessionId: String) : ClientMessage

    @Serializable @SerialName("session_close")
    data class SessionClose(val sessionId: String) : ClientMessage

    @Serializable @SerialName("list_active_sessions")
    data object ListActiveSessions : ClientMessage

    @Serializable @SerialName("list_sessions")
    data object ListSessions : ClientMessage

    @Serializable @SerialName("rewind")
    data class Rewind(val turns: Int) : ClientMessage

    @Serializable @SerialName("confirm_on_hud_response")
    data class ConfirmOnHudResponse(
        val requestId: String,
        val result: String,                             // 'confirmed' | 'rejected'
    ) : ClientMessage

    @Serializable @SerialName("ble_ack")
    data class BleAck(
        val messageId: String,
        val status: String,                             // 'verified' | 'unverified'
        val reason: String? = null,
    ) : ClientMessage

    /** Free-form diagnostic line — server logs with `[client-diag]` prefix.
     *  Used during hardware bring-up to surface phone-side state without
     *  needing adb / logcat access. */
    @Serializable @SerialName("diag")
    data class Diag(val text: String) : ClientMessage

    /** Opt into Glasses-OS mode — the server then drives the display via
     *  `render` and reacts to `input` (Phase 1). */
    @Serializable @SerialName("os_attach")
    data object OsAttach : ClientMessage

    /** A ring/gesture input event (from EventParser) forwarded to the PC.
     *  Optional fields carry per-variant payloads. */
    @Serializable @SerialName("input")
    data class Input(
        val event: String,                  // tap|double_tap|scroll_up|scroll_down|scroll_focus|hub_select|hub_gesture|focus
        val widgetType: String? = null,     // hub_select
        val index: Int? = null,             // hub_select
        val code: Int? = null,              // hub_gesture
        val region: String? = null,         // focus — the focused region's name
        val value: Int? = null,             // focus — raw f3 (observed 1/2)
    ) : ClientMessage

    /** Result of a Phase-4a inline reply we attempted (loud either way). */
    @Serializable @SerialName("notification_reply_result")
    data class NotificationReplyResult(
        val key: String,
        val ok: Boolean,
        val error: String? = null,
    ) : ClientMessage

    /** Now-playing snapshot pushed on MediaSession change (Phase 7). */
    @Serializable @SerialName("media_state")
    data class MediaState(val state: MediaInfo) : ClientMessage

    /** Reply to sms_threads_request (Phase 4b) — the phone is the provider. */
    @Serializable @SerialName("sms_threads_reply")
    data class SmsThreadsReply(
        val threads: List<SmsThread>,
        val offset: Int,
        val total: Int,
        val error: String? = null,
    ) : ClientMessage

    /** Reply to sms_thread_request — one thread's messages, paginated. */
    @Serializable @SerialName("sms_thread_reply")
    data class SmsThreadReply(
        val threadId: String,
        val name: String,
        val address: String,
        val messages: List<SmsMessage>,
        val page: Int,
        val totalPages: Int,
        val error: String? = null,
    ) : ClientMessage

    /** Live Maps nav line → pinned top-line on glass (Phase 6). */
    @Serializable @SerialName("nav_update")
    data class NavUpdate(val text: String, val eta: String? = null) : ClientMessage

    /** Navigation ended — drop the pinned nav line (Phase 6). */
    @Serializable @SerialName("nav_clear")
    data object NavClear : ClientMessage
}

// ============================================================
// Server → Client messages
// ============================================================

@Serializable
sealed interface ServerMessage {
    @Serializable @SerialName("auth_result")
    data class AuthResult(val success: Boolean, val error: String? = null) : ServerMessage

    @Serializable @SerialName("hb")
    data class Hb(val now: Long) : ServerMessage

    @Serializable @SerialName("config_snapshot")
    data object ConfigSnapshot : ServerMessage

    @Serializable @SerialName("dispatch_target_list")
    data class DispatchTargetList(val targets: List<DispatchTarget>) : ServerMessage

    @Serializable @SerialName("dispatch_target_set")
    data class DispatchTargetSet(val targetId: String, val flow: String? = null) : ServerMessage

    @Serializable @SerialName("directory_list_reply")
    data class DirectoryListReply(val entries: List<DirectoryEntry>) : ServerMessage

    @Serializable @SerialName("session_info")
    data class SessionInfo(
        val sessionId: String,
        val projectPath: String,
        val mode: String,
        val poolSize: Int? = null,
        val poolIndex: Int? = null,
        val resumed: Boolean,
        val ccSessionId: String? = null,
    ) : ServerMessage

    @Serializable @SerialName("output")
    data class Output(val text: String, val page: Int, val totalPages: Int) : ServerMessage

    @Serializable @SerialName("text_delta")
    data class TextDelta(val text: String) : ServerMessage

    @Serializable @SerialName("response_complete")
    data object ResponseComplete : ServerMessage

    @Serializable @SerialName("tool_use")
    data class ToolUse(val tool: String, val description: String) : ServerMessage

    @Serializable @SerialName("permission_request")
    data class PermissionRequest(
        val requestId: String,
        val tool: String? = null,
        val details: String? = null,
    ) : ServerMessage

    @Serializable @SerialName("stt_result")
    data class SttResult(val text: String) : ServerMessage

    @Serializable @SerialName("stt_error")
    data class SttError(val error: String) : ServerMessage

    @Serializable @SerialName("status")
    data class Status(
        val mode: String,
        val contextPct: Int,
        val isProcessing: Boolean,
        val poolSize: Int? = null,
        val poolIndex: Int? = null,
        val projectName: String? = null,
        val backgroundAlerts: List<BackgroundAlert>? = null,
    ) : ServerMessage

    @Serializable @SerialName("cc_error")
    data class CcError(val error: String) : ServerMessage

    @Serializable @SerialName("session_list")
    data class SessionList(val sessions: List<SessionSummary>) : ServerMessage

    @Serializable @SerialName("active_session_list")
    data class ActiveSessionList(val sessions: List<ActiveSessionSummary>) : ServerMessage

    @Serializable @SerialName("background_alert")
    data class BackgroundAlertMsg(
        val sessionId: String,
        val alertType: String,
        val details: String? = null,
    ) : ServerMessage

    @Serializable @SerialName("rewind_result")
    data class RewindResult(
        val success: Boolean,
        val turnsRewound: Int,
        val summary: String,
    ) : ServerMessage

    @Serializable @SerialName("confirm_on_hud")
    data class ConfirmOnHud(val requestId: String, val text: String) : ServerMessage

    /** PC → glasses: render this scene (Phase 1 Glasses-OS). The client builds a
     *  render.Scene from it (injecting the app-owned clock) and drives G2Renderer. */
    @Serializable @SerialName("render")
    data class Render(val scene: WireScene) : ServerMessage

    /** Server → client: start/stop streaming the phone mic (DE 'Dictate'/'Ask').
     *  Drives AudioStreamer; capture failures surface back to the server as a
     *  '[audio-error]'-prefixed diag message (loud, never logcat-only). */
    @Serializable @SerialName("audio_request")
    data class AudioRequest(val action: String, val mode: String? = null) : ServerMessage   // action: start|stop; mode: dictate(default)|handsfree (Phase 9)

    /** Server → client: the DE 'Reload' action — abort any wedged render op and
     *  re-run the COLD_INIT re-takeover with the current scene (the proven
     *  renewal path), re-pushing the whole display. */
    @Serializable @SerialName("display_reload")
    data object DisplayReload : ServerMessage

    /** Server → client: cancel a forwarded notification on the PHONE (Adam
     *  2026-06-13 dismiss sync) — read on glass / MkAll'd. The client calls
     *  cancelNotification(key); a key it no longer holds is a no-op. */
    @Serializable @SerialName("notification_cancel")
    data class NotificationCancel(val key: String) : ServerMessage

    @Serializable @SerialName("error")
    data class Error(val message: String) : ServerMessage

    /** Fill + fire a forwarded notification's inline-reply RemoteInput (Phase
     *  4a). The client reports back via ClientMessage.NotificationReplyResult. */
    @Serializable @SerialName("notification_reply")
    data class NotificationReply(val key: String, val text: String) : ServerMessage

    /** A media transport command (Phase 7). 'subscribe'/'unsubscribe' gate the
     *  MediaController callback; subscribe also pushes the current state. */
    @Serializable @SerialName("media_cmd")
    data class MediaCmd(val cmd: String) : ServerMessage   // play_pause|next|prev|shuffle|subscribe|unsubscribe

    /** Query the phone's SMS/MMS thread list (Phase 4b). */
    @Serializable @SerialName("sms_threads_request")
    data class SmsThreadsRequest(val offset: Int, val limit: Int) : ServerMessage

    /** Query one SMS/MMS thread's messages, paginated (Phase 4b). */
    @Serializable @SerialName("sms_thread_request")
    data class SmsThreadRequest(val threadId: String, val page: Int) : ServerMessage

    /** Send an SMS (Phase 4b — SmsManager.sendTextMessage, needs SEND_SMS). */
    @Serializable @SerialName("sms_send")
    data class SmsSend(val address: String, val text: String) : ServerMessage

    /** Ring the phone to find it (Phase 15). */
    @Serializable @SerialName("phone_locate")
    data class PhoneLocate(val action: String) : ServerMessage   // 'start' | 'stop'
}
