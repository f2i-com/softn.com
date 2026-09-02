/**
 * PixelCanvas Component
 *
 * The dense counterpart to PixelGrid. PixelGrid draws a sparse set of
 * {x, y, color} cells as DOM nodes, which is right for a snake board or a Game
 * of Life at chunky cell sizes and wrong the moment every pixel is lit: 23040
 * absolutely-positioned divs measured ~54ms a frame, so a full-screen bitmap
 * tops out well under 10fps. This one hands the whole image to the compositor
 * in a single `putImageData` and holds 60fps.
 *
 * It knows nothing about what it is showing. A mandelbrot, a plasma, a cellular
 * automaton, a decoded video frame and an emulator's framebuffer are all the
 * same thing to it: some bytes, a size, and optionally a palette.
 *
 * Two shapes of bytes are accepted, and a frame may say which it is:
 *
 *   - `p8`   — one byte per pixel, an index into `palette`. Cheapest across the
 *              scripting boundary: a 160x144 frame is 23040 bytes.
 *   - `rgba` — four bytes per pixel, no palette needed.
 *
 * The loop never touches React state. Everything mutable lives in refs and the
 * only thing that changes per frame is the contents of one reused
 * `Uint8ClampedArray` — the same zero-rerender pattern Sprite uses for its
 * background-position animation, applied to a whole bitmap instead of a style.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/* -------------------------------------------------------------------------- */
/* Frame shapes                                                               */
/* -------------------------------------------------------------------------- */

/** A palette entry: a CSS colour, or `[r, g, b]` / `[r, g, b, a]` 0-255. */
export type PixelCanvasColor = string | readonly number[];

/**
 * The rich form a frame source may return, for producers that need to say more
 * than "here are the bytes" — a size that changes, a palette that changes, or a
 * frame counter that lets the canvas skip a repaint it does not need.
 *
 * Every field is optional; anything missing falls back to the component's props.
 */
export interface PixelCanvasFrame {
  /** Logical width of this frame; overrides the `width` prop when present. */
  w?: number;
  /** Logical height of this frame; overrides the `height` prop when present. */
  h?: number;
  /** `"p8"` (one byte per pixel) or `"rgba"` (four). Inferred when absent. */
  format?: string;
  /** The frame's bytes, base64. */
  pixels?: string;
  /**
   * Palette for `p8` frames: base64 RGB triples (3 bytes an entry), or an array
   * of `PixelCanvasColor`. Overrides the `palette` prop for as long as it is
   * supplied.
   */
  palette?: string | readonly PixelCanvasColor[];
  /**
   * Bumped by the producer only when `palette` actually changed. The palette is
   * decoded and re-packed only when this changes, so a producer that sends the
   * same palette every frame costs nothing.
   */
  paletteRev?: number;
  /**
   * Producer's frame counter. When it is unchanged from the previous call the
   * canvas skips the decode and the repaint entirely — a producer that is
   * paced slower than the display gets this for free.
   */
  frame?: number;
}

/**
 * What a frame source hands back. A bare base64 string is the whole of it for
 * simple producers; `null`/`undefined` means "nothing new, keep what is up".
 */
export type PixelCanvasSource = string | PixelCanvasFrame | null | undefined;

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/** Refuse absurd dimensions rather than asking the browser for a 4GB surface. */
const MAX_DIMENSION = 8192;
/** 16M pixels is a 64MB RGBA surface, which is already generous. */
const MAX_PIXELS = 1 << 24;

/* -------------------------------------------------------------------------- */
/* Byte packing                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Whether a `Uint32Array` view over the pixel buffer stores the low byte first.
 *
 * Writing a whole pixel as one 32-bit store is the difference between one
 * memory op per pixel and four, and it is the reason the p8 expansion loop is
 * cheap. It does mean the component has to know which end the red channel
 * lands on. Every shipping target is little-endian, but the probe costs one
 * allocation at module load and removes an assumption.
 */
const LITTLE_ENDIAN = (() => {
  const probe = new Uint32Array([0x11223344]);
  return new Uint8Array(probe.buffer)[0] === 0x44;
})();

/** Pack 0-255 channels into one word laid out the way ImageData reads it. */
function packRgba(r: number, g: number, b: number, a: number): number {
  return LITTLE_ENDIAN
    ? (((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff)) >>> 0
    : (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (a & 0xff)) >>> 0;
}

/* -------------------------------------------------------------------------- */
/* Base64                                                                      */
/* -------------------------------------------------------------------------- */

/** char code -> 6-bit value, -1 for anything else. */
const BASE64_VALUES = (() => {
  const table = new Int8Array(128).fill(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < alphabet.length; i += 1) table[alphabet.charCodeAt(i)] = i;
  // URL-safe spellings, so a frame that arrived through a URL still decodes.
  table['-'.charCodeAt(0)] = 62;
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

/**
 * Whether the engine has the ES2026 base64 methods on typed arrays.
 *
 * `setFromBase64` decodes straight into a buffer we already own, which is both
 * faster than anything written in JS and allocation-free. `atob` is the usual
 * fallback and is not used here at all: it materialises an intermediate string
 * as long as the frame, which for a 92KB frame is 92KB of garbage sixty times a
 * second — precisely what this component exists to avoid.
 */
const HAS_SET_FROM_BASE64 =
  typeof (Uint8Array.prototype as unknown as { setFromBase64?: unknown }).setFromBase64 === 'function';

/**
 * Decode base64 into an existing buffer.
 *
 * Returns the number of bytes the input represents — which may exceed `dest`,
 * in which case the surplus is discarded — or -1 if the input is not base64.
 * Whitespace is skipped, since base64 that has been through a text file often
 * carries line breaks; anything else is a malformed frame and the caller keeps
 * the previous image.
 */
function decodeBase64Into(source: string, dest: Uint8Array): number {
  const limit = dest.length;
  let accumulator = 0;
  let bits = 0;
  let written = 0;

  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    if (code === 61) break; // '=' — padding, and the end of the data
    const value = code < 128 ? BASE64_VALUES[code] : -1;
    if (value < 0) {
      if (code === 32 || code === 9 || code === 10 || code === 13) continue;
      return -1;
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (written < limit) dest[written] = (accumulator >>> bits) & 0xff;
      written += 1;
    }
  }

  return written;
}

/**
 * Fill `dest` from base64, by whichever route this engine has.
 *
 * Returns the byte count represented by the input, or -1 on malformed input.
 */
function fillFromBase64(source: string, dest: Uint8Array): number {
  if (HAS_SET_FROM_BASE64) {
    try {
      const result = (dest as unknown as { setFromBase64: (s: string) => { written: number } }).setFromBase64(source);
      return result.written;
    } catch {
      // Malformed, or a final chunk the strict decoder dislikes. Fall through to
      // the tolerant decoder, which will either cope or report -1 itself.
    }
  }
  return decodeBase64Into(source, dest);
}

/* -------------------------------------------------------------------------- */
/* Colour parsing                                                              */
/* -------------------------------------------------------------------------- */

/** Lazily built 1x1 context, used only for colours the fast paths do not know. */
let probeContext: CanvasRenderingContext2D | null | undefined;

/**
 * Resolve any CSS colour through the browser's own parser.
 *
 * The double-sentinel dance is how an invalid colour is detected: assigning a
 * value the parser rejects leaves `fillStyle` at whatever it was, so a value
 * that survives being written over two different sentinels is real.
 */
function colorViaCanvas(value: string): number | null {
  if (probeContext === undefined) {
    probeContext =
      typeof document !== 'undefined'
        ? document.createElement('canvas').getContext('2d', { willReadFrequently: true })
        : null;
    if (probeContext) {
      probeContext.canvas.width = 1;
      probeContext.canvas.height = 1;
    }
  }
  if (!probeContext) return null;

  probeContext.fillStyle = '#000000';
  probeContext.fillStyle = value;
  const first = probeContext.fillStyle;
  probeContext.fillStyle = '#ffffff';
  probeContext.fillStyle = value;
  if (first !== probeContext.fillStyle) return null;

  probeContext.clearRect(0, 0, 1, 1);
  probeContext.fillRect(0, 0, 1, 1);
  const data = probeContext.getImageData(0, 0, 1, 1).data;
  return packRgba(data[0], data[1], data[2], data[3]);
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return value | 0;
}

/**
 * A palette entry as a packed pixel word.
 *
 * `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` and `rgb()`/`rgba()` are read here
 * because palettes are usually written that way and going through the canvas
 * for 256 of them is a needless synchronous readback each. Everything else —
 * named colours, `hsl()`, `color()` — falls through to the browser.
 */
function parseColor(entry: PixelCanvasColor): number {
  if (Array.isArray(entry) || ArrayBuffer.isView(entry)) {
    const parts = entry as unknown as readonly number[];
    const alpha = parts.length > 3 ? parts[3] : 255;
    // Alpha may reasonably be written 0-1 or 0-255. Values at or below 1 are
    // read as a fraction, which agrees with both readings at the only point
    // they collide: 1 is opaque either way.
    const resolved = alpha <= 1 ? alpha * 255 : alpha;
    return packRgba(clampByte(parts[0]), clampByte(parts[1]), clampByte(parts[2]), clampByte(resolved));
  }

  if (typeof entry !== 'string') return packRgba(0, 0, 0, 255);
  const value = entry.trim();
  if (value.length === 0) return packRgba(0, 0, 0, 0);

  if (value.charCodeAt(0) === 35) {
    const hex = value.slice(1);
    const short = hex.length === 3 || hex.length === 4;
    const long = hex.length === 6 || hex.length === 8;
    if (short || long) {
      const digits = parseInt(hex, 16);
      if (!Number.isNaN(digits)) {
        if (short) {
          const r = (digits >> (hex.length === 4 ? 12 : 8)) & 0xf;
          const g = (digits >> (hex.length === 4 ? 8 : 4)) & 0xf;
          const b = (digits >> (hex.length === 4 ? 4 : 0)) & 0xf;
          const a = hex.length === 4 ? digits & 0xf : 0xf;
          return packRgba(r * 17, g * 17, b * 17, a * 17);
        }
        const r = (digits >>> (hex.length === 8 ? 24 : 16)) & 0xff;
        const g = (digits >>> (hex.length === 8 ? 16 : 8)) & 0xff;
        const b = (digits >>> (hex.length === 8 ? 8 : 0)) & 0xff;
        const a = hex.length === 8 ? digits & 0xff : 0xff;
        return packRgba(r, g, b, a);
      }
    }
  }

  if (value.startsWith('rgb')) {
    const numbers = value.match(/[-+]?[0-9]*\.?[0-9]+/g);
    if (numbers && numbers.length >= 3) {
      const r = Number(numbers[0]);
      const g = Number(numbers[1]);
      const b = Number(numbers[2]);
      const rawAlpha = numbers.length > 3 ? Number(numbers[3]) : 1;
      const alpha = rawAlpha <= 1 ? rawAlpha * 255 : rawAlpha;
      return packRgba(clampByte(r), clampByte(g), clampByte(b), clampByte(alpha));
    }
  }

  const resolved = colorViaCanvas(value);
  return resolved === null ? packRgba(0, 0, 0, 255) : resolved;
}

/**
 * A stable string for a palette, so a host that rebuilds its array every render
 * does not make the component re-parse 256 colours every render.
 *
 * Built during render, never inside the frame loop.
 */
function paletteSignature(palette: readonly PixelCanvasColor[] | undefined | null): string {
  if (!palette || palette.length === 0) return '';
  let signature = `${palette.length}`;
  for (let i = 0; i < palette.length; i += 1) {
    const entry = palette[i];
    signature += Array.isArray(entry) ? `|${(entry as readonly number[]).join(',')}` : `|${String(entry)}`;
  }
  return signature;
}

/** Pack an array of palette entries into the 256-slot lookup table. */
function writePaletteEntries(entries: readonly PixelCanvasColor[], lut: Uint32Array): number {
  const count = Math.min(entries.length, 256);
  for (let i = 0; i < count; i += 1) lut[i] = parseColor(entries[i]);
  // Indices past the end of the palette are transparent rather than black, so a
  // short palette shows as holes — a visible mistake instead of a silent one.
  for (let i = count; i < 256; i += 1) lut[i] = 0;
  return count;
}

/**
 * Fallback palette: a 256-step greyscale ramp.
 *
 * Used when a producer sends `p8` bytes and never sends a palette. A height
 * field or an intensity map is then legible immediately, which beats the
 * alternative of a fully transparent canvas and no clue why.
 */
function writeGreyscale(lut: Uint32Array): void {
  for (let i = 0; i < 256; i += 1) lut[i] = packRgba(i, i, i, 255);
}

/* -------------------------------------------------------------------------- */
/* Props                                                                       */
/* -------------------------------------------------------------------------- */

export interface PixelCanvasProps {
  /** Logical width of the bitmap, in pixels. A frame may override it. */
  width?: number;
  /** Logical height of the bitmap, in pixels. A frame may override it. */
  height?: number;
  /**
   * Integer upscale factor.
   *
   * Omitted, the canvas fits itself to the width available and takes the
   * largest whole multiple that fits — whole, because a fractional multiple
   * makes some source pixels wider than others and the seams are visible on
   * anything with a grid in it. If not even 1:1 fits, it scales down to fit
   * rather than overflowing.
   *
   * Height is only taken into account when the container has a height of its
   * own (given through `style`). Deriving the scale from a height that is
   * itself derived from the canvas would just measure the canvas.
   */
  scale?: number;
  /**
   * How the bitmap fills its container when `scale` is not given.
   *
   * `"pixel"` (the default) takes the largest whole multiple that fits and
   * centres it. Every source pixel is the same size, which is what pixel art
   * and anything with a grid in it needs — at the cost of leaving a margin,
   * since a 160-wide bitmap in a 405px box is 2x and not 2.53x.
   *
   * `"contain"` fills the container instead, keeping the aspect ratio but
   * allowing a fractional factor. The margin goes away; in exchange some source
   * pixels land on three screen pixels and their neighbours on four. With
   * nearest-neighbour scaling that is a faint unevenness in the seams rather
   * than blurring, and on a photographic or continuous-tone bitmap it is
   * invisible. Choose it when filling the frame matters more than exact pixel
   * geometry — a console screen in a bezel, a video, a fullscreen view.
   */
  fit?: 'pixel' | 'contain';
  /**
   * Palette for one-byte-per-pixel frames.
   *
   * Its presence is also what tells the component the frames are indexed: with
   * a palette, a frame is one byte per pixel; without, four. A frame that says
   * `format` explicitly overrides that.
   */
  palette?: readonly PixelCanvasColor[];
  /**
   * Called once per `requestAnimationFrame`, returning the next frame — a
   * base64 string of its bytes, or a {@link PixelCanvasFrame} for producers
   * that also need to say how big it is or what palette it uses.
   *
   * Returning `null` or `undefined` means "no new frame": the last image stays
   * up and nothing is decoded. A producer slower than the display should do
   * exactly that rather than resending the frame already on screen.
   */
  getFrame?: () => PixelCanvasSource | Promise<PixelCanvasSource>;
  /**
   * A frame as a prop, repainted whenever it changes.
   *
   * The alternative to `getFrame`, for sources that push rather than pull. When
   * both are given `getFrame` wins, since a puller and a pusher driving one
   * surface would fight over it.
   */
  frame?: PixelCanvasSource;
  /** Whether the frame loop is running (default true). */
  running?: boolean;
  /** Smooth the upscale instead of keeping pixels square (default false). */
  smooth?: boolean;
  /** Called about once a second with the frames actually painted per second. */
  onFps?: (fps: number) => void;
  /** Styles for the element the canvas sits in. */
  style?: React.CSSProperties;
  /** Class for the element the canvas sits in. */
  className?: string;
}

/** `useLayoutEffect` on the client, `useEffect` where there is no layout. */
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

function isThenable<T>(value: unknown): value is Promise<T> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export function PixelCanvas({
  width,
  height,
  scale,
  fit = 'pixel',
  palette,
  getFrame,
  frame,
  running = true,
  smooth = false,
  onFps,
  style,
  className,
}: PixelCanvasProps): React.ReactElement {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);

  // The surface. Allocated when the logical size changes and at no other time:
  // one ImageData, its Uint8ClampedArray, and two views over the same bytes —
  // a byte view for straight RGBA copies and a word view for palette expansion.
  const imageDataRef = useRef<ImageData | null>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const wordsRef = useRef<Uint32Array | null>(null);

  /**
   * Where an incoming frame is decoded before anything is painted.
   *
   * Frames are decoded here and copied on, rather than decoded straight into
   * the live surface, so that a truncated or corrupt frame cannot leave half an
   * image on screen. Sized exactly to the frame so the copy needs no subarray —
   * a subarray would be an allocation, and there are to be none per frame.
   */
  const scratchRef = useRef<Uint8Array | null>(null);
  /** 3 bytes an entry, 256 entries: the largest palette a frame can carry. */
  const paletteBytesRef = useRef<Uint8Array>(new Uint8Array(768));
  /** Index -> packed pixel. 256 slots, so an index can never be out of range. */
  const paletteLutRef = useRef<Uint32Array>(new Uint32Array(256));
  const paletteCountRef = useRef(0);
  const paletteSignatureRef = useRef<string | null>(null);
  const paletteRevRef = useRef<number | null>(null);
  const paletteSourceRef = useRef<string>('');

  const dimensionsRef = useRef({ w: 0, h: 0 });
  const appliedScaleRef = useRef(0);
  const lastFrameNumberRef = useRef<number | null>(null);

  const rafRef = useRef(0);
  const framesPaintedRef = useRef(0);
  const fpsSinceRef = useRef(0);
  const warnedRef = useRef(false);
  /** A pull whose promise has not settled; see `issue` in `startLoop`. */
  const inFlightRef = useRef(false);
  const loopGenerationRef = useRef(0);

  // Everything the loop reads lives here, refreshed each render, so that a host
  // passing a fresh closure or a fresh palette array every render never
  // restarts the loop. Restarting it would drop a frame and reset the fps
  // window; Sprite refreshes row/colOffset the same way and for the same
  // reason.
  const configRef = useRef({ width, height, scale, fit, getFrame, onFps, hasFixedHeight: false });
  configRef.current = {
    width,
    height,
    scale,
    fit,
    getFrame,
    onFps,
    hasFixedHeight: style?.height !== undefined || style?.maxHeight !== undefined,
  };

  /* ---------------------------------------------------------------------- */
  /* Sizing                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Set the canvas's CSS size from the scale.
   *
   * The backing store stays at the bitmap's own size and the element is scaled
   * by CSS: `putImageData` ignores the transform matrix, so drawing into a
   * scaled-up surface would mean an intermediate bitmap and a `drawImage` every
   * frame. Nearest-neighbour upscaling is something the compositor does for
   * free.
   */
  const applyScale = useCallback(() => {
    const canvas = canvasRef.current;
    const { w, h } = dimensionsRef.current;
    if (!canvas || w <= 0 || h <= 0) return;

    const config = configRef.current;
    let factor: number;

    if (typeof config.scale === 'number' && Number.isFinite(config.scale) && config.scale > 0) {
      // Below 1 is a deliberate downscale and is left fractional; at or above 1
      // it is rounded down to a whole multiple so pixels stay square.
      factor = config.scale >= 1 ? Math.floor(config.scale) : config.scale;
    } else {
      const wrapper = wrapperRef.current;
      const availableWidth = wrapper ? wrapper.clientWidth : 0;
      const availableHeight = config.hasFixedHeight && wrapper ? wrapper.clientHeight : 0;

      // The exact factor that would fill the container on its tightest axis.
      let exact = availableWidth > 0 ? availableWidth / w : 1;
      if (availableHeight > 0) exact = Math.min(exact, availableHeight / h);

      if (config.fit === 'contain') {
        factor = exact;
      } else {
        // Largest whole multiple that fits. Below 1:1 there is no whole multiple
        // to take, and shrinking to the space beats spilling out of it — the one
        // case where "pixel" also goes fractional.
        factor = exact >= 1 ? Math.floor(exact) : exact;
      }
    }

    if (factor === appliedScaleRef.current) return;
    appliedScaleRef.current = factor;

    const cssWidth = `${Math.max(1, Math.round(w * factor))}px`;
    const cssHeight = `${Math.max(1, Math.round(h * factor))}px`;
    // Written only when they differ, so a ResizeObserver watching the wrapper
    // is not woken by a style write that changed nothing.
    if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth;
    if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
  }, []);

  /**
   * Make sure the surface matches `w` x `h`, reallocating only if it does not.
   *
   * Returns false when there is nothing to draw on, which is the signal to keep
   * whatever is already up.
   */
  const ensureSurface = useCallback(
    (w: number, h: number): boolean => {
      const canvas = canvasRef.current;
      if (!canvas) return false;

      let context = contextRef.current;
      if (!context) {
        context = canvas.getContext('2d', { alpha: true, desynchronized: true });
        contextRef.current = context;
      }
      if (!context) return false;

      const dimensions = dimensionsRef.current;
      if (dimensions.w === w && dimensions.h === h && imageDataRef.current) return true;

      canvas.width = w;
      canvas.height = h;

      const image = context.createImageData(w, h);
      const data = image.data;
      imageDataRef.current = image;
      bytesRef.current = new Uint8Array(data.buffer, data.byteOffset, data.length);
      wordsRef.current = new Uint32Array(data.buffer, data.byteOffset, w * h);
      dimensions.w = w;
      dimensions.h = h;

      // A resize invalidates the frame counter: the next frame is a different
      // picture whatever number the producer gives it.
      lastFrameNumberRef.current = null;
      appliedScaleRef.current = 0;
      applyScale();
      return true;
    },
    [applyScale],
  );

  /** The decode buffer, exactly `size` bytes so copies need no view. */
  const ensureScratch = useCallback((size: number): Uint8Array => {
    const current = scratchRef.current;
    if (current && current.length === size) return current;
    const next = new Uint8Array(size);
    scratchRef.current = next;
    return next;
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Painting                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Decode one frame and put it on the canvas.
   *
   * Returns true if the canvas was repainted. Everything it touches is
   * preallocated; the only per-frame work is the decode, the expansion and the
   * `putImageData`. Nothing here calls setState, and nothing here throws: a
   * frame it cannot make sense of leaves the previous image alone.
   */
  const paint = useCallback(
    (source: PixelCanvasSource): boolean => {
      if (source === null || source === undefined) return false;

      const config = configRef.current;

      let encoded: string;
      let frameWidth = 0;
      let frameHeight = 0;
      let format = '';
      let framePalette: string | readonly PixelCanvasColor[] | undefined;
      let frameRev: number | undefined;
      let frameNumber: number | undefined;

      if (typeof source === 'string') {
        if (source.length === 0) return false;
        encoded = source;
      } else if (typeof source === 'object') {
        const rich = source as PixelCanvasFrame;
        if (typeof rich.pixels !== 'string' || rich.pixels.length === 0) return false;
        encoded = rich.pixels;
        if (typeof rich.w === 'number') frameWidth = rich.w;
        if (typeof rich.h === 'number') frameHeight = rich.h;
        if (typeof rich.format === 'string') format = rich.format;
        if (typeof rich.paletteRev === 'number') frameRev = rich.paletteRev;
        if (typeof rich.frame === 'number') frameNumber = rich.frame;
        if (rich.palette !== undefined && rich.palette !== null) framePalette = rich.palette;
      } else {
        return false;
      }

      // Same frame as last time, and the palette has not moved either: there is
      // nothing on screen that would change, so do not decode 23040 bytes to
      // find that out.
      if (
        frameNumber !== undefined &&
        frameNumber === lastFrameNumberRef.current &&
        (frameRev === undefined || frameRev === paletteRevRef.current)
      ) {
        return false;
      }

      const w = Math.floor(frameWidth > 0 ? frameWidth : Number(config.width) || 0);
      const h = Math.floor(frameHeight > 0 ? frameHeight : Number(config.height) || 0);
      if (
        !Number.isFinite(w) ||
        !Number.isFinite(h) ||
        w <= 0 ||
        h <= 0 ||
        w > MAX_DIMENSION ||
        h > MAX_DIMENSION ||
        w * h > MAX_PIXELS
      ) {
        return false;
      }

      if (!ensureSurface(w, h)) return false;

      // The frame's own palette, when it has one. Decoded only when the
      // producer says it changed — or, for a producer that sends no revision
      // number, when the bytes themselves differ from last time. A string
      // comparison is cheap and allocates nothing; re-parsing 64 colours is
      // neither.
      if (framePalette !== undefined) {
        const revChanged = frameRev !== undefined && frameRev !== paletteRevRef.current;
        if (typeof framePalette === 'string') {
          const stale = revChanged || (frameRev === undefined && framePalette !== paletteSourceRef.current);
          if (stale) {
            const bytes = paletteBytesRef.current;
            const decoded = fillFromBase64(framePalette, bytes);
            if (decoded > 0) {
              const entries = Math.min(256, Math.floor(Math.min(decoded, bytes.length) / 3));
              const lut = paletteLutRef.current;
              for (let i = 0; i < entries; i += 1) {
                const base = i * 3;
                lut[i] = packRgba(bytes[base], bytes[base + 1], bytes[base + 2], 255);
              }
              for (let i = entries; i < 256; i += 1) lut[i] = 0;
              paletteCountRef.current = entries;
              paletteRevRef.current = frameRev ?? null;
              paletteSourceRef.current = framePalette;
              // The frame's palette has replaced the prop's, so the prop must be
              // reconsidered if it ever changes again.
              paletteSignatureRef.current = null;
            }
          }
        } else if (revChanged || paletteCountRef.current === 0) {
          // An array palette in a frame is re-parsed only on an explicit
          // revision bump: comparing arrays every frame would cost more than
          // the frame does.
          paletteCountRef.current = writePaletteEntries(framePalette, paletteLutRef.current);
          paletteRevRef.current = frameRev ?? null;
          paletteSourceRef.current = '';
          paletteSignatureRef.current = null;
        }
      }

      // A frame that names its format is believed; one that does not is read as
      // indexed if there is a palette to index into, and as RGBA otherwise.
      const indexed =
        format === 'p8' || format === 'indexed' || format === 'index' || format === 'pal8'
          ? true
          : format === 'rgba' || format === 'rgba8' || format === 'rgba32'
            ? false
            : paletteCountRef.current > 0;

      const pixelCount = w * h;
      const needed = indexed ? pixelCount : pixelCount * 4;
      const scratch = ensureScratch(needed);

      const decoded = fillFromBase64(encoded, scratch);
      // Short is as bad as malformed: half a frame drawn over the other half of
      // the last one is worse to look at than a frame that did not arrive.
      if (decoded < needed) return false;

      const context = contextRef.current;
      const image = imageDataRef.current;
      if (!context || !image) return false;

      if (indexed) {
        if (paletteCountRef.current === 0) {
          writeGreyscale(paletteLutRef.current);
          paletteCountRef.current = 256;
        }
        const lut = paletteLutRef.current;
        const words = wordsRef.current;
        if (!words) return false;
        for (let i = 0; i < pixelCount; i += 1) words[i] = lut[scratch[i]];
      } else {
        const bytes = bytesRef.current;
        if (!bytes) return false;
        bytes.set(scratch);
      }

      context.putImageData(image, 0, 0);
      if (frameNumber !== undefined) lastFrameNumberRef.current = frameNumber;
      return true;
    },
    [ensureScratch, ensureSurface],
  );

  /* ---------------------------------------------------------------------- */
  /* The loop                                                                */
  /* ---------------------------------------------------------------------- */

  const stopLoop = useCallback(() => {
    if (rafRef.current !== 0) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  }, []);

  const startLoop = useCallback(() => {
    if (rafRef.current !== 0) return;
    if (typeof requestAnimationFrame !== 'function') return;

    framesPaintedRef.current = 0;
    fpsSinceRef.current = -1;

    // Each start is a generation. A pull that was in flight when the loop
    // stopped resolves later; the generation it captured no longer matches, so
    // its frame is dropped rather than painted onto a canvas that has since
    // been told to stop, and a loop restarted in the meantime is not blocked by
    // the old pull's `inFlight`.
    const generation = ++loopGenerationRef.current;
    inFlightRef.current = false;

    const warnOnce = (error: unknown) => {
      // A producer that throws is a bug in the producer. Tearing the canvas
      // down over it would take the rest of the page's animation with it, so
      // the frame is dropped and the last image stays up — and it is said
      // once, because saying it sixty times a second helps nobody.
      if (!warnedRef.current) {
        warnedRef.current = true;
        console.warn('PixelCanvas: getFrame threw; keeping the previous frame.', error);
      }
    };

    // One pull. A synchronous producer is painted on the spot. An asynchronous
    // one — a script function running in a worker returns a promise — is
    // painted when it resolves, off the animation frame, and if that frame was
    // new the next pull is issued immediately rather than at the next frame:
    // the producer, not this loop, sets the pace, so a worker that can make
    // 45 frames a second shows 45 and one that can make 90 is held by its own
    // pacing (a frame that is not new stops the chain until the next
    // requestAnimationFrame). At most one pull is ever in flight.
    const issue = () => {
      if (rafRef.current === 0 || inFlightRef.current) return;
      const { getFrame: pull } = configRef.current;
      if (!pull) return;
      let produced: PixelCanvasSource | Promise<PixelCanvasSource> = null;
      try {
        produced = pull() as PixelCanvasSource | Promise<PixelCanvasSource>;
      } catch (error) {
        warnOnce(error);
        return;
      }
      if (isThenable(produced)) {
        inFlightRef.current = true;
        produced.then(
          (frame) => {
            if (generation !== loopGenerationRef.current) return;
            inFlightRef.current = false;
            if (rafRef.current === 0) return;
            if (frame !== null && frame !== undefined && paint(frame)) {
              framesPaintedRef.current += 1;
              issue();
            }
          },
          (error) => {
            if (generation !== loopGenerationRef.current) return;
            inFlightRef.current = false;
            warnOnce(error);
          }
        );
        return;
      }
      if (produced !== null && produced !== undefined && paint(produced)) {
        framesPaintedRef.current += 1;
      }
    };

    // Named `step` rather than `render` or `animate` on purpose: those names
    // are load-bearing elsewhere in SoftN, and a frame loop is the last place
    // to find out.
    const step = (time: number) => {
      rafRef.current = requestAnimationFrame(step);

      // The measuring window opens before the first frame is drawn, so that
      // frame lands inside the window it was drawn in.
      if (fpsSinceRef.current < 0) fpsSinceRef.current = time;

      const { onFps: report } = configRef.current;
      issue();

      const elapsed = time - fpsSinceRef.current;
      if (elapsed >= 1000) {
        // Frames actually put on the canvas, not frames the loop woke up for: a
        // producer that has nothing new is not running at 60fps.
        const fps = Math.round(((framesPaintedRef.current * 1000) / elapsed) * 10) / 10;
        framesPaintedRef.current = 0;
        fpsSinceRef.current = time;
        if (report) report(fps);
      }
    };

    rafRef.current = requestAnimationFrame(step);
  }, [paint]);

  // Run the loop only while it is wanted and only while it can be seen. A
  // hidden tab throttles rAF to about once a second rather than stopping it, so
  // without this a backgrounded emulator keeps decoding frames nobody is
  // looking at.
  const wantsLoop = typeof getFrame === 'function';
  useEffect(() => {
    if (!wantsLoop) {
      stopLoop();
      return undefined;
    }

    const sync = () => {
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (running && !hidden) startLoop();
      else stopLoop();
    };

    sync();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', sync);
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', sync);
      }
      stopLoop();
    };
  }, [wantsLoop, running, startLoop, stopLoop]);

  /* ---------------------------------------------------------------------- */
  /* Props that feed the surface                                             */
  /* ---------------------------------------------------------------------- */

  // Palette prop. Compared by content, not identity, because a template that
  // writes its palette inline hands over a new array on every render.
  useEffect(() => {
    const signature = paletteSignature(palette);
    if (signature === paletteSignatureRef.current) return;
    paletteSignatureRef.current = signature;

    if (!palette || palette.length === 0) {
      paletteCountRef.current = 0;
      paletteLutRef.current.fill(0);
    } else {
      paletteCountRef.current = writePaletteEntries(palette, paletteLutRef.current);
    }

    // A frame-supplied palette has to be allowed to take over again, so forget
    // which one was last seen; the next frame carrying one will re-decode it.
    paletteRevRef.current = null;
    paletteSourceRef.current = '';
    // The pixels on screen were expanded through the old palette.
    lastFrameNumberRef.current = null;
  }, [palette]);

  // Pushed frames. `getFrame` owns the surface when it is present; this is for
  // hosts that hand over a frame at a time.
  //
  // `palette`, `width` and `height` are dependencies although the body does not
  // read them: each changes how the bytes already in hand should be drawn, and
  // with no loop running there is nothing else to notice that.
  useEffect(() => {
    if (wantsLoop) return;
    if (frame === null || frame === undefined) return;
    paint(frame);
  }, [frame, wantsLoop, paint, palette, width, height]);

  // Size the surface before the browser paints, so the first frame is never
  // shown at the wrong scale.
  useIsomorphicLayoutEffect(() => {
    const w = Math.floor(Number(width) || 0);
    const h = Math.floor(Number(height) || 0);
    if (w > 0 && h > 0 && w <= MAX_DIMENSION && h <= MAX_DIMENSION && w * h <= MAX_PIXELS) {
      ensureSurface(w, h);
    }
    appliedScaleRef.current = 0;
    applyScale();
  }, [width, height, scale, fit, ensureSurface, applyScale]);

  // Auto-fit follows the container. Observing the wrapper rather than the
  // window catches the cases a resize event does not: a sidebar opening, a
  // layout changing, the element being revealed.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return undefined;

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => applyScale());
      observer.observe(wrapper);
      return () => observer.disconnect();
    }

    const onResize = () => applyScale();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [applyScale]);

  // Drop the surface on unmount. A framebuffer this size is worth not leaving
  // to chance, and the views must not outlive the canvas they came from.
  useEffect(
    () => () => {
      stopLoop();
      imageDataRef.current = null;
      bytesRef.current = null;
      wordsRef.current = null;
      scratchRef.current = null;
      contextRef.current = null;
    },
    [stopLoop],
  );

  return (
    <div
      ref={wrapperRef}
      className={className}
      style={{
        // Centred, because the auto-fit factor is a whole number: a 160-wide
        // bitmap in a 405px box scales 2x, not 2.53x, and the 85px it cannot
        // use has to go somewhere. Split evenly it reads as a deliberate
        // surround; left in the corner it reads as a broken layout.
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 0,
        ...style,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          // Nearest-neighbour, so one source pixel stays a solid square rather
          // than a smear. Without it the browser bilinearly interpolates every
          // upscale, which is exactly wrong for pixel art and for anything
          // where a single pixel carries meaning.
          imageRendering: smooth ? 'auto' : 'pixelated',
        }}
      />
    </div>
  );
}

export default PixelCanvas;
