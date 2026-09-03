/**
 * Synthesizes the two sounds Blockscape uses, as 16-bit mono 22.05 kHz WAV:
 *
 *   assets/sfx/break.wav — a short crunch: filtered noise with a falling pitch
 *   assets/sfx/place.wav — a soft wooden knock: a damped low sine with a click
 *
 * Generated rather than recorded so the bundle carries nothing of unknown
 * provenance. Usage: node make-sfx.cjs
 */
const fs = require('fs');
const path = require('path');

const RATE = 22050;
const out = path.join(__dirname, '..', 'assets', 'sfx');
fs.mkdirSync(out, { recursive: true });

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

let seed = 7;
function rand() {
  seed = (seed * 48271) % 2147483647;
  return seed / 2147483647 - 0.5;
}

function crunch() {
  const n = Math.floor(RATE * 0.22);
  const s = new Float64Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const env = Math.pow(1 - t, 2.2);
    // A one-pole low-pass whose cutoff drops through the sound.
    const k = 0.55 - 0.45 * t;
    lp = lp + (rand() * 2 - lp) * k;
    s[i] = lp * env * 0.9 + Math.sin(i * 0.09) * env * 0.08;
  }
  return s;
}

function knock() {
  const n = Math.floor(RATE * 0.16);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = Math.exp(-t * 34);
    const f = 190 - 60 * (i / n);
    s[i] = Math.sin(2 * Math.PI * f * t) * env * 0.8 + (i < 90 ? rand() * 0.5 * (1 - i / 90) : 0);
  }
  return s;
}

fs.writeFileSync(path.join(out, 'break.wav'), wav(crunch()));
fs.writeFileSync(path.join(out, 'place.wav'), wav(knock()));
console.log('wrote break.wav and place.wav');
