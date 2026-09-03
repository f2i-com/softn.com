/**
 * The three sounds Maze Escape uses. Usage: node make-sfx.cjs
 *
 *   start.wav — a low rising tone as a maze opens
 *   found.wav — a soft tick when you step into a cell you have not seen
 *   win.wav   — a rising four-note chime at the exit
 */
const path = require('path');
const sfx = require('../../../scripts/sfx-lib.cjs');

const start = sfx.blank(0.5);
sfx.tone(start, { freq: (p) => 160 + 180 * p, len: 0.5, gain: 0.3, decay: 3, shape: 'tri' });

const found = sfx.blank(0.05);
sfx.tone(found, { freq: 1320, len: 0.05, gain: 0.12, decay: 9 });

const win = sfx.blank(0.9);
sfx.tone(win, { freq: 523, len: 0.3, gain: 0.3, decay: 4 });
sfx.tone(win, { at: 0.14, freq: 659, len: 0.3, gain: 0.3, decay: 4 });
sfx.tone(win, { at: 0.28, freq: 784, len: 0.3, gain: 0.3, decay: 4 });
sfx.tone(win, { at: 0.42, freq: 1047, len: 0.45, gain: 0.32, decay: 3 });

sfx.writeAll(path.join(__dirname, '..'), { start, found, win });
