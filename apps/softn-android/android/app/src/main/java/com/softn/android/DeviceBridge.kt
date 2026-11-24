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
    }

    private data class QueuedPermRequest(
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
            if (current != null) {
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

    private var pendingPhotoRequestId: Long? = null
    private var pendingPhotoFile: File? = null
    private var pendingPhotoMaxWidth: Int = 960
    private var pendingPhotoQuality: Int = 85

    private val takePictureLauncher: ActivityResultLauncher<Uri> =
        activity.registerForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
            val reqId = pendingPhotoRequestId
            val file = pendingPhotoFile
            val maxW = pendingPhotoMaxWidth
            val quality = pendingPhotoQuality
            pendingPhotoRequestId = null
            pendingPhotoFile = null
            if (reqId == null) return@registerForActivityResult

            if (!saved || file == null || !file.exists() || file.length() == 0L) {
                file?.delete()
                fail(reqId, "Camera capture cancelled")
                return@registerForActivityResult
            }
            submitIo(reqId, "Camera processing failed") {
                try {
                    val decoded = decodeSampledFile(file, maxW)
                    if (decoded == null) {
                        fail(reqId, "Failed to decode captured photo")
                        return@submitIo
                    }
                    encodeAndResolveBitmap(reqId, decoded, maxW, quality)
                } finally {
                    file.delete()
                }
            }
        }

    private var pendingPickPhotoRequestId: Long? = null
    private var pendingPickPhotoMaxWidth: Int = 960
    private var pendingPickPhotoQuality: Int = 85

    private val pickPhotoLauncher: ActivityResultLauncher<String> =
        activity.registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
            val reqId = pendingPickPhotoRequestId
            val maxW = pendingPickPhotoMaxWidth
            val quality = pendingPickPhotoQuality
            pendingPickPhotoRequestId = null
            if (reqId == null) return@registerForActivityResult
            if (uri == null) {
                fail(reqId, "Photo selection cancelled")
                return@registerForActivityResult
            }
            submitIo(reqId, "Photo pick failed") {
                val decoded = decodeSampledUri(uri, maxW)
                if (decoded == null) {
                    fail(reqId, "Failed to decode selected photo")
                    return@submitIo
                }
                encodeAndResolveBitmap(reqId, decoded, maxW, quality)
            }
        }

    private var pendingFilePickRequestId: Long? = null
    private val openDocumentLauncher: ActivityResultLauncher<Array<String>> =
        activity.registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
            val reqId = pendingFilePickRequestId
            pendingFilePickRequestId = null
            if (reqId == null) return@registerForActivityResult
            if (uri == null) {
                fail(reqId, "File selection cancelled")
                return@registerForActivityResult
            }
            submitIo(reqId, "Failed to read file") {
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
                succeed(reqId, res)
            }
        }

    private var pendingFileSaveRequestId: Long? = null
    private var pendingFileSaveBytes: ByteArray? = null
    private val createDocumentLauncher: ActivityResultLauncher<String> =
        activity.registerForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri: Uri? ->
            val reqId = pendingFileSaveRequestId
            val data = pendingFileSaveBytes
            pendingFileSaveRequestId = null
            pendingFileSaveBytes = null
            if (reqId == null) return@registerForActivityResult
            if (uri == null || data == null) {
                fail(reqId, "File save cancelled")
                return@registerForActivityResult
            }
            submitIo(reqId, "Failed to save file") {
                activity.contentResolver.openOutputStream(uri)?.use { out ->
                    out.write(data)
                    out.flush()
                } ?: run {
                    fail(reqId, "Unable to open output stream for destination file")
                    return@submitIo
                }
                val name = queryDisplayName(uri) ?: "saved-file"
                succeed(
                    reqId,
                    JSONObject()
                        .put("ok", true)
                        .put("name", name)
                        .put("size", data.size)
                )
            }
        }

    private fun submitIo(reqId: Long, errorPrefix: String, block: () -> Unit) {
        if (closed.get()) return
        try {
            ioExecutor.execute {
                if (closed.get()) return@execute
                try {
                    block()
                } catch (t: Throwable) {
                    fail(reqId, "$errorPrefix: ${t.message}")
                }
            }
        } catch (t: Throwable) {
            fail(reqId, "$errorPrefix: ${t.message}")
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

    private fun encodeAndResolveBitmap(reqId: Long, decoded: Bitmap, maxW: Int, quality: Int) {
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

    private val activeGatts = ConcurrentHashMap<String, BluetoothGatt>()
    private val gattPendingReads = ConcurrentHashMap<String, Long>()
    private val gattPendingWrites = ConcurrentHashMap<String, Long>()
    private val gattPendingConnects = ConcurrentHashMap<String, Long>()

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
                    dispatch(id, ns, method, params)
                }
            }
        }
    }

    private fun dispatch(id: Long, namespace: String, method: String, params: JSONObject) {
        try {
            when (namespace) {
                "device" -> handleDevice(id, method, params)
                "haptics" -> handleHaptics(id, method, params)
                "notifications" -> handleNotifications(id, method, params)
                "camera" -> handleCamera(id, method, params)
                "location" -> handleLocation(id, method, params)
                "bluetooth" -> handleBluetooth(id, method, params)
                "files" -> handleFiles(id, method, params)
                "sensors" -> handleSensors(id, method, params)
                "permissions" -> handlePermissions(id, method, params)
                else -> fail(id, "Unsupported native bridge namespace: $namespace")
            }
        } catch (t: Throwable) {
            Log.e("SoftN", "DeviceBridge error in $namespace.$method", t)
            fail(id, t.message ?: "Native bridge failure")
        }
    }

    // ── Device (Share, Clipboard) ───────────────────────────────────────────

    private fun handleDevice(id: Long, method: String, params: JSONObject) {
        when (method) {
            "share" -> {
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
                succeed(id, JSONObject().put("shared", true))
            }
            "clipboardWrite" -> {
                val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                val text = params.optString("text", "")
                if (text.length > MAX_CLIPBOARD_CHARS) {
                    fail(id, "Clipboard payload exceeds 256 KB limit")
                    return
                }
                cm?.setPrimaryClip(ClipData.newPlainText("SoftN", text))
                succeed(id, JSONObject().put("ok", cm != null))
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
                succeed(id, JSONObject().put("text", text))
            }
            else -> fail(id, "Unknown device method: $method")
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
    private fun handleHaptics(id: Long, method: String, params: JSONObject) {
        val vib = getVibrator()
        if (vib == null || !vib.hasVibrator()) {
            succeed(id, JSONObject().put("ok", false))
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
                fail(id, "Unknown haptics method: $method")
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
            succeed(id, JSONObject().put("ok", true))
        } catch (se: SecurityException) {
            fail(id, "VIBRATE permission missing from APK manifest: ${se.message}")
        }
    }

    // ── Notifications ───────────────────────────────────────────────────────

    private fun handleNotifications(id: Long, method: String, params: JSONObject) {
        if (method != "notify") {
            fail(id, "Unknown notifications method: $method")
            return
        }
        val perms = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            arrayOf(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            emptyArray()
        }
        ensurePermissions(perms) { granted ->
            if (!granted) {
                fail(id, "Notification permission denied")
                return@ensurePermissions
            }
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
            val noteId = if (params.has("id")) params.optInt("id") else nextNotificationId.getAndIncrement()
            val notification = NotificationCompat.Builder(activity, channelId)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(params.optString("title", "SoftN"))
                .setContentText(params.optString("body", ""))
                .setAutoCancel(true)
                .build()
            nm.notify(noteId, notification)
            succeed(id, JSONObject().put("ok", true).put("id", noteId))
        }
    }

    // ── Camera ──────────────────────────────────────────────────────────────

    private fun handleCamera(id: Long, method: String, params: JSONObject) {
        when (method) {
            "takePhoto" -> {
                ensurePermissions(arrayOf(Manifest.permission.CAMERA)) { granted ->
                    if (!granted) {
                        fail(id, "Android CAMERA permission denied")
                        return@ensurePermissions
                    }
                    try {
                        val cameraCacheDir = File(activity.cacheDir, "camera").apply { mkdirs() }
                        val photoFile = File(cameraCacheDir, "softn_photo_${System.currentTimeMillis()}.jpg")
                        val authority = "${activity.packageName}.fileprovider"
                        val uri = FileProvider.getUriForFile(activity, authority, photoFile)
                        pendingPhotoRequestId?.let { prev -> fail(prev, "Superseded by newer camera request") }
                        pendingPhotoFile?.delete()
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
                        fail(id, "Failed to launch camera: ${t.message}")
                    }
                }
            }
            "pickPhoto" -> {
                try {
                    pendingPickPhotoRequestId?.let { prev -> fail(prev, "Superseded by newer photo pick request") }
                    pendingPickPhotoRequestId = id
                    pendingPickPhotoMaxWidth = params.optInt("maxWidth", 960).coerceIn(160, 2048)
                    val rawQ = params.optDouble("quality", 0.85)
                    pendingPickPhotoQuality = (if (rawQ > 1.0) rawQ else rawQ * 100.0).toInt().coerceIn(20, 100)
                    pickPhotoLauncher.launch("image/*")
                } catch (t: Throwable) {
                    pendingPickPhotoRequestId = null
                    fail(id, "Failed to launch photo picker: ${t.message}")
                }
            }
            else -> fail(id, "Unknown camera method: $method")
        }
    }

    // ── Files (Storage Access Framework — zero broad storage permission) ───

    private fun handleFiles(id: Long, method: String, params: JSONObject) {
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
                    pendingFilePickRequestId?.let { prev -> fail(prev, "Superseded by newer file pick request") }
                    pendingFilePickRequestId = id
                    openDocumentLauncher.launch(mimes.toTypedArray())
                } catch (t: Throwable) {
                    pendingFilePickRequestId = null
                    fail(id, "Failed to open file picker: ${t.message}")
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
                    fail(id, "File save payload exceeds 16 MB limit")
                    return
                }
                val gen = activeGeneration.get()
                submitIo(id, "Invalid file save payload") {
                    val data = if (b64.isNotEmpty()) {
                        Base64.decode(b64, Base64.DEFAULT)
                    } else {
                        txt.toByteArray(Charsets.UTF_8)
                    }
                    if (data.size > MAX_SAVE_FILE_BYTES) {
                        fail(id, "File save payload exceeds 16 MB limit")
                        return@submitIo
                    }
                    mainHandler.post {
                        if (closed.get() || activeGeneration.get() != gen) return@post
                        try {
                            pendingFileSaveRequestId?.let { prev -> fail(prev, "Superseded by newer file save request") }
                            pendingFileSaveRequestId = id
                            pendingFileSaveBytes = data
                            createDocumentLauncher.launch(filename)
                        } catch (t: Throwable) {
                            pendingFileSaveRequestId = null
                            pendingFileSaveBytes = null
                            fail(id, "Failed to launch save dialog: ${t.message}")
                        }
                    }
                }
            }
            else -> fail(id, "Unknown files method: $method")
        }
    }

    // ── Motion Sensors (Accelerometer / Gyroscope) ──────────────────────────

    private fun handleSensors(id: Long, method: String, params: JSONObject) {
        if (method != "getMotion") {
            fail(id, "Unknown sensors method: $method")
            return
        }
        val sm = activity.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        val accel = sm?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        val gyro = sm?.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
        if (sm == null || (accel == null && gyro == null)) {
            fail(id, "Motion sensors are unavailable on this device")
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
            "clipboard-read", "clipboard-write" -> "granted"
            else -> "denied"
        }
    }

    private fun handlePermissions(id: Long, method: String, params: JSONObject) {
        if (method != "query") {
            fail(id, "Unknown permissions method: $method")
            return
        }
        val state = describePermissionState(params.optString("name", ""))
        succeed(id, JSONObject().put("state", state))
    }

    // ── Location ────────────────────────────────────────────────────────────

    @SuppressLint("MissingPermission")
    private fun handleLocation(id: Long, method: String, params: JSONObject) {
        if (method != "getCurrentPosition") {
            fail(id, "Unknown location method: $method")
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
        ensurePermissions(needed, requireAny = true) { granted ->
            if (!granted) {
                fail(id, "Android location permission denied")
                return@ensurePermissions
            }
            val lm = activity.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            if (lm == null) {
                fail(id, "LocationManager unavailable")
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
                succeed(id, locationToJson(cached))
                return@ensurePermissions
            }
            val preferredProvider = when {
                highAccuracy && lm.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
                lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
                lm.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
                else -> null
            }
            if (preferredProvider == null) {
                if (best != null) succeed(id, locationToJson(best))
                else fail(id, "Location services are turned off on this device")
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
                        if (best != null) succeed(id, locationToJson(best))
                        else fail(id, "Location request timed out")
                    }
                }
                mainHandler.postDelayed(timeoutRunnable, timeoutMs)
                try {
                    lm.getCurrentLocation(preferredProvider, cancelSignal, activity.mainExecutor) { loc ->
                        if (settled.compareAndSet(false, true)) {
                            activeCleanups.remove(locCleanup)
                            mainHandler.removeCallbacks(timeoutRunnable)
                            val resolved = loc ?: best
                            if (resolved != null) succeed(id, locationToJson(resolved))
                            else fail(id, "Unable to obtain GPS/network location fix")
                        }
                    }
                } catch (t: Throwable) {
                    if (settled.compareAndSet(false, true)) {
                        activeCleanups.remove(locCleanup)
                        mainHandler.removeCallbacks(timeoutRunnable)
                        if (best != null) succeed(id, locationToJson(best))
                        else fail(id, "Location query failed: ${t.message}")
                    }
                }
            } else {
                lateinit var listener: LocationListener
                lateinit var locCleanup: () -> Unit
                val timeoutRunnable = Runnable {
                    if (settled.compareAndSet(false, true)) {
                        activeCleanups.remove(locCleanup)
                        try { lm.removeUpdates(listener) } catch (_: Throwable) {}
                        if (best != null) succeed(id, locationToJson(best))
                        else fail(id, "Location request timed out")
                    }
                }
                listener = object : LocationListener {
                    override fun onLocationChanged(loc: Location) {
                        if (settled.compareAndSet(false, true)) {
                            activeCleanups.remove(locCleanup)
                            mainHandler.removeCallbacks(timeoutRunnable)
                            try { lm.removeUpdates(this) } catch (_: Throwable) {}
                            succeed(id, locationToJson(loc))
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
                        if (best != null) succeed(id, locationToJson(best))
                        else fail(id, "Location query failed: ${t.message}")
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
    private fun handleBluetooth(id: Long, method: String, params: JSONObject) {
        val bm = activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter: BluetoothAdapter? = bm?.adapter
        if (adapter == null) {
            fail(id, "Bluetooth hardware adapter is not available on this device")
            return
        }
        if (!adapter.isEnabled) {
            fail(id, "Bluetooth is currently turned off")
            return
        }

        ensurePermissions(blePermissions()) { granted ->
            if (!granted) {
                fail(id, "Android Bluetooth permission denied")
                return@ensurePermissions
            }
            when (method) {
                "scan" -> scanBle(id, adapter, params)
                "connect" -> connectBle(id, adapter, params.optString("deviceId"))
                "disconnect" -> {
                    val devId = params.optString("deviceId")
                    activeGatts.remove(devId)?.let {
                        it.disconnect()
                        it.close()
                    }
                    succeed(id, JSONObject().put("disconnected", true).put("deviceId", devId))
                }
                "read" -> readBleCharacteristic(
                    id,
                    params.optString("deviceId"),
                    params.optString("serviceUuid"),
                    params.optString("characteristicUuid")
                )
                "write" -> writeBleCharacteristic(
                    id,
                    params.optString("deviceId"),
                    params.optString("serviceUuid"),
                    params.optString("characteristicUuid"),
                    params.optString("base64"),
                    params.optBoolean("withoutResponse", false)
                )
                else -> fail(id, "Unknown bluetooth method: $method")
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun scanBle(id: Long, adapter: BluetoothAdapter, params: JSONObject) {
        val scanner = adapter.bluetoothLeScanner
        if (scanner == null) {
            fail(id, "BLE scanner unavailable on this device")
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
                    fail(id, "BLE scan failed (code $errorCode)")
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
                succeed(id, JSONObject().put("devices", arr))
            }
        }, durationMs)
    }

    @SuppressLint("MissingPermission")
    private fun connectBle(id: Long, adapter: BluetoothAdapter, deviceId: String) {
        if (deviceId.isBlank()) {
            fail(id, "Missing Bluetooth deviceId")
            return
        }
        val device = try {
            adapter.getRemoteDevice(deviceId)
        } catch (t: Throwable) {
            fail(id, "Invalid Bluetooth address '$deviceId': ${t.message}")
            return
        }
        // Close any existing GATT for this device before reconnecting to avoid leaking BluetoothGatt slots.
        activeGatts.remove(deviceId)?.let { prevGatt ->
            try {
                prevGatt.disconnect()
                prevGatt.close()
            } catch (_: Throwable) {}
        }
        gattPendingConnects.put(deviceId, id)?.let { prevReq ->
            fail(prevReq, "Superseded by newer Bluetooth connect request")
        }
        failPendingGattOpsForDevice(deviceId, "Bluetooth reconnecting")
        val gatt = device.connectGatt(activity, false, object : BluetoothGattCallback() {
            override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    activeGatts[deviceId] = g
                    g.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                    activeGatts.remove(deviceId, g)
                    gattPendingConnects.remove(deviceId)?.let { reqId ->
                        fail(reqId, "Bluetooth device disconnected (status $status)")
                    }
                    failPendingGattOpsForDevice(deviceId, "Bluetooth device disconnected (status $status)")
                    g.close()
                }
            }

            override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                val reqId = gattPendingConnects.remove(deviceId) ?: return
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    fail(reqId, "GATT service discovery failed (status $status)")
                    return
                }
                val svcs = JSONArray()
                g.services.forEach { svcs.put(it.uuid.toString()) }
                succeed(
                    reqId,
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
                val reqId = gattPendingReads.remove(key) ?: return
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    fail(reqId, "GATT read failed (status $status)")
                    return
                }
                succeed(
                    reqId,
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
                val reqId = gattPendingWrites.remove(key) ?: return
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    succeed(reqId, JSONObject().put("ok", true))
                } else {
                    fail(reqId, "GATT write failed (status $status)")
                }
            }
        })
        if (gatt == null) {
            gattPendingConnects.remove(deviceId, id)
            fail(id, "Failed to initiate GATT connection")
        }
    }

    private fun gattCharKey(deviceId: String, serviceUuid: UUID?, charUuid: UUID): String =
        "$deviceId:${serviceUuid?.toString() ?: ""}:$charUuid"

    private fun failPendingGattOpsForDevice(deviceId: String, reason: String) {
        val prefix = "$deviceId:"
        for (k in gattPendingReads.keys().toList()) {
            if (k.startsWith(prefix)) {
                gattPendingReads.remove(k)?.let { fail(it, reason) }
            }
        }
        for (k in gattPendingWrites.keys().toList()) {
            if (k.startsWith(prefix)) {
                gattPendingWrites.remove(k)?.let { fail(it, reason) }
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun readBleCharacteristic(
        id: Long,
        deviceId: String,
        serviceUuid: String,
        charUuid: String
    ) {
        val gatt = activeGatts[deviceId] ?: run {
            fail(id, "Device not connected: $deviceId")
            return
        }
        val svc = parseBleUuid(serviceUuid)?.let { gatt.getService(it) } ?: run {
            fail(id, "GATT service not found: $serviceUuid")
            return
        }
        val ch = parseBleUuid(charUuid)?.let { svc.getCharacteristic(it) } ?: run {
            fail(id, "GATT characteristic not found: $charUuid")
            return
        }
        val key = gattCharKey(deviceId, svc.uuid, ch.uuid)
        gattPendingReads.put(key, id)?.let { prev ->
            fail(prev, "Superseded by newer GATT read on same characteristic")
        }
        if (!gatt.readCharacteristic(ch)) {
            gattPendingReads.remove(key, id)
            fail(id, "GATT readCharacteristic rejected")
        }
    }

    @SuppressLint("MissingPermission")
    private fun writeBleCharacteristic(
        id: Long,
        deviceId: String,
        serviceUuid: String,
        charUuid: String,
        base64: String,
        withoutResponse: Boolean
    ) {
        val gatt = activeGatts[deviceId] ?: run {
            fail(id, "Device not connected: $deviceId")
            return
        }
        val svc = parseBleUuid(serviceUuid)?.let { gatt.getService(it) } ?: run {
            fail(id, "GATT service not found: $serviceUuid")
            return
        }
        val ch = parseBleUuid(charUuid)?.let { svc.getCharacteristic(it) } ?: run {
            fail(id, "GATT characteristic not found: $charUuid")
            return
        }
        val data = try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (t: Throwable) {
            fail(id, "Invalid Base64 BLE payload: ${t.message}")
            return
        }
        val writeType = if (withoutResponse) {
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        } else {
            BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        }
        val key = gattCharKey(deviceId, svc.uuid, ch.uuid)
        gattPendingWrites.put(key, id)?.let { prev ->
            fail(prev, "Superseded by newer GATT write on same characteristic")
        }
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
            gattPendingWrites.remove(key, id)
            fail(id, "GATT writeCharacteristic rejected")
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
        permissions: Array<String>,
        requireAny: Boolean = false,
        onResult: (Boolean) -> Unit
    ) {
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
                permissions = permissions,
                missing = missing.toTypedArray(),
                requireAny = requireAny,
                onResult = onResult
            )
        )
        pumpNextPermissionRequest()
    }

    private fun pumpNextPermissionRequest() {
        if (activePermRequest != null) return
        while (permissionQueue.isNotEmpty()) {
            val next = permissionQueue.removeFirst()
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

    private fun succeed(requestId: Long, result: JSONObject) {
        if (closed.get()) return
        onResolve(activeGeneration.get(), requestId, true, result.toString())
    }

    private fun fail(requestId: Long, message: String) {
        if (closed.get()) return
        onResolve(activeGeneration.get(), requestId, false, JSONObject().put("error", message).toString())
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
        gattPendingReads.clear()
        gattPendingWrites.clear()
        gattPendingConnects.clear()
        pendingPhotoRequestId = null
        pendingPhotoFile?.delete()
        pendingPhotoFile = null
        pendingPickPhotoRequestId = null
        pendingFilePickRequestId = null
        pendingFileSaveRequestId = null
        pendingFileSaveBytes = null
        permissionQueue.clear()
    }

    @SuppressLint("MissingPermission")
    fun close() {
        if (!closed.compareAndSet(false, true)) return
        reset(activeGeneration.incrementAndGet())
        ioExecutor.shutdownNow()
    }
}
