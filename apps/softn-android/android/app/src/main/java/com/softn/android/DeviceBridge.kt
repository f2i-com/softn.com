package com.softn.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Collections
import java.util.IdentityHashMap
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Native Android Hardware Bridge for SoftN v2 containers.
 *
 * Implements the exact cross-platform Device Bridge protocol shared with `@softn/container`:
 * - `camera`: photo capture via Android Camera intent + FileProvider
 * - `bluetooth`: real BLE scanning, GATT connect, characteristic read & write
 * - `location`: GPS / Network current location via LocationManager
 * - `haptics`: Vibrator / VibratorManager tactile impacts
 * - `notifications`: native Android NotificationManager alerts
 * - `device`: hardware capability detection, Android Share Sheet, Clipboard
 *
 * Every call has ALREADY been checked natively in Rust against `permission.json` before
 * reaching this class; here we additionally request Android OS runtime permissions cleanly.
 */
class DeviceBridge(
    private val activity: ComponentActivity,
    private val onResolve: (generation: Long, requestId: Long, ok: Boolean, payloadJson: String) -> Unit
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val ioExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "softn-device-io").apply { isDaemon = true }
    }
    private val closed = AtomicBoolean(false)
    private val activeGeneration = AtomicLong(0L)
    private val activeCleanups = CopyOnWriteArrayList<() -> Unit>()
    private val nextNotificationId = AtomicInteger(100)
    @Volatile private var notificationChannelCreated = false

    companion object {
        private const val MAX_CLIPBOARD_CHARS = 256 * 1024
        private const val MAX_SHARE_CHARS = 64 * 1024
        private const val MAX_SAVE_FILE_BYTES = 16 * 1024 * 1024
        private const val MAX_SAVE_BASE64_CHARS = 22 * 1024 * 1024
        private const val MAX_BLE_SCAN_DEVICES = 256
        private const val MAX_BLE_WRITE_BYTES = 512
        private const val MAX_BLE_WRITE_BASE64_CHARS = 1024
        private const val BLE_OP_TIMEOUT_MS = 15_000L
        private const val MAX_NOTIFICATION_TITLE_CHARS = 256
        private const val MAX_NOTIFICATION_BODY_CHARS = 1024
        private const val MAX_NOTIFICATIONS_PER_MINUTE = 10
        private const val MIN_NOTIFICATION_INTERVAL_MS = 250L
        private const val MIN_SHARE_INTERVAL_MS = 1500L
    }

    private val notificationTimestamps = ArrayDeque<Long>()
    private var lastShareAtMs: Long = 0L

    private data class QueuedPermRequest(
        val generation: Long,
        val permissions: Array<String>,
        val missing: Array<String>,
        val requireAny: Boolean,
        val onResult: (Boolean) -> Unit
    )
    private val permissionQueue = ArrayDeque<QueuedPermRequest>()
    private var activePermRequest: QueuedPermRequest? = null
    private val permissionLauncher: ActivityResultLauncher<Array<String>> =
        activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
            val current = activePermRequest
            activePermRequest = null
            if (current != null && !closed.get() && current.generation == activeGeneration.get()) {
                val ok = if (current.requireAny) {
                    results.values.any { it }
                } else {
                    current.permissions.all {
                        results[it] == true ||
                            ContextCompat.checkSelfPermission(activity, it) == PackageManager.PERMISSION_GRANTED
                    }
                }
                current.onResult(ok)
            }
            pumpNextPermissionRequest()
        }

    private var pendingPhotoGeneration: Long = 0L
    private var pendingPhotoRequestId: Long? = null
    private var pendingPhotoFile: File? = null
    private var pendingPhotoMaxWidth: Int = 960
    private var pendingPhotoQuality: Int = 85

    private val takePictureLauncher: ActivityResultLauncher<Uri> =
        activity.registerForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
            val reqGen = pendingPhotoGeneration
            val reqId = pendingPhotoRequestId
            val file = pendingPhotoFile
            val maxW = pendingPhotoMaxWidth
            val quality = pendingPhotoQuality
            pendingPhotoRequestId = null
            pendingPhotoFile = null
            if (reqId == null) {
                file?.delete()
                return@registerForActivityResult
            }
            if (reqGen != activeGeneration.get()) {
                file?.delete()
                return@registerForActivityResult
            }

            if (!saved || file == null || !file.exists() || file.length() == 0L) {
                file?.delete()
                fail(reqGen, reqId, "Camera capture cancelled")
                return@registerForActivityResult
            }
            submitIo(reqGen, reqId, "Camera processing failed") {
                try {
                    val decoded = decodeSampledFile(file, maxW)
                    if (decoded == null) {
                        fail(reqGen, reqId, "Failed to decode captured photo")
                        return@submitIo
                    }
                    encodeAndResolveBitmap(reqGen, reqId, decoded, maxW, quality)
                } finally {
                    file.delete()
                }
            }
        }

    private var pendingPickPhotoGeneration: Long = 0L
    private var pendingPickPhotoRequestId: Long? = null
    private var pendingPickPhotoMaxWidth: Int = 960
    private var pendingPickPhotoQuality: Int = 85

    private val pickPhotoLauncher: ActivityResultLauncher<String> =
        activity.registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
            val reqGen = pendingPickPhotoGeneration
            val reqId = pendingPickPhotoRequestId
            val maxW = pendingPickPhotoMaxWidth
            val quality = pendingPickPhotoQuality
            pendingPickPhotoRequestId = null
            if (reqId == null || reqGen != activeGeneration.get()) return@registerForActivityResult
            if (uri == null) {
                fail(reqGen, reqId, "Photo selection cancelled")
                return@registerForActivityResult
            }
            submitIo(reqGen, reqId, "Photo pick failed") {
                val decoded = decodeSampledUri(uri, maxW)
                if (decoded == null) {
                    fail(reqGen, reqId, "Failed to decode selected photo")
                    return@submitIo
                }
                encodeAndResolveBitmap(reqGen, reqId, decoded, maxW, quality)
            }
        }

    private var pendingFilePickGeneration: Long = 0L
    private var pendingFilePickRequestId: Long? = null
    private val openDocumentLauncher: ActivityResultLauncher<Array<String>> =
        activity.registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
            val reqGen = pendingFilePickGeneration
            val reqId = pendingFilePickRequestId
            pendingFilePickRequestId = null
            if (reqId == null || reqGen != activeGeneration.get()) return@registerForActivityResult
            if (uri == null) {
                fail(reqGen, reqId, "File selection cancelled")
                return@registerForActivityResult
            }
            submitIo(reqGen, reqId, "Failed to read file") {
                val name = queryDisplayName(uri) ?: "file"
                val mimeType = activity.contentResolver.getType(uri) ?: "application/octet-stream"
                val maxBytes = 16 * 1024 * 1024
                val bytes = activity.contentResolver.openInputStream(uri)?.use { input ->
                    val buf = ByteArrayOutputStream()
                    val chunk = ByteArray(16384)
                    var total = 0
                    while (true) {
                        val n = input.read(chunk)
                        if (n <= 0) break
                        total += n
                        if (total > maxBytes) {
                            throw IllegalStateException("Selected file exceeds 16 MB limit")
                        }
                        buf.write(chunk, 0, n)
                    }
                    buf.toByteArray()
                } ?: ByteArray(0)
                val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                val res = JSONObject()
                    .put("name", name)
                    .put("mimeType", mimeType)
                    .put("size", bytes.size)
                    .put("base64", b64)
                val looksText = mimeType.startsWith("text/") ||
                    mimeType.contains("json") ||
                    mimeType.contains("xml") ||
                    mimeType.contains("svg") ||
                    mimeType.contains("csv") ||
                    mimeType.contains("javascript")
                if (looksText && bytes.size <= 2 * 1024 * 1024) {
                    res.put("text", String(bytes, Charsets.UTF_8))
                }
                succeed(reqGen, reqId, res)
            }
        }

    private var pendingFileSaveGeneration: Long = 0L
    private var pendingFileSaveRequestId: Long? = null
    private var pendingFileSaveBytes: ByteArray? = null
    private val createDocumentLauncher: ActivityResultLauncher<String> =
        activity.registerForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri: Uri? ->
            val reqGen = pendingFileSaveGeneration
            val reqId = pendingFileSaveRequestId
            val data = pendingFileSaveBytes
            pendingFileSaveRequestId = null
            pendingFileSaveBytes = null
            if (reqId == null || reqGen != activeGeneration.get()) return@registerForActivityResult
            if (uri == null || data == null) {
                fail(reqGen, reqId, "File save cancelled")
                return@registerForActivityResult
            }
            submitIo(reqGen, reqId, "Failed to save file") {
                activity.contentResolver.openOutputStream(uri)?.use { out ->
                    out.write(data)
                    out.flush()
                } ?: run {
                    fail(reqGen, reqId, "Unable to open output stream for destination file")
                    return@submitIo
                }
                val name = queryDisplayName(uri) ?: "saved-file"
                succeed(
                    reqGen,
                    reqId,
                    JSONObject()
                        .put("ok", true)
                        .put("name", name)
                        .put("size", data.size)
                )
            }
        }

    private fun submitIo(gen: Long, reqId: Long, errorPrefix: String, block: () -> Unit) {
        if (closed.get() || activeGeneration.get() != gen) return
        try {
            ioExecutor.execute {
                if (closed.get() || activeGeneration.get() != gen) return@execute
                try {
                    block()
                } catch (t: Throwable) {
                    fail(gen, reqId, "$errorPrefix: ${t.message}")
                }
            }
        } catch (t: Throwable) {
            fail(gen, reqId, "$errorPrefix: ${t.message}")
        }
    }

    private fun computeInSampleSize(srcWidth: Int, srcHeight: Int, maxDim: Int): Int {
        var sample = 1
        val longest = maxOf(srcWidth, srcHeight)
        if (longest > maxDim) {
            while ((longest / (sample * 2)) >= maxDim) {
                sample *= 2
            }
        }
        return sample.coerceAtLeast(1)
    }

    private fun applyExifOrientation(bitmap: Bitmap, orientation: Int): Bitmap {
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                matrix.postRotate(90f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                matrix.postRotate(270f)
                matrix.postScale(-1f, 1f)
            }
            else -> return bitmap
        }
        return try {
            Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true).also {
                if (it != bitmap) bitmap.recycle()
            }
        } catch (_: Throwable) {
            bitmap
        }
    }

    /**
     * OOM-safe downsampled decode for high-megapixel camera files, honoring EXIF rotation.
     */
    private fun decodeSampledFile(file: File, maxW: Int): Bitmap? {
        val orientation = try {
            ExifInterface(file.absolutePath).getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL
            )
        } catch (_: Throwable) {
            ExifInterface.ORIENTATION_NORMAL
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        val opts = BitmapFactory.Options().apply {
            inSampleSize = computeInSampleSize(bounds.outWidth, bounds.outHeight, maxW)
        }
        val decoded = BitmapFactory.decodeFile(file.absolutePath, opts) ?: return null
        return applyExifOrientation(decoded, orientation)
    }

    /**
     * OOM-safe downsampled decode for gallery URIs, honoring EXIF rotation when present.
     */
    private fun decodeSampledUri(uri: Uri, maxW: Int): Bitmap? {
        val orientation = try {
            activity.contentResolver.openInputStream(uri)?.use { stream ->
                ExifInterface(stream).getAttributeInt(
                    ExifInterface.TAG_ORIENTATION,
                    ExifInterface.ORIENTATION_NORMAL
                )
            } ?: ExifInterface.ORIENTATION_NORMAL
        } catch (_: Throwable) {
            ExifInterface.ORIENTATION_NORMAL
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        activity.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, bounds)
        }
        val opts = BitmapFactory.Options().apply {
            inSampleSize = computeInSampleSize(bounds.outWidth, bounds.outHeight, maxW)
        }
        val decoded = activity.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, opts)
        } ?: return null
        return applyExifOrientation(decoded, orientation)
    }

    private fun encodeAndResolveBitmap(gen: Long, reqId: Long, decoded: Bitmap, maxW: Int, quality: Int) {
        val scaled = if (decoded.width > maxW) {
            val ratio = maxW.toFloat() / decoded.width.toFloat()
            val targetH = (decoded.height * ratio).toInt().coerceAtLeast(1)
            Bitmap.createScaledBitmap(decoded, maxW, targetH, true).also {
                if (it != decoded) decoded.recycle()
            }
        } else {
            decoded
        }
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(20, 100), out)
        val bytes = out.toByteArray()
        val w = scaled.width
        val h = scaled.height
        scaled.recycle()

        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
        succeed(
            gen,
            reqId,
            JSONObject()
                .put("dataUrl", "data:image/jpeg;base64,$b64")
                .put("mimeType", "image/jpeg")
                .put("width", w)
                .put("height", h)
                .put("size", bytes.size)
        )
    }

    private fun queryDisplayName(uri: Uri): String? {
        return try {
            activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        } catch (_: Throwable) {
            null
        }
    }

    private val declaredManifestPermissions: Set<String> by lazy {
        try {
            val pm = activity.packageManager
            val pkgInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageInfo(
                    activity.packageName,
                    PackageManager.PackageInfoFlags.of(PackageManager.GET_PERMISSIONS.toLong())
                )
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(activity.packageName, PackageManager.GET_PERMISSIONS)
            }
            pkgInfo.requestedPermissions?.toSet() ?: emptySet()
        } catch (_: Throwable) {
            emptySet()
        }
    }

    private data class GattPendingOp(
        val gen: Long,
        val reqId: Long,
        val timeout: Runnable
    )

    private val activeGatts = ConcurrentHashMap<String, BluetoothGatt>()
    private val gattAllowedServices: MutableMap<BluetoothGatt, Set<UUID>> =
        Collections.synchronizedMap(IdentityHashMap())
    private val gattPendingReads = ConcurrentHashMap<String, GattPendingOp>()
    private val gattPendingWrites = ConcurrentHashMap<String, GattPendingOp>()
    private val gattPendingConnects = ConcurrentHashMap<String, GattPendingOp>()

    fun buildHostDeviceInfoJson(
        playerMode: Boolean = false,
        grantedCapabilities: List<String>? = null
    ): String {
        val pm = activity.packageManager
        val hasCamera = pm.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
        val hasBle = pm.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)
        val hasLocation = pm.hasSystemFeature(PackageManager.FEATURE_LOCATION)
        val hasVibrator = getVibrator()?.hasVibrator() == true
        val hasMic = pm.hasSystemFeature(PackageManager.FEATURE_MICROPHONE)
        val sm = activity.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        val hasAccel = sm?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null

        val caps = JSONObject()
            .put("camera", hasCamera)
            .put("bluetooth", hasBle)
            .put("location", hasLocation)
            .put("haptics", hasVibrator)
            .put("notifications", true)
            .put("files", true)
            .put("sensors", hasAccel)
            .put("accel", hasAccel)
            .put("mic", hasMic)
            .put("clipboard", true)

        val root = JSONObject()
            .put("platform", "android")
            .put("engine", "zipp-browser-android")
            .put("os_version", "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            .put("model", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
            .put("capabilities", caps)
            .put("player_mode", playerMode)
        if (grantedCapabilities != null) {
            val arr = JSONArray()
            grantedCapabilities.forEach { arr.put(it) }
            root.put("granted_capabilities", arr)
        }
        return root.toString()
    }

    fun executePendingCallsJson(callsJson: String, generation: Long = activeGeneration.get()) {
        if (callsJson.isBlank() || callsJson == "[]") return
        val arr = try {
            JSONArray(callsJson)
        } catch (_: Throwable) {
            return
        }
        for (i in 0 until arr.length()) {
            val obj = arr.optJSONObject(i) ?: continue
            val id = obj.optLong("id", 0L)
            val ns = obj.optString("namespace", "")
            val method = obj.optString("method", "")
            val params = obj.optJSONObject("params") ?: JSONObject()
            mainHandler.post {
                if (!closed.get() && activeGeneration.get() == generation) {
                    dispatch(generation, id, ns, method, params)
                }
            }
        }
    }

    private fun dispatch(gen: Long, id: Long, namespace: String, method: String, params: JSONObject) {
        try {
            when (namespace) {
                "device" -> handleDevice(gen, id, method, params)
                "haptics" -> handleHaptics(gen, id, method, params)
                "notifications" -> handleNotifications(gen, id, method, params)
                "camera" -> handleCamera(gen, id, method, params)
                "location" -> handleLocation(gen, id, method, params)
                "bluetooth" -> handleBluetooth(gen, id, method, params)
                "files" -> handleFiles(gen, id, method, params)
                "sensors" -> handleSensors(gen, id, method, params)
                "permissions" -> handlePermissions(gen, id, method, params)
                else -> fail(gen, id, "Unsupported native bridge namespace: $namespace")
            }
        } catch (t: Throwable) {
            Log.e("SoftN", "DeviceBridge error in $namespace.$method", t)
            fail(gen, id, t.message ?: "Native bridge failure")
        }
    }

    // ── Device (Share, Clipboard) ───────────────────────────────────────────

    private fun handleDevice(gen: Long, id: Long, method: String, params: JSONObject) {
        when (method) {
            "share" -> {
                val now = System.currentTimeMillis()
                if (now - lastShareAtMs < MIN_SHARE_INTERVAL_MS) {
                    fail(gen, id, "Share rate limit exceeded")
                    return
                }
                lastShareAtMs = now
                val rawUrl = params.optString("url", "").trim()
                val safeUrl = if (rawUrl.startsWith("https://", ignoreCase = true) ||
                    rawUrl.startsWith("http://", ignoreCase = true)
                ) {
                    rawUrl
                } else {
                    null
                }
                val text = listOfNotNull(
                    params.optString("title").takeIf { it.isNotBlank() },
                    params.optString("text").takeIf { it.isNotBlank() },
                    safeUrl
                ).joinToString("\n").take(MAX_SHARE_CHARS)
                val intent = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_SUBJECT, params.optString("title", "SoftN").take(256))
                    putExtra(Intent.EXTRA_TEXT, text)
                }
                activity.startActivity(Intent.createChooser(intent, "Share"))
                succeed(gen, id, JSONObject().put("shared", true))
            }
            "clipboardWrite" -> {
                val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                val text = params.optString("text", "")
                if (text.length > MAX_CLIPBOARD_CHARS) {
                    fail(gen, id, "Clipboard payload exceeds 256 KB limit")
                    return
                }
                cm?.setPrimaryClip(ClipData.newPlainText("SoftN", text))
                succeed(gen, id, JSONObject().put("ok", cm != null))
            }
            "clipboardRead" -> {
                val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                // Read plain CharSequence text only — NEVER call coerceToText(activity)
                // which can dereference arbitrary content:// URIs placed on the clipboard.
                val text = try {
                    val clip = cm?.primaryClip
                    if (clip != null && clip.itemCount > 0) {
                        (clip.getItemAt(0)?.text?.toString() ?: "").take(MAX_CLIPBOARD_CHARS)
                    } else {
                        ""
                    }
                } catch (_: Throwable) {
                    ""
                }
                succeed(gen, id, JSONObject().put("text", text))
            }
            else -> fail(gen, id, "Unknown device method: $method")
        }
    }

    // ── Haptics ─────────────────────────────────────────────────────────────

    private fun getVibrator(): Vibrator? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vm = activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
            vm?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }

    @SuppressLint("MissingPermission")
    private fun handleHaptics(gen: Long, id: Long, method: String, params: JSONObject) {
        val vib = getVibrator()
        if (vib == null || !vib.hasVibrator()) {
            succeed(gen, id, JSONObject().put("ok", false))
            return
        }
        val durationMs = when (method) {
            "impact" -> when (params.optString("style", "medium")) {
                "light" -> 18L
                "heavy" -> 65L
                else -> 35L
            }
            "vibrate" -> params.optLong("durationMs", 40L).coerceIn(5L, 2000L)
            else -> {
                fail(gen, id, "Unknown haptics method: $method")
                return
            }
        }
        val amplitude = when (params.optString("style", "medium")) {
            "light" -> 80
            "heavy" -> 255
            else -> VibrationEffect.DEFAULT_AMPLITUDE
        }
        try {
            vib.vibrate(VibrationEffect.createOneShot(durationMs, amplitude))
            succeed(gen, id, JSONObject().put("ok", true))
        } catch (se: SecurityException) {
            fail(gen, id, "VIBRATE permission missing from APK manifest: ${se.message}")
        }
    }

    // ── Notifications ───────────────────────────────────────────────────────

    private fun handleNotifications(gen: Long, id: Long, method: String, params: JSONObject) {
        if (method != "notify") {
            fail(gen, id, "Unknown notifications method: $method")
            return
        }
        val now = System.currentTimeMillis()
        while (notificationTimestamps.isNotEmpty() && now - notificationTimestamps.first() > 60_000L) {
            notificationTimestamps.removeFirst()
        }
        val lastNotif = notificationTimestamps.lastOrNull()
        if (notificationTimestamps.size >= MAX_NOTIFICATIONS_PER_MINUTE ||
            (lastNotif != null && now - lastNotif < MIN_NOTIFICATION_INTERVAL_MS)
        ) {
            fail(gen, id, "Notification rate limit exceeded")
            return
        }
        val perms = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            arrayOf(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            emptyArray()
        }
        ensurePermissions(gen, perms) { granted ->
            if (!granted) {
                fail(gen, id, "Notification permission denied")
                return@ensurePermissions
            }
            val postNow = System.currentTimeMillis()
            while (notificationTimestamps.isNotEmpty() && postNow - notificationTimestamps.first() > 60_000L) {
                notificationTimestamps.removeFirst()
            }
            if (notificationTimestamps.size >= MAX_NOTIFICATIONS_PER_MINUTE) {
                fail(gen, id, "Notification rate limit exceeded")
                return@ensurePermissions
            }
            notificationTimestamps.addLast(postNow)
            val nm = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channelId = "softn_app_notifications"
            if (!notificationChannelCreated) {
                val channel = NotificationChannel(
                    channelId,
                    "SoftN App Alerts",
                    NotificationManager.IMPORTANCE_DEFAULT
                )
                nm.createNotificationChannel(channel)
                notificationChannelCreated = true
            }
            val title = params.optString("title", "SoftN")
                .replace(Regex("[\\x00-\\x1f\\x7f]"), " ")
                .trim()
                .take(MAX_NOTIFICATION_TITLE_CHARS)
                .ifEmpty { "SoftN" }
            val body = params.optString("body", "")
                .replace(Regex("[\\x00-\\x09\\x0b-\\x1f\\x7f]"), " ")
                .take(MAX_NOTIFICATION_BODY_CHARS)
            val noteId = if (params.has("id")) params.optInt("id") else nextNotificationId.getAndIncrement()
            val notification = NotificationCompat.Builder(activity, channelId)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .build()
            nm.notify(noteId, notification)
            succeed(gen, id, JSONObject().put("ok", true).put("id", noteId))
        }
    }

    // ── Camera ──────────────────────────────────────────────────────────────

    private fun handleCamera(gen: Long, id: Long, method: String, params: JSONObject) {
        when (method) {
            "takePhoto" -> {
                ensurePermissions(gen, arrayOf(Manifest.permission.CAMERA)) { granted ->
                    if (!granted) {
                        fail(gen, id, "Android CAMERA permission denied")
                        return@ensurePermissions
                    }
                    try {
                        val cameraCacheDir = File(activity.cacheDir, "camera").apply { mkdirs() }
                        val photoFile = File(cameraCacheDir, "softn_photo_${System.currentTimeMillis()}.jpg")
                        val authority = "${activity.packageName}.fileprovider"
                        val uri = FileProvider.getUriForFile(activity, authority, photoFile)
                        pendingPhotoRequestId?.let { prev ->
                            fail(pendingPhotoGeneration, prev, "Superseded by newer camera request")
                        }
                        pendingPhotoFile?.delete()
                        pendingPhotoGeneration = gen
                        pendingPhotoRequestId = id
                        pendingPhotoFile = photoFile
                        pendingPhotoMaxWidth = params.optInt("maxWidth", 960).coerceIn(160, 2048)
                        val rawQ = params.optDouble("quality", 0.85)
                        pendingPhotoQuality = (if (rawQ > 1.0) rawQ else rawQ * 100.0).toInt().coerceIn(20, 100)
                        takePictureLauncher.launch(uri)
                    } catch (t: Throwable) {
                        pendingPhotoRequestId = null
                        pendingPhotoFile?.delete()
                        pendingPhotoFile = null
                        fail(gen, id, "Failed to launch camera: ${t.message}")
                    }
                }
            }
            "pickPhoto" -> {
                try {
                    pendingPickPhotoRequestId?.let { prev ->
                        fail(pendingPickPhotoGeneration, prev, "Superseded by newer photo pick request")
                    }
                    pendingPickPhotoGeneration = gen
                    pendingPickPhotoRequestId = id
                    pendingPickPhotoMaxWidth = params.optInt("maxWidth", 960).coerceIn(160, 2048)
                    val rawQ = params.optDouble("quality", 0.85)
                    pendingPickPhotoQuality = (if (rawQ > 1.0) rawQ else rawQ * 100.0).toInt().coerceIn(20, 100)
                    pickPhotoLauncher.launch("image/*")
                } catch (t: Throwable) {
                    pendingPickPhotoRequestId = null
                    fail(gen, id, "Failed to launch photo picker: ${t.message}")
                }
            }
            else -> fail(gen, id, "Unknown camera method: $method")
        }
    }

    // ── Files (Storage Access Framework — zero broad storage permission) ───

    private fun handleFiles(gen: Long, id: Long, method: String, params: JSONObject) {
        when (method) {
            "pick" -> {
                val mimes = mutableListOf<String>()
                val arr = params.optJSONArray("mimeTypes")
                if (arr != null) {
                    for (i in 0 until arr.length()) {
                        val s = arr.optString(i).trim()
                        if (s.isNotEmpty()) mimes.add(s)
                    }
                }
                if (mimes.isEmpty()) mimes.add("*/*")
                try {
                    pendingFilePickRequestId?.let { prev ->
                        fail(pendingFilePickGeneration, prev, "Superseded by newer file pick request")
                    }
                    pendingFilePickGeneration = gen
                    pendingFilePickRequestId = id
                    openDocumentLauncher.launch(mimes.toTypedArray())
                } catch (t: Throwable) {
                    pendingFilePickRequestId = null
                    fail(gen, id, "Failed to open file picker: ${t.message}")
                }
            }
            "save" -> {
                val rawFilename = params.optString("filename", "export.txt")
                val filename = rawFilename
                    .replace(Regex("[/\\\\:*?\"<>|\\x00-\\x1f\\x7f]"), "_")
                    .trimStart('.')
                    .trim()
                    .take(120)
                    .ifBlank { "export.txt" }
                val b64 = params.optString("base64", "")
                val hasText = params.has("text")
                val txt = if (hasText) params.optString("text", "") else params.optString("content", "")
                if (b64.length > MAX_SAVE_BASE64_CHARS || txt.length > MAX_SAVE_FILE_BYTES) {
                    fail(gen, id, "File save payload exceeds 16 MB limit")
                    return
                }
                submitIo(gen, id, "Invalid file save payload") {
                    val data = if (b64.isNotEmpty()) {
                        Base64.decode(b64, Base64.DEFAULT)
                    } else {
                        txt.toByteArray(Charsets.UTF_8)
                    }
                    if (data.size > MAX_SAVE_FILE_BYTES) {
                        fail(gen, id, "File save payload exceeds 16 MB limit")
                        return@submitIo
                    }
                    mainHandler.post {
                        if (closed.get() || activeGeneration.get() != gen) return@post
                        try {
                            pendingFileSaveRequestId?.let { prev ->
                                fail(pendingFileSaveGeneration, prev, "Superseded by newer file save request")
                            }
                            pendingFileSaveGeneration = gen
                            pendingFileSaveRequestId = id
                            pendingFileSaveBytes = data
                            createDocumentLauncher.launch(filename)
                        } catch (t: Throwable) {
                            pendingFileSaveRequestId = null
                            pendingFileSaveBytes = null
                            fail(gen, id, "Failed to launch save dialog: ${t.message}")
                        }
                    }
                }
            }
            else -> fail(gen, id, "Unknown files method: $method")
        }
    }

    // ── Motion Sensors (Accelerometer / Gyroscope) ──────────────────────────

    private fun handleSensors(gen: Long, id: Long, method: String, params: JSONObject) {
        if (method != "getMotion") {
            fail(gen, id, "Unknown sensors method: $method")
            return
        }
        val sm = activity.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        val accel = sm?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        val gyro = sm?.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
        if (sm == null || (accel == null && gyro == null)) {
            fail(gen, id, "Motion sensors are unavailable on this device")
            return
        }
        val done = AtomicBoolean(false)
        var ax = 0.0; var ay = 0.0; var az = 0.0
        var gx = 0.0; var gy = 0.0; var gz = 0.0
        var gotAccel = (accel == null)
        var gotGyro = (gyro == null)

        lateinit var listener: SensorEventListener
        lateinit var cleanup: () -> Unit
        fun finish() {
            if (!done.compareAndSet(false, true)) return
            activeCleanups.remove(cleanup)
            try { sm.unregisterListener(listener) } catch (_: Throwable) {}
            succeed(
                gen,
                id,
                JSONObject()
                    .put("acceleration", JSONObject().put("x", ax).put("y", ay).put("z", az))
                    .put("rotationRate", JSONObject().put("alpha", gx).put("beta", gy).put("gamma", gz))
                    .put("timestamp", System.currentTimeMillis())
            )
        }

        listener = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
                when (event.sensor.type) {
                    Sensor.TYPE_ACCELEROMETER -> {
                        ax = event.values.getOrElse(0) { 0f }.toDouble()
                        ay = event.values.getOrElse(1) { 0f }.toDouble()
                        az = event.values.getOrElse(2) { 0f }.toDouble()
                        gotAccel = true
                    }
                    Sensor.TYPE_GYROSCOPE -> {
                        gx = event.values.getOrElse(0) { 0f }.toDouble()
                        gy = event.values.getOrElse(1) { 0f }.toDouble()
                        gz = event.values.getOrElse(2) { 0f }.toDouble()
                        gotGyro = true
                    }
                }
                if (gotAccel && gotGyro) {
                    finish()
                }
            }

            override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
        }

        cleanup = {
            if (done.compareAndSet(false, true)) {
                try { sm.unregisterListener(listener) } catch (_: Throwable) {}
            }
        }
        activeCleanups.add(cleanup)
        if (accel != null) sm.registerListener(listener, accel, SensorManager.SENSOR_DELAY_UI)
        if (gyro != null) sm.registerListener(listener, gyro, SensorManager.SENSOR_DELAY_UI)
        mainHandler.postDelayed({ finish() }, 1200L)
    }

    // ── Permissions Query ───────────────────────────────────────────────────

    fun describePermissionState(rawName: String): String {
        val name = rawName.trim().lowercase()
        fun checkRuntime(perms: Array<String>, requireAny: Boolean = false): String {
            val declaredAny = perms.any { declaredManifestPermissions.contains(it) }
            if (!declaredAny) return "denied"
            val grantedCount = perms.count {
                ContextCompat.checkSelfPermission(activity, it) == PackageManager.PERMISSION_GRANTED
            }
            val isGranted = if (requireAny) grantedCount > 0 else grantedCount == perms.size
            return if (isGranted) "granted" else "prompt"
        }
        return when (name) {
            "camera" -> checkRuntime(arrayOf(Manifest.permission.CAMERA))
            "location", "geolocation" -> checkRuntime(
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                requireAny = true
            )
            "bluetooth" -> checkRuntime(blePermissions())
            "mic", "microphone" -> checkRuntime(arrayOf(Manifest.permission.RECORD_AUDIO))
            "notifications" -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    checkRuntime(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
                } else {
                    if (NotificationManagerCompat.from(activity).areNotificationsEnabled()) "granted" else "denied"
                }
            }
            "haptics" -> if (declaredManifestPermissions.contains(Manifest.permission.VIBRATE)) "granted" else "denied"
            "net" -> if (declaredManifestPermissions.contains(Manifest.permission.INTERNET)) "granted" else "denied"
            "files", "accel", "sensors", "accelerometer", "gyroscope", "magnetometer",
            "clipboard", "clipboard-read", "clipboard-write" -> "granted"
            else -> "denied"
        }
    }

    private fun handlePermissions(gen: Long, id: Long, method: String, params: JSONObject) {
        if (method != "query") {
            fail(gen, id, "Unknown permissions method: $method")
            return
        }
        val state = describePermissionState(params.optString("name", ""))
        succeed(gen, id, JSONObject().put("state", state))
    }

    // ── Location ────────────────────────────────────────────────────────────

    @SuppressLint("MissingPermission")
    private fun handleLocation(gen: Long, id: Long, method: String, params: JSONObject) {
        if (method != "getCurrentPosition") {
            fail(gen, id, "Unknown location method: $method")
            return
        }
        val highAccuracy = params.optBoolean("highAccuracy", false)
        val maximumAgeMs = params.optLong("maximumAgeMs", 0L).coerceAtLeast(0L)
        val timeoutMs = params.optLong("timeoutMs", 10000L).coerceIn(1500L, 30000L)
        val needed = if (highAccuracy) {
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        } else {
            arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION)
        }
        ensurePermissions(gen, needed, requireAny = true) { granted ->
            if (!granted) {
                fail(gen, id, "Android location permission denied")
                return@ensurePermissions
            }
            val lm = activity.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            if (lm == null) {
                fail(gen, id, "LocationManager unavailable")
                return@ensurePermissions
            }
            val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
            var best: Location? = null
            for (p in providers) {
                try {
                    val loc = lm.getLastKnownLocation(p)
                    if (loc != null && (best == null || loc.time > best.time)) {
                        best = loc
                    }
                } catch (_: Throwable) {}
            }
            val now = System.currentTimeMillis()
            val cached = best
            if (cached != null && (
                (maximumAgeMs > 0L && (now - cached.time) <= maximumAgeMs) ||
                (!highAccuracy && (now - cached.time) <= 30_000L)
            )) {
                succeed(gen, id, locationToJson(cached))
                return@ensurePermissions
            }
            val preferredProvider = when {
                highAccuracy && lm.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
                lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
                lm.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
                else -> null
            }
            if (preferredProvider == null) {
                if (best != null) succeed(gen, id, locationToJson(best))
                else fail(gen, id, "Location services are turned off on this device")
                return@ensurePermissions
            }

            val settled = AtomicBoolean(false)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val cancelSignal = CancellationSignal()
                val locCleanup: () -> Unit = {
                    if (settled.compareAndSet(false, true)) {
                        try { cancelSignal.cancel() } catch (_: Throwable) {}
                    }
                }
                activeCleanups.add(locCleanup)
                val timeoutRunnable = Runnable {
                    if (settled.compareAndSet(false, true)) {
                        activeCleanups.remove(locCleanup)
                        try { cancelSignal.cancel() } catch (_: Throwable) {}
                        if (best != null) succeed(gen, id, locationToJson(best))
                        else fail(gen, id, "Location request timed out")
                    }
                }
                mainHandler.postDelayed(timeoutRunnable, timeoutMs)
                try {
                    lm.getCurrentLocation(preferredProvider, cancelSignal, activity.mainExecutor) { loc ->
                        if (settled.compareAndSet(false, true)) {
                            activeCleanups.remove(locCleanup)
                            mainHandler.removeCallbacks(timeoutRunnable)
                            val resolved = loc ?: best
                            if (resolved != null) succeed(gen, id, locationToJson(resolved))
                            else fail(gen, id, "Unable to obtain GPS/network location fix")
                        }
                    }
                } catch (t: Throwable) {
                    if (settled.compareAndSet(false, true)) {
                        activeCleanups.remove(locCleanup)
                        mainHandler.removeCallbacks(timeoutRunnable)
                        if (best != null) succeed(gen, id, locationToJson(best))
                        else fail(gen, id, "Location query failed: ${t.message}")
                    }
                }
            } else {
                lateinit var listener: LocationListener
                lateinit var locCleanup: () -> Unit
                val timeoutRunnable = Runnable {
                    if (settled.compareAndSet(false, true)) {
                        activeCleanups.remove(locCleanup)
                        try { lm.removeUpdates(listener) } catch (_: Throwable) {}
                        if (best != null) succeed(gen, id, locationToJson(best))
                        else fail(gen, id, "Location request timed out")
                    }
                }
                listener = object : LocationListener {
                    override fun onLocationChanged(loc: Location) {
                        if (settled.compareAndSet(false, true)) {
                            activeCleanups.remove(locCleanup)
                            mainHandler.removeCallbacks(timeoutRunnable)
                            try { lm.removeUpdates(this) } catch (_: Throwable) {}
                            succeed(gen, id, locationToJson(loc))
                        }
                    }
                    @Deprecated("Deprecated in Java")
                    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
                    override fun onProviderEnabled(provider: String) {}
                    override fun onProviderDisabled(provider: String) {}
                }
                locCleanup = {
                    if (settled.compareAndSet(false, true)) {
                        try { lm.removeUpdates(listener) } catch (_: Throwable) {}
                    }
                }
                activeCleanups.add(locCleanup)
                mainHandler.postDelayed(timeoutRunnable, timeoutMs)
                try {
                    @Suppress("DEPRECATION")
                    lm.requestSingleUpdate(preferredProvider, listener, Looper.getMainLooper())
                } catch (t: Throwable) {
                    if (settled.compareAndSet(false, true)) {
                        activeCleanups.remove(locCleanup)
                        mainHandler.removeCallbacks(timeoutRunnable)
                        if (best != null) succeed(gen, id, locationToJson(best))
                        else fail(gen, id, "Location query failed: ${t.message}")
                    }
                }
            }
        }
    }

    private fun locationToJson(loc: Location): JSONObject =
        JSONObject()
            .put("latitude", loc.latitude)
            .put("longitude", loc.longitude)
            .put("accuracy", loc.accuracy.toDouble())
            .put("altitude", if (loc.hasAltitude()) loc.altitude else JSONObject.NULL)
            .put("heading", if (loc.hasBearing()) loc.bearing.toDouble() else JSONObject.NULL)
            .put("speed", if (loc.hasSpeed()) loc.speed.toDouble() else JSONObject.NULL)
            .put("timestamp", loc.time)

    // ── Bluetooth Low Energy (BLE) ──────────────────────────────────────────

    private fun blePermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    @SuppressLint("MissingPermission")
    private fun handleBluetooth(gen: Long, id: Long, method: String, params: JSONObject) {
        val bm = activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter: BluetoothAdapter? = bm?.adapter
        if (adapter == null) {
            fail(gen, id, "Bluetooth hardware adapter is not available on this device")
            return
        }
        if (!adapter.isEnabled) {
            fail(gen, id, "Bluetooth is currently turned off")
            return
        }

        ensurePermissions(gen, blePermissions()) { granted ->
            if (!granted) {
                fail(gen, id, "Android Bluetooth permission denied")
                return@ensurePermissions
            }
            when (method) {
                "scan" -> scanBle(gen, id, adapter, params)
                "connect" -> {
                    val allowedArr = params.optJSONArray("allowedServices")
                    val allowedSet = if (allowedArr != null && allowedArr.length() > 0) {
                        val s = mutableSetOf<UUID>()
                        for (i in 0 until allowedArr.length()) {
                            parseBleUuid(allowedArr.optString(i))?.let { s.add(it) }
                        }
                        s
                    } else {
                        null
                    }
                    connectBle(gen, id, adapter, params.optString("deviceId"), allowedSet)
                }
                "disconnect" -> {
                    val devId = params.optString("deviceId")
                    gattPendingConnects.remove(devId)?.let { op ->
                        mainHandler.removeCallbacks(op.timeout)
                        fail(op.gen, op.reqId, "Bluetooth device disconnected")
                    }
                    failPendingGattOpsForDevice(devId, "Bluetooth device disconnected")
                    activeGatts.remove(devId)?.let {
                        gattAllowedServices.remove(it)
                        try {
                            it.disconnect()
                            it.close()
                        } catch (_: Throwable) {}
                    }
                    succeed(gen, id, JSONObject().put("disconnected", true).put("deviceId", devId))
                }
                "read" -> readBleCharacteristic(
                    gen,
                    id,
                    params.optString("deviceId"),
                    params.optString("serviceUuid"),
                    params.optString("characteristicUuid")
                )
                "write" -> writeBleCharacteristic(
                    gen,
                    id,
                    params.optString("deviceId"),
                    params.optString("serviceUuid"),
                    params.optString("characteristicUuid"),
                    params.optString("base64"),
                    params.optBoolean("withoutResponse", false)
                )
                else -> fail(gen, id, "Unknown bluetooth method: $method")
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun scanBle(gen: Long, id: Long, adapter: BluetoothAdapter, params: JSONObject) {
        val scanner = adapter.bluetoothLeScanner
        if (scanner == null) {
            fail(gen, id, "BLE scanner unavailable on this device")
            return
        }
        val durationMs = params.optLong("durationMs", 2500L).coerceIn(500L, 10000L)
        val namePrefix = params.optString("namePrefix", "").takeIf { it.isNotBlank() }
        val filters = mutableListOf<ScanFilter>()
        val servicesArr = params.optJSONArray("services")
        if (servicesArr != null && servicesArr.length() > 0) {
            for (i in 0 until servicesArr.length()) {
                val rawUuid = servicesArr.optString(i)
                parseBleUuid(rawUuid)?.let { uuid ->
                    filters.add(ScanFilter.Builder().setServiceUuid(ParcelUuid(uuid)).build())
                }
            }
        }

        val found = ConcurrentHashMap<String, JSONObject>()
        val scanSettled = AtomicBoolean(false)
        lateinit var callback: ScanCallback
        lateinit var stopCleanup: () -> Unit

        callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val dev = result.device ?: return
                if (!found.containsKey(dev.address) && found.size >= MAX_BLE_SCAN_DEVICES) return
                val devName = dev.name ?: result.scanRecord?.deviceName ?: "BLE Device"
                if (namePrefix != null && !devName.startsWith(namePrefix, ignoreCase = true)) return
                val svcList = JSONArray()
                result.scanRecord?.serviceUuids?.forEach { svcList.put(it.uuid.toString()) }
                found[dev.address] = JSONObject()
                    .put("id", dev.address)
                    .put("name", devName)
                    .put("rssi", result.rssi)
                    .put("services", svcList)
            }

            override fun onScanFailed(errorCode: Int) {
                if (scanSettled.compareAndSet(false, true)) {
                    activeCleanups.remove(stopCleanup)
                    fail(gen, id, "BLE scan failed (code $errorCode)")
                }
            }
        }

        stopCleanup = {
            if (scanSettled.compareAndSet(false, true)) {
                try { scanner.stopScan(callback) } catch (_: Throwable) {}
            }
        }
        activeCleanups.add(stopCleanup)

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()
        scanner.startScan(filters.ifEmpty { null }, settings, callback)

        mainHandler.postDelayed({
            if (scanSettled.compareAndSet(false, true)) {
                activeCleanups.remove(stopCleanup)
                try {
                    scanner.stopScan(callback)
                } catch (_: Throwable) {}
                val arr = JSONArray()
                found.values.forEach { arr.put(it) }
                succeed(gen, id, JSONObject().put("devices", arr))
            }
        }, durationMs)
    }

    @SuppressLint("MissingPermission")
    private fun connectBle(
        gen: Long,
        id: Long,
        adapter: BluetoothAdapter,
        deviceId: String,
        allowedServices: Set<UUID>?
    ) {
        if (deviceId.isBlank()) {
            fail(gen, id, "Missing Bluetooth deviceId")
            return
        }
        val device = try {
            adapter.getRemoteDevice(deviceId)
        } catch (t: Throwable) {
            fail(gen, id, "Invalid Bluetooth address '$deviceId': ${t.message}")
            return
        }
        // Close any existing GATT for this device before reconnecting to avoid leaking BluetoothGatt slots.
        activeGatts.remove(deviceId)?.let { prevGatt ->
            gattAllowedServices.remove(prevGatt)
            try {
                prevGatt.disconnect()
                prevGatt.close()
            } catch (_: Throwable) {}
        }
        lateinit var connectOp: GattPendingOp
        var gattRef: BluetoothGatt? = null
        val connectTimeout = Runnable {
            if (gattPendingConnects.remove(deviceId, connectOp)) {
                gattRef?.let { g ->
                    activeGatts.remove(deviceId, g)
                    gattAllowedServices.remove(g)
                }
                try {
                    gattRef?.disconnect()
                    gattRef?.close()
                } catch (_: Throwable) {}
                fail(gen, id, "Bluetooth connect timed out")
            }
        }
        connectOp = GattPendingOp(gen, id, connectTimeout)
        gattPendingConnects.put(deviceId, connectOp)?.let { prevOp ->
            mainHandler.removeCallbacks(prevOp.timeout)
            fail(prevOp.gen, prevOp.reqId, "Superseded by newer Bluetooth connect request")
        }
        failPendingGattOpsForDevice(deviceId, "Bluetooth reconnecting")
        mainHandler.postDelayed(connectTimeout, BLE_OP_TIMEOUT_MS)

        val gatt = device.connectGatt(activity, false, object : BluetoothGattCallback() {
            override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                if (closed.get() || activeGeneration.get() != gen) {
                    gattAllowedServices.remove(g)
                    try {
                        g.disconnect()
                        g.close()
                    } catch (_: Throwable) {}
                    return
                }
                if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    if (allowedServices != null) {
                        gattAllowedServices[g] = allowedServices
                    } else {
                        gattAllowedServices.remove(g)
                    }
                    activeGatts[deviceId] = g
                    g.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                    val wasActive = activeGatts.remove(deviceId, g)
                    gattAllowedServices.remove(g)
                    val wasPending = gattPendingConnects.remove(deviceId, connectOp)
                    if (wasPending) {
                        mainHandler.removeCallbacks(connectOp.timeout)
                        fail(connectOp.gen, connectOp.reqId, "Bluetooth device disconnected (status $status)")
                    }
                    if (wasActive) {
                        failPendingGattOpsForDevice(deviceId, "Bluetooth device disconnected (status $status)")
                    }
                    g.close()
                }
            }

            override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                if (!gattPendingConnects.remove(deviceId, connectOp)) return
                mainHandler.removeCallbacks(connectOp.timeout)
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    activeGatts.remove(deviceId, g)
                    gattAllowedServices.remove(g)
                    try { g.disconnect() } catch (_: Throwable) {}
                    try { g.close() } catch (_: Throwable) {}
                    fail(connectOp.gen, connectOp.reqId, "GATT service discovery failed (status $status)")
                    return
                }
                val allowed = allowedServices ?: gattAllowedServices[g]
                val svcs = JSONArray()
                g.services.forEach { svc ->
                    if (allowed == null || allowed.contains(svc.uuid)) {
                        svcs.put(svc.uuid.toString())
                    }
                }
                succeed(
                    connectOp.gen,
                    connectOp.reqId,
                    JSONObject()
                        .put("connected", true)
                        .put("deviceId", deviceId)
                        .put("services", svcs)
                )
            }

            override fun onCharacteristicRead(
                g: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                value: ByteArray,
                status: Int
            ) {
                handleGattReadResult(deviceId, characteristic, value, status)
            }

            @Deprecated("Deprecated in Java")
            override fun onCharacteristicRead(
                g: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                status: Int
            ) {
                @Suppress("DEPRECATION")
                val value = characteristic.value ?: ByteArray(0)
                handleGattReadResult(deviceId, characteristic, value, status)
            }

            private fun handleGattReadResult(
                devId: String,
                characteristic: BluetoothGattCharacteristic,
                value: ByteArray,
                status: Int
            ) {
                val key = gattCharKey(devId, characteristic.service?.uuid, characteristic.uuid)
                val op = gattPendingReads.remove(key) ?: return
                mainHandler.removeCallbacks(op.timeout)
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    fail(op.gen, op.reqId, "GATT read failed (status $status)")
                    return
                }
                succeed(
                    op.gen,
                    op.reqId,
                    JSONObject()
                        .put("base64", Base64.encodeToString(value, Base64.NO_WRAP))
                        .put("utf8", String(value, Charsets.UTF_8))
                )
            }

            override fun onCharacteristicWrite(
                g: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                status: Int
            ) {
                val key = gattCharKey(deviceId, characteristic.service?.uuid, characteristic.uuid)
                val op = gattPendingWrites.remove(key) ?: return
                mainHandler.removeCallbacks(op.timeout)
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    succeed(op.gen, op.reqId, JSONObject().put("ok", true))
                } else {
                    fail(op.gen, op.reqId, "GATT write failed (status $status)")
                }
            }
        })
        gattRef = gatt
        if (gatt != null && allowedServices != null) {
            gattAllowedServices[gatt] = allowedServices
        }
        if (gatt == null) {
            if (gattPendingConnects.remove(deviceId, connectOp)) {
                mainHandler.removeCallbacks(connectTimeout)
            }
            fail(gen, id, "Failed to initiate GATT connection")
        }
    }

    private fun gattCharKey(deviceId: String, serviceUuid: UUID?, charUuid: UUID): String =
        "$deviceId:${serviceUuid?.toString() ?: ""}:$charUuid"

    private fun failPendingGattOpsForDevice(deviceId: String, reason: String) {
        val prefix = "$deviceId:"
        for (k in gattPendingReads.keys().toList()) {
            if (k.startsWith(prefix)) {
                gattPendingReads.remove(k)?.let { op ->
                    mainHandler.removeCallbacks(op.timeout)
                    fail(op.gen, op.reqId, reason)
                }
            }
        }
        for (k in gattPendingWrites.keys().toList()) {
            if (k.startsWith(prefix)) {
                gattPendingWrites.remove(k)?.let { op ->
                    mainHandler.removeCallbacks(op.timeout)
                    fail(op.gen, op.reqId, reason)
                }
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun readBleCharacteristic(
        gen: Long,
        id: Long,
        deviceId: String,
        serviceUuid: String,
        charUuid: String
    ) {
        val gatt = activeGatts[deviceId] ?: run {
            fail(gen, id, "Device not connected: $deviceId")
            return
        }
        val parsedSvc = parseBleUuid(serviceUuid) ?: run {
            fail(gen, id, "GATT service not found: $serviceUuid")
            return
        }
        val allowed = gattAllowedServices[gatt]
        if (allowed != null && !allowed.contains(parsedSvc)) {
            fail(gen, id, "GATT service $serviceUuid is not in allowedServices")
            return
        }
        val svc = gatt.getService(parsedSvc) ?: run {
            fail(gen, id, "GATT service not found: $serviceUuid")
            return
        }
        val ch = parseBleUuid(charUuid)?.let { svc.getCharacteristic(it) } ?: run {
            fail(gen, id, "GATT characteristic not found: $charUuid")
            return
        }
        val key = gattCharKey(deviceId, svc.uuid, ch.uuid)
        lateinit var readOp: GattPendingOp
        val timeout = Runnable {
            if (gattPendingReads.remove(key, readOp)) {
                fail(gen, id, "GATT read timed out")
            }
        }
        readOp = GattPendingOp(gen, id, timeout)
        gattPendingReads.put(key, readOp)?.let { prev ->
            mainHandler.removeCallbacks(prev.timeout)
            fail(prev.gen, prev.reqId, "Superseded by newer GATT read on same characteristic")
        }
        mainHandler.postDelayed(timeout, BLE_OP_TIMEOUT_MS)
        if (!gatt.readCharacteristic(ch)) {
            if (gattPendingReads.remove(key, readOp)) {
                mainHandler.removeCallbacks(timeout)
            }
            fail(gen, id, "GATT readCharacteristic rejected")
        }
    }

    @SuppressLint("MissingPermission")
    private fun writeBleCharacteristic(
        gen: Long,
        id: Long,
        deviceId: String,
        serviceUuid: String,
        charUuid: String,
        base64: String,
        withoutResponse: Boolean
    ) {
        if (base64.length > MAX_BLE_WRITE_BASE64_CHARS) {
            fail(gen, id, "BLE write payload exceeds maximum size ($MAX_BLE_WRITE_BYTES bytes)")
            return
        }
        val gatt = activeGatts[deviceId] ?: run {
            fail(gen, id, "Device not connected: $deviceId")
            return
        }
        val parsedSvc = parseBleUuid(serviceUuid) ?: run {
            fail(gen, id, "GATT service not found: $serviceUuid")
            return
        }
        val allowed = gattAllowedServices[gatt]
        if (allowed != null && !allowed.contains(parsedSvc)) {
            fail(gen, id, "GATT service $serviceUuid is not in allowedServices")
            return
        }
        val svc = gatt.getService(parsedSvc) ?: run {
            fail(gen, id, "GATT service not found: $serviceUuid")
            return
        }
        val ch = parseBleUuid(charUuid)?.let { svc.getCharacteristic(it) } ?: run {
            fail(gen, id, "GATT characteristic not found: $charUuid")
            return
        }
        val data = try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (t: Throwable) {
            fail(gen, id, "Invalid Base64 BLE payload: ${t.message}")
            return
        }
        if (data.size > MAX_BLE_WRITE_BYTES) {
            fail(gen, id, "BLE write payload exceeds maximum size ($MAX_BLE_WRITE_BYTES bytes)")
            return
        }
        val writeType = if (withoutResponse) {
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        } else {
            BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        }
        val key = gattCharKey(deviceId, svc.uuid, ch.uuid)
        lateinit var writeOp: GattPendingOp
        val timeout = Runnable {
            if (gattPendingWrites.remove(key, writeOp)) {
                fail(gen, id, "GATT write timed out")
            }
        }
        writeOp = GattPendingOp(gen, id, timeout)
        gattPendingWrites.put(key, writeOp)?.let { prev ->
            mainHandler.removeCallbacks(prev.timeout)
            fail(prev.gen, prev.reqId, "Superseded by newer GATT write on same characteristic")
        }
        mainHandler.postDelayed(timeout, BLE_OP_TIMEOUT_MS)
        val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeCharacteristic(ch, data, writeType) == android.bluetooth.BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            ch.writeType = writeType
            @Suppress("DEPRECATION")
            ch.value = data
            @Suppress("DEPRECATION")
            gatt.writeCharacteristic(ch)
        }
        if (!ok) {
            if (gattPendingWrites.remove(key, writeOp)) {
                mainHandler.removeCallbacks(timeout)
            }
            fail(gen, id, "GATT writeCharacteristic rejected")
        }
    }

    private fun parseBleUuid(raw: String): UUID? {
        val trimmed = raw.trim()
        return try {
            when (trimmed.length) {
                4 -> UUID.fromString("0000$trimmed-0000-1000-8000-00805f9b34fb")
                8 -> UUID.fromString("$trimmed-0000-1000-8000-00805f9b34fb")
                else -> UUID.fromString(trimmed)
            }
        } catch (_: Throwable) {
            null
        }
    }

    // ── Permission & Completion Helpers ─────────────────────────────────────

    private fun ensurePermissions(
        gen: Long,
        permissions: Array<String>,
        requireAny: Boolean = false,
        onResult: (Boolean) -> Unit
    ) {
        if (closed.get() || activeGeneration.get() != gen) return
        if (permissions.isEmpty()) {
            onResult(true)
            return
        }
        val missing = permissions.filter {
            ContextCompat.checkSelfPermission(activity, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty() || (requireAny && missing.size < permissions.size)) {
            onResult(true)
            return
        }
        permissionQueue.addLast(
            QueuedPermRequest(
                generation = gen,
                permissions = permissions,
                missing = missing.toTypedArray(),
                requireAny = requireAny,
                onResult = onResult
            )
        )
        pumpNextPermissionRequest()
    }

    private fun pumpNextPermissionRequest() {
        if (activePermRequest != null || closed.get()) return
        val curGen = activeGeneration.get()
        while (permissionQueue.isNotEmpty()) {
            val next = permissionQueue.removeFirst()
            if (next.generation != curGen) continue
            val stillMissing = next.permissions.filter {
                ContextCompat.checkSelfPermission(activity, it) != PackageManager.PERMISSION_GRANTED
            }
            if (stillMissing.isEmpty() || (next.requireAny && stillMissing.size < next.permissions.size)) {
                next.onResult(true)
                continue
            }
            activePermRequest = next
            permissionLauncher.launch(stillMissing.toTypedArray())
            return
        }
    }

    private fun succeed(gen: Long, requestId: Long, result: JSONObject) {
        if (closed.get() || activeGeneration.get() != gen) return
        onResolve(gen, requestId, true, result.toString())
    }

    private fun fail(gen: Long, requestId: Long, message: String) {
        if (closed.get() || activeGeneration.get() != gen) return
        onResolve(gen, requestId, false, JSONObject().put("error", message).toString())
    }

    /**
     * Cancel all in-flight sensors, location, BLE GATT connections, and pending pickers
     * when switching bundles in Player Mode so the previous app cannot leak callbacks or
     * open BLE handles into the new engine generation.
     */
    @SuppressLint("MissingPermission")
    fun reset(newGeneration: Long) {
        activeGeneration.set(newGeneration)
        mainHandler.removeCallbacksAndMessages(null)
        for (cleanup in activeCleanups) {
            try { cleanup() } catch (_: Throwable) {}
        }
        activeCleanups.clear()
        for (g in activeGatts.values) {
            try {
                g.disconnect()
                g.close()
            } catch (_: Throwable) {}
        }
        activeGatts.clear()
        gattAllowedServices.clear()
        gattPendingReads.clear()
        gattPendingWrites.clear()
        gattPendingConnects.clear()
        val clearUiState = {
            val curGen = activeGeneration.get()
            val forceAll = closed.get()
            if (forceAll || pendingPhotoGeneration < curGen) {
                pendingPhotoRequestId = null
                pendingPhotoFile?.delete()
                pendingPhotoFile = null
            }
            if (forceAll || pendingPickPhotoGeneration < curGen) {
                pendingPickPhotoRequestId = null
            }
            if (forceAll || pendingFilePickGeneration < curGen) {
                pendingFilePickRequestId = null
            }
            if (forceAll || pendingFileSaveGeneration < curGen) {
                pendingFileSaveRequestId = null
                pendingFileSaveBytes = null
            }
            if (forceAll || (activePermRequest != null && activePermRequest!!.generation < curGen)) {
                activePermRequest = null
            }
            val iter = permissionQueue.iterator()
            while (iter.hasNext()) {
                val item = iter.next()
                if (forceAll || item.generation < curGen) {
                    iter.remove()
                }
            }
            notificationTimestamps.clear()
            lastShareAtMs = 0L
        }
        if (Looper.myLooper() == Looper.getMainLooper()) {
            clearUiState()
        } else {
            mainHandler.post(clearUiState)
        }
    }

    @SuppressLint("MissingPermission")
    fun close() {
        if (!closed.compareAndSet(false, true)) return
        reset(activeGeneration.incrementAndGet())
        ioExecutor.shutdownNow()
    }
}
