package com.g2cc.g2cc.hud

import android.util.Log
import com.g2cc.g2cc.net.ClientMessage
import com.g2cc.g2cc.net.ConnectionManager
import com.g2cc.g2cc.net.DispatchTarget
import com.g2cc.g2cc.net.DirectoryEntry

/**
 * High-level HUD navigation:
 *
 *   IDLE → tap → MENU (top-level dispatch targets)
 *     → pick "Claude Code" → DIRECTORY_PICKER (scrollable /home/user/{name})
 *       → pick directory → server spawns CC → IDLE in that session
 *
 * When the swarm exists (Phase 9), additional top-level targets appear; the
 * HUD navigation here doesn't change — only the top-level menu list grows.
 *
 * Phase 6 implements the menu rendering + selection logic; the actual gesture
 * dispatch (tap / double-tap / scroll → menu navigation) lands when EventParser
 * is refined with real BLE input events from hardware testing.
 */
class MenuController(private val hud: Hud, private val connection: ConnectionManager) {

    /** Top-level menu state. Updated when the server sends DispatchTargetList. */
    var dispatchTargets: List<DispatchTarget> = emptyList()
        set(value) { field = value; Log.i(TAG, "targets updated: ${value.map { it.id }}") }

    var directories: List<DirectoryEntry> = emptyList()
        set(value) { field = value; Log.i(TAG, "directories updated: ${value.size} entries") }

    /** Phase 6: render the top-level menu (just the list of dispatch target labels). */
    fun showMenu() {
        if (dispatchTargets.isEmpty()) {
            connection.send(ClientMessage.ListDispatchTargets)
            // Reply will repaint when DispatchTargetList arrives. For now, render
            // an empty placeholder loud-and-proud rather than a fake "loading…".
            hud.render("(menu loading — server hasn't sent dispatch_target_list yet)")
            return
        }
        val text = buildString {
            appendLine("DISPATCH TARGETS")
            for ((i, t) in dispatchTargets.withIndex()) {
                appendLine("${i + 1}. ${t.label}")
            }
        }.trimEnd()
        hud.render(text)
    }

    /** Pick a target. The server replies with DispatchTargetSet + (if flow=='directory-picker')
     *  a DirectoryListReply. */
    fun selectTarget(targetId: String) {
        connection.send(ClientMessage.DispatchTargetSelect(targetId))
    }

    /** Phase 6: render the /home/user/{name} directory list scrollably. */
    fun showDirectoryPicker() {
        if (directories.isEmpty()) {
            connection.send(ClientMessage.DirectoryList)
            hud.render("(directory list loading)")
            return
        }
        val text = buildString {
            appendLine("PROJECT DIRECTORIES")
            for ((i, d) in directories.withIndex()) {
                appendLine("${i + 1}. ${d.name}")
            }
        }.trimEnd()
        // The HUD natively scrolls multi-page content via the teleprompter
        // primitive — full list of /home/user/{name} is reachable, NEVER truncated.
        hud.render(text)
    }

    fun selectDirectory(path: String) {
        connection.send(ClientMessage.DirectorySelect(path))
    }

    companion object {
        const val TAG = "G2CCMenu"
    }
}
