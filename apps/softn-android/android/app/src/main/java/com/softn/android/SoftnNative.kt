package com.softn.android

import java.nio.ByteBuffer

/**
 * JNI bindings to the native Rust SoftN Mobile Engine (`libsoftn_mobile.so`),
 * powered by `zipp-browser` (Stylo CSS + Taffy + Parley + TinySkia) and `zipp-vm`
 * (frontend JS/TS/React + full-stack Container v2 PHP/JS/TS/Python/Rust backend + SQLite).
 */
object SoftnNative {
    init {
        System.loadLibrary("softn_mobile")
    }

    external fun nativeCreate(
        bundleBytes: ByteArray,
        dataDir: String,
        width: Int,
        height: Int,
        density: Float,
        deviceInfoJson: String
    ): Long

    external fun nativeResize(handle: Long, width: Int, height: Int, density: Float)

    external fun nativeRender(handle: Long, rgbaBuffer: ByteBuffer): Boolean

    external fun nativeTap(handle: Long, x: Float, y: Float): String

    external fun nativeScroll(handle: Long, deltaY: Float): Boolean

    external fun nativeScroll2D(handle: Long, deltaX: Float, deltaY: Float): Boolean

    @Volatile private var hasScroll2D = true

    /**
     * 2D scroll helper with graceful fallback to vertical-only `nativeScroll` when running
     * against an older prebuilt `libsoftn_mobile.so` (e.g. zipp-browser v0.1.2).
     */
    fun scroll2D(handle: Long, deltaX: Float, deltaY: Float): Boolean {
        if (hasScroll2D) {
            try {
                return nativeScroll2D(handle, deltaX, deltaY)
            } catch (_: UnsatisfiedLinkError) {
                hasScroll2D = false
            }
        }
        return if (kotlin.math.abs(deltaY) > 0.01f) nativeScroll(handle, deltaY) else false
    }

    external fun nativePointerDown(handle: Long, x: Float, y: Float): Boolean

    external fun nativePointerMove(handle: Long, x: Float, y: Float): String

    external fun nativePointerUp(handle: Long, x: Float, y: Float): String

    external fun nativeSelectOption(handle: Long, flid: Int, index: Int): String

    external fun nativeTextInput(handle: Long, text: String): String

    external fun nativeSubmitIme(handle: Long): String

    external fun nativeResolveDeviceCall(
        handle: Long,
        requestId: Long,
        ok: Boolean,
        payloadJson: String
    ): String

    external fun nativeDrainPendingCalls(handle: Long): String

    external fun nativeTick(handle: Long): String

    external fun nativeGetBundleInfo(handle: Long): String

    external fun nativeClearCache(handle: Long): String

    external fun nativeClearSiteData(handle: Long): String

    external fun nativeDestroy(handle: Long)
}
