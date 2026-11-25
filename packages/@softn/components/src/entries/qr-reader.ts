/**
 * QR code camera scanner entry: @yudiel/react-qr-scanner (~140 KB minified)
 * and its bundled zxing-wasm reader (919 KB WASM). Kept in its own feature
 * chunk so apps using <Camera>, <Microphone>, <AudioStream>, or <QRCode>
 * never download the QR scanner or reference zxing_reader.wasm.
 */
export * from '../utility/QRReader';

import { QRReader } from '../utility/QRReader';

export const qrReaderComponents = { QRReader };
