package com.g2cc.g2cc.state

import android.content.Context
import com.g2cc.g2cc.R

/**
 * Phase 4 placeholder state machine — ports the SHAPE of g2code's `app/src/state.ts`
 * without wiring the transitions to real BLE / WebSocket / audio events.
 *
 * Phase 6 brings this to life. Transition rules below are advisory until then.
 */
enum class AppState {
    BOOTING,
    CONNECTING,
    AUTHED,
    IDLE,
    MENU,
    DIRECTORY_PICKER,
    AWAITING_TRANSCRIPT,
    AWAITING_CONFIRMATION,
    STREAMING,
    ERROR;

    fun label(ctx: Context): String = when (this) {
        BOOTING -> ctx.getString(R.string.fg_state_booting)
        CONNECTING -> ctx.getString(R.string.fg_state_connecting)
        AUTHED -> ctx.getString(R.string.fg_state_authed)
        IDLE -> ctx.getString(R.string.fg_state_idle)
        MENU -> ctx.getString(R.string.fg_state_menu)
        DIRECTORY_PICKER -> ctx.getString(R.string.fg_state_directory_picker)
        AWAITING_TRANSCRIPT -> ctx.getString(R.string.fg_state_transcribing)
        AWAITING_CONFIRMATION -> ctx.getString(R.string.fg_state_awaiting)
        STREAMING -> ctx.getString(R.string.fg_state_streaming)
        ERROR -> ctx.getString(R.string.fg_state_error)
    }

    /**
     * Whether `target` is a valid transition from this state. Phase 6 turns
     * this into an enforced invariant; today it's documentation.
     */
    fun canTransitionTo(target: AppState): Boolean = when (this) {
        BOOTING -> target == CONNECTING || target == ERROR
        CONNECTING -> target == AUTHED || target == ERROR || target == BOOTING
        AUTHED -> target == IDLE || target == ERROR
        IDLE -> target in setOf(MENU, AWAITING_TRANSCRIPT, STREAMING, ERROR, CONNECTING)
        MENU -> target in setOf(IDLE, DIRECTORY_PICKER)
        DIRECTORY_PICKER -> target in setOf(IDLE, MENU)
        AWAITING_TRANSCRIPT -> target in setOf(AWAITING_CONFIRMATION, ERROR, IDLE)
        AWAITING_CONFIRMATION -> target in setOf(STREAMING, AWAITING_TRANSCRIPT, IDLE)
        STREAMING -> target in setOf(IDLE, MENU, ERROR)
        ERROR -> target in setOf(IDLE, CONNECTING)
    }
}
