/**
 * The three sounds 2048 uses. Usage: node make-sfx.cjs
 *
 *   merge.wav — a soft pop when tiles combine
 *   win.wav   — a rising three-note chime for the 2048 tile
 *   over.wav  — two falling notes when no move is left
 */
const path = require('path');
const sfx = require('../../../scripts/sfx-lib.cjs');

const merge = sfx.blank(0.08);
sfx.tone(merge, { freq: (p) => 720 - 160 * p, len: 0.08, gain: 0.3, decay: 7 });
sfx.noise(merge, { len: 0.02, gain: 0.15, cutoff: 0.6, decay: 10 });

const win = sfx.blank(0.7);
sfx.tone(win, { freq: 523, len: 0.25, gain: 0.3, decay: 4 });
sfx.tone(win, { at: 0.12, freq: 659, len: 0.25, gain: 0.3, decay: 4 });
sfx.tone(win, { at: 0.24, freq: 784, len: 0.25, gain: 0.3, decay: 4 });
sfx.tone(win, { at: 0.36, freq: 1047, len: 0.34, gain: 0.3, decay: 3 });

const over = sfx.blank(0.55);
sfx.tone(over, { freq: 392, len: 0.22, gain: 0.3, decay: 4, shape: 'tri' });
sfx.tone(over, { at: 0.2, freq: 262, len: 0.35, gain: 0.3, decay: 3, shape: 'tri' });

sfx.writeAll(path.join(__dirname, '..'), { merge, win, over });
