/**
 * The browser's device bridge (device-bridge.ts) as an app uses it through `softn:bluetooth`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebDeviceBridge, dispatchDeviceBridgeCall, type ContainerDeviceBridge } from '../src/device-bridge';

/** A Web Bluetooth device as the browser hands one over: it stays the page's after a disconnect. */
class FakeDevice extends EventTarget {
  readonly id = 'dev-1';
  readonly name = 'Heart rate';
  listenersAdded = 0;
  connects = 0;
  readonly gatt = {
    connected: false,
    connect: async () => {
      this.connects++;
      this.gatt.connected = true;
      return { getPrimaryServices: async () => [{ uuid: 'heart_rate' }], getPrimaryService: async () => { throw new Error('none'); } };
    },
    disconnect: () => {
      this.gatt.connected = false;
      this.dispatchEvent(new Event('gattserverdisconnected'));
    },
  };

  override addEventListener(type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions): void {
    this.listenersAdded++;
    super.addEventListener(type, fn, opts);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Bluetooth through the browser bridge', () => {
  it('connects again, by the id the scan gave, to a device it disconnected from (as on Android)', async () => {
    const device = new FakeDevice();
    vi.stubGlobal('navigator', { bluetooth: { requestDevice: async () => device } });
    const bridge = createWebDeviceBridge();
    const found = await bridge.bluetooth!.scan({ services: ['heart_rate'] });
    expect(found.devices.map((d) => d.id)).toEqual(['dev-1']);
    expect((await bridge.bluetooth!.connect('dev-1')).connected).toBe(true);
    await bridge.bluetooth!.disconnect('dev-1');
    // The link dropped (or the app let go): the person chose this device, and it is still theirs to use.
    expect((await bridge.bluetooth!.connect('dev-1')).connected).toBe(true);
    expect(device.connects).toBe(2);
    bridge.dispose?.();
  });

  it('reads a service named short (180d, as on Android) as the full UUID the browser and the device use', async () => {
    const HEART = '0000180d-0000-1000-8000-00805f9b34fb';
    const asked: unknown[] = [];
    const bridge: ContainerDeviceBridge = {
      platform: 'web',
      bluetooth: {
        isAvailable: () => true,
        scan: async (opts) => {
          asked.push(['scan', opts?.services]);
          return { devices: [{ id: 'dev-1', name: 'Heart rate' }] };
        },
        connect: async (deviceId) => ({ connected: true, deviceId, services: [HEART, '0000180f-0000-1000-8000-00805f9b34fb'] }),
        disconnect: async (deviceId) => ({ disconnected: true, deviceId }),
        read: async (_deviceId, service, characteristic) => {
          asked.push(['read', service, characteristic]);
          return { base64: 'AA==' };
        },
        write: async () => ({ ok: true }),
      },
    };
    const granted = new Set(['bluetooth'] as const);
    const permissions = { permissions: { bluetooth: { enabled: true, services: ['180d'] } } } as never;
    const call = (method: string, params: Record<string, unknown>) => dispatchDeviceBridgeCall(bridge, 'bluetooth', method, params, granted as never, permissions);

    await call('scan', { services: ['180D'] });
    // What Web Bluetooth's requestDevice takes: a full UUID, never a bare "180d".
    expect(asked[0]).toEqual(['scan', [HEART]]);
    // The device names its services in full: the one declared is among them, the other is not.
    const connected = (await call('connect', { deviceId: 'dev-1' })) as { services: string[] };
    expect(connected.services).toEqual([HEART]);
    // Read by its full name (as connect gave it) or its short one: both are the service declared.
    await call('read', { deviceId: 'dev-1', serviceUuid: HEART.toUpperCase(), characteristicUuid: '2a37' });
    await call('read', { deviceId: 'dev-1', serviceUuid: '180d', characteristicUuid: '2a37' });
    expect(asked.slice(1)).toEqual([
      ['read', HEART, '00002a37-0000-1000-8000-00805f9b34fb'],
      ['read', HEART, '00002a37-0000-1000-8000-00805f9b34fb'],
    ]);
    // A service not declared is still refused, however it is named.
    await expect(call('read', { deviceId: 'dev-1', serviceUuid: '180f', characteristicUuid: '2a19' })).rejects.toThrow(/not allowed/);
  });

  it('adds nothing to a device each time the same device is chosen again', async () => {
    const device = new FakeDevice();
    vi.stubGlobal('navigator', { bluetooth: { requestDevice: async () => device } });
    const bridge = createWebDeviceBridge();
    for (let i = 0; i < 5; i++) await bridge.bluetooth!.scan({ services: ['heart_rate'] });
    expect(device.listenersAdded).toBeLessThanOrEqual(1);
    bridge.dispose?.();
  });
});
