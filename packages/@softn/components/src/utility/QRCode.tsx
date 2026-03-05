/**
 * QRCode Component
 *
 * Canvas-based QR code generator using @rc-component/qrcode.
 * Right-click the QR code to save as image.
 */

import React from 'react';
import { QRCodeCanvas } from '@rc-component/qrcode';

export interface QRCodeProps {
  /** The data to encode */
  value: string;
  /** Size of the QR code in pixels (default 256) */
  size?: number;
  /** Foreground color (default '#000') */
  color?: string;
  /** Background color (default '#fff') */
  bgColor?: string;
  /** Error correction level (default 'M') */
  errorCorrection?: 'L' | 'M' | 'Q' | 'H';
  /** Inline styles */
  style?: React.CSSProperties;
  /** CSS class name */
  className?: string;
}

export function QRCode({
  value,
  size = 256,
  color = '#000',
  bgColor = '#fff',
  errorCorrection = 'M',
  style,
  className,
}: QRCodeProps): React.ReactElement {
  return React.createElement(QRCodeCanvas, {
    value: value || ' ',
    size,
    fgColor: color,
    bgColor,
    level: errorCorrection,
    marginSize: 4,
    className,
    style,
  });
}

export default QRCode;
