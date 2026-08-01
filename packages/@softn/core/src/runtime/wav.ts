/**
 * PCM to WAV.
 *
 * Recorded sound leaves SoftN as an uncompressed 16-bit WAV data URL, not as
 * whatever MediaRecorder happens to produce. MediaRecorder gives you Opus, and
 * Opus is a *speech* codec — it reproduces what a voice sounds like, not what
 * the waveform was. Fine for a voice note, useless for anything that treats
 * sound as a signal. A WAV is what came off the microphone, so it can be
 * played, saved, or taken apart again sample by sample.
 *
 * Shared by the Microphone component and the `softn.mic.*` host API so the two
 * routes cannot drift into producing different files from the same audio.
 */

/** Number of bytes a WAV header occupies before the samples start. */
export const WAV_HEADER_BYTES = 44;

/**
 * Mono 16-bit PCM WAV bytes, header and all.
 *
 * Synchronous by construction: the Blob/FileReader route would resolve a tick
 * later, after the caller had already been told the recording had ended.
 */
export function pcmToWavBytes(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // format: uncompressed PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i += 1) {
    // Clamp before scaling: a sample above 1 would wrap round to a large
    // negative 16-bit value, which is heard as a click rather than as clipping.
    const clamped = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
    view.setInt16(WAV_HEADER_BYTES + i * 2, Math.round(clamped * 32767), true);
  }

  return new Uint8Array(buffer);
}

/** The same WAV, as a `data:` URL any `<audio>` or `softn.audio.play` will take. */
export function pcmToWavDataUrl(samples: Float32Array, sampleRate: number): string {
  const bytes = pcmToWavBytes(samples, sampleRate);
  let binary = '';
  // In chunks, because `String.fromCharCode(...bytes)` spreads every byte as an
  // argument and blows the call stack somewhere around a second of audio.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}
