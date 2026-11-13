/**
 * What a game is drawn with and played with: a pixel canvas and a pixel
 * grid, an on-screen direction pad, and the controls that keep what the
 * player holds (keys, a gamepad). About 16 KB minified; an app that is a
 * game is the exception, not the rule.
 */
export * from '../utility/PixelGrid';
export * from '../utility/PixelCanvas';
export * from '../utility/DPad';
export * from '../utility/Controls';

import { PixelGrid } from '../utility/PixelGrid';
import { PixelCanvas } from '../utility/PixelCanvas';
import { DPad } from '../utility/DPad';
import { Controls } from '../utility/Controls';

export const gameComponents = { PixelGrid, PixelCanvas, DPad, Controls };
