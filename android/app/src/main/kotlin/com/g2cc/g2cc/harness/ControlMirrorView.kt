package com.g2cc.g2cc.harness

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import androidx.core.view.GestureDetectorCompat
import com.g2cc.g2cc.net.ClientMessage
import com.g2cc.g2cc.os.ControlInputMapper
import com.g2cc.g2cc.os.MirrorGeometry
import com.g2cc.g2cc.render.Display
import com.g2cc.g2cc.render.Scene

/**
 * The control-mode display surface (multi-surface 2026-07-13): draws the
 * [ExpectedMirror] bitmap FIT-scaled on black (pillarboxed on a 20:9 landscape
 * phone) and turns touch into `input` messages:
 *
 *   touch → GestureDetector → [MirrorGeometry.viewToScene] → [ControlInputMapper]
 *         → [onInput] (the Activity forwards to ConnectionService.sendControlInput)
 *
 * All geometry (fit rect, list rows) comes from [MirrorGeometry] — the same
 * module the mirror renderer uses — so taps land exactly on drawn rows.
 * ACTION_UP/CANCEL reset the mapper's scroll accumulator (remainder is
 * per-gesture by design).
 */
class ControlMirrorView(context: Context) : View(context) {

    /** Mapped inputs surface here — the Activity owns delivery + red status. */
    var onInput: (ClientMessage.Input) -> Unit = {}

    private val mapper = ControlInputMapper()
    private var scene: Scene? = null
    private var bitmap: Bitmap? = null
    private val paint = Paint()   // filtering OFF (default) → crisp pixels at ~4×, like the PC page's `pixelated`
    private val dst = RectF()

    init {
        // Accessibility basics: this is one big interactive surface.
        isClickable = true
        isFocusable = true
        contentDescription = "G2 display mirror — tap to select, drag to scroll, double-tap to go back"
    }

    /** New scene + its rendered mirror bitmap (the Activity renders once and
     *  hands both over so hit-testing and pixels can never diverge). */
    fun setScene(s: Scene?, bmp: Bitmap) {
        scene = s
        bitmap = bmp
        invalidate()
    }

    // GestureDetectorCompat (deprecated in androidx.core in favor of the
    // platform detector, kept per the plan — identical behavior on API 29+).
    @Suppress("DEPRECATION")
    private val gestures = GestureDetectorCompat(
        context,
        object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent): Boolean = true   // claim the stream

            override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
                // Null = the letterbox bars — dead space, not display.
                val p = MirrorGeometry.viewToScene(width, height, e.x, e.y) ?: return true
                emit(mapper.map(scene, ControlInputMapper.Gesture.SingleTap(p.first, p.second)))
                return true
            }

            override fun onDoubleTap(e: MotionEvent): Boolean {
                emit(mapper.map(scene, ControlInputMapper.Gesture.DoubleTap))
                return true
            }

            override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
                val scale = MirrorGeometry.fitScale(width, height)
                if (scale <= 0f) return true
                // distanceY > 0 = finger moved UP (the detector's old−new convention)
                // — matches the mapper's ScrollBy sign contract.
                emit(mapper.map(scene, ControlInputMapper.Gesture.ScrollBy(distanceY / scale)))
                return true
            }
        },
    )

    private fun emit(inputs: List<ClientMessage.Input>) {
        for (i in inputs) onInput(i)
    }

    @SuppressLint("ClickableViewAccessibility")   // performClick fired below on UP
    override fun onTouchEvent(event: MotionEvent): Boolean {
        gestures.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_UP -> {
                mapper.reset()      // gesture over — drop the sub-notch scroll remainder
                performClick()      // accessibility click hook
            }
            MotionEvent.ACTION_CANCEL -> mapper.reset()
        }
        return true
    }

    override fun performClick(): Boolean {
        super.performClick()   // accessibility event; real handling is gesture-based
        return true
    }

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(Color.BLACK)
        val b = bitmap ?: return
        val scale = MirrorGeometry.fitScale(width, height)
        if (scale <= 0f) return
        val w = Display.WIDTH * scale
        val h = Display.HEIGHT * scale
        val ox = (width - w) / 2f
        val oy = (height - h) / 2f
        dst.set(ox, oy, ox + w, oy + h)
        canvas.drawBitmap(b, null, dst, paint)
    }
}
