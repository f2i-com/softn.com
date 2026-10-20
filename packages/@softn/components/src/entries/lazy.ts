/**
 * The runtime's registration: the minimal set now, everything else by loader.
 *
 * softn-web and softn-single both boot through registerRuntimeComponents(),
 * so the two hosts agree on which names load when. Each loader is a dynamic
 * import of one of this package's own feature entries — never of the root
 * barrel, which would fetch every feature to pick one out of it — followed
 * by the named export, so the registry receives the component itself.
 *
 * The map below names every built-in that is not in the minimal set. A
 * test holds it equal to registry.ts's eager `builtinComponents`, so a
 * component added to a feature entry without a line here fails the suite
 * rather than silently disappearing from the runtime.
 */

import type { ComponentRegistry, SoftNComponent, SoftNComponentLoader } from '@softn/core';
import { getDefaultRegistry } from '@softn/core';
import { minimalComponents } from './minimal';

export interface LazyComponentRegistration {
  /** The feature entry the loader fetches: `charts`, `scene3d`, … */
  feature: string;
  load: SoftNComponentLoader;
}

// One import() per feature, so every name of a feature shares the module
// promise and the browser fetches its chunk once.
const charts = () => import('./charts');
const editors = () => import('./editors');
const smart = () => import('./smart');
const media = () => import('./media');
const animation = () => import('./animation');
const scene3d = () => import('./scene3d');
const pickers = () => import('./pickers');
const games = () => import('./games');

// `keyof M` ties each name to an export of its entry, so a renamed export is
// a type error here rather than an "Element type is invalid" in a browser.
function fromFeature<M extends object>(
  feature: string,
  load: () => Promise<M>,
  key: keyof M & string
): LazyComponentRegistration {
  return {
    feature,
    load: () => load().then((m) => m[key] as unknown as SoftNComponent),
  };
}

/**
 * Every built-in outside the minimal set, by registry name.
 */
export const lazyComponentRegistrations: Record<string, LazyComponentRegistration> = {
  // Charts (SVG; ~30 KB minified)
  LineChart: fromFeature('charts', charts, 'LineChart'),
  BarChart: fromFeature('charts', charts, 'BarChart'),
  PieChart: fromFeature('charts', charts, 'PieChart'),
  AreaChart: fromFeature('charts', charts, 'AreaChart'),
  RadarChart: fromFeature('charts', charts, 'RadarChart'),
  GaugeChart: fromFeature('charts', charts, 'GaugeChart'),

  // Animation (~19 KB minified)
  AnimatedBox: fromFeature('animation', animation, 'AnimatedBox'),
  AnimatedNumber: fromFeature('animation', animation, 'AnimatedNumber'),
  Marquee: fromFeature('animation', animation, 'Marquee'),
  Typewriter: fromFeature('animation', animation, 'Typewriter'),
  Draggable: fromFeature('animation', animation, 'Draggable'),
  SortableList: fromFeature('animation', animation, 'SortableList'),
  PanView: fromFeature('animation', animation, 'PanView'),
  Sprite: fromFeature('animation', animation, 'Sprite'),
  TileMap: fromFeature('animation', animation, 'TileMap'),

  // Editors (~17 KB minified)
  CodeEditor: fromFeature('editors', editors, 'CodeEditor'),
  MarkdownEditor: fromFeature('editors', editors, 'MarkdownEditor'),
  RichTextEditor: fromFeature('editors', editors, 'RichTextEditor'),

  // 3D: Scene3D and, through it, Three.js, four model loaders and the
  // post-processing passes — the reason this file exists.
  Scene3D: fromFeature('scene3d', scene3d, 'Scene3D'),

  // Smart components (~60 KB minified)
  SmartGrid: fromFeature('smart', smart, 'SmartGrid'),
  SmartView: fromFeature('smart', smart, 'SmartView'),
  SmartForm: fromFeature('smart', smart, 'SmartForm'),
  SmartStats: fromFeature('smart', smart, 'SmartStats'),
  SmartCards: fromFeature('smart', smart, 'SmartCards'),
  SmartList: fromFeature('smart', smart, 'SmartList'),
  SmartTimeline: fromFeature('smart', smart, 'SmartTimeline'),

  // Media: the camera, the microphone, the audio streamer and the QR pair,
  // whose scanner alone is ~140 KB minified before its WASM decoder.
  Camera: fromFeature('media', media, 'Camera'),
  Microphone: fromFeature('media', media, 'Microphone'),
  AudioStream: fromFeature('media', media, 'AudioStream'),
  QRCode: fromFeature('media', media, 'QRCode'),
  QRReader: fromFeature('media', media, 'QRReader'),

  // The date and colour pickers (~15 KB minified)
  DatePicker: fromFeature('pickers', pickers, 'DatePicker'),
  ColorPicker: fromFeature('pickers', pickers, 'ColorPicker'),

  // What games are drawn with (~12 KB minified)
  PixelGrid: fromFeature('games', games, 'PixelGrid'),
  PixelCanvas: fromFeature('games', games, 'PixelCanvas'),
  DPad: fromFeature('games', games, 'DPad'),
};

/**
 * What a component fetches later than its feature's chunk, when a page first
 * uses it a particular way: Scene3D's model loaders, controls and effects,
 * QRReader's decoder. A host installing an app for offline use runs these for
 * the components the app names, so what the app may ask for later is already
 * held; nothing else calls them.
 */
export const offlineExtras: Record<string, () => Promise<void>> = {
  Scene3D: () => scene3d().then((m) => m.preloadScene3DAddons()),
  QRReader: () => media().then((m) => m.preloadQrDecoder()),
};

/** Every name registerRuntimeComponents() registers, eager and lazy alike. */
export const runtimeComponentNames: readonly string[] = [
  ...Object.keys(minimalComponents),
  ...Object.keys(lazyComponentRegistrations),
];

/**
 * Register the built-ins the way the browser hosts do: the minimal set
 * eagerly, every other component as a loader. The default registry is the
 * one SoftNRenderer reads.
 */
export function registerRuntimeComponents(
  registry: ComponentRegistry = getDefaultRegistry()
): void {
  registry.registerAll(minimalComponents as unknown as Record<string, SoftNComponent>);
  for (const [name, { feature, load }] of Object.entries(lazyComponentRegistrations)) {
    registry.registerLazy(name, load, { feature });
  }
}

const registeredOnce = new WeakSet<ComponentRegistry>();

/**
 * registerRuntimeComponents(), once per registry: for code that can run more
 * than once in a page, such as every module @softn/vite-plugin compiles, where
 * registering again would start every feature's load over.
 */
export function ensureRuntimeComponents(
  registry: ComponentRegistry = getDefaultRegistry()
): void {
  if (registeredOnce.has(registry)) return;
  registeredOnce.add(registry);
  registerRuntimeComponents(registry);
}
