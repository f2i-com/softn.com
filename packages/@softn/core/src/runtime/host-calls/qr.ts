/**
 * `softn.qr.*`. Encoding is the QRCode component's; decoding reads an image
 * with the browser's BarcodeDetector where there is one.
 */

import { isRemoteUrl } from '../../renderer/sanitize-html';
import type { PendingHostCall } from '../script-runtime-types';
import type { HostGate } from './permissions';

/** How long an image may take to load, and then to be read. */
const OPERATION_TIMEOUT_MS = 10_000;

export class QrReader {
  /** QR image loads/detections in flight. Cleanup rejects them immediately. */
  private readonly cancelers = new Set<() => void>();

  constructor(private readonly gate: HostGate) {}

  async encode(call: PendingHostCall): Promise<unknown> {
    this.gate.checkPermission('qr');
    const [text] = call.args;
    // Return the text — actual QR rendering is done by the QRCode component
    return { text, encoded: true };
  }

  async decode(call: PendingHostCall): Promise<unknown> {
    this.gate.checkPermission('qr');
    const [imageDataUrl] = call.args;
    // The argument goes straight to `img.src`, so a remote URL here is a GET
    // to that host on the bundle's behalf — the same egress `softn.net.fetch`
    // and `softn.audio.play` are held to. `qr` alone says nothing about the
    // network; a data: or blob: image, the ordinary case, carries its bytes.
    if (typeof imageDataUrl === 'string' && isRemoteUrl(imageDataUrl)) {
      this.gate.checkPermission('net');
      this.gate.checkNetHost(imageDataUrl);
    }
    // Use BarcodeDetector API if available
    if ('BarcodeDetector' in globalThis) {
      try {
        const detector = new (
          globalThis as unknown as {
            BarcodeDetector: new (opts: { formats: string[] }) => {
              detect: (img: HTMLImageElement) => Promise<Array<{ rawValue: string }>>;
            };
          }
        ).BarcodeDetector({ formats: ['qr_code'] });
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          let timeout: ReturnType<typeof setTimeout> | null = null;

          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            img.onload = null;
            img.onerror = null;
            this.cancelers.delete(cancel);
            if (error) {
              // Removing the source asks the browser to abandon any decode work
              // still associated with this detached image.
              img.removeAttribute('src');
              reject(error);
            } else {
              resolve();
            }
          };
          const cancel = () => finish(new Error('QR image load cancelled'));

          this.cancelers.add(cancel);
          img.onload = () => finish();
          img.onerror = () => finish(new Error('Could not load QR image'));
          timeout = setTimeout(
            () => finish(new Error('QR image load timed out')),
            OPERATION_TIMEOUT_MS
          );
          img.src = imageDataUrl;
        });
        const results = await new Promise<Array<{ rawValue: string }>>((resolve, reject) => {
          let settled = false;
          const finish = (result?: Array<{ rawValue: string }>, error?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            this.cancelers.delete(cancel);
            if (error) reject(error);
            else resolve(result ?? []);
          };
          const cancel = () => finish(undefined, new Error('QR detection cancelled'));
          const timeout = setTimeout(
            () => finish(undefined, new Error('QR detection timed out')),
            OPERATION_TIMEOUT_MS
          );

          this.cancelers.add(cancel);
          detector.detect(img).then(
            (result) => finish(result),
            (error) => finish(undefined, error)
          );
        });
        if (results.length > 0) {
          return { data: results[0].rawValue };
        }
      } catch {
        /* fallthrough */
      }
    }
    return { data: null, error: 'QR detection not available' };
  }

  /**
   * Settle every load and detection still pending. Image decoding has no
   * AbortSignal, and a malformed image must not keep a host call alive.
   */
  dispose(): void {
    for (const cancel of this.cancelers) cancel();
    this.cancelers.clear();
  }
}
