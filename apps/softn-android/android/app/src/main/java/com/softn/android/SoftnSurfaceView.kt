package com.softn.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.widget.OverScroller
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs

/**
 * Renders the RGBA8888 framebuffer produced by `zipp-browser`'s TinySkia rasterizer
 * directly onto an Android hardware-accelerated Canvas.
 *
 * Performance & UX features:
 * - Double-buffered `Bitmap` presentation so `copyPixelsFromBuffer` never stalls UI `onDraw()`.
 * - Inertial momentum fling (`VelocityTracker` + `OverScroller`) driven by vsync `postOnAnimation`.
 * - Multi-touch safe active-pointer tracking and 2D (horizontal + vertical) drag scrolling.
 * - Leak-safe `release()` guarded against late engine frames after `onDestroy()`.
 */
class SoftnSurfaceView(
    context: Context,
    private val onViewportReady: (width: Int, height: Int, density: Float) -> Unit,
    private val onTap: (x: Float, y: Float) -> Unit,
    private val onScroll: (deltaX: Float, deltaY: Float) -> Unit,
    private val onPointerDown: (x: Float, y: Float) -> Boolean,
    private val onPointerMove: (x: Float, y: Float) -> Unit,
    private val onPointerUp: (x: Float, y: Float) -> Unit
) : View(context) {

    private var frontBitmap: Bitmap? = null
    private var backBitmap: Bitmap? = null
    private val bitmapLock = Any()
    private val presentLock = Any()
    private val released = AtomicBoolean(false)

    private val statusPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#94A3B8")
        textSize = 15f * resources.displayMetrics.density
        textAlign = Paint.Align.CENTER
    }
    @Volatile private var statusMessage: String? = "Booting SoftN Engine..."

    private val viewConfig = ViewConfiguration.get(context)
    private val touchSlop = viewConfig.scaledTouchSlop.toFloat()
    private val minFlingVelocity = viewConfig.scaledMinimumFlingVelocity.toFloat()
    private val maxFlingVelocity = viewConfig.scaledMaximumFlingVelocity.toFloat()

    private val scroller = OverScroller(context)
    private var velocityTracker: VelocityTracker? = null
    private var lastFlingX = 0
    private var lastFlingY = 0
    private var flingActive = false

    private var activePointerId = MotionEvent.INVALID_POINTER_ID
    private var downX = 0f
    private var downY = 0f
    private var lastX = 0f
    private var lastY = 0f
    private var isDragging = false
    private var canvasCaptured = false

    private val flingRunnable = object : Runnable {
        override fun run() {
            if (!flingActive || released.get()) return
            if (scroller.computeScrollOffset()) {
                val curX = scroller.currX
                val curY = scroller.currY
                val dx = (curX - lastFlingX).toFloat()
                val dy = (curY - lastFlingY).toFloat()
                lastFlingX = curX
                lastFlingY = curY
                if (abs(dx) > 0.25f || abs(dy) > 0.25f) {
                    onScroll(dx, dy)
                }
                if (!scroller.isFinished) {
                    postOnAnimation(this)
                } else {
                    flingActive = false
                }
            } else {
                flingActive = false
            }
        }
    }

    fun setStatusMessage(message: String?) {
        statusMessage = message
        postInvalidate()
    }

    /**
     * Drop the last frame, so the status message shows instead of a picture of an app whose
     * engine is gone (onDraw draws the status only when there is no frame).
     */
    fun clearFrame() {
        synchronized(presentLock) {
            synchronized(bitmapLock) {
                frontBitmap = null
                backBitmap = null
            }
        }
        postInvalidate()
    }

    /**
     * Copy pixels into the off-screen `backBitmap` outside `bitmapLock`, then swap
     * `frontBitmap` <-> `backBitmap` under a sub-microsecond lock so UI `onDraw()` never
     * waits for a 10+ MB framebuffer copy.
     */
    fun presentRgbaBuffer(buffer: ByteBuffer, width: Int, height: Int) {
        if (width <= 0 || height <= 0 || released.get()) return
        synchronized(presentLock) {
            if (released.get()) return
            var target = backBitmap
            if (target == null || target.isRecycled || target.width != width || target.height != height) {
                // Do not call Bitmap.recycle() explicitly on hardware-accelerated bitmaps:
                // RenderThread may still reference the old buffer until its display list finishes.
                target = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                backBitmap = target
            }
            buffer.rewind()
            target.copyPixelsFromBuffer(buffer)
            statusMessage = null

            synchronized(bitmapLock) {
                if (released.get()) {
                    backBitmap = null
                    return
                }
                val previousFront = frontBitmap
                frontBitmap = target
                backBitmap = previousFront
            }
        }
        postInvalidate()
    }

    private fun stopFling() {
        if (flingActive || !scroller.isFinished) {
            flingActive = false
            scroller.forceFinished(true)
            removeCallbacks(flingRunnable)
        }
    }

    private fun recycleVelocityTracker() {
        velocityTracker?.recycle()
        velocityTracker = null
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (w > 0 && h > 0) {
            onViewportReady(w, h, resources.displayMetrics.density)
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        synchronized(bitmapLock) {
            val bmp = frontBitmap
            if (bmp != null && !bmp.isRecycled) {
                if (bmp.width < width || bmp.height < height) {
                    canvas.drawColor(Color.parseColor("#0F172A"))
                }
                canvas.drawBitmap(bmp, 0f, 0f, null)
                return
            }
        }
        canvas.drawColor(Color.parseColor("#0F172A"))
        statusMessage?.let { msg ->
            canvas.drawText(msg, width / 2f, height / 2f, statusPaint)
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                stopFling()
                recycleVelocityTracker()
                velocityTracker = VelocityTracker.obtain().also { it.addMovement(event) }

                activePointerId = event.getPointerId(0)
                downX = event.x
                downY = event.y
                lastX = event.x
                lastY = event.y
                isDragging = false
                canvasCaptured = onPointerDown(event.x, event.y)
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                val ptrIdx = event.findPointerIndex(activePointerId)
                if (ptrIdx < 0) return true
                val curX = event.getX(ptrIdx)
                val curY = event.getY(ptrIdx)

                if (canvasCaptured) {
                    onPointerMove(curX, curY)
                    return true
                }
                velocityTracker?.addMovement(event)

                val dxTotal = abs(curX - downX)
                val dyTotal = abs(curY - downY)
                if (!isDragging && (dyTotal > touchSlop || dxTotal > touchSlop)) {
                    isDragging = true
                    lastX = curX
                    lastY = curY
                }
                if (isDragging) {
                    val deltaX = lastX - curX
                    val deltaY = lastY - curY
                    lastX = curX
                    lastY = curY
                    if (abs(deltaX) > 0.5f || abs(deltaY) > 0.5f) {
                        onScroll(deltaX, deltaY)
                    }
                }
                return true
            }
            MotionEvent.ACTION_POINTER_UP -> {
                val pointerIndex = event.actionIndex
                val pointerId = event.getPointerId(pointerIndex)
                if (pointerId == activePointerId) {
                    val newIndex = if (pointerIndex == 0) 1 else 0
                    if (newIndex < event.pointerCount) {
                        activePointerId = event.getPointerId(newIndex)
                        lastX = event.getX(newIndex)
                        lastY = event.getY(newIndex)
                        velocityTracker?.clear()
                    }
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                val ptrIdx = event.findPointerIndex(activePointerId).let { if (it >= 0) it else 0 }
                val upX = event.getX(ptrIdx)
                val upY = event.getY(ptrIdx)
                activePointerId = MotionEvent.INVALID_POINTER_ID

                if (canvasCaptured) {
                    canvasCaptured = false
                    recycleVelocityTracker()
                    onPointerUp(upX, upY)
                    return true
                }
                if (!isDragging) {
                    recycleVelocityTracker()
                    onTap(upX, upY)
                } else {
                    velocityTracker?.let { vt ->
                        vt.addMovement(event)
                        vt.computeCurrentVelocity(1000, maxFlingVelocity)
                        val vx = -vt.xVelocity
                        val vy = -vt.yVelocity
                        val flingVx = if (abs(vx) >= minFlingVelocity) vx.toInt() else 0
                        val flingVy = if (abs(vy) >= minFlingVelocity) vy.toInt() else 0
                        if (flingVx != 0 || flingVy != 0) {
                            lastFlingX = 0
                            lastFlingY = 0
                            scroller.fling(
                                0,
                                0,
                                flingVx,
                                flingVy,
                                -100_000,
                                100_000,
                                -100_000,
                                100_000
                            )
                            flingActive = true
                            postOnAnimation(flingRunnable)
                        }
                    }
                    recycleVelocityTracker()
                }
                isDragging = false
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                activePointerId = MotionEvent.INVALID_POINTER_ID
                stopFling()
                recycleVelocityTracker()
                if (canvasCaptured) {
                    canvasCaptured = false
                    onPointerUp(event.x, event.y)
                }
                isDragging = false
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    override fun onDetachedFromWindow() {
        stopFling()
        recycleVelocityTracker()
        super.onDetachedFromWindow()
    }

    fun release() {
        released.set(true)
        stopFling()
        recycleVelocityTracker()
        synchronized(presentLock) {
            synchronized(bitmapLock) {
                // Drop references without calling recycle() so RenderThread never draws a recycled bitmap.
                frontBitmap = null
                backBitmap = null
            }
        }
    }
}
