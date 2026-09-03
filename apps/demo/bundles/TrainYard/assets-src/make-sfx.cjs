/**
 * The one sound the train yard carries. Usage: node make-sfx.cjs
 *
 *   whistle.wav — a three-chime steam whistle: three tones a minor-sixth
 *   chord apart, each with a little vibrato, that scoop up as the steam
 *   pressure rises and sag as the valve closes, over a bed of hiss.
 *   Runs 1.8 s, which is how long the plunger stays lit in the logic.
 */
const path = require('path');
const sfx = require('../../../scripts/sfx-lib.cjs');

const LEN = 1.8;
const whistle = sfx.blank(LEN + 0.2);

// Pitch shaping shared by every chime: a quick scoop up at the start, a
// slow 5.5 Hz vibrato through the sustain, and a droop over the last 15%.
function shaped(base) {
  return (p) => {
    const scoop = 0.94 + 0.06 * Math.min(1, p * 9);
    const droop = 1 - 0.06 * Math.max(0, (p - 0.85) / 0.15);
    const vib = 1 + 0.0045 * Math.sin(p * LEN * 2 * Math.PI * 5.5);
    return base * scoop * droop * vib;
  };
}

const chimes = [311.1, 370.0, 466.2]; // Eb4, F#4, Bb4
for (const f of chimes) {
  sfx.tone(whistle, { freq: shaped(f), len: LEN, gain: 0.22, decay: 0.55, attack: 0.09 });
  sfx.tone(whistle, { freq: shaped(f * 2), len: LEN, gain: 0.07, decay: 0.9, attack: 0.09 });
  sfx.tone(whistle, { freq: shaped(f * 3), len: LEN, gain: 0.025, decay: 1.4, attack: 0.09 });
}
// Steam hiss: strongest as the valve opens, then a quieter bed under the chord.
sfx.noise(whistle, { len: 0.35, gain: 0.16, decay: 6, cutoff: 0.5 });
sfx.noise(whistle, { len: LEN, gain: 0.045, decay: 1.2, cutoff: 0.25 });

sfx.writeAll(path.join(__dirname, '..'), { whistle });
