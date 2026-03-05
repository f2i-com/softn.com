/**
 * QRReader Component
 *
 * Camera-based QR code scanner wrapping @yudiel/react-qr-scanner.
 * Provides a simplified API with onScan callback, facing mode, and sizing.
 */

import React, { useCallback, useRef } from 'react';
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

  return (
    <div style={{
      width,
      height,
      overflow: 'hidden',
      borderRadius: '0.5rem',
      backgroundColor: '#000',
      ...style,
    }}>
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
