import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Capability } from '@softn/bundle-format/capabilities';
import { mountSoftNContainer } from '../src/index';
import { dispatchDeviceBridgeCall, type ContainerDeviceBridge } from '../src/device-bridge';
import type { ContainerPermissions } from '../src/types';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..', '..');
const ENGINES_DIR = path.join(PKG_ROOT, 'dist', 'runtime', 'engines');

function makeMockBridge(): ContainerDeviceBridge {
  return {
    platform: 'android',
    engine: 'zipp-browser-android',
    getInfo: () => ({
      platform: 'android',
      engine: 'zipp-browser-android',
      osVersion: '16',
      model: 'Pixel Test',
      screenWidth: 412,
      screenHeight: 915,
      devicePixelRatio: 2.625,
    }),
    share: vi.fn(async () => ({ shared: true })),
    clipboardWrite: vi.fn(async () => ({ ok: true })),
    camera: {
      isAvailable: () => true,
      takePhoto: vi.fn(async () => ({
        dataUrl: 'data:image/jpeg;base64,AAAA',
        mimeType: 'image/jpeg',
        width: 640,
        height: 480,
        size: 3,
      })),
    },
    bluetooth: {
      isAvailable: () => true,
      scan: vi.fn(async () => ({
        devices: [{ id: 'AA:BB:CC:DD:EE:FF', name: 'SoftN Sensor', rssi: -52, services: ['180d'] }],
      })),
      connect: vi.fn(async (deviceId) => ({ connected: true, deviceId, services: ['180d'] })),
      disconnect: vi.fn(async (deviceId) => ({ disconnected: true, deviceId })),
      read: vi.fn(async () => ({ base64: 'SGVsbG8=', utf8: 'Hello' })),
      write: vi.fn(async () => ({ ok: true })),
    },
    location: {
      isAvailable: () => true,
      getCurrentPosition: vi.fn(async () => ({
        latitude: -33.8688,
        longitude: 151.2093,
        accuracy: 10,
        altitude: 25,
        timestamp: 1700000000000,
      })),
    },
    haptics: {
      isAvailable: () => true,
      impact: vi.fn(async () => ({ ok: true })),
      vibrate: vi.fn(async () => ({ ok: true })),
    },
    notifications: {
      isAvailable: () => true,
      notify: vi.fn(async ({ id }) => ({ ok: true, id: id ?? 1 })),
    },
  };
}

describe('Container Device Bridge', () => {
  it('allows device.getInfo and hardware isAvailable without elevated permissions', async () => {
    const bridge = makeMockBridge();
    const empty = new Set<Capability>();
    const perms: ContainerPermissions = {};

    const info = (await dispatchDeviceBridgeCall(bridge, 'device', 'getInfo', {}, empty, perms)) as Record<string, unknown>;
    expect(info.platform).toBe('android');
    expect(info.engine).toBe('zipp-browser-android');
    expect((info.capabilities as Record<string, boolean>).bluetooth).toBe(true);

    const bleAvail = (await dispatchDeviceBridgeCall(bridge, 'bluetooth', 'isAvailable', {}, empty, perms)) as {
      available: boolean;
      permitted: boolean;
    };
    expect(bleAvail).toEqual({ available: true, permitted: false });
  });

  it('denies camera, bluetooth, location, haptics, and notifications when not granted', async () => {
    const bridge = makeMockBridge();
    const empty = new Set<Capability>();
    const perms: ContainerPermissions = {};

    await expect(dispatchDeviceBridgeCall(bridge, 'camera', 'takePhoto', {}, empty, perms)).rejects.toThrow(/camera access is not granted/i);
    await expect(dispatchDeviceBridgeCall(bridge, 'bluetooth', 'scan', {}, empty, perms)).rejects.toThrow(/bluetooth access is not granted/i);
    await expect(dispatchDeviceBridgeCall(bridge, 'location', 'getCurrentPosition', {}, empty, perms)).rejects.toThrow(/location access is not granted/i);
    await expect(dispatchDeviceBridgeCall(bridge, 'haptics', 'impact', {}, empty, perms)).rejects.toThrow(/haptics access is not granted/i);
    await expect(dispatchDeviceBridgeCall(bridge, 'notifications', 'notify', { title: 'Hi' }, empty, perms)).rejects.toThrow(
      /notifications access is not granted/i
    );
  });

  it('enforces bluetooth.services allowlist when declared in permission.json', async () => {
    const bridge = makeMockBridge();
    const granted = new Set<Capability>(['bluetooth']);
    const perms: ContainerPermissions = {
      permissions: {
        bluetooth: { enabled: true, services: ['180d'] },
      },
    };

    const okScan = await dispatchDeviceBridgeCall(bridge, 'bluetooth', 'scan', { services: ['180D'] }, granted, perms);
    expect(okScan).toEqual({
      devices: [{ id: 'AA:BB:CC:DD:EE:FF', name: 'SoftN Sensor', rssi: -52, services: ['180d'] }],
    });

    await expect(
      dispatchDeviceBridgeCall(bridge, 'bluetooth', 'scan', { services: ['180f'] }, granted, perms)
    ).rejects.toThrow(/allowlist/i);

    await expect(
      dispatchDeviceBridgeCall(
        bridge,
        'bluetooth',
        'read',
        { deviceId: 'AA:BB:CC:DD:EE:FF', serviceUuid: '180f', characteristicUuid: '2a19' },
        granted,
        perms
      )
    ).rejects.toThrow(/not allowed/i);

    const okRead = await dispatchDeviceBridgeCall(
      bridge,
      'bluetooth',
      'read',
      { deviceId: 'AA:BB:CC:DD:EE:FF', serviceUuid: '180d', characteristicUuid: '2a37' },
      granted,
      perms
    );
    expect(okRead).toEqual({ base64: 'SGVsbG8=', utf8: 'Hello' });
  });

  it('dispatches camera, location, haptics, and notifications when granted', async () => {
    const bridge = makeMockBridge();
    const granted = new Set<Capability>(['camera', 'location', 'haptics', 'notifications']);
    const perms: ContainerPermissions = {
      permissions: {
        camera: { enabled: true },
        location: { enabled: true },
        haptics: { enabled: true },
        notifications: { enabled: true },
      },
    };

    const photo = (await dispatchDeviceBridgeCall(bridge, 'camera', 'takePhoto', { facing: 'user' }, granted, perms)) as { mimeType: string };
    expect(photo.mimeType).toBe('image/jpeg');

    const pos = (await dispatchDeviceBridgeCall(bridge, 'location', 'getCurrentPosition', { highAccuracy: true }, granted, perms)) as { latitude: number };
    expect(pos.latitude).toBeCloseTo(-33.8688, 3);

    const hap = await dispatchDeviceBridgeCall(bridge, 'haptics', 'impact', { style: 'heavy' }, granted, perms);
    expect(hap).toEqual({ ok: true });

    const note = await dispatchDeviceBridgeCall(bridge, 'notifications', 'notify', { title: 'Test', body: 'Hello' }, granted, perms);
    expect(note).toEqual({ ok: true, id: 1 });
  });

  it('mounts the exact same mobile-fieldkit.softn full-stack PHP + SQLite bundle on Web via @softn/container', async () => {
    const bundlePath = path.join(REPO_ROOT, 'examples', 'mobile-fieldkit', 'mobile-fieldkit.softn');
    const liteWasm = path.join(ENGINES_DIR, 'zipp-javascript-lite.wasm');
    const phpWasm = path.join(ENGINES_DIR, 'zipp-php.wasm');
    const xdbWasm = path.join(ENGINES_DIR, 'xdb-wasm.wasm');
    const xdbGlue = path.join(ENGINES_DIR, 'xdb-wasm.glue.js');
    if (!fs.existsSync(bundlePath) || !fs.existsSync(phpWasm) || !fs.existsSync(xdbWasm)) return;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const bridge = makeMockBridge();
    const handle = await mountSoftNContainer(host, {
      source: new Uint8Array(fs.readFileSync(bundlePath)),
      isolation: 'inline',
      permissionMode: 'preapproved',
      persistStorage: false,
      deviceBridge: bridge,
      engineWasm: {
        lite: new Uint8Array(fs.readFileSync(liteWasm)),
        php: new Uint8Array(fs.readFileSync(phpWasm)),
      },
      xdbWasm: new Uint8Array(fs.readFileSync(xdbWasm)),
      xdbGlueUrl: xdbGlue,
    });

    try {
      await new Promise((r) => setTimeout(r, 150));
      const text = handle.shadowRoot.textContent || '';
      expect(text).toContain('FieldKit');
      expect(text).toContain('Turbine Bearing Temperature OK');
      expect(text).toContain('2 / 3 verified');

      // Click Haptic Pulse button inside ShadowRoot -> invokes cross-platform deviceBridge.haptics.impact
      const hapticBtn = handle.shadowRoot.getElementById('btn-haptic');
      expect(hapticBtn).toBeTruthy();
      hapticBtn?.click();
      await new Promise((r) => setTimeout(r, 80));
      expect(bridge.haptics?.impact).toHaveBeenCalledWith('heavy');

      // Click + Quick Log -> sends UTF-8 JSON (including em-dash) to PHP 8 + SQLite 3
      const quickBtn = handle.shadowRoot.getElementById('btn-quick');
      expect(quickBtn).toBeTruthy();
      quickBtn?.click();
      await new Promise((r) => setTimeout(r, 200));
      const updated = handle.shadowRoot.textContent || '';
      expect(updated).toContain('Field Check #1 — Pump Pressure Nominal');
      expect(updated).toContain('2 / 4 verified');
    } finally {
      handle.dispose();
      host.remove();
    }
  }, 30_000);
});
