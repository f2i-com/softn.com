/**
 * WarbleWire protocol round trips.
 *
 * The bundle's warble.logic is a transliteration of the TypeScript modem at
 * qxw.org, so the thing worth guarding is that it still agrees with the
 * protocol it was copied from — a transliteration breaks quietly. A dropped
 * `>>> 0`, a `>>` where the original had `>>>`, an off-by-one in the pilot
 * schedule: each of those still encodes something, still decodes something,
 * and produces a signal no other WarbleWire implementation can read.
 *
 * Runs the real file in a Node vm rather than through zipp, so it needs no
 * extra toolchain. The two base64 helpers zipp has and V8 does not are
 * polyfilled in; everything else the file uses exists in both.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');

const logicPath = path.join(__dirname, '..', 'bundles', 'WarbleWire', 'logic', 'warble.logic');
const source = fs.readFileSync(logicPath, 'utf8');

/**
 * zipp implements the ES2026 Uint8Array base64 proposal; Node 24 does not. The
 * .logic file is right to use it — this is the shim that lets V8 run it.
 *
 * It has to be evaluated *inside* the vm context: a context is its own realm
 * with its own Uint8Array, so patching the prototype out here would leave the
 * one the script actually constructs untouched.
 */
const BASE64_SHIM = `
if (typeof Uint8Array.prototype.toBase64 !== 'function') {
  Uint8Array.prototype.toBase64 = function () {
    var out = '';
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var i = 0;
    for (; i + 2 < this.length; i += 3) {
      var n = (this[i] << 16) | (this[i + 1] << 8) | this[i + 2];
      out += alphabet[(n >>> 18) & 63] + alphabet[(n >>> 12) & 63] + alphabet[(n >>> 6) & 63] + alphabet[n & 63];
    }
    if (i + 1 === this.length) {
      var a = this[i] << 16;
      out += alphabet[(a >>> 18) & 63] + alphabet[(a >>> 12) & 63] + '==';
    } else if (i + 2 === this.length) {
      var b = (this[i] << 16) | (this[i + 1] << 8);
      out += alphabet[(b >>> 18) & 63] + alphabet[(b >>> 12) & 63] + alphabet[(b >>> 6) & 63] + '=';
    }
    return out;
  };
}
if (typeof Uint8Array.fromBase64 !== 'function') {
  Uint8Array.fromBase64 = function (text) {
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var clean = String(text).replace(/[^A-Za-z0-9+/]/g, '');
    var out = new Uint8Array((clean.length * 3) >> 2);
    var acc = 0, bits = 0, at = 0;
    for (var i = 0; i < clean.length; i++) {
      acc = (acc << 6) | alphabet.indexOf(clean[i]);
      bits += 6;
      if (bits >= 8) { bits -= 8; out[at++] = (acc >>> bits) & 0xff; }
    }
    return out.subarray(0, at);
  };
}
`;

// Top-level `let` in a script is a lexical binding, not a property of the
// global object, so nothing declared that way is reachable from outside the
// script. SoftN gets at them through the VM's symbol table; here the same
// bindings are collected by appending an object literal to the source, which
// is evaluated inside their scope and so can see them all.
const exported = [];
for (const match of source.matchAll(/^(?:let|const|function)\s+([A-Za-z_$][\w$]*)/gm)) {
  if (!exported.includes(match[1])) exported.push(match[1]);
}
assert.ok(exported.length > 40, 'expected to find the module surface; the scan found ' + exported.length);

const sandbox = { Math, Date, JSON, print: () => {}, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(BASE64_SHIM, sandbox, { filename: 'base64-shim.js' });
vm.runInContext(
  `${source}\n;globalThis.__exports = { ${exported.join(', ')} };\n`,
  sandbox,
  { filename: 'warble.logic' }
);

const W = sandbox.__exports;
let checks = 0;
const check = (label, fn) => {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
};

console.log('UTF-8');
check('round trips ASCII, accents and an astral pair', () => {
  for (const text of ['hi', 'caffè latte', 'a — b', '\u{1F426} warble']) {
    assert.equal(W.utf8Decode(W.utf8Encode(text)), text);
  }
});
check('counts bytes, not characters', () => {
  assert.equal(W.utf8Encode('abc').length, 3);
  assert.equal(W.utf8Encode('è').length, 2);
  assert.equal(W.utf8Encode('\u{1F426}').length, 4);
});
check('refuses invalid UTF-8 rather than inventing characters', () => {
  // The TypeScript original decodes with {fatal:true} and the caller relies on
  // that failing — a lone continuation byte must not come back as U+FFFD.
  assert.throws(() => W.utf8Decode(new Uint8Array([0x80, 0x41])));
});

console.log('Coding');
check('convolutional encode then Viterbi recovers the input', () => {
  const bits = new Uint8Array(W.CONVOLUTIONAL_INPUT_BITS);
  for (let i = 0; i < W.FRAME_BIT_COUNT; i += 1) bits[i] = (i * 7 + 3) % 5 === 0 ? 1 : 0;
  const coded = W.convolutionalEncode(bits);
  assert.equal(coded.length, W.ENCODED_BIT_COUNT);
  const soft = new Float32Array(coded.length);
  for (let i = 0; i < coded.length; i += 1) soft[i] = coded[i] ? 8 : -8;
  const out = W.viterbiDecodeSoft(soft);
  for (let i = 0; i < bits.length; i += 1) assert.equal(out[i], bits[i], `bit ${i}`);
});
check('Viterbi still recovers the input with bits flipped', () => {
  const bits = new Uint8Array(W.CONVOLUTIONAL_INPUT_BITS);
  for (let i = 0; i < W.FRAME_BIT_COUNT; i += 1) bits[i] = i % 3 === 0 ? 1 : 0;
  const coded = W.convolutionalEncode(bits);
  const soft = new Float32Array(coded.length);
  for (let i = 0; i < coded.length; i += 1) soft[i] = coded[i] ? 8 : -8;
  for (const at of [11, 97, 300, 601, 900]) soft[at] = -soft[at];
  const out = W.viterbiDecodeSoft(soft);
  for (let i = 0; i < bits.length; i += 1) assert.equal(out[i], bits[i], `bit ${i}`);
});
check('interleave and deinterleave are inverses', () => {
  const bits = new Uint8Array(W.ENCODED_BIT_COUNT);
  for (let i = 0; i < bits.length; i += 1) bits[i] = i % 2;
  const back = W.deinterleaveBits(W.interleaveBits(bits));
  for (let i = 0; i < bits.length; i += 1) assert.equal(back[i], bits[i], `bit ${i}`);
});

console.log('Frames');
check('build then parse preserves the payload and the profile', () => {
  const payload = W.utf8Encode('frame check');
  const frame = W.buildWarbleFrame(payload, { speedId: 'finch', voiceId: 'night' });
  assert.equal(frame.length, W.FRAME_BYTES);
  const parsed = W.parseWarbleFrame(frame);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.speedId, 'finch');
  assert.equal(parsed.voiceId, 'night');
  assert.equal(W.utf8Decode(parsed.payload), 'frame check');
});
check('a corrupted frame fails its checksum instead of decoding', () => {
  const frame = W.buildWarbleFrame(W.utf8Encode('tamper me'), {});
  frame[20] = frame[20] ^ 0xff;
  assert.equal(W.parseWarbleFrame(frame).ok, false);
});

console.log('Round trips');
const MESSAGE = 'Meet me by the old gum tree.';
for (const speed of ['wren', 'finch', 'swift']) {
  for (const voice of ['meadow', 'canopy', 'dawn', 'night']) {
    check(`${speed} · ${voice}`, () => {
      const enc = W.encodeWarbleMessage(MESSAGE, { speedId: speed, voiceId: voice });
      assert.equal(enc.speedId, speed);
      assert.equal(enc.voiceId, voice);
      assert.equal(enc.symbols.length, W.TOTAL_SYMBOL_COUNT);
      const dec = W.decodeWarblePcm(enc.pcm);
      assert.equal(dec.ok, true, dec.reason);
      assert.equal(dec.text, MESSAGE);
      // The decoder is not told which profile to expect; it works it out from
      // the pilots and the frame header, so this is a real detection check.
      assert.equal(dec.speedId, speed);
      assert.equal(dec.voiceId, voice);
    });
  }
}
check('survives a noisy channel', () => {
  const enc = W.encodeWarbleMessage(MESSAGE, {});
  const noisy = W.addSeededNoise(enc.pcm.slice(), 18, 0x717877);
  const dec = W.decodeWarblePcm(noisy);
  assert.equal(dec.ok, true, dec.reason);
  assert.equal(dec.text, MESSAGE);
});
check('rejects noise on its own rather than inventing a message', () => {
  const silence = new Float32Array(W.TOTAL_PCM_SAMPLES);
  const junk = W.addSeededNoise(silence, 0, 99);
  assert.equal(W.decodeWarblePcm(junk).ok, false);
});

console.log('WAV');
check('a WAV data URL round trips to the samples that went in', () => {
  const enc = W.encodeWarbleMessage('wav check', {});
  const parsed = W.pcmFromWavDataUrl(W.wavDataUrl(enc.pcm, 48000));
  assert.equal(parsed.sampleRate, 48000);
  assert.equal(parsed.pcm.length, enc.pcm.length);
  for (let i = 0; i < enc.pcm.length; i += 200) {
    // Quantisation is the only loss allowed here. The budget is a bit over one
    // LSB: half from rounding, and the rest because the encoder scales by 32767
    // while the decoder divides by 32768 — the usual asymmetry of a range that
    // runs -32768..32767. Measured worst case is 3.2e-5.
    assert.ok(Math.abs(parsed.pcm[i] - enc.pcm[i]) < 1e-4, `sample ${i}`);
  }
});
check('a decoded WAV still decodes as a frame', () => {
  const enc = W.encodeWarbleMessage(MESSAGE, {});
  const parsed = W.pcmFromWavDataUrl(W.wavDataUrl(enc.pcm, 48000));
  assert.equal(W.decodeWarblePcm(parsed.pcm).text, MESSAGE);
});

console.log('Acquisition');
check('finds a burst buried in a longer, quieter recording', () => {
  // This is the whole over-the-air case. The exact-buffer decoder infers the
  // tempo from the buffer length and assumes the frame starts at sample 0;
  // neither is true of anything a microphone captured.
  const enc = W.encodeWarbleMessage(MESSAGE, { speedId: 'wren', voiceId: 'dawn' });
  const lead = 19200; // 0.4 s of room before the bird
  const heard = new Float32Array(lead + enc.pcm.length + 12000);
  for (let i = 0; i < enc.pcm.length; i += 1) heard[lead + i] = enc.pcm[i] * 0.6;
  const noisy = W.addSeededNoise(heard, 30, 4242);

  const found = W.findFrameOffset(noisy, 'wren', 'dawn');
  assert.ok(Math.abs(found.offset - lead) <= 8, `offset ${found.offset}, wanted ~${lead}`);

  const dec = W.decodeCapturedPcm(noisy, 48000);
  assert.equal(dec.ok, true, dec.reason);
  assert.equal(dec.text, MESSAGE);
  assert.equal(dec.voiceId, 'dawn');
});
check('a recording at the wrong sample rate is resampled, not rejected', () => {
  // Browsers hand back 44100 even when 48000 is asked for, and every constant
  // in this protocol assumes 48000. This is the harsher of the two ways that
  // can happen — a signal resampled down and then back up, so it pays the
  // interpolation twice; a device that genuinely sampled the air at 44100 pays
  // it once. Measured round-trip fidelity through the pair is about 81 dB.
  const enc = W.encodeWarbleMessage('rate check', {});
  const at44k = W.resamplePcm(enc.pcm, 48000, 44100);
  // Real recordings have some room either side of the burst; a clip trimmed to
  // exactly one frame is not what a microphone produces.
  const withTail = new Float32Array(at44k.length + 8000);
  withTail.set(at44k, 2000);
  const dec = W.decodeCapturedPcm(withTail, 44100);
  assert.equal(dec.ok, true, dec.reason);
  assert.equal(dec.text, 'rate check');
});
check('an empty room decodes as nothing, not as a message', () => {
  assert.equal(W.decodeCapturedPcm(new Float32Array(48000 * 2), 48000).ok, false);
});

console.log(`\n${checks} checks passed.`);
