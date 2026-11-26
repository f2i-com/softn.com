import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { generateLeastPrivilegeManifest, parseArgs, validatePackageId } from './pack-apk.mjs';
import {
  ensureAndroidWebView,
  extractVerifiedAndroidWebView,
  validateAbis,
  validateReleaseTag,
} from './fetch-zipp-webview.mjs';

test('zero-capability offline bundle omits INTERNET and all hardware permissions', () => {
  const xml = generateLeastPrivilegeManifest([]);
  assert.doesNotMatch(xml, /android\.permission\.INTERNET/);
  assert.doesNotMatch(xml, /android\.permission\.CAMERA/);
  assert.doesNotMatch(xml, /android\.permission\.BLUETOOTH/);
  assert.doesNotMatch(xml, /android\.permission\.ACCESS_FINE_LOCATION/);
  assert.match(xml, /offline zero-egress/);
});

test('camera + bluetooth + haptics bundle includes only declared Android permissions', () => {
  const xml = generateLeastPrivilegeManifest(['camera', 'bluetooth', 'haptics']);
  assert.doesNotMatch(xml, /android\.permission\.INTERNET/);
  assert.match(xml, /android\.permission\.CAMERA/);
  assert.match(xml, /android\.permission\.BLUETOOTH_SCAN/);
  assert.match(xml, /android\.permission\.BLUETOOTH_CONNECT/);
  assert.match(xml, /android\.permission\.VIBRATE/);
  assert.doesNotMatch(xml, /android\.permission\.ACCESS_FINE_LOCATION/);
  assert.doesNotMatch(xml, /android\.permission\.POST_NOTIFICATIONS/);
});

test('net capability adds INTERNET permission', () => {
  const xml = generateLeastPrivilegeManifest(['net', 'location', 'notifications']);
  assert.match(xml, /android\.permission\.INTERNET/);
  assert.match(xml, /android\.permission\.ACCESS_FINE_LOCATION/);
  assert.match(xml, /android\.permission\.POST_NOTIFICATIONS/);
});

test('mic, accel, and files capabilities generate least-privilege manifest entries', () => {
  const xml = generateLeastPrivilegeManifest(['mic', 'accel', 'files']);
  assert.match(xml, /android\.permission\.RECORD_AUDIO/);
  assert.match(xml, /android\.hardware\.microphone/);
  assert.match(xml, /android\.hardware\.sensor\.accelerometer/);
  assert.doesNotMatch(xml, /READ_EXTERNAL_STORAGE/);
  assert.doesNotMatch(xml, /android\.permission\.INTERNET/);
});

test('a resize, fold or keyboard attach does not recreate the activity (and restart the app)', () => {
  // Activity recreation boots the bundle again from scratch: nothing in memory survives.
  const configChanges = (xml) => xml.match(/android:configChanges="([^"]*)"/)?.[1].split('|') ?? [];
  const packed = configChanges(generateLeastPrivilegeManifest(['net']));
  const player = configChanges(
    fs.readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8')
  );
  for (const handled of [packed, player]) {
    for (const change of ['orientation', 'screenSize', 'smallestScreenSize', 'screenLayout', 'keyboard', 'keyboardHidden', 'uiMode']) {
      assert.ok(handled.includes(change), `${change} missing from configChanges: ${handled.join('|')}`);
    }
  }
});

test('parseArgs supports prebuilt webview flags and --build-local opt-in', () => {
  const def = parseArgs(['app.softn']);
  assert.equal(def.buildLocal, false);
  assert.equal(def.webviewTag, null);
  assert.equal(def.webviewZip, null);

  const custom = parseArgs([
    'app.softn',
    '--abi',
    'all',
    '--webview-tag',
    'v0.1.2',
    '--webview-zip',
    'out/android-webview.zip',
    '--build-local',
  ]);
  assert.equal(custom.abi, 'all');
  assert.equal(custom.webviewTag, 'v0.1.2');
  assert.equal(custom.webviewZip, 'out/android-webview.zip');
  assert.equal(custom.buildLocal, true);
});

test('extractVerifiedAndroidWebView verifies SHA-256 and stages jniLibs without Rust/NDK', () => {
  const armBytes = Buffer.from('ELF-arm64-prebuilt-webview-bytes');
  const x64Bytes = Buffer.from('ELF-x86_64-prebuilt-webview-bytes');
  const armSha = crypto.createHash('sha256').update(armBytes).digest('hex');
  const x64Sha = crypto.createHash('sha256').update(x64Bytes).digest('hex');

  const goodZip = zipSync({
    'jniLibs/arm64-v8a/libsoftn_mobile.so': armBytes,
    'jniLibs/x86_64/libsoftn_mobile.so': x64Bytes,
    'SHA256SUMS.txt': strToU8(
      `${armSha}  jniLibs/arm64-v8a/libsoftn_mobile.so\n${x64Sha}  jniLibs/x86_64/libsoftn_mobile.so\n`
    ),
    'manifest.json': strToU8(
      JSON.stringify({
        schema: 1,
        tag: 'v0.1.2',
        zipp_release: 'v0.0.40',
        abis: ['arm64-v8a', 'x86_64'],
      })
    ),
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-webview-test-'));
  try {
    const res = extractVerifiedAndroidWebView(goodZip, {
      abis: ['arm64-v8a', 'x86_64'],
      jniLibsDir: tmpDir,
    });
    assert.equal(res.staged.length, 2);
    assert.deepEqual(fs.readFileSync(path.join(tmpDir, 'arm64-v8a', 'libsoftn_mobile.so')), armBytes);
    assert.deepEqual(fs.readFileSync(path.join(tmpDir, 'x86_64', 'libsoftn_mobile.so')), x64Bytes);

    // Tampered archive must be rejected.
    const badZip = zipSync({
      'jniLibs/x86_64/libsoftn_mobile.so': Buffer.from('tampered-bytes'),
      'SHA256SUMS.txt': strToU8(`${x64Sha}  jniLibs/x86_64/libsoftn_mobile.so\n`),
    });
    assert.throws(
      () => extractVerifiedAndroidWebView(badZip, { abis: ['x86_64'], jniLibsDir: tmpDir }),
      /SHA-256 mismatch/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ensureAndroidWebView falls back to verified cached archive when GitHub is unreachable', async () => {
  const x64Bytes = Buffer.from('ELF-x86_64-cached-fallback-bytes');
  const x64Sha = crypto.createHash('sha256').update(x64Bytes).digest('hex');
  const cachedZip = zipSync({
    'jniLibs/x86_64/libsoftn_mobile.so': x64Bytes,
    'SHA256SUMS.txt': strToU8(`${x64Sha}  jniLibs/x86_64/libsoftn_mobile.so\n`),
    'manifest.json': strToU8(JSON.stringify({ schema: 1, tag: 'v0.1.2', abis: ['x86_64'] })),
  });
  const cachedZipSha = crypto.createHash('sha256').update(cachedZip).digest('hex');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-webview-fallback-'));
  try {
    const cacheDir = path.join(tmpRoot, 'cache', 'v0.1.2');
    const jniLibsDir = path.join(tmpRoot, 'jniLibs');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'zipp-browser-v0.1.2-android-webview.zip'), cachedZip);

    const offlineFetch = async () => ({ ok: false, status: 403 });
    // Missing SHA256SUMS.txt in cache must fail closed.
    await assert.rejects(
      () =>
        ensureAndroidWebView({
          abis: ['x86_64'],
          cacheRoot: path.join(tmpRoot, 'cache'),
          jniLibsDir,
          fetchImpl: offlineFetch,
        }),
      /missing SHA256SUMS\.txt/
    );

    fs.writeFileSync(
      path.join(cacheDir, 'SHA256SUMS.txt'),
      `${cachedZipSha}  zipp-browser-v0.1.2-android-webview.zip\n`
    );
    const res = await ensureAndroidWebView({
      abis: ['x86_64'],
      cacheRoot: path.join(tmpRoot, 'cache'),
      jniLibsDir,
      fetchImpl: offlineFetch,
    });
    assert.equal(res.staged.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(jniLibsDir, 'x86_64', 'libsoftn_mobile.so')), x64Bytes);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('manifest generator blocks XML comment injection, enforces cleartext=false, and validates package/tag/ABI', async () => {
  const xml = generateLeastPrivilegeManifest([
    'net',
    'evil --><uses-permission android:name="android.permission.READ_SMS" /><!--',
  ]);
  assert.doesNotMatch(xml, /READ_SMS/);
  assert.match(xml, /android:usesCleartextTraffic="false"/);
  assert.throws(() => validatePackageId('../evil.pkg'), /Invalid Android package ID/);
  assert.throws(() => validatePackageId('singleword'), /Invalid Android package ID/);
  assert.equal(validatePackageId('com.softn.app.demo_1'), 'com.softn.app.demo_1');
  assert.throws(() => validateReleaseTag('../../pwn'), /Invalid release tag/);
  assert.throws(() => validateAbis(['../../etc']), /Unsupported Android ABI/);

  // Remote GitHub release without SHA256SUMS.txt must fail closed.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-webview-failclosed-'));
  try {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        tag_name: 'v9.9.9',
        assets: [
          {
            name: 'zipp-browser-v9.9.9-android-webview.zip',
            browser_download_url: 'https://example.invalid/asset.zip',
          },
        ],
      }),
    });
    await assert.rejects(
      () =>
        ensureAndroidWebView({
          abis: ['x86_64'],
          tag: 'v9.9.9',
          cacheRoot: path.join(tmpRoot, 'cache'),
          jniLibsDir: path.join(tmpRoot, 'jniLibs'),
          fetchImpl: mockFetch,
        }),
      /missing SHA256SUMS\.txt/
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
