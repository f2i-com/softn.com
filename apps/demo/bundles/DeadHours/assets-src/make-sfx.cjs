/**
 * Synthesizes every sound Dead Hours uses, as 16-bit mono 22.05 kHz WAV:
 *
 *   pistol   a sharp noise crack with a low thump
 *   shotgun  a longer, deeper crack with more body
 *   reload   two mechanical clicks
 *   click    the dry click of an empty gun
 *   hit      a short wet thud
 *   groan    a wobbling low voice
 *   hurt     a dull impact with a descending tone
 *   wave     a rising two-note horn
 *   pickup   a bright ascending chime
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

let seed = 11;
function rand() {
  seed = (seed * 48271) % 2147483647;
  return seed / 2147483647 - 0.5;
}

function make(seconds, fn) {
  const n = Math.floor(RATE * seconds);
  const s = new Float64Array(n);
  let state = { lp: 0 };
  for (let i = 0; i < n; i++) s[i] = fn(i / RATE, i / n, state);
  return s;
}

const pistol = make(0.28, (t, u, st) => {
  st.lp = st.lp + (rand() * 2 - st.lp) * (0.9 - 0.7 * u);
  const crack = st.lp * Math.pow(1 - u, 3.5) * 1.1;
  const thump = Math.sin(2 * Math.PI * (90 - 50 * u) * t) * Math.exp(-t * 26) * 0.7;
  return crack + thump;
});

const shotgun = make(0.5, (t, u, st) => {
  st.lp = st.lp + (rand() * 2 - st.lp) * (0.7 - 0.55 * u);
  const crack = st.lp * Math.pow(1 - u, 2.6) * 1.2;
  const thump = Math.sin(2 * Math.PI * (60 - 30 * u) * t) * Math.exp(-t * 12) * 0.9;
  return crack + thump;
});

const reload = make(0.5, (t, u) => {
  let v = 0;
  for (const at of [0.04, 0.3]) {
    const dt = t - at;
    if (dt >= 0 && dt < 0.06) v += rand() * 1.4 * Math.exp(-dt * 90) + Math.sin(2 * Math.PI * 1400 * dt) * Math.exp(-dt * 120) * 0.4;
  }
  return v;
});

const click = make(0.08, (t) => rand() * Math.exp(-t * 140) * 0.9 + Math.sin(2 * Math.PI * 900 * t) * Math.exp(-t * 200) * 0.5);

const hit = make(0.16, (t, u, st) => {
  st.lp = st.lp + (rand() * 2 - st.lp) * 0.25;
  return st.lp * Math.pow(1 - u, 2) * 0.9 + Math.sin(2 * Math.PI * 140 * t) * Math.exp(-t * 30) * 0.5;
});

const groan = make(0.9, (t, u) => {
  const f = 95 + Math.sin(t * 9) * 12 - u * 25;
  const env = Math.sin(Math.PI * Math.min(1, u * 1.2)) * (1 - u * 0.3);
  const voice = Math.sin(2 * Math.PI * f * t) * 0.5 + Math.sin(2 * Math.PI * f * 2.01 * t) * 0.25 + Math.sin(2 * Math.PI * f * 3.02 * t) * 0.12;
  const breath = rand() * 0.12;
  return (voice + breath) * env * 0.8;
});

const hurt = make(0.35, (t, u, st) => {
  st.lp = st.lp + (rand() * 2 - st.lp) * 0.2;
  return st.lp * Math.pow(1 - u, 2) * 0.7 + Math.sin(2 * Math.PI * (220 - 120 * u) * t) * Math.exp(-t * 9) * 0.6;
});

const wave = make(1.2, (t, u) => {
  const f = t < 0.5 ? 196 : 262;
  const env = t < 0.5 ? Math.min(1, t * 12) * (1 - (t / 0.5) * 0.3) : Math.min(1, (t - 0.5) * 12) * Math.pow(1 - (t - 0.5) / 0.7, 1.4);
  const tone = Math.sin(2 * Math.PI * f * t) * 0.5 + Math.sin(2 * Math.PI * f * 2 * t) * 0.2 + Math.sin(2 * Math.PI * f * 3 * t) * 0.1 + (Math.sin(2 * Math.PI * f * t) > 0 ? 0.15 : -0.15);
  return tone * env * 0.7;
});

const pickup = make(0.35, (t) => {
  const f = t < 0.12 ? 660 : t < 0.24 ? 880 : 1320;
  const seg = t < 0.12 ? t : t < 0.24 ? t - 0.12 : t - 0.24;
  return Math.sin(2 * Math.PI * f * t) * Math.exp(-seg * 22) * 0.6;
});

const files = { pistol, shotgun, reload, click, hit, groan, hurt, wave, pickup };
for (const [name, samples] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, `${name}.wav`), wav(samples));
}
console.log('wrote', Object.keys(files).join(', '));
