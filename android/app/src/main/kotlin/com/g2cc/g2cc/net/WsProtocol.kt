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

// ---- Glasses-OS display contract (Phase 1) — mirrors shared/src/protocol.ts.
// SceneContent is modelled as ONE flat data class (not a sealed hierarchy) so
// it shares WsJson's `type` classDiscriminator-free: the polymorphism is the
// `kind` field, validated in os/SceneCodec.kt. Wire JSON is identical to the
// TS SceneTextContent | SceneImageContent union.

@Serializable
data class SceneContent(
    val kind: String,                 // "text" | "image"
    val text: String? = null,         // kind == "text"
    val scroll: Boolean? = null,      // kind == "text"
    val bmpBase64: String? = null,    // kind == "image" — base64 4bpp gray BMP
)

@Serializable
data class SceneRegion(
    val id: Int,
    val name: String,
    val x: Int,
    val y: Int,
    val w: Int,
    val h: Int,
    val kind: String,                 // "text" | "image"
    val content: SceneContent? = null,
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
    data class ClientHb(val now: Long) : ClientMessage

    /** Audio format announcement. Defaults match the legacy 16 kHz mono int16
     *  path so older callers don't need to set anything. */
    @Serializable @SerialName("audio_start")
    data class AudioStart(
        val sampleRate: Int = 16_000,
        val channels: Int = 1,
        val encoding: String = "int16",          // "int16" | "float32"
        val source: String? = null,              // "phone-mic" | "dji-usb" | "dji-bt"
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

    @Serializable @SerialName("error")
    data class Error(val message: String) : ServerMessage
}
