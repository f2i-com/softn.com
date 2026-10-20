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
  /** Accessible name for the code (default "QR code") */
  ariaLabel?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** CSS class name */
  className?: string;
}

/** The most bytes a code holds at each error-correction level (version 40, byte mode). */
const CAPACITY = { L: 2953, M: 2331, Q: 1663, H: 1273 } as const;

export function QRCode({
  value,
  size = 256,
  color = '#000',
  bgColor = '#fff',
  errorCorrection = 'M',
  ariaLabel = 'QR code',
  style,
  className,
}: QRCodeProps): React.ReactElement {
  // A level that is not one of the four (`errorCorrection={null}`, "high")
  // threw inside the encoder; it is the default one. A number is its digits.
  const asked = (['L', 'M', 'Q', 'H'] as const).find((own) => own === errorCorrection) ?? 'M';
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  // Text the level asked for cannot hold goes in at the strongest level that
  // can, and text no code holds is said, where the encoder threw "Data too
  // long" and the page showed an error box.
  const bytes = new TextEncoder().encode(text).length;
  const level = bytes <= CAPACITY[asked] ? asked : (['Q', 'M', 'L'] as const).find((own) => bytes <= CAPACITY[own]);
  if (!level) {
    return React.createElement(
      'div',
      {
        role: 'img',
        'aria-label': `${ariaLabel}: too long to encode`,
        className,
        style: { width: size, height: size, display: 'grid', placeItems: 'center', textAlign: 'center', fontSize: 12, border: '1px dashed currentColor', ...style },
      },
      'Too long for a QR code'
    );
  }
  return React.createElement(QRCodeCanvas, {
    value: text || ' ',
    size,
    fgColor: color,
    bgColor,
    level,
    marginSize: 4,
    className,
    style,
    // A canvas is nothing to a screen reader until it is named as an image.
    role: 'img',
    'aria-label': ariaLabel,
  });
}

export default QRCode;
