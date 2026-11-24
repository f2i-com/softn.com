# SoftN Android Mobile Harness (`apps/softn-android`)

Runs **SoftN v2 Web App Containers** — including **full-stack apps with embedded PHP 8, JS/TS, Python, or Rust backends and persistent SQLite 3** — as native Android APKs powered by **`zipp-browser`** (Stylo CSS + Taffy Flexbox/Grid + Parley/Skrifa + TinySkia) and **`zipp-vm`** (`safe-sandbox`), with **zero Android WebView dependency**.

The exact same `.softn` bundle runs unmodified on **Web** (`@softn/container`) and on **Android** (standalone `.apk` or Player mode).

## Architecture

- **`rust/` (`libsoftn_mobile.so`)**:
  - `.softn` ZIP archive loader + virtual origin (`https://app.softn.local/`) + native `permission.json` gatekeeper
  - Frontend JS/TS/React execution in `zipp-vm` + OXC AST ESM module linker (`softn:*` virtual modules)
  - Rendering via `zipp-browser` (`zipp-dom` + `zipp-renderer` TinySkia RGBA framebuffer)
  - Full-stack Container v2 in-process backend (`PHP 8`, `JS/TS`, `Python`, `Rust`) + persistent `rusqlite` SQLite 3 in Android `filesDir`
- **`android/` (Kotlin + Gradle)**:
  - `MainActivity.kt` + `SoftnSurfaceView.kt`: edge-to-edge native Canvas presentation, touch tap/scroll, synchronized Android soft keyboard (IME)
  - `DeviceBridge.kt`: capability-gated native Android bridges for **Camera**, **Bluetooth LE (scan/connect/read/write)**, **GPS Location**, **Haptics**, **Notifications**, **Share Sheet**, and **Clipboard**
- **`scripts/pack-apk.mjs`**:
  - Generates a **least-privilege `AndroidManifest.xml`** containing only the `<uses-permission>` entries declared in `permission.json` (offline apps omit `INTERNET` completely!)
  - Stamps `applicationId`, launcher name, version, and embedded `assets/app.softn` into a standalone installable `.apk`

## Packaging an Android APK

By default, `pack-apk.mjs` downloads and caches the prebuilt Android WebView
native libraries (`zipp-browser-<tag>-android-webview.zip`) from
`f2i-com/zipp-browser` releases and embeds `libsoftn_mobile.so` directly into
`jniLibs/` — **no Rust toolchain or Android NDK build required** for repeat APK builds.

```sh
# 1. Build the showcase full-stack mobile+web .softn bundle
node examples/mobile-fieldkit/build.mjs

# 2. Package it into a standalone Android APK using the prebuilt Zipp Browser Android WebView release
npm run android:pack -- examples/mobile-fieldkit/mobile-fieldkit.softn --abi x86_64

# Pin a specific Zipp Browser release or embed a local android-webview.zip archive:
npm run android:pack -- examples/mobile-fieldkit/mobile-fieldkit.softn --abi all --webview-tag v0.1.2
npm run android:pack -- examples/mobile-fieldkit/mobile-fieldkit.softn --abi all --webview-zip path/to/zipp-browser-v0.1.2-android-webview.zip

# Or opt in to cross-compiling the native Rust engine locally via Android NDK:
npm run android:pack -- examples/mobile-fieldkit/mobile-fieldkit.softn --abi x86_64 --build-local

# Or build the generic SoftN Mobile Player APK (opens any .softn file on device):
npm run android:player -- --abi arm64-v8a
```

## Testing

```sh
# Rust engine unit + full-stack integration tests (including opal-sales.softn)
cargo test --manifest-path apps/softn-android/rust/Cargo.toml
```
