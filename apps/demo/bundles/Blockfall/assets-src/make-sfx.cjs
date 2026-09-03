/**
 * The five sounds Blockfall uses. Usage: node make-sfx.cjs
 *
 *   lock.wav  — a dull thud as a piece settles
 *   drop.wav  — a short whoosh for a hard drop
 *   clear.wav — a rising sweep as lines vanish
 *   level.wav — two bright notes on a level up
 *   over.wav  — three falling notes at the top of the well
 */
const path = require('path');
const sfx = require('../../../scripts/sfx-lib.cjs');

const lock = sfx.blank(0.1);
sfx.tone(lock, { freq: (p) => 140 - 50 * p, len: 0.1, gain: 0.5, decay: 9 });
sfx.noise(lock, { len: 0.03, gain: 0.2, cutoff: 0.5, decay: 10 });

const drop = sfx.blank(0.14);
sfx.noise(drop, { len: 0.14, gain: 0.35, cutoff: (p) => 0.15 + 0.5 * p, decay: 5 });

const clear = sfx.blank(0.3);
sfx.tone(clear, { freq: (p) => 420 + 900 * p, len: 0.3, gain: 0.3, decay: 4, shape: 'tri' });
sfx.tone(clear, { at: 0.05, freq: (p) => 630 + 1300 * p, len: 0.25, gain: 0.15, decay: 4 });

const level = sfx.blank(0.45);
sfx.tone(level, { freq: 784, len: 0.2, gain: 0.3, decay: 5 });
sfx.tone(level, { at: 0.13, freq: 1175, len: 0.32, gain: 0.3, decay: 4 });

const over = sfx.blank(0.8);
sfx.tone(over, { freq: 440, len: 0.25, gain: 0.3, decay: 4, shape: 'tri' });
sfx.tone(over, { at: 0.22, freq: 349, len: 0.25, gain: 0.3, decay: 4, shape: 'tri' });
sfx.tone(over, { at: 0.44, freq: 262, len: 0.36, gain: 0.3, decay: 3, shape: 'tri' });

sfx.writeAll(path.join(__dirname, '..'), { lock, drop, clear, level, over });
