/**
 * Small synthesizer for the sound effects the demo games carry.
 *
 * Every game's `assets-src/make-sfx.cjs` builds its handful of sounds from
 * these primitives and writes 16-bit mono 22.05 kHz WAV files into
 * `assets/sfx/`. Generated rather than recorded so a bundle carries nothing
 * of unknown provenance, and so a sound can be tuned by editing a number.
 */
const fs = require('fs');
const path = require('path');

const RATE = 22050;

let seed = 7;
/** Deterministic noise in [-0.5, 0.5); the same seed gives the same file. */
function rand() {
  seed = (seed * 48271) % 2147483647;
  return seed / 2147483647 - 0.5;
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A buffer of `seconds` silence to draw into. */
function blank(seconds) {
  return new Float64Array(Math.floor(RATE * seconds));
}

/**
 * Add a tone. `freq` is a number or a function of progress 0..1; `shape` is
 * 'sine', 'square' or 'tri'; `decay` is the exponential envelope rate.
 */
function tone(buf, opts) {
  const start = Math.floor((opts.at || 0) * RATE);
  const n = Math.floor(opts.len * RATE);
  const gain = opts.gain === undefined ? 0.5 : opts.gain;
  const decay = opts.decay === undefined ? 8 : opts.decay;
  const shape = opts.shape || 'sine';
  const attack = Math.max(1, Math.floor((opts.attack || 0.004) * RATE));
  let phase = 0;
  for (let i = 0; i < n && start + i < buf.length; i++) {
    const p = i / n;
    const f = typeof opts.freq === 'function' ? opts.freq(p) : opts.freq;
    phase += (2 * Math.PI * f) / RATE;
    let v = Math.sin(phase);
    if (shape === 'square') v = v > 0 ? 0.6 : -0.6;
    if (shape === 'tri') v = (2 / Math.PI) * Math.asin(v);
    const env = Math.exp(-p * decay) * Math.min(1, i / attack) * (1 - Math.pow(p, 12));
    buf[start + i] += v * env * gain;
  }
  return buf;
}

/** Add filtered noise; `cutoff` is a number or a function of progress 0..1. */
function noise(buf, opts) {
  const start = Math.floor((opts.at || 0) * RATE);
  const n = Math.floor(opts.len * RATE);
  const gain = opts.gain === undefined ? 0.5 : opts.gain;
  const decay = opts.decay === undefined ? 6 : opts.decay;
  let lp = 0;
  for (let i = 0; i < n && start + i < buf.length; i++) {
    const p = i / n;
    const k = typeof opts.cutoff === 'function' ? opts.cutoff(p) : (opts.cutoff || 0.3);
    lp = lp + (rand() * 2 - lp) * k;
    buf[start + i] += lp * Math.exp(-p * decay) * gain;
  }
  return buf;
}

/** Write a set of sounds into `<bundleDir>/assets/sfx/`. */
function writeAll(bundleDir, sounds) {
  const out = path.join(bundleDir, 'assets', 'sfx');
  fs.mkdirSync(out, { recursive: true });
  const names = Object.keys(sounds);
  for (const name of names) {
    fs.writeFileSync(path.join(out, name + '.wav'), wav(sounds[name]));
  }
  console.log('wrote ' + names.map((n) => n + '.wav').join(', ') + ' to ' + out);
}

module.exports = { RATE, rand, wav, blank, tone, noise, writeAll };
