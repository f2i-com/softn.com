import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type PermissionConfig,
  type ScriptContext,
} from '../src/runtime/script-runtime';

interface QRRuntimeInternals {
  setPermissionConfig(config: PermissionConfig): void;
  handleQrDecode(call: { id: number; kind: string; args: string[] }): Promise<unknown>;
}

function makeRuntime() {
  const context: ScriptContext = {
    state: {},
    setState: () => {},
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
  const runtime = createScriptRuntime(context, undefined, 'qr-lifecycle-test');
  (runtime as unknown as QRRuntimeInternals).setPermissionConfig({
    permissions: { qr: { enabled: true } },
  });
  return runtime;
}

function decode(runtime: ReturnType<typeof makeRuntime>) {
  return (runtime as unknown as QRRuntimeInternals).handleQrDecode({
    id: 1,
    kind: 'qr.decode',
    args: ['data:image/png;base64,not-an-image'],
  });
}

function installBarcodeDetector() {
  const detect = vi.fn(async () => []);
  vi.stubGlobal(
    'BarcodeDetector',
    class {
      detect = detect;
    }
  );
  return detect;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('softn.qr.decode image lifecycle', () => {
  it('settles when the supplied image cannot be decoded', async () => {
    const detect = installBarcodeDetector();
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onerror?.());
        }
        removeAttribute() {}
      }
    );

    const runtime = makeRuntime();
    await expect(decode(runtime)).resolves.toEqual({
      data: null,
      error: 'QR detection not available',
    });
    expect(detect).not.toHaveBeenCalled();
    runtime.cleanup();
  });

  it('times out an image load that emits neither load nor error', async () => {
    vi.useFakeTimers();
    const detect = installBarcodeDetector();
    const removeAttribute = vi.fn();
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src = '';
        removeAttribute = removeAttribute;
      }
    );

    const runtime = makeRuntime();
    const decoding = decode(runtime);
    await vi.advanceTimersByTimeAsync(10_001);

    await expect(decoding).resolves.toEqual({
      data: null,
      error: 'QR detection not available',
    });
    expect(detect).not.toHaveBeenCalled();
    expect(removeAttribute).toHaveBeenCalledWith('src');
    runtime.cleanup();
  });

  it('cancels a pending image load during runtime cleanup', async () => {
    installBarcodeDetector();
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src = '';
        removeAttribute() {}
      }
    );

    const runtime = makeRuntime();
    const decoding = decode(runtime);
    runtime.cleanup();

    await expect(decoding).resolves.toEqual({
      data: null,
      error: 'QR detection not available',
    });
  });

  it('times out a detector that never settles after the image loads', async () => {
    vi.useFakeTimers();
    const detect = vi.fn(() => new Promise<Array<{ rawValue: string }>>(() => {}));
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        detect = detect;
      }
    );
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
        removeAttribute() {}
      }
    );

    const runtime = makeRuntime();
    const decoding = decode(runtime);
    await vi.advanceTimersByTimeAsync(10_001);

    await expect(decoding).resolves.toEqual({
      data: null,
      error: 'QR detection not available',
    });
    expect(detect).toHaveBeenCalledOnce();
    runtime.cleanup();
  });
});

describe('softn.qr.decode egress', () => {
  // The argument goes straight to img.src, so a remote URL is a GET to that
  // host on the bundle's behalf. `qr` says nothing about the network; the
  // same gate as softn.net.fetch and softn.audio.play stands in front of it.
  function decodeUrl(runtime: ReturnType<typeof makeRuntime>, url: string) {
    return (runtime as unknown as QRRuntimeInternals).handleQrDecode({
      id: 2,
      kind: 'qr.decode',
      args: [url],
    });
  }

  it('refuses a remote image when net is not granted', async () => {
    const detect = installBarcodeDetector();
    const runtime = makeRuntime();
    await expect(decodeUrl(runtime, 'https://attacker.test/qr.png')).rejects.toThrow(
      /Network access not permitted/
    );
    await expect(decodeUrl(runtime, '//attacker.test/qr.png')).rejects.toThrow(
      /Network access not permitted/
    );
    expect(detect).not.toHaveBeenCalled();
    runtime.cleanup();
  });

  it('holds a remote image to the host allowlist once net is granted', async () => {
    installBarcodeDetector();
    const runtime = makeRuntime();
    (runtime as unknown as QRRuntimeInternals).setPermissionConfig({
      permissions: { qr: { enabled: true }, net: { enabled: true, allowed_hosts: ['codes.test'] } },
    });
    await expect(decodeUrl(runtime, 'https://attacker.test/qr.png')).rejects.toThrow(
      /Host not allowed/
    );
    runtime.cleanup();
  });

  it('still takes a data: image with qr alone', async () => {
    installBarcodeDetector();
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
        removeAttribute() {}
      }
    );
    const runtime = makeRuntime();
    // Nothing found in the image: the decode ran, and reported no code.
    await expect(decode(runtime)).resolves.toEqual({
      data: null,
      error: 'QR detection not available',
    });
    runtime.cleanup();
  });
});
