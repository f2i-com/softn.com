#!/usr/bin/env node
/**
 * SoftN Standalone Android APK Packager (`softn-pack-android`)
 *
 * Packages any `.softn` v2 Web App Container (static OR full-stack PHP/JS/TS/Python/Rust + SQLite)
 * into a standalone installable Android `.apk` powered by `zipp-browser` + `zipp-vm`:
 *
 *   1. Inspects `manifest.json` & `permission.json` inside the `.softn` archive
 *   2. Generates a least-privilege `AndroidManifest.xml` containing ONLY Android permissions
 *      matching the capabilities declared in `permission.json` (zero-egress apps omit INTERNET!)
 *   3. Embeds the `.softn` archive into `assets/app.softn`
 *   4. Downloads & embeds prebuilt `libsoftn_mobile.so` from the latest `zipp-browser`
 *      GitHub Release (cached in `.zipp-browser-release/`, zero Rust/NDK required!),
 *      or cross-compiles locally when `--build-local` is passed
 *   5. Runs Gradle to build a signed standalone `.apk` with its own `applicationId` and launcher label
 *
 * Usage:
 *   node apps/softn-android/scripts/pack-apk.mjs <path/to/app.softn> [options]
 *
 * Options:
 *   --out <file.apk>        Output APK path (default: dist-apk/<slug>.apk)
 *   --abi <abi>             Target ABI: x86_64 | arm64-v8a | all (default: x86_64)
 *   --package <id>          Override Android applicationId (default: com.softn.app.<slug>)
 *   --mode <debug|release>  Gradle build variant (default: debug)
 *   --webview-tag <tag>     Pin a specific `f2i-com/zipp-browser` release tag for prebuilt WebView `.so`
 *   --webview-zip <file>    Embed prebuilt `zipp-browser-*-android-webview.zip` from a local file
 *   --build-local           Cross-compile `rust/` locally with Android NDK instead of downloading prebuilt release
 *   --skip-rust             Reuse already-staged jniLibs/*.so without downloading or invoking cargo
 *   --player                Build the generic SoftN Mobile Player APK (no embedded bundle)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { ensureAndroidWebView } from './fetch-zipp-webview.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANDROID_ROOT = path.resolve(HERE, '..');
const RUST_DIR = path.join(ANDROID_ROOT, 'rust');
const GRADLE_DIR = path.join(ANDROID_ROOT, 'android');
const JNI_LIBS_DIR = path.join(GRADLE_DIR, 'app', 'src', 'main', 'jniLibs');

const ABI_MAP = {
  x86_64: { rustTarget: 'x86_64-linux-android', clangPrefix: 'x86_64-linux-android26-clang' },
  'arm64-v8a': { rustTarget: 'aarch64-linux-android', clangPrefix: 'aarch64-linux-android26-clang' },
};

const ALLOWED_CAPABILITIES = new Set([
  'net',
  'camera',
  'mic',
  'files',
  'qr',
  'ai',
  'gpu',
  'sync',
  'storage',
  'accel',
  'bluetooth',
  'location',
  'haptics',
  'notifications',
  'clipboard',
]);
const MAX_BUNDLE_ZIP_BYTES = 128 * 1024 * 1024;
const MAX_META_ENTRY_BYTES = 1024 * 1024;
const MAX_BUNDLE_ENTRIES = 20_000;

export function validatePackageId(pkg) {
  if (typeof pkg !== 'string' || pkg.length > 128 || !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(pkg)) {
    throw new Error(`Invalid Android package ID: ${JSON.stringify(pkg)}`);
  }
  return pkg;
}

function sanitizeXmlComment(text) {
  return String(text || '')
    .replace(/[\x00-\x1f\x7f<>]/g, '')
    .replace(/-{2,}/g, '-')
    .trim();
}

function sanitizeAppName(raw, fallback) {
  const cleaned = String(raw || '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function sanitizeVersionName(raw) {
  const cleaned = String(raw || '')
    .replace(/[^a-zA-Z0-9._+-]/g, '')
    .slice(0, 64);
  return cleaned || '1.0.0';
}

export function parseArgs(argv) {
  const opts = {
    bundlePath: null,
    outPath: null,
    abi: 'x86_64',
    packageId: null,
    mode: 'debug',
    skipRust: false,
    buildLocal: false,
    webviewTag: null,
    webviewZip: null,
    player: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.outPath = argv[++i];
    else if (a === '--abi') opts.abi = argv[++i];
    else if (a === '--package') opts.packageId = argv[++i];
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--skip-rust') opts.skipRust = true;
    else if (a === '--build-local') opts.buildLocal = true;
    else if (a === '--webview-tag') opts.webviewTag = argv[++i];
    else if (a === '--webview-zip') opts.webviewZip = argv[++i];
    else if (a === '--player') opts.player = true;
    else if (!a.startsWith('-') && !opts.bundlePath) opts.bundlePath = a;
  }
  return opts;
}

function findJavaHome() {
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'))) {
    return process.env.JAVA_HOME;
  }
  const candidates = [
    'C:\\Program Files\\Android\\Android Studio\\jbr',
    'C:\\Program Files\\Java\\jdk-21',
    'C:\\Program Files\\Java\\jdk-17',
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return process.env.JAVA_HOME || '';
}

function findAndroidHome() {
  if (process.env.ANDROID_HOME && fs.existsSync(process.env.ANDROID_HOME)) return process.env.ANDROID_HOME;
  if (process.env.ANDROID_SDK_ROOT && fs.existsSync(process.env.ANDROID_SDK_ROOT)) return process.env.ANDROID_SDK_ROOT;
  const local = path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
  if (fs.existsSync(local)) return local;
  const mac = path.join(os.homedir(), 'Library', 'Android', 'sdk');
  if (fs.existsSync(mac)) return mac;
  throw new Error('ANDROID_HOME is not set and Android SDK was not found');
}

function findNdkBin(androidHome) {
  const ndkRoot = path.join(androidHome, 'ndk');
  if (!fs.existsSync(ndkRoot)) throw new Error(`No Android NDK found under ${ndkRoot}`);
  const versions = fs.readdirSync(ndkRoot).sort().reverse();
  const preferred = versions.find((v) => v.startsWith('27.')) || versions[0];
  if (!preferred) throw new Error(`No NDK version directory found in ${ndkRoot}`);
  const hostTag = process.platform === 'win32' ? 'windows-x86_64' : process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
  return path.join(ndkRoot, preferred, 'toolchains', 'llvm', 'prebuilt', hostTag, 'bin');
}

function findGradleBin() {
  const wrapperBase = path.join(os.homedir(), '.gradle', 'wrapper', 'dists');
  if (fs.existsSync(wrapperBase)) {
    const dists = fs.readdirSync(wrapperBase).sort().reverse();
    for (const dist of dists) {
      const distDir = path.join(wrapperBase, dist);
      if (!fs.statSync(distDir).isDirectory()) continue;
      for (const hashDir of fs.readdirSync(distDir)) {
        const sub = path.join(distDir, hashDir);
        if (!fs.statSync(sub).isDirectory()) continue;
        for (const inner of fs.readdirSync(sub)) {
          const bin = path.join(sub, inner, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle');
          if (fs.existsSync(bin)) return bin;
        }
      }
    }
  }
  return process.platform === 'win32' ? 'gradle.bat' : 'gradle';
}

function inspectSoftnBundle(bundleBytes, fallbackName) {
  if (bundleBytes.byteLength > MAX_BUNDLE_ZIP_BYTES) {
    throw new Error(`Bundle exceeds ${MAX_BUNDLE_ZIP_BYTES / (1024 * 1024)} MB limit`);
  }
  let entryCount = 0;
  const entries = unzipSync(bundleBytes, {
    filter(file) {
      entryCount++;
      if (entryCount > MAX_BUNDLE_ENTRIES) {
        throw new Error(`Bundle exceeds maximum entry count (${MAX_BUNDLE_ENTRIES})`);
      }
      if (file.name !== 'manifest.json' && file.name !== 'permission.json') {
        return false;
      }
      if (file.originalSize > MAX_META_ENTRY_BYTES) {
        throw new Error(`Bundle metadata entry '${file.name}' exceeds 1 MiB limit`);
      }
      return true;
    },
  });
  let manifest = {};
  if (entries['manifest.json']) {
    if (entries['manifest.json'].byteLength > MAX_META_ENTRY_BYTES) {
      throw new Error(`Bundle metadata entry 'manifest.json' exceeds 1 MiB limit after decompression`);
    }
    try {
      manifest = JSON.parse(strFromU8(entries['manifest.json']));
    } catch {
      manifest = {};
    }
  }
  let permissions = {};
  if (entries['permission.json']) {
    if (entries['permission.json'].byteLength > MAX_META_ENTRY_BYTES) {
      throw new Error(`Bundle metadata entry 'permission.json' exceeds 1 MiB limit after decompression`);
    }
    try {
      permissions = JSON.parse(strFromU8(entries['permission.json']))?.permissions || {};
    } catch {
      permissions = {};
    }
  }
  const enabledCaps = Object.entries(permissions)
    .filter(([name, cfg]) => ALLOWED_CAPABILITIES.has(name) && cfg && typeof cfg === 'object' && cfg.enabled === true)
    .map(([name]) => name);

  const name = sanitizeAppName(typeof manifest.name === 'string' ? manifest.name : '', fallbackName);
  const version = sanitizeVersionName(typeof manifest.version === 'string' ? manifest.version : '');
  const rawId = (typeof manifest.id === 'string' && manifest.id.trim()) || fallbackName;
  const slug = rawId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'app_$1') || 'softn_app';

  return {
    name,
    version,
    slug,
    manifest,
    capabilities: enabledCaps,
  };
}

/**
 * Generates a least-privilege AndroidManifest.xml declaring ONLY the Android
 * permissions required by the `.softn` bundle's `permission.json`.
 */
export function generateLeastPrivilegeManifest(capabilities) {
  const safeCaps = Array.from(
    new Set(
      (Array.isArray(capabilities) ? capabilities : [])
        .filter((c) => typeof c === 'string' && ALLOWED_CAPABILITIES.has(c))
    )
  );
  const capSet = new Set(safeCaps);
  const perms = [];
  const features = [];

  if (capSet.has('net') || capSet.has('sync')) {
    perms.push('    <uses-permission android:name="android.permission.INTERNET" />');
  }
  if (capSet.has('camera') || capSet.has('qr')) {
    perms.push('    <uses-permission android:name="android.permission.CAMERA" />');
    features.push('    <uses-feature android:name="android.hardware.camera" android:required="false" />');
  }
  if (capSet.has('mic')) {
    perms.push('    <uses-permission android:name="android.permission.RECORD_AUDIO" />');
    features.push('    <uses-feature android:name="android.hardware.microphone" android:required="false" />');
  }
  if (capSet.has('accel')) {
    features.push('    <uses-feature android:name="android.hardware.sensor.accelerometer" android:required="false" />');
  }
  if (capSet.has('haptics')) {
    perms.push('    <uses-permission android:name="android.permission.VIBRATE" />');
  }
  if (capSet.has('location')) {
    perms.push('    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />');
    perms.push('    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />');
    features.push('    <uses-feature android:name="android.hardware.location.gps" android:required="false" />');
  }
  if (capSet.has('notifications')) {
    perms.push('    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />');
  }
  if (capSet.has('bluetooth')) {
    perms.push('    <uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />');
    perms.push('    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />');
    perms.push('    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />');
    perms.push('    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />');
    features.push('    <uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />');
  }

  const commentList = safeCaps.length
    ? sanitizeXmlComment(safeCaps.join(', '))
    : '(none — offline zero-egress)';

  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <!-- Auto-generated least-privilege manifest from SoftN permission.json -->
    <!-- Declared SoftN capabilities: ${commentList} -->
${perms.join('\n')}
${features.join('\n')}

    <application
        android:allowBackup="false"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@style/Theme.SoftN"
        android:usesCleartextTraffic="false">

        <activity
            android:name="com.softn.android.MainActivity"
            android:configChanges="orientation|screenSize|screenLayout|keyboardHidden|uiMode"
            android:exported="true"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths" />
        </provider>
    </application>
</manifest>
`;
}

function buildRustNativeLib(abi, androidHome) {
  const spec = ABI_MAP[abi];
  if (!spec) throw new Error(`Unsupported ABI: ${abi}`);
  const ndkBin = findNdkBin(androidHome);
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const arExt = process.platform === 'win32' ? '.exe' : '';
  const cc = path.join(ndkBin, `${spec.clangPrefix}${ext}`);
  const ar = path.join(ndkBin, `llvm-ar${arExt}`);
  const targetEnvKey = spec.rustTarget.replace(/-/g, '_');
  const upperKey = targetEnvKey.toUpperCase();

  const env = {
    ...process.env,
    [`CC_${targetEnvKey}`]: cc,
    [`AR_${targetEnvKey}`]: ar,
    [`CARGO_TARGET_${upperKey}_LINKER`]: cc,
  };

  console.log(`[softn-apk] Building libsoftn_mobile.so for ${abi} (${spec.rustTarget})...`);
  execFileSync(
    'cargo',
    ['build', '--release', '--manifest-path', path.join(RUST_DIR, 'Cargo.toml'), '--target', spec.rustTarget],
    { env, stdio: 'inherit' }
  );

  const builtSo = path.join(RUST_DIR, 'target', spec.rustTarget, 'release', 'libsoftn_mobile.so');
  if (!fs.existsSync(builtSo)) {
    throw new Error(`Expected built native library at ${builtSo}`);
  }
  const destDir = path.join(JNI_LIBS_DIR, abi);
  fs.mkdirSync(destDir, { recursive: true });
  const destSo = path.join(destDir, 'libsoftn_mobile.so');
  fs.copyFileSync(builtSo, destSo);
  const sizeMb = (fs.statSync(destSo).size / (1024 * 1024)).toFixed(2);
  console.log(`[softn-apk] Staged ${destSo} (${sizeMb} MB)`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.player && !opts.bundlePath) {
    console.error(
      'Usage: node apps/softn-android/scripts/pack-apk.mjs <app.softn> [--out app.apk] [--abi x86_64|arm64-v8a|all] [--package com.example.app] [--webview-tag vX.Y.Z] [--webview-zip file.zip] [--build-local]'
    );
    process.exit(1);
  }

  const androidHome = findAndroidHome();
  const javaHome = findJavaHome();
  const gradleBin = findGradleBin();

  const abis = opts.abi === 'all' ? Object.keys(ABI_MAP) : [opts.abi];
  if (opts.buildLocal) {
    for (const abi of abis) {
      buildRustNativeLib(abi, androidHome);
    }
  } else if (opts.skipRust) {
    // Still copy any freshly built .so from cargo target if present
    for (const abi of abis) {
      const spec = ABI_MAP[abi];
      const builtSo = path.join(RUST_DIR, 'target', spec.rustTarget, 'release', 'libsoftn_mobile.so');
      if (fs.existsSync(builtSo)) {
        const destDir = path.join(JNI_LIBS_DIR, abi);
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(builtSo, path.join(destDir, 'libsoftn_mobile.so'));
      }
    }
  } else {
    // Default fast path: download/cache prebuilt Android WebView `.so` binaries
    // from `f2i-com/zipp-browser` releases (zero Rust / NDK rebuild!).
    await ensureAndroidWebView({
      abis,
      tag: opts.webviewTag,
      localZip: opts.webviewZip,
      jniLibsDir: JNI_LIBS_DIR,
    });
  }

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-apk-stage-'));
  try {
    let appName = 'SoftN Player';
    let appId = validatePackageId(opts.packageId || 'com.softn.player');
    let versionName = '1.0.0';
    let slug = 'softn-player';
    let manifestPath = '';
    let stageAssets = '';

    if (!opts.player) {
      const absBundle = path.resolve(opts.bundlePath);
      const bundleBytes = new Uint8Array(fs.readFileSync(absBundle));
      const fallbackName = path.basename(absBundle, '.softn');
      const info = inspectSoftnBundle(bundleBytes, fallbackName);
      appName = info.name;
      versionName = info.version;
      slug = info.slug;
      appId = validatePackageId(opts.packageId || `com.softn.app.${info.slug}`);

      stageAssets = path.join(stageDir, 'assets');
      fs.mkdirSync(stageAssets, { recursive: true });
      fs.copyFileSync(absBundle, path.join(stageAssets, 'app.softn'));

      const manifestXml = generateLeastPrivilegeManifest(info.capabilities);
      manifestPath = path.join(stageDir, 'AndroidManifest.xml');
      fs.writeFileSync(manifestPath, manifestXml, 'utf8');

      console.log(`[softn-apk] App: ${appName} (${appId} v${versionName})`);
      console.log(`[softn-apk] Capabilities: ${info.capabilities.length ? info.capabilities.join(', ') : '(zero-egress offline)'}`);
      if (info.manifest.backend) {
        console.log(`[softn-apk] Embedded Full-Stack Backend: ${info.manifest.backend.runtime} (${info.manifest.backend.entry})`);
      }
    }

    const task = opts.mode === 'release' ? 'assembleRelease' : 'assembleDebug';
    const env = {
      ...process.env,
      ANDROID_HOME: androidHome,
      ANDROID_SDK_ROOT: androidHome,
      ...(javaHome ? { JAVA_HOME: javaHome } : {}),
      SOFTN_APP_ID: appId,
      SOFTN_APP_NAME: appName,
      SOFTN_VERSION_NAME: versionName,
      SOFTN_VERSION_CODE: '1',
      ...(manifestPath ? { SOFTN_MANIFEST_FILE: manifestPath } : {}),
      ...(stageAssets ? { SOFTN_ASSETS_DIR: stageAssets } : {}),
    };

    console.log(`[softn-apk] Running Gradle ${task}...`);
    if (process.platform === 'win32') {
      execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', gradleBin, task, '--no-daemon'], {
        cwd: GRADLE_DIR,
        env,
        stdio: 'inherit',
      });
    } else {
      execFileSync(gradleBin, [task, '--no-daemon'], {
        cwd: GRADLE_DIR,
        env,
        stdio: 'inherit',
      });
    }

    const apkName = opts.mode === 'release' ? 'app-release.apk' : 'app-debug.apk';
    const builtApk = path.join(GRADLE_DIR, 'app', 'build', 'outputs', 'apk', opts.mode, apkName);
    if (!fs.existsSync(builtApk)) {
      throw new Error(`Expected APK not found at ${builtApk}`);
    }

    const outPath = path.resolve(opts.outPath || path.join(ANDROID_ROOT, 'dist-apk', `${slug}.apk`));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(builtApk, outPath);
    const apkMb = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2);
    console.log(`[softn-apk] Built standalone APK: ${outPath} (${apkMb} MB)`);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[softn-apk] ERROR: ${err.message}`);
    process.exit(1);
  });
}
