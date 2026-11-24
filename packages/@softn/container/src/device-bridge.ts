/**
 * Cross-platform Device Bridge for SoftN v2 containers.
 *
 * Exposes a single capability-gated RPC surface (`softn:device`, `softn:camera`,
 * `softn:bluetooth`, `softn:location`, `softn:haptics`, `softn:notifications`)
 * shared identically across Web (`createWebDeviceBridge`) and Native Mobile
 * harnesses (Android / iOS / Tauri).
 *
 * Every sensitive call is checked by the host against both the bundle's declared
 * `permission.json` AND the user's currently granted capabilities before the
 * underlying bridge adapter is invoked.
 */

import type { Capability } from '@softn/bundle-format/capabilities';
import type { ContainerPermissions } from './types';

export interface DeviceInfoResult {
  platform: 'web' | 'android' | 'ios' | 'desktop';
  engine: string;
  osVersion: string;
  model: string;
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  capabilities: Record<string, boolean>;
}

export interface CameraPhotoOptions {
  facing?: 'user' | 'environment';
  maxWidth?: number;
  quality?: number;
}

export interface CameraPhotoResult {
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
  size: number;
}

export interface BleDeviceInfo {
  id: string;
  name: string;
  rssi?: number;
  services?: string[];
}

export interface BleScanOptions {
  services?: string[];
  namePrefix?: string;
  durationMs?: number;
}

export interface LocationPositionResult {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  timestamp: number;
}

export interface ContainerDeviceBridge {
  readonly platform: 'web' | 'android' | 'ios' | 'desktop';
  readonly engine?: string;
  getInfo?(): Promise<Partial<DeviceInfoResult>> | Partial<DeviceInfoResult>;
  share?(opts: { title?: string; text?: string; url?: string }): Promise<{ shared: boolean }>;
  clipboardWrite?(text: string): Promise<{ ok: boolean }>;

  camera?: {
    isAvailable(): boolean | Promise<boolean>;
    takePhoto(options?: CameraPhotoOptions): Promise<CameraPhotoResult>;
  };

  bluetooth?: {
    isAvailable(): boolean | Promise<boolean>;
    scan(options?: BleScanOptions): Promise<{ devices: BleDeviceInfo[] }>;
    connect(deviceId: string): Promise<{ connected: boolean; deviceId: string; services?: string[] }>;
    disconnect(deviceId: string): Promise<{ disconnected: boolean; deviceId: string }>;
    read(deviceId: string, serviceUuid: string, characteristicUuid: string): Promise<{ base64: string; utf8?: string }>;
    write(
      deviceId: string,
      serviceUuid: string,
      characteristicUuid: string,
      base64: string,
      withoutResponse?: boolean
    ): Promise<{ ok: boolean }>;
  };

  location?: {
    isAvailable(): boolean | Promise<boolean>;
    getCurrentPosition(options?: { highAccuracy?: boolean; timeoutMs?: number }): Promise<LocationPositionResult>;
  };

  haptics?: {
    isAvailable(): boolean | Promise<boolean>;
    impact(style?: 'light' | 'medium' | 'heavy'): Promise<{ ok: boolean }>;
    vibrate(durationMs?: number): Promise<{ ok: boolean }>;
  };

  notifications?: {
    isAvailable(): boolean | Promise<boolean>;
    notify(options: { title: string; body?: string; id?: number }): Promise<{ ok: boolean; id: number }>;
  };
}

const NAMESPACE_CAPABILITY: Readonly<Record<string, Capability | null>> = {
  device: null,
  camera: 'camera',
  bluetooth: 'bluetooth',
  location: 'location',
  haptics: 'haptics',
  notifications: 'notifications',
};

function normalizeUuid(uuid: string): string {
  return uuid.trim().toLowerCase();
}

const MAX_CLIPBOARD_CHARS = 256 * 1024;
const MAX_NOTIFICATION_TEXT_CHARS = 1024;

function bytesToBase64Local(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  const NodeBuf = (globalThis as { Buffer?: { from(input: Uint8Array): { toString(enc: string): string } } }).Buffer;
  return NodeBuf ? NodeBuf.from(bytes).toString('base64') : '';
}

function base64ToBytesLocal(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const NodeBuf = (globalThis as { Buffer?: { from(input: string, enc: string): Uint8Array } }).Buffer;
  return NodeBuf ? new Uint8Array(NodeBuf.from(b64, 'base64')) : new Uint8Array(0);
}

/**
 * Default browser implementation of `ContainerDeviceBridge`.
 * Uses standard Web APIs (`getUserMedia`, Web Bluetooth, Geolocation, Vibration,
 * Notifications, Web Share) with graceful feature detection on unsupported browsers.
 */
export function createWebDeviceBridge(): ContainerDeviceBridge {
  // Remember Web Bluetooth device handles for connect/read/write across RPC calls
  type WebBleDevice = {
    id: string;
    name?: string;
    gatt?: {
      connected: boolean;
      connect(): Promise<{
        getPrimaryServices?(): Promise<Array<{ uuid: string }>>;
        getPrimaryService(uuid: string): Promise<{
          getCharacteristic(uuid: string): Promise<{
            readValue(): Promise<DataView>;
            writeValue?(value: BufferSource): Promise<void>;
            writeValueWithoutResponse?(value: BufferSource): Promise<void>;
          }>;
        }>;
      }>;
      disconnect(): void;
    };
  };
  const bleDevices = new Map<string, WebBleDevice>();
  let nextNotificationId = 1;

  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & {
    bluetooth?: {
      requestDevice(opts: Record<string, unknown>): Promise<WebBleDevice>;
    };
  }) : undefined;

  return {
    platform: 'web',
    engine: 'softn-web-container',

    async getInfo() {
      return {
        platform: 'web',
        engine: 'softn-web-container',
        osVersion: nav?.platform ?? 'browser',
        model: nav?.userAgent ?? 'Web Browser',
        screenWidth: typeof window !== 'undefined' ? window.innerWidth : 0,
        screenHeight: typeof window !== 'undefined' ? window.innerHeight : 0,
        devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      };
    },

    async share(opts) {
      if (nav && typeof nav.share === 'function') {
        await nav.share({ title: opts.title, text: opts.text, url: opts.url });
        return { shared: true };
      }
      if (nav?.clipboard && typeof nav.clipboard.writeText === 'function') {
        const text = [opts.title, opts.text, opts.url].filter(Boolean).join('\n');
        if (text) await nav.clipboard.writeText(text);
        return { shared: false };
      }
      return { shared: false };
    },

    async clipboardWrite(text) {
      if (nav?.clipboard && typeof nav.clipboard.writeText === 'function') {
        await nav.clipboard.writeText(text);
        return { ok: true };
      }
      return { ok: false };
    },

    camera: {
      isAvailable() {
        return Boolean(nav?.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function');
      },
      async takePhoto(options) {
        if (!nav?.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') {
          throw new Error('Camera is not available in this browser');
        }
        const facingMode = options?.facing === 'user' ? 'user' : 'environment';
        const maxWidth = Math.max(160, Math.min(2048, Number(options?.maxWidth) || 960));
        const quality = Math.max(0.2, Math.min(1, Number(options?.quality) || 0.85));
        const stream = await nav.mediaDevices.getUserMedia({
          video: { facingMode },
          audio: false,
        });
        try {
          const video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.srcObject = stream;
          await video.play();
          await new Promise<void>((resolve, reject) => {
            if (video.readyState >= 2 && video.videoWidth > 0) {
              resolve();
              return;
            }
            const timer = setTimeout(() => reject(new Error('Camera stream timed out')), 10_000);
            video.onloadeddata = () => {
              clearTimeout(timer);
              resolve();
            };
            video.onerror = () => {
              clearTimeout(timer);
              reject(new Error('Camera stream failed to load'));
            };
          });
          const srcW = video.videoWidth || 640;
          const srcH = video.videoHeight || 480;
          const scale = srcW > maxWidth ? maxWidth / srcW : 1;
          const width = Math.max(1, Math.round(srcW * scale));
          const height = Math.max(1, Math.round(srcH * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Unable to create 2D capture context');
          ctx.drawImage(video, 0, 0, width, height);
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          return {
            dataUrl,
            mimeType: 'image/jpeg',
            width,
            height,
            size: Math.round((dataUrl.length * 3) / 4),
          };
        } finally {
          for (const track of stream.getTracks()) track.stop();
        }
      },
    },

    bluetooth: {
      isAvailable() {
        return Boolean(nav?.bluetooth && typeof nav.bluetooth.requestDevice === 'function');
      },
      async scan(options) {
        if (!nav?.bluetooth || typeof nav.bluetooth.requestDevice !== 'function') {
          throw new Error('Web Bluetooth is not available in this browser');
        }
        const services = Array.isArray(options?.services) ? options.services.filter(Boolean) : [];
        const reqOpts: Record<string, unknown> =
          services.length > 0
            ? { filters: [{ services }], optionalServices: services }
            : options?.namePrefix
              ? { filters: [{ namePrefix: options.namePrefix }] }
              : { acceptAllDevices: true };
        const dev = await nav.bluetooth.requestDevice(reqOpts);
        bleDevices.set(dev.id, dev);
        return {
          devices: [
            {
              id: dev.id,
              name: dev.name || 'Unnamed BLE Device',
              services,
            },
          ],
        };
      },
      async connect(deviceId) {
        const dev = bleDevices.get(deviceId);
        if (!dev?.gatt) throw new Error(`Bluetooth device not found: ${deviceId}`);
        const server = await dev.gatt.connect();
        let services: string[] = [];
        try {
          if (typeof server.getPrimaryServices === 'function') {
            services = (await server.getPrimaryServices()).map((s) => s.uuid);
          }
        } catch {
          // Some platforms disallow unfiltered primary service enumeration
        }
        return { connected: true, deviceId, services };
      },
      async disconnect(deviceId) {
        const dev = bleDevices.get(deviceId);
        if (dev?.gatt?.connected) dev.gatt.disconnect();
        return { disconnected: true, deviceId };
      },
      async read(deviceId, serviceUuid, characteristicUuid) {
        const dev = bleDevices.get(deviceId);
        if (!dev?.gatt) throw new Error(`Bluetooth device not found: ${deviceId}`);
        const server = await dev.gatt.connect();
        const svc = await server.getPrimaryService(serviceUuid);
        const ch = await svc.getCharacteristic(characteristicUuid);
        const view = await ch.readValue();
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        let utf8: string | undefined;
        try {
          utf8 = new TextDecoder().decode(bytes);
        } catch {
          utf8 = undefined;
        }
        return { base64: bytesToBase64Local(bytes), utf8 };
      },
      async write(deviceId, serviceUuid, characteristicUuid, base64, withoutResponse) {
        const dev = bleDevices.get(deviceId);
        if (!dev?.gatt) throw new Error(`Bluetooth device not found: ${deviceId}`);
        const server = await dev.gatt.connect();
        const svc = await server.getPrimaryService(serviceUuid);
        const ch = await svc.getCharacteristic(characteristicUuid);
        const bytes = base64ToBytesLocal(base64);
        if (withoutResponse && typeof ch.writeValueWithoutResponse === 'function') {
          await ch.writeValueWithoutResponse(bytes as BufferSource);
        } else if (typeof ch.writeValue === 'function') {
          await ch.writeValue(bytes as BufferSource);
        } else {
          throw new Error('Bluetooth characteristic is not writable');
        }
        return { ok: true };
      },
    },

    location: {
      isAvailable() {
        return Boolean(nav?.geolocation && typeof nav.geolocation.getCurrentPosition === 'function');
      },
      getCurrentPosition(options) {
        if (!nav?.geolocation) {
          return Promise.reject(new Error('Geolocation is not available in this browser'));
        }
        return new Promise((resolve, reject) => {
          nav.geolocation.getCurrentPosition(
            (pos) =>
              resolve({
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
                altitude: pos.coords.altitude ?? null,
                timestamp: pos.timestamp,
              }),
            (err) => reject(new Error(err.message || 'Location request failed')),
            {
              enableHighAccuracy: Boolean(options?.highAccuracy),
              timeout: Math.max(1000, Math.min(30_000, Number(options?.timeoutMs) || 10_000)),
            }
          );
        });
      },
    },

    haptics: {
      isAvailable() {
        return Boolean(nav && typeof nav.vibrate === 'function');
      },
      async impact(style = 'medium') {
        if (!nav || typeof nav.vibrate !== 'function') return { ok: false };
        const ms = style === 'light' ? 15 : style === 'heavy' ? 60 : 30;
        return { ok: Boolean(nav.vibrate(ms)) };
      },
      async vibrate(durationMs = 40) {
        if (!nav || typeof nav.vibrate !== 'function') return { ok: false };
        const clamped = Math.max(5, Math.min(2000, Math.round(Number(durationMs) || 40)));
        return { ok: Boolean(nav.vibrate(clamped)) };
      },
    },

    notifications: {
      isAvailable() {
        return typeof Notification !== 'undefined';
      },
      async notify(options) {
        if (typeof Notification === 'undefined') {
          throw new Error('Notifications are not available in this browser');
        }
        let perm = Notification.permission;
        if (perm === 'default' && typeof Notification.requestPermission === 'function') {
          perm = await Notification.requestPermission();
        }
        if (perm !== 'granted') {
          throw new Error('Notification permission denied');
        }
        const id = typeof options.id === 'number' ? options.id : nextNotificationId++;
        new Notification(String(options.title || 'SoftN App'), {
          body: options.body ? String(options.body) : undefined,
        });
        return { ok: true, id };
      },
    },
  };
}

/**
 * Capability-gated dispatcher for Worker `device.call` host requests.
 */
export async function dispatchDeviceBridgeCall(
  bridge: ContainerDeviceBridge,
  namespace: string,
  method: string,
  params: Record<string, unknown>,
  grantedCaps: ReadonlySet<Capability>,
  permissions: ContainerPermissions
): Promise<unknown> {
  if (!Object.prototype.hasOwnProperty.call(NAMESPACE_CAPABILITY, namespace)) {
    throw new Error(`Unknown device namespace: ${namespace}`);
  }

  // `isAvailable` queries never access user hardware or leak personal data, so they
  // are allowed even before a capability is granted (so apps can feature-detect cleanly).
  if (method === 'isAvailable' && namespace !== 'device') {
    const mod = bridge[namespace as 'camera' | 'bluetooth' | 'location' | 'haptics' | 'notifications'];
    const available = mod ? Boolean(await mod.isAvailable()) : false;
    const capability = NAMESPACE_CAPABILITY[namespace];
    const permEntry = capability ? (permissions.permissions as Record<string, { enabled?: boolean } | undefined> | undefined)?.[capability] : undefined;
    const permitted = capability ? grantedCaps.has(capability) && permEntry?.enabled === true : true;
    return { available, permitted };
  }

  const requiredCap = NAMESPACE_CAPABILITY[namespace];
  const capPerm = requiredCap
    ? (permissions.permissions as Record<string, { enabled?: boolean } | undefined> | undefined)?.[requiredCap]
    : undefined;
  if (requiredCap && (!grantedCaps.has(requiredCap) || capPerm?.enabled !== true)) {
    throw new Error(
      `${requiredCap} access is not granted. Declare "${requiredCap}": { "enabled": true } in permission.json and grant permission.`
    );
  }

  // Enforce optional BLE service UUID allowlist from permission.json
  const allowedBleServices = (() => {
    const raw = permissions.permissions?.bluetooth as { enabled?: boolean; services?: unknown } | undefined;
    if (!raw || !Array.isArray(raw.services) || raw.services.length === 0) return null;
    return new Set(raw.services.filter((s): s is string => typeof s === 'string').map(normalizeUuid));
  })();

  switch (namespace) {
    case 'device': {
      if (method === 'getInfo') {
        const base = (await bridge.getInfo?.()) ?? {};
        const caps: Record<string, boolean> = {
          camera: Boolean(await bridge.camera?.isAvailable()),
          bluetooth: Boolean(await bridge.bluetooth?.isAvailable()),
          location: Boolean(await bridge.location?.isAvailable()),
          haptics: Boolean(await bridge.haptics?.isAvailable()),
          notifications: Boolean(await bridge.notifications?.isAvailable()),
        };
        return {
          platform: base.platform ?? bridge.platform,
          engine: base.engine ?? bridge.engine ?? 'softn-container',
          osVersion: base.osVersion ?? '',
          model: base.model ?? '',
          screenWidth: base.screenWidth ?? 0,
          screenHeight: base.screenHeight ?? 0,
          devicePixelRatio: base.devicePixelRatio ?? 1,
          capabilities: caps,
        } satisfies DeviceInfoResult;
      }
      if (method === 'share') {
        if (!bridge.share) return { shared: false };
        let safeUrl: string | undefined;
        if (typeof params.url === 'string' && params.url.trim()) {
          try {
            const parsed = new URL(params.url.trim());
            if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
              safeUrl = parsed.href;
            }
          } catch {
            // Drop invalid/dangerous URL schemes from share payload
          }
        }
        return await bridge.share({
          title: typeof params.title === 'string' ? params.title.slice(0, MAX_NOTIFICATION_TEXT_CHARS) : undefined,
          text: typeof params.text === 'string' ? params.text.slice(0, MAX_CLIPBOARD_CHARS) : undefined,
          url: safeUrl,
        });
      }
      if (method === 'clipboardWrite') {
        if (!bridge.clipboardWrite) return { ok: false };
        return await bridge.clipboardWrite(String(params.text ?? '').slice(0, MAX_CLIPBOARD_CHARS));
      }
      throw new Error(`Unknown device method: ${method}`);
    }

    case 'camera': {
      if (!bridge.camera) throw new Error('Camera bridge is unavailable on this host');
      if (method === 'takePhoto') {
        return await bridge.camera.takePhoto({
          facing: params.facing === 'user' ? 'user' : 'environment',
          maxWidth: typeof params.maxWidth === 'number' ? params.maxWidth : undefined,
          quality: typeof params.quality === 'number' ? params.quality : undefined,
        });
      }
      throw new Error(`Unknown camera method: ${method}`);
    }

    case 'bluetooth': {
      if (!bridge.bluetooth) throw new Error('Bluetooth bridge is unavailable on this host');
      if (method === 'scan') {
        const requestedServices = Array.isArray(params.services)
          ? params.services.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          : undefined;
        if (allowedBleServices) {
          if (requestedServices && requestedServices.some((s) => !allowedBleServices.has(normalizeUuid(s)))) {
            throw new Error('Requested Bluetooth service UUID is not in permission.json bluetooth.services allowlist');
          }
        }
        // When `bluetooth.services` allowlist is configured, an empty `services: []` must NOT
        // fall through to `acceptAllDevices: true` — enforce the allowlisted service list.
        const effectiveServices =
          requestedServices && requestedServices.length > 0
            ? requestedServices
            : allowedBleServices
              ? [...allowedBleServices]
              : undefined;
        return await bridge.bluetooth.scan({
          services: effectiveServices,
          namePrefix: typeof params.namePrefix === 'string' ? params.namePrefix : undefined,
          durationMs: typeof params.durationMs === 'number' ? params.durationMs : undefined,
        });
      }
      if (method === 'connect') {
        const res = await bridge.bluetooth.connect(String(params.deviceId ?? ''));
        if (allowedBleServices && Array.isArray(res.services)) {
          return {
            ...res,
            services: res.services.filter((s) => allowedBleServices.has(normalizeUuid(s))),
          };
        }
        return res;
      }
      if (method === 'disconnect') {
        return await bridge.bluetooth.disconnect(String(params.deviceId ?? ''));
      }
      if (method === 'read') {
        const svc = String(params.serviceUuid ?? '');
        if (allowedBleServices && !allowedBleServices.has(normalizeUuid(svc))) {
          throw new Error(`Bluetooth service ${svc} is not allowed by permission.json`);
        }
        return await bridge.bluetooth.read(String(params.deviceId ?? ''), svc, String(params.characteristicUuid ?? ''));
      }
      if (method === 'write') {
        const svc = String(params.serviceUuid ?? '');
        if (allowedBleServices && !allowedBleServices.has(normalizeUuid(svc))) {
          throw new Error(`Bluetooth service ${svc} is not allowed by permission.json`);
        }
        return await bridge.bluetooth.write(
          String(params.deviceId ?? ''),
          svc,
          String(params.characteristicUuid ?? ''),
          String(params.base64 ?? ''),
          Boolean(params.withoutResponse)
        );
      }
      throw new Error(`Unknown bluetooth method: ${method}`);
    }

    case 'location': {
      if (!bridge.location) throw new Error('Location bridge is unavailable on this host');
      if (method === 'getCurrentPosition') {
        return await bridge.location.getCurrentPosition({
          highAccuracy: Boolean(params.highAccuracy),
          timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined,
        });
      }
      throw new Error(`Unknown location method: ${method}`);
    }

    case 'haptics': {
      if (!bridge.haptics) throw new Error('Haptics bridge is unavailable on this host');
      if (method === 'impact') {
        const style = params.style === 'light' || params.style === 'heavy' ? params.style : 'medium';
        return await bridge.haptics.impact(style);
      }
      if (method === 'vibrate') {
        return await bridge.haptics.vibrate(typeof params.durationMs === 'number' ? params.durationMs : 40);
      }
      throw new Error(`Unknown haptics method: ${method}`);
    }

    case 'notifications': {
      if (!bridge.notifications) throw new Error('Notifications bridge is unavailable on this host');
      if (method === 'notify') {
        return await bridge.notifications.notify({
          title: String(params.title ?? 'SoftN').slice(0, MAX_NOTIFICATION_TEXT_CHARS),
          body: typeof params.body === 'string' ? params.body.slice(0, MAX_NOTIFICATION_TEXT_CHARS) : undefined,
          id: typeof params.id === 'number' ? params.id : undefined,
        });
      }
      throw new Error(`Unknown notifications method: ${method}`);
    }

    default:
      throw new Error(`Unknown device namespace: ${namespace}`);
  }
}
