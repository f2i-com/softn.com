/**
 * The components that reach a device: the camera, the microphone, the audio
 * streamer, and the QR pair with their dependencies — @rc-component/qrcode
 * for drawing one, @yudiel/react-qr-scanner for reading one, which alone is
 * ~140 KB minified and fetches a WASM decoder when it runs. Each of these
 * also sits behind a capability the user has to grant, so an app that never
 * asks never downloads them.
 */
export * from '../utility/Camera';
export * from '../utility/Microphone';
export * from '../utility/AudioStream';
export * from '../utility/QRCode';
export * from '../utility/QRReader';

import { Camera } from '../utility/Camera';
import { Microphone } from '../utility/Microphone';
import { AudioStream } from '../utility/AudioStream';
import { QRCode } from '../utility/QRCode';
import { QRReader } from '../utility/QRReader';

export const mediaComponents = { Camera, Microphone, AudioStream, QRCode, QRReader };
