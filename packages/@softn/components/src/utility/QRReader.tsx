/**
 * QRReader Component
 *
 * Camera-based QR code scanner wrapping @yudiel/react-qr-scanner.
 * Provides a simplified API with onScan callback, facing mode, and sizing.
 */

import React, { useCallback, useRef } from 'react';
import { isCapabilityAllowed, useCapability } from '@softn/core';
import { Scanner, type IDetectedBarcode } from '@yudiel/react-qr-scanner';

export interface QRReaderProps {
  /** Callback fired when a QR code is detected */
  onScan?: (data: string) => void;
  /** Camera facing mode (default 'environment') */
  facing?: 'user' | 'environment';
  /** Video width in pixels (default 640) */
  width?: number;
  /** Video height in pixels (default 480) */
  height?: number;
  /** Whether the scanner is active (default true) */
  active?: boolean;
  /** Inline styles */
  style?: React.CSSProperties;
}

export function QRReader({
  onScan,
  facing = 'environment',
  width = 640,
  height = 480,
  active = true,
  style,
}: QRReaderProps): React.ReactElement {
  // Same exposure as <Camera>: the scanner opens the camera itself, from its
  // own mount, and permission.json says nothing about it. Held on the host's
  // published decision: either the `qr` capability — reading codes is what it
  // declares — or `camera` lets the scanner open the device. It mounts on the
  // render that follows the grant, with no reload.
  const qrGrant = useCapability('qr');
  const cameraGrant = useCapability('camera');
  const consentPending = qrGrant === 'pending';
  const scannerAllowed = isCapabilityAllowed(qrGrant) || isCapabilityAllowed(cameraGrant);
  const refusal = consentPending
    ? 'Scanning stays off until you choose Allow in the permission bar at the top of this app.'
    : !scannerAllowed
      ? 'This app has not declared camera or QR access. Its permission.json needs { "qr": { "enabled": true } }.'
      : null;

  const lastScanRef = useRef<string>('');
  const lastScanTimeRef = useRef<number>(0);

  const handleScan = useCallback((detectedCodes: IDetectedBarcode[]) => {
    if (detectedCodes.length === 0) return;
    const value = detectedCodes[0].rawValue;
    if (!value) return;

    // Debounce: don't fire the same code within 2 seconds
    const now = Date.now();
    if (value !== lastScanRef.current || now - lastScanTimeRef.current > 2000) {
      lastScanRef.current = value;
      lastScanTimeRef.current = now;
      onScan?.(value);
    }
  }, [onScan]);

  const frameStyle: React.CSSProperties = {
    width,
    height,
    overflow: 'hidden',
    borderRadius: '0.5rem',
    backgroundColor: '#000',
    ...style,
  };

  // Not rendered at all, rather than rendered `paused`: pausing stops the
  // decode, not the stream, so the scanner would still have opened the camera.
  if (refusal !== null) {
    return (
      <div style={frameStyle}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%',
            padding: '1rem',
            textAlign: 'center',
            color: '#a1a1aa',
            fontSize: '0.875rem',
            lineHeight: 1.5,
          }}
        >
          {refusal}
        </div>
      </div>
    );
  }

  return (
    <div style={frameStyle}>
      <Scanner
        onScan={handleScan}
        paused={!active}
        formats={['qr_code']}
        constraints={{
          facingMode: facing,
          width: { ideal: width },
          height: { ideal: height },
        }}
        components={{
          finder: true,
          torch: false,
        }}
        styles={{
          container: {
            width: '100%',
            height: '100%',
          },
          video: {
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          },
        }}
        scanDelay={100}
        sound={false}
      />
    </div>
  );
}

export default QRReader;
