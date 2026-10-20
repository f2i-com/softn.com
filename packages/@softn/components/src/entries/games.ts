/**
 * What a game is drawn with: a pixel canvas and a pixel grid, and an
 * on-screen direction pad. About 12 KB minified; an app that is a game is the
 * exception, not the rule.
 */
export * from '../utility/PixelGrid';
export * from '../utility/PixelCanvas';
export * from '../utility/DPad';

import { PixelGrid } from '../utility/PixelGrid';
import { PixelCanvas } from '../utility/PixelCanvas';
import { DPad } from '../utility/DPad';

export const gameComponents = { PixelGrid, PixelCanvas, DPad };
