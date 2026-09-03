/**
 * The three sounds Snake uses. Usage: node make-sfx.cjs
 *
 *   eat.wav  — a quick rising blip
 *   die.wav  — a falling buzz
 *   best.wav — two rising notes when a game ends on a new best
 */
const path = require('path');
const sfx = require('../../../scripts/sfx-lib.cjs');

const eat = sfx.tone(sfx.blank(0.09), { freq: (p) => 520 + 420 * p, len: 0.09, gain: 0.45, decay: 5, shape: 'tri' });

const die = sfx.blank(0.42);
sfx.tone(die, { freq: (p) => 300 - 220 * p, len: 0.42, gain: 0.4, decay: 3, shape: 'square' });
sfx.noise(die, { len: 0.2, gain: 0.25, cutoff: 0.2, decay: 8 });

const best = sfx.blank(0.5);
sfx.tone(best, { freq: 659, len: 0.18, gain: 0.35, decay: 5 });
sfx.tone(best, { at: 0.14, freq: 988, len: 0.34, gain: 0.35, decay: 5 });

sfx.writeAll(path.join(__dirname, '..'), { eat, die, best });
