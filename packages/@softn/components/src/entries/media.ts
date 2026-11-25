/**
 * The components that reach a device: the camera, the microphone, the audio
 * streamer, and QR code rendering (@rc-component/qrcode). QRReader lives in
 * its own `qr-reader` entry so apps that don't scan QR codes never download
 * @yudiel/react-qr-scanner (~140 KB) or reference zxing_reader.wasm (919 KB).
 */
export * from '../utility/Camera';
export * from '../utility/Microphone';
export * from '../utility/AudioStream';
export * from '../utility/QRCode';

import { Camera } from '../utility/Camera';
import { Microphone } from '../utility/Microphone';
import { AudioStream } from '../utility/AudioStream';
import { QRCode } from '../utility/QRCode';

export const mediaComponents = { Camera, Microphone, AudioStream, QRCode };
