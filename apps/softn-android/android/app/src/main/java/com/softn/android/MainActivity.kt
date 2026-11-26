package com.softn.android

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.zip.Inflater
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.Log
import android.view.Choreographer
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer

/**
 * Main Android Activity for the SoftN Mobile Harness.
 *
 * Supports two seamless modes from one APK architecture:
 * 1. **Standalone App Mode**: Automatically boots `assets/app.softn` embedded inside the APK.
 * 2. **Player Mode**: Opens `.softn` files from `ACTION_VIEW` intents or via Android's document picker.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var rootLayout: LinearLayout
    private lateinit var playerTopBar: LinearLayout
    private lateinit var playerTitleView: TextView
    private lateinit var surfaceView: SoftnSurfaceView
    private lateinit var imeBar: LinearLayout
    private lateinit var imeEditText: EditText
    private lateinit var deviceBridge: DeviceBridge

    private var isStandaloneMode: Boolean = false
    private var isPlayerMode: Boolean = false
    @Volatile private var currentBundleInfoJson: String = "{}"
    @Volatile private var currentGrantedCapabilities: List<String>? = null
    private val consentedCapabilitiesByDigest = ConcurrentHashMap<String, List<String>>()
    private val bundleIoExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "softn-bundle-io").apply { isDaemon = true }
    }

    companion object {
        private const val MAX_BUNDLE_BYTES = 128 * 1024 * 1024
        private const val MAX_META_JSON_BYTES = 256 * 1024
        private val KNOWN_CAPS = setOf(
            "camera", "mic", "location", "bluetooth", "clipboard", "files", "net",
            "notifications", "haptics", "accel", "qr", "storage", "sync", "gpu", "ai"
        )
        private val SENSITIVE_CAPS = setOf(
            "camera", "mic", "location", "bluetooth", "clipboard", "files", "net", "notifications"
        )
    }

    private data class PendingBundle(
        val bytes: ByteArray,
        val grantedCapabilities: List<String>?
    )

    // Dedicated 8 MiB native-stack Looper thread for `zipp-vm` + `zipp-dom` + TinySkia
    // (Android's default HandlerThread only allocates ~1 MiB, which large React apps can exceed).
    private var engineLooper: Looper? = null
    private val engineLooperReady = CountDownLatch(1)
    private val engineThread = Thread(
        null,
        {
            Looper.prepare()
            engineLooper = Looper.myLooper()
            engineLooperReady.countDown()
            Looper.loop()
        },
        "softn-engine",
        8L * 1024L * 1024L
    ).apply { start() }
    private val engineHandler by lazy {
        engineLooperReady.await()
        Handler(engineLooper!!)
    }
    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile private var engineHandle: Long = 0L
    private val engineGeneration = AtomicLong(0L)
    private val destroyed = AtomicBoolean(false)
    private var rgbaBuffer: ByteBuffer? = null
    @Volatile private var viewportWidth: Int = 0
    @Volatile private var viewportHeight: Int = 0
    @Volatile private var viewportDensity: Float = 2f
    @Volatile private var pendingBundle: PendingBundle? = null
    private var playerLandingView: View? = null
    private var suppressImeWatcher = false
    @Volatile private var tickerRunning = false
    @Volatile private var wantsRaf = false
    @Volatile private var hasInteractiveCanvas = true
    @Volatile private var nextTimerMs = 120L
    private val tickInFlight = AtomicBoolean(false)
    private val pointerMoveInFlight = AtomicBoolean(false)
    private val hasQueuedMove = AtomicBoolean(false)
    @Volatile private var latestMoveX = 0f
    @Volatile private var latestMoveY = 0f
    private val scrollLock = Any()
    private var pendingScrollX = 0f
    private var pendingScrollY = 0f
    private val scrollInFlight = AtomicBoolean(false)
    private val imeInputInFlight = AtomicBoolean(false)
    private val hasQueuedImeText = AtomicBoolean(false)
    @Volatile private var latestImeText = ""
    private val frameCallbackPosted = AtomicBoolean(false)

    private val openBundleLauncher =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
            if (uri != null) loadBundleFromUri(uri)
        }

    private val vsyncCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            frameCallbackPosted.set(false)
            if (!tickerRunning || destroyed.get()) return
            dispatchTickOnce()
            scheduleNextTick()
        }
    }

    private val idleTickRunnable = Runnable {
        if (!tickerRunning || destroyed.get()) return@Runnable
        dispatchTickOnce()
        scheduleNextTick()
    }

    private fun dispatchTickOnce() {
        val handle = engineHandle
        if (handle != 0L && !destroyed.get() && tickInFlight.compareAndSet(false, true)) {
            engineHandler.post {
                try {
                    val h = engineHandle
                    if (h != 0L && !destroyed.get()) {
                        val resJson = SoftnNative.nativeTick(h)
                        handleInteractionJson(resJson)
                    }
                } finally {
                    tickInFlight.set(false)
                }
            }
        }
    }

    private fun scheduleNextTick() {
        if (!tickerRunning || destroyed.get()) return
        if (wantsRaf) {
            mainHandler.removeCallbacks(idleTickRunnable)
            if (frameCallbackPosted.compareAndSet(false, true)) {
                Choreographer.getInstance().postFrameCallback(vsyncCallback)
            }
        } else if (!frameCallbackPosted.get()) {
            mainHandler.removeCallbacks(idleTickRunnable)
            val delay = nextTimerMs
            if (delay >= 0L) {
                mainHandler.postDelayed(idleTickRunnable, delay.coerceIn(16L, 2000L))
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        deviceBridge = DeviceBridge(this) { gen, reqId, ok, payload ->
            engineHandler.post {
                val h = engineHandle
                if (h == 0L || destroyed.get() || engineGeneration.get() != gen) return@post
                val resJson = SoftnNative.nativeResolveDeviceCall(h, reqId, ok, payload)
                handleInteractionJson(resJson, gen)
            }
        }

        rootLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0F172A"))
        }

        // Respect Android status bar, navigation bar, and soft keyboard insets cleanly,
        // and collapse the native IME bar automatically when the user hides the soft keyboard.
        var wasImeVisible = false
        ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime()
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
            if (wasImeVisible && !imeVisible && imeBar.visibility == View.VISIBLE) {
                imeBar.visibility = View.GONE
            }
            wasImeVisible = imeVisible
            insets
        }

        // Compact Player Mode toolbar (hidden for standalone packaged APKs)
        playerTopBar = buildPlayerTopBar()
        rootLayout.addView(
            playerTopBar,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        val canvasHolder = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }

        surfaceView = SoftnSurfaceView(
            context = this,
            onViewportReady = { w, h, d -> onViewportChanged(w, h, d) },
            onTap = { x, y -> dispatchTap(x, y) },
            onScroll = { dx, dy -> dispatchScroll(dx, dy) },
            onPointerDown = { x, y -> dispatchPointerDown(x, y) },
            onPointerMove = { x, y -> dispatchPointerMove(x, y) },
            onPointerUp = { x, y -> dispatchPointerUp(x, y) }
        )
        canvasHolder.addView(
            surfaceView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        rootLayout.addView(canvasHolder)

        // Synchronized native Android IME input bar shown automatically when an <input> is tapped
        imeBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.parseColor("#1E293B"))
            setPadding(16, 10, 16, 10)
            visibility = View.GONE
        }
        imeEditText = EditText(this).apply {
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#94A3B8"))
            hint = "Type here..."
            imeOptions = EditorInfo.IME_ACTION_DONE
            isSingleLine = true
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val doneBtn = Button(this).apply {
            text = "Done"
            setOnClickListener { submitAndHideIme() }
        }
        imeBar.addView(imeEditText)
        imeBar.addView(doneBtn)
        rootLayout.addView(
            imeBar,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        imeEditText.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                if (suppressImeWatcher) return
                dispatchTextInput(s?.toString() ?: "")
            }
        })
        imeEditText.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE ||
                actionId == EditorInfo.IME_ACTION_GO ||
                actionId == EditorInfo.IME_ACTION_SEARCH
            ) {
                submitAndHideIme()
                true
            } else {
                false
            }
        }

        // Dismiss the IME overlay on Back press before allowing Activity finish.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (imeBar.visibility == View.VISIBLE) {
                    hideIme()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        })

        setContentView(rootLayout)

        // Security: check embedded `assets/app.softn` FIRST so standalone packaged APKs
        // CANNOT be hijacked into running an attacker-supplied `.softn` bundle via ACTION_VIEW.
        // Detect presence cheaply on UI thread, then read the bundle bytes off-thread to avoid ANR.
        if (hasEmbeddedBundle()) {
            isStandaloneMode = true
            isPlayerMode = false
            surfaceView.setStatusMessage("Loading SoftN App...")
            bundleIoExecutor.execute {
                if (destroyed.get()) return@execute
                val embedded = readEmbeddedBundle()
                mainHandler.post {
                    if (destroyed.get()) return@post
                    if (embedded == null || embedded.isEmpty()) {
                        surfaceView.setStatusMessage("Failed to read embedded SoftN bundle")
                        return@post
                    }
                    pendingBundle = PendingBundle(embedded, null)
                    if (viewportWidth > 0 && viewportHeight > 0) {
                        bootPendingBundle()
                    }
                }
            }
        } else {
            isStandaloneMode = false
            isPlayerMode = true
            val intentUri = intent?.data
            if (intent?.action == Intent.ACTION_VIEW && intentUri != null) {
                loadBundleFromUri(intentUri)
            } else {
                showPlayerLanding(canvasHolder)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (isStandaloneMode) {
            Log.w("SoftN", "Ignoring ACTION_VIEW intent in Standalone APK mode")
            return
        }
        val uri = intent.data
        if (intent.action == Intent.ACTION_VIEW && uri != null) {
            isPlayerMode = true
            loadBundleFromUri(uri)
        }
    }

    private fun buildPlayerTopBar(): LinearLayout {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#1E293B"))
            setPadding(20, 8, 12, 8)
            visibility = View.GONE
        }
        playerTitleView = TextView(this).apply {
            text = "SoftN Player"
            textSize = 14f
            setTextColor(Color.WHITE)
            maxLines = 1
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        fun makeActionChip(label: String, onClick: () -> Unit): TextView =
            TextView(this).apply {
                text = label
                textSize = 12f
                setTextColor(Color.parseColor("#E2E8F0"))
                setBackgroundColor(Color.parseColor("#334155"))
                setPadding(16, 10, 16, 10)
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                lp.setMargins(8, 0, 0, 0)
                layoutParams = lp
                setOnClickListener { onClick() }
            }

        bar.addView(playerTitleView)
        bar.addView(makeActionChip("Perms") { showBundlePermissionsDialog() })
        bar.addView(makeActionChip("Cache") { clearAppCache() })
        bar.addView(makeActionChip("Reset") { confirmClearSiteData() })
        bar.addView(makeActionChip("Open") {
            openBundleLauncher.launch(arrayOf("application/octet-stream", "*/*"))
        })
        return bar
    }

    private fun showBundlePermissionsDialog() {
        val info = try {
            JSONObject(currentBundleInfoJson)
        } catch (_: Throwable) {
            JSONObject()
        }
        val name = info.optString("name", "SoftN App")
        val version = info.optString("version", "1.0.0")
        val backend = info.optString("backendRuntime", "").ifBlank { "none (static)" }
        val dbCount = info.optInt("databases", 0)
        val capsArr = info.optJSONArray("capabilities")
        val lines = mutableListOf<String>()
        lines.add("App: $name v$version")
        lines.add("Backend: $backend  |  SQLite DBs: $dbCount")
        lines.add("")
        if (capsArr == null || capsArr.length() == 0) {
            lines.add("Declared Capabilities: none (offline zero-egress)")
        } else {
            val granted = currentGrantedCapabilities
            lines.add("Declared Capabilities (permission.json):")
            for (i in 0 until capsArr.length()) {
                val cap = capsArr.optString(i)
                val osState = deviceBridge.describePermissionState(cap)
                val userState = if (granted == null) "app-bundled" else if (granted.contains(cap)) "granted" else "denied by user"
                lines.add("  • $cap  —  Player: $userState | OS: $osState")
            }
        }
        if (isFinishing || isDestroyed) return
        AlertDialog.Builder(this)
            .setTitle("App Permissions & Runtime")
            .setMessage(lines.joinToString("\n"))
            .setPositiveButton("Close", null)
            .setNeutralButton("Clear Cache") { _, _ -> clearAppCache() }
            .show()
    }

    private fun clearAppCache() {
        engineHandler.post {
            if (engineHandle == 0L) return@post
            val resJson = SoftnNative.nativeClearCache(engineHandle)
            val obj = try { JSONObject(resJson) } catch (_: Throwable) { JSONObject() }
            val entries = obj.optInt("entries", 0)
            val kb = obj.optLong("bytes", 0L) / 1024L
            mainHandler.post {
                if (isFinishing || isDestroyed) return@post
                Toast.makeText(
                    this,
                    "Cleared cache ($entries entries, ${kb} KB)",
                    Toast.LENGTH_SHORT
                ).show()
            }
        }
    }

    private fun confirmClearSiteData() {
        if (isFinishing || isDestroyed) return
        AlertDialog.Builder(this)
            .setTitle("Clear Site Data?")
            .setMessage("Clears HTTP cache, cookies, sessions, localStorage, and IndexedDB for this SoftN app.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Clear") { _, _ ->
                engineHandler.post {
                    if (engineHandle == 0L) return@post
                    val resJson = SoftnNative.nativeClearSiteData(engineHandle)
                    val obj = try { JSONObject(resJson) } catch (_: Throwable) { JSONObject() }
                    val cookies = obj.optInt("cookies", 0)
                    val entries = obj.optInt("entries", 0)
                    mainHandler.post {
                        if (isFinishing || isDestroyed) return@post
                        Toast.makeText(
                            this,
                            "Cleared site data ($cookies cookies, $entries cached entries)",
                            Toast.LENGTH_SHORT
                        ).show()
                    }
                }
            }
            .show()
    }

    private fun hasEmbeddedBundle(): Boolean {
        return try {
            assets.list("")?.contains("app.softn") == true
        } catch (_: Throwable) {
            false
        }
    }

    private fun readEmbeddedBundle(): ByteArray? {
        return try {
            assets.open("app.softn").use { input ->
                val out = ByteArrayOutputStream()
                val chunk = ByteArray(32 * 1024)
                var total = 0
                while (true) {
                    val n = input.read(chunk)
                    if (n <= 0) break
                    total += n
                    if (total > MAX_BUNDLE_BYTES) return null
                    out.write(chunk, 0, n)
                }
                out.toByteArray()
            }
        } catch (_: Throwable) {
            null
        }
    }

    private data class BundlePreviewMeta(
        val digest: String,
        val name: String,
        val capabilities: List<String>
    )

    private fun u16Le(buf: ByteArray, off: Int): Int =
        (buf[off].toInt() and 0xFF) or ((buf[off + 1].toInt() and 0xFF) shl 8)

    private fun u32Le(buf: ByteArray, off: Int): Long =
        (buf[off].toLong() and 0xFFL) or
            ((buf[off + 1].toLong() and 0xFFL) shl 8) or
            ((buf[off + 2].toLong() and 0xFFL) shl 16) or
            ((buf[off + 3].toLong() and 0xFFL) shl 24)

    /**
     * Parses the ZIP Central Directory directly in memory so non-metadata entries are
     * skipped in O(1) without ever decompressing potential ZIP-bomb payload files.
     * Takes the union of all `permission.json` entries (in case of duplicate ZIP entries)
     * and normalizes/whitelists capability keys against `KNOWN_CAPS`.
     */
    private fun inspectBundleMeta(bytes: ByteArray): BundlePreviewMeta {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }
        var appName = "SoftN Bundle"
        val caps = LinkedHashSet<String>()
        try {
            if (bytes.size >= 22) {
                var eocd = -1
                val minPos = maxOf(0, bytes.size - 65557)
                for (pos in (bytes.size - 22) downTo minPos) {
                    if (bytes[pos] == 0x50.toByte() &&
                        bytes[pos + 1] == 0x4B.toByte() &&
                        bytes[pos + 2] == 0x05.toByte() &&
                        bytes[pos + 3] == 0x06.toByte()
                    ) {
                        val commentLen = u16Le(bytes, pos + 20)
                        if (pos + 22 + commentLen == bytes.size) {
                            eocd = pos
                            break
                        }
                    }
                }
                if (eocd >= 0) {
                    val cdEntryCount = u16Le(bytes, eocd + 10)
                    val cdSize = u32Le(bytes, eocd + 12)
                    val cdOffset = u32Le(bytes, eocd + 16)
                    if (cdOffset >= 0 && cdSize >= 0 && cdOffset + cdSize <= bytes.size.toLong()) {
                        var cursor = cdOffset.toInt()
                        val cdEnd = (cdOffset + cdSize).toInt()
                        val limitEntries = minOf(cdEntryCount, 10_000)
                        var seen = 0
                        while (seen < limitEntries && cursor + 46 <= cdEnd) {
                            if (bytes[cursor] != 0x50.toByte() ||
                                bytes[cursor + 1] != 0x4B.toByte() ||
                                bytes[cursor + 2] != 0x01.toByte() ||
                                bytes[cursor + 3] != 0x02.toByte()
                            ) break
                            val method = u16Le(bytes, cursor + 10)
                            val compSize = u32Le(bytes, cursor + 20)
                            val nameLen = u16Le(bytes, cursor + 28)
                            val extraLen = u16Le(bytes, cursor + 30)
                            val commentLen = u16Le(bytes, cursor + 32)
                            val localOffset = u32Le(bytes, cursor + 42)
                            val nextCursor = cursor + 46 + nameLen + extraLen + commentLen
                            if (nextCursor > cdEnd || nextCursor <= cursor) break
                            val rawName = String(bytes, cursor + 46, nameLen, Charsets.UTF_8)
                            var norm = rawName.replace('\\', '/').trimStart('/')
                            while (norm.startsWith("./")) {
                                norm = norm.removePrefix("./")
                            }
                            if (norm == "manifest.json" || norm == "permission.json") {
                                val entryBytes = extractSmallZipEntry(bytes, localOffset, method, compSize)
                                if (entryBytes != null) {
                                    val json = try {
                                        JSONObject(String(entryBytes, Charsets.UTF_8))
                                    } catch (_: Throwable) {
                                        null
                                    }
                                    if (norm == "manifest.json" && json != null) {
                                        val cleaned = json.optString("name", "")
                                            .filter { ch ->
                                                val type = Character.getType(ch)
                                                type != Character.CONTROL.toInt() && type != Character.FORMAT.toInt()
                                            }
                                            .replace(Regex("\\s+"), " ")
                                            .trim()
                                            .take(80)
                                        if (cleaned.isNotEmpty()) appName = cleaned
                                    } else if (norm == "permission.json" && json != null) {
                                        val perms = json.optJSONObject("permissions")
                                        if (perms != null) {
                                            val keys = perms.keys()
                                            while (keys.hasNext()) {
                                                val rawKey = keys.next()
                                                val normKey = rawKey.trim().lowercase()
                                                if (!KNOWN_CAPS.contains(normKey)) continue
                                                val obj = perms.optJSONObject(rawKey)
                                                if (obj != null && obj.optBoolean("enabled", false)) {
                                                    caps.add(normKey)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            cursor = nextCursor
                            seen++
                        }
                    }
                }
            }
        } catch (_: Throwable) {
        }
        return BundlePreviewMeta(digest = digest, name = appName, capabilities = caps.sorted())
    }

    private fun extractSmallZipEntry(
        bytes: ByteArray,
        localOffset: Long,
        method: Int,
        compSize: Long
    ): ByteArray? {
        if (localOffset < 0 || localOffset + 30 > bytes.size.toLong()) return null
        val off = localOffset.toInt()
        if (bytes[off] != 0x50.toByte() ||
            bytes[off + 1] != 0x4B.toByte() ||
            bytes[off + 2] != 0x03.toByte() ||
            bytes[off + 3] != 0x04.toByte()
        ) return null
        val localNameLen = u16Le(bytes, off + 26)
        val localExtraLen = u16Le(bytes, off + 28)
        val dataStart = off.toLong() + 30L + localNameLen.toLong() + localExtraLen.toLong()
        if (compSize < 0 || dataStart + compSize > bytes.size.toLong()) return null
        if (method == 0) {
            if (compSize > MAX_META_JSON_BYTES.toLong()) return null
            return bytes.copyOfRange(dataStart.toInt(), (dataStart + compSize).toInt())
        }
        if (method == 8) {
            if (compSize > MAX_META_JSON_BYTES.toLong() * 2L) return null
            val inflater = Inflater(true)
            return try {
                inflater.setInput(bytes, dataStart.toInt(), compSize.toInt())
                val out = ByteArrayOutputStream()
                val buf = ByteArray(8192)
                var total = 0
                while (!inflater.finished()) {
                    val n = inflater.inflate(buf)
                    if (n == 0) {
                        if (inflater.needsInput() || inflater.needsDictionary()) break
                    } else {
                        total += n
                        if (total > MAX_META_JSON_BYTES) return null
                        out.write(buf, 0, n)
                    }
                }
                out.toByteArray()
            } finally {
                inflater.end()
            }
        }
        return null
    }

    private fun loadBundleFromUri(uri: Uri) {
        if (!"content".equals(uri.scheme, ignoreCase = true)) {
            surfaceView.setStatusMessage("Blocked unsupported bundle URI scheme: ${uri.scheme ?: "none"}")
            return
        }
        playerLandingView?.visibility = View.GONE
        surfaceView.setStatusMessage("Loading .softn bundle...")
        bundleIoExecutor.execute {
            if (destroyed.get()) return@execute
            try {
                val bytes = contentResolver.openInputStream(uri)?.use { input ->
                    val out = ByteArrayOutputStream()
                    val chunk = ByteArray(32 * 1024)
                    var total = 0
                    while (true) {
                        val n = input.read(chunk)
                        if (n <= 0) break
                        total += n
                        if (total > MAX_BUNDLE_BYTES) {
                            throw IllegalStateException("Bundle exceeds 128 MB limit")
                        }
                        out.write(chunk, 0, n)
                    }
                    out.toByteArray()
                }
                if (bytes == null || bytes.isEmpty()) {
                    mainHandler.post { reportBundleFailure("Selected .softn file is empty") }
                    return@execute
                }
                val meta = inspectBundleMeta(bytes)
                mainHandler.post {
                    if (destroyed.get()) return@post
                    val existing = consentedCapabilitiesByDigest[meta.digest]
                    if (!isPlayerMode || meta.capabilities.isEmpty() || existing != null) {
                        val granted = if (!isPlayerMode) null else (existing ?: emptyList())
                        launchPlayerBundle(bytes, granted)
                    } else {
                        promptForBundleCapabilities(bytes, meta)
                    }
                }
            } catch (t: Throwable) {
                mainHandler.post {
                    reportBundleFailure("Failed to open .softn file: ${t.message}")
                }
            }
        }
    }

    /**
     * A bundle that did not open or boot. Over an app that still runs it is a toast (the
     * surface draws its status only when no frame is up). With none running, the frame goes:
     * it is the last picture of an engine since destroyed, which looked alive and answered
     * nothing. The message then shows, and in Player mode the top bar's Open is there.
     */
    private fun reportBundleFailure(message: String) {
        if (destroyed.get() || isFinishing || isDestroyed) return
        if (engineHandle != 0L) {
            Toast.makeText(this, message, Toast.LENGTH_LONG).show()
            return
        }
        surfaceView.clearFrame()
        surfaceView.setStatusMessage(message)
        if (isPlayerMode) {
            playerTitleView.text = "SoftN Player"
            playerTopBar.visibility = View.VISIBLE
        }
    }

    private fun promptForBundleCapabilities(bytes: ByteArray, meta: BundlePreviewMeta) {
        if (isFinishing || isDestroyed) return
        val labels = meta.capabilities.toTypedArray()
        // Sensitive capabilities start unchecked so the user makes an explicit opt-in decision.
        val checked = BooleanArray(labels.size) { i -> !SENSITIVE_CAPS.contains(labels[i]) }
        val shortHash = meta.digest.take(12)
        AlertDialog.Builder(this)
            .setTitle("Permissions for ${meta.name} ($shortHash)")
            .setMultiChoiceItems(labels, checked) { _, which, isChecked ->
                checked[which] = isChecked
            }
            .setCancelable(false)
            .setPositiveButton("Allow Selected") { _, _ ->
                val granted = labels.indices.filter { checked[it] }.map { labels[it] }
                consentedCapabilitiesByDigest[meta.digest] = granted
                launchPlayerBundle(bytes, granted)
            }
            .setNeutralButton("Run Offline (None)") { _, _ ->
                consentedCapabilitiesByDigest[meta.digest] = emptyList()
                launchPlayerBundle(bytes, emptyList())
            }
            .setNegativeButton("Cancel") { _, _ ->
                if (engineHandle == 0L) {
                    playerLandingView?.visibility = View.VISIBLE
                    surfaceView.setStatusMessage(null)
                }
            }
            .show()
    }

    private fun launchPlayerBundle(bytes: ByteArray, grantedCapabilities: List<String>?) {
        playerLandingView?.visibility = View.GONE
        surfaceView.setStatusMessage("Booting SoftN Engine...")
        pendingBundle = PendingBundle(bytes, grantedCapabilities)
        if (viewportWidth > 0 && viewportHeight > 0) {
            bootPendingBundle()
        }
    }

    private fun showPlayerLanding(holder: FrameLayout) {
        surfaceView.setStatusMessage(null)
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
        }
        val title = TextView(this).apply {
            text = "SoftN Mobile Player"
            textSize = 24f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
        }
        val sub = TextView(this).apply {
            text = "Powered by Zipp Browser + Container v2\nOpen any .softn bundle to run locally with full backend & SQLite."
            textSize = 14f
            setTextColor(Color.parseColor("#94A3B8"))
            gravity = Gravity.CENTER
            setPadding(0, 16, 0, 32)
        }
        val openBtn = Button(this).apply {
            text = "Open .softn App"
            setOnClickListener {
                openBundleLauncher.launch(arrayOf("application/octet-stream", "*/*"))
            }
        }
        panel.addView(title)
        panel.addView(sub)
        panel.addView(openBtn)
        playerLandingView = panel
        holder.addView(panel)
    }

    private fun onViewportChanged(width: Int, height: Int, density: Float) {
        engineHandler.post {
            viewportWidth = width
            viewportHeight = height
            viewportDensity = density
            ensureBuffer(width, height)
            if (engineHandle == 0L) {
                bootPendingBundleOnEngineThread()
            } else {
                SoftnNative.nativeResize(engineHandle, width, height, density)
                renderCurrentFrame()
            }
        }
    }

    private fun bootPendingBundle() {
        engineHandler.post { bootPendingBundleOnEngineThread() }
    }

    private fun bootPendingBundleOnEngineThread() {
        if (destroyed.get()) return
        val pending = pendingBundle ?: return
        val w = viewportWidth
        val h = viewportHeight
        val d = viewportDensity
        if (w <= 0 || h <= 0) return
        pendingBundle = null
        val bytes = pending.bytes
        val grantedCaps = pending.grantedCapabilities

        val gen = engineGeneration.incrementAndGet()
        deviceBridge.reset(gen)
        if (engineHandle != 0L) {
            SoftnNative.nativeDestroy(engineHandle)
            engineHandle = 0L
        }
        val dataDir = File(filesDir, "softn_apps").apply { mkdirs() }.absolutePath
        val deviceInfoJson = deviceBridge.buildHostDeviceInfoJson(
            playerMode = isPlayerMode,
            grantedCapabilities = grantedCaps
        )
        val handle = SoftnNative.nativeCreate(
            bytes,
            dataDir,
            w,
            h,
            d,
            deviceInfoJson
        )
        if (handle == 0L) {
            // The previous app's engine was destroyed above, whatever this one does.
            mainHandler.post { reportBundleFailure("Failed to load SoftN bundle (see logcat)") }
            return
        }
        if (destroyed.get()) {
            SoftnNative.nativeDestroy(handle)
            return
        }
        engineHandle = handle
        currentGrantedCapabilities = grantedCaps
        val info = SoftnNative.nativeGetBundleInfo(handle)
        currentBundleInfoJson = info
        Log.i("SoftN", "Loaded bundle info: $info")
        val infoObj = try { JSONObject(info) } catch (_: Throwable) { JSONObject() }
        hasInteractiveCanvas = infoObj.optBoolean("hasCanvas", true)
        if (isPlayerMode) {
            val appName = infoObj.optString("name", "SoftN App")
            mainHandler.post {
                playerTitleView.text = appName
                playerTopBar.visibility = View.VISIBLE
            }
        }
        renderCurrentFrame()
        val initialPending = SoftnNative.nativeDrainPendingCalls(handle)
        deviceBridge.executePendingCallsJson(initialPending, gen)
        // Run one settle tick right after boot so wantsRaf / nextTimerMs reflect the live app state.
        val settleJson = SoftnNative.nativeTick(handle)
        handleInteractionJson(settleJson, gen)
    }

    private fun ensureBuffer(width: Int, height: Int): ByteBuffer {
        val needed = width * height * 4
        val existing = rgbaBuffer
        if (existing != null && existing.capacity() == needed) {
            return existing
        }
        return ByteBuffer.allocateDirect(needed).also { rgbaBuffer = it }
    }

    private fun renderCurrentFrame() {
        val handle = engineHandle
        val w = viewportWidth
        val h = viewportHeight
        if (handle == 0L || w <= 0 || h <= 0) return
        val buf = ensureBuffer(w, h)
        if (SoftnNative.nativeRender(handle, buf)) {
            surfaceView.presentRgbaBuffer(buf, w, h)
        } else {
            Log.w("SoftN", "nativeRender returned false for ${w}x${h} (cap=${buf.capacity()})")
        }
    }

    private fun dispatchTap(x: Float, y: Float) {
        if (destroyed.get()) return
        engineHandler.post {
            val h = engineHandle
            if (h == 0L || destroyed.get()) return@post
            val resJson = SoftnNative.nativeTap(h, x, y)
            handleInteractionJson(resJson)
        }
    }

    /**
     * Coalesces rapid touch-move and fling scroll deltas so fast drags never backlog
     * `engineHandler` with stale full-screen repaints.
     */
    private fun dispatchScroll(deltaX: Float, deltaY: Float) {
        if (destroyed.get()) return
        synchronized(scrollLock) {
            pendingScrollX += deltaX
            pendingScrollY += deltaY
        }
        if (!scrollInFlight.compareAndSet(false, true)) return
        engineHandler.post {
            try {
                while (!destroyed.get()) {
                    val dx: Float
                    val dy: Float
                    synchronized(scrollLock) {
                        dx = pendingScrollX
                        dy = pendingScrollY
                        pendingScrollX = 0f
                        pendingScrollY = 0f
                    }
                    if (kotlin.math.abs(dx) < 0.01f && kotlin.math.abs(dy) < 0.01f) break
                    val h = engineHandle
                    if (h == 0L) break
                    if (SoftnNative.scroll2D(h, dx, dy)) {
                        renderCurrentFrame()
                    }
                }
            } finally {
                scrollInFlight.set(false)
                val morePending = synchronized(scrollLock) {
                    kotlin.math.abs(pendingScrollX) >= 0.01f || kotlin.math.abs(pendingScrollY) >= 0.01f
                }
                if (morePending && !destroyed.get()) {
                    dispatchScroll(0f, 0f)
                }
            }
        }
    }

    /**
     * Coalesces rapid IME keystrokes so fast typing renders only the latest string
     * instead of queuing redundant full DOM rebuilds.
     */
    private fun dispatchTextInput(text: String) {
        if (destroyed.get()) return
        latestImeText = text
        hasQueuedImeText.set(true)
        if (!imeInputInFlight.compareAndSet(false, true)) return
        engineHandler.post {
            try {
                while (hasQueuedImeText.getAndSet(false)) {
                    val h = engineHandle
                    if (h == 0L || destroyed.get()) break
                    val res = SoftnNative.nativeTextInput(h, latestImeText)
                    handleInteractionJson(res)
                }
            } finally {
                imeInputInFlight.set(false)
                if (hasQueuedImeText.get() && !destroyed.get()) {
                    dispatchTextInput(latestImeText)
                }
            }
        }
    }

    private fun dispatchPointerDown(x: Float, y: Float): Boolean {
        val handle = engineHandle
        if (handle == 0L || destroyed.get()) return false
        // Fast path for non-canvas apps (buttons, cards, lists, forms): NEVER block Android's
        // UI thread with a synchronous CountDownLatch! Still record the touch anchor
        // asynchronously so nested overflow containers scroll under the exact finger position.
        if (!hasInteractiveCanvas) {
            engineHandler.post {
                val h = engineHandle
                if (h != 0L && !destroyed.get()) {
                    SoftnNative.nativePointerDown(h, x, y)
                }
            }
            return false
        }
        val latch = CountDownLatch(1)
        val captured = AtomicBoolean(false)
        val timedOut = AtomicBoolean(false)
        engineHandler.post {
            try {
                val h = engineHandle
                if (h != 0L && !destroyed.get()) {
                    val didCapture = SoftnNative.nativePointerDown(h, x, y)
                    if (timedOut.get()) {
                        if (didCapture) {
                            SoftnNative.nativePointerUp(h, x, y)
                        }
                    } else {
                        captured.set(didCapture)
                    }
                }
            } finally {
                latch.countDown()
            }
        }
        val finished = try {
            latch.await(16L, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            false
        }
        if (!finished) {
            timedOut.set(true)
            return false
        }
        return captured.get()
    }

    private fun dispatchPointerMove(x: Float, y: Float) {
        latestMoveX = x
        latestMoveY = y
        hasQueuedMove.set(true)
        if (!pointerMoveInFlight.compareAndSet(false, true)) return
        engineHandler.post {
            try {
                while (hasQueuedMove.getAndSet(false)) {
                    if (engineHandle == 0L) break
                    val mx = latestMoveX
                    val my = latestMoveY
                    val resJson = SoftnNative.nativePointerMove(engineHandle, mx, my)
                    handleInteractionJson(resJson)
                }
            } finally {
                pointerMoveInFlight.set(false)
                if (hasQueuedMove.get()) {
                    dispatchPointerMove(latestMoveX, latestMoveY)
                }
            }
        }
    }

    private fun dispatchPointerUp(x: Float, y: Float) {
        engineHandler.post {
            if (engineHandle == 0L) return@post
            val resJson = SoftnNative.nativePointerUp(engineHandle, x, y)
            handleInteractionJson(resJson)
        }
    }

    private fun handleInteractionJson(resJson: String, gen: Long = engineGeneration.get()) {
        if (resJson.isBlank() || resJson == "{}" || engineGeneration.get() != gen) return
        val obj = try {
            JSONObject(resJson)
        } catch (_: Throwable) {
            return
        }
        val prevWantsRaf = wantsRaf
        val prevNextTimer = nextTimerMs
        wantsRaf = obj.optBoolean("wants_raf", wantsRaf)
        if (obj.has("has_canvas")) {
            hasInteractiveCanvas = obj.optBoolean("has_canvas", hasInteractiveCanvas)
        }
        nextTimerMs = if (obj.has("next_timer_ms")) {
            obj.optLong("next_timer_ms", -1L)
        } else {
            120L
        }
        val needsReschedule = (wantsRaf && !prevWantsRaf) ||
            (!wantsRaf && nextTimerMs >= 0L && (prevNextTimer < 0L || nextTimerMs < prevNextTimer))
        if (needsReschedule) {
            mainHandler.post { scheduleNextTick() }
        }
        if (obj.optBoolean("dirty", false)) {
            renderCurrentFrame()
        }
        val pending = obj.optJSONArray("pending_calls")
        if (pending != null && pending.length() > 0) {
            deviceBridge.executePendingCallsJson(pending.toString(), gen)
        }
        val selectObj = obj.optJSONObject("select_picker")
        if (selectObj != null) {
            val flid = selectObj.optInt("flid", -1)
            val selIdx = selectObj.optInt("selected_index", 0)
            val optsArr = selectObj.optJSONArray("options")
            if (flid >= 0 && optsArr != null && optsArr.length() > 0) {
                val labels = Array(optsArr.length()) { i -> optsArr.optString(i, "") }
                mainHandler.post {
                    if (isFinishing || isDestroyed || engineGeneration.get() != gen) return@post
                    AlertDialog.Builder(this)
                        .setSingleChoiceItems(labels, selIdx) { dialog, which ->
                            dialog.dismiss()
                            engineHandler.post {
                                if (engineHandle == 0L || destroyed.get() || engineGeneration.get() != gen) return@post
                                val res = SoftnNative.nativeSelectOption(engineHandle, flid, which)
                                handleInteractionJson(res, gen)
                            }
                        }
                        .setNegativeButton("Cancel", null)
                        .show()
                }
            }
        }
        if (obj.optBoolean("ime_changed", false)) {
            val wantsIme = obj.optBoolean("wants_ime", false)
            val inputText = obj.optString("input_text", "")
            val inputType = obj.optString("input_type", "text")
            mainHandler.post {
                if (wantsIme) {
                    showIme(inputText, inputType)
                } else if (imeBar.visibility == View.VISIBLE) {
                    hideIme()
                }
            }
        }
    }

    private fun showIme(currentText: String, fieldType: String) {
        suppressImeWatcher = true
        val lowerType = fieldType.lowercase()
        val isMultiline = lowerType == "textarea"
        imeEditText.isSingleLine = !isMultiline
        imeEditText.maxLines = if (isMultiline) 4 else 1
        imeEditText.imeOptions = when (lowerType) {
            "textarea" -> EditorInfo.IME_ACTION_NONE
            "search" -> EditorInfo.IME_ACTION_SEARCH
            else -> EditorInfo.IME_ACTION_DONE
        }
        imeEditText.inputType = when (lowerType) {
            "textarea" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            "password" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            "email" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
            "number" -> InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or InputType.TYPE_NUMBER_FLAG_SIGNED
            "tel" -> InputType.TYPE_CLASS_PHONE
            "url" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            else -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        }
        imeBar.visibility = View.VISIBLE
        if (imeEditText.text.toString() != currentText) {
            imeEditText.setText(currentText)
            imeEditText.setSelection(currentText.length)
        }
        suppressImeWatcher = false
        imeEditText.requestFocus()
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.showSoftInput(imeEditText, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun hideIme() {
        imeBar.visibility = View.GONE
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.hideSoftInputFromWindow(imeEditText.windowToken, 0)
    }

    private fun submitAndHideIme() {
        hideIme()
        engineHandler.post {
            val h = engineHandle
            if (h == 0L || destroyed.get()) return@post
            val res = SoftnNative.nativeSubmitIme(h)
            handleInteractionJson(res)
        }
    }

    override fun onResume() {
        super.onResume()
        tickerRunning = true
        scheduleNextTick()
    }

    override fun onPause() {
        super.onPause()
        tickerRunning = false
        mainHandler.removeCallbacks(idleTickRunnable)
        if (frameCallbackPosted.getAndSet(false)) {
            Choreographer.getInstance().removeFrameCallback(vsyncCallback)
        }
    }

    override fun onDestroy() {
        destroyed.set(true)
        super.onDestroy()
        tickerRunning = false
        if (frameCallbackPosted.getAndSet(false)) {
            Choreographer.getInstance().removeFrameCallback(vsyncCallback)
        }
        mainHandler.removeCallbacksAndMessages(null)
        deviceBridge.close()
        bundleIoExecutor.shutdownNow()
        surfaceView.release()
        engineHandler.post {
            val h = engineHandle
            engineHandle = 0L
            if (h != 0L) {
                SoftnNative.nativeDestroy(h)
            }
            engineLooper?.quitSafely()
        }
    }
}
