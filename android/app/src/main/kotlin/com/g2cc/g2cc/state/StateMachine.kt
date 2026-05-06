package com.g2cc.g2cc.state

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Coroutine-flow-backed state holder. Phase 4 placeholder; transitions are
 * loud (logged at INFO) so the plumbing is observable during sideload.
 *
 * Hard rules baked in:
 *   - Invalid transitions are LOGGED and rejected (loud, not silent).
 *   - No `withTimeout` anywhere — the state machine is event-driven; the
 *     external signal (BLE event, WS message, gesture) drives transitions.
 */
class StateMachine(initial: AppState = AppState.BOOTING) {

    private val _flow = MutableStateFlow(initial)
    val flow: StateFlow<AppState> = _flow.asStateFlow()

    val current: AppState get() = _flow.value

    /**
     * Attempt a transition. Returns `true` on success, `false` if rejected.
     * Rejection is logged loudly with both states for diagnostics.
     */
    fun transition(target: AppState): Boolean {
        val from = _flow.value
        if (from == target) return true
        if (!from.canTransitionTo(target)) {
            Log.w(TAG, "rejected transition: $from -> $target")
            return false
        }
        _flow.value = target
        Log.i(TAG, "transition: $from -> $target")
        return true
    }

    /** Force-set without validating transitions. ERROR-recovery only. */
    fun forceSet(target: AppState) {
        val from = _flow.value
        Log.w(TAG, "forced transition: $from -> $target")
        _flow.value = target
    }

    companion object {
        const val TAG = "G2CCState"
    }
}
