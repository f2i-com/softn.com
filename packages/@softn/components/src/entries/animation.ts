/**
 * The motion primitives and the game pair (Sprite, TileMap). About 19 KB
 * minified — a tenth of the minimal set, and used by games and showcases
 * rather than by forms — so it is fetched when a document names one.
 */
export * from '../animation';

import { AnimatedBox } from '../animation/AnimatedBox';
import { AnimatedNumber } from '../animation/AnimatedNumber';
import { Marquee } from '../animation/Marquee';
import { Typewriter } from '../animation/Typewriter';
import { Draggable } from '../animation/Draggable';
import { SortableList } from '../animation/SortableList';
import { PanView } from '../animation/PanView';
import { Sprite } from '../animation/Sprite';
import { TileMap } from '../animation/TileMap';

export const animationComponents = {
  AnimatedBox,
  AnimatedNumber,
  Marquee,
  Typewriter,
  Draggable,
  SortableList,
  PanView,
  Sprite,
  TileMap,
};
