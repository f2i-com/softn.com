/**
 * WasmApp: a WebAssembly program, run on top of the app.
 *
 * The program is a .wasm file of the app's. It runs in a worker of its own
 * with only what SoftN gives it (core's runtime/wasm/): it draws by handing
 * over frames of pixels, hears the keys, the pointer and gamepads while it
 * has the focus, queues sound, keeps files in a folder of its own, and talks
 * to the app's logic: what it posts arrives as `@message`, and the logic
 * calls its functions with `softn.wasm.call(handle, …)`, the handle `@ready`
 * gave. No JavaScript the program ships is run, and it reaches nothing of
 * the page, the device or the network.
 *
 * What a program exports, all optional but `frame` for one that draws:
 *
 *   frame(time_ms: f64)            once per screen refresh while it runs
 *   key(code: i32, down: i32)      a key, as a USB HID code (SDL's scancodes):
 *                                  4 = A, 44 = Space, 79..82 = Right, Left, Down, Up
 *   text(codepoint: i32)           a character typed
 *   pointer(id, phase, x: f32, y: f32, buttons)
 *                                  phase 0 move, 1 down, 2 up, 3 cancel; x and y
 *                                  in the frame's own pixels; id 0 the mouse
 *   wheel(dx: f32, dy: f32)
 *   gamepad(index, buttons, lx, ly, rx, ry)
 *                                  each frame for each pad, standard mapping
 *   resize(width, height)          the space it is shown in, in device pixels
 *   alloc(size) -> ptr             for a text the app's logic sends it
 *
 * What it may import, from the module `softn`:
 *
 *   present(ptr, width, height)    show width x height RGBA pixels from memory
 *   audio(ptr, frames)             queue stereo f32 samples at audio_rate()
 *   audio_rate() -> i32            48000
 *   audio_queued() -> f64          seconds of sound still to play
 *   post(ptr, len)                 a text to the app (@message)
 *   log(ptr, len)                  a line to the console
 *   now() -> f64                   milliseconds since it started
 *
 * and WASI (wasi_snapshot_preview1): stdout and stderr go to the console,
 * `files` are its file system. A program with no `frame` is run once and
 * what it printed is shown in place of a screen. A program that has exited
 * is stopped: its worker and memory are let go, and its handle reaches
 * nothing (what it has to tell the app, it posts first).
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  LoadingIndicator,
  describeMarkupEgress,
  startWasmProgram,
  useAppActive,
  useAppAssets,
  useAppId,
  useEgressConfig,
  type WasmInputEvent,
  type WasmProgram,
} from '@softn/core';
import { namesBundleFile, useBundleSrc } from '../utils/bundle-src';

export interface WasmAppProps {
  /** The program: a .wasm file of the app's (`assets/game.wasm`), or an address the app's `net` permission reaches. */
  src: string;
  /** How wide its screen is before its first frame, in pixels (default 320); its frames decide after that. */
  width?: number;
  /** How tall its screen is before its first frame, in pixels (default 240). */
  height?: number;
  /**
   * How the screen fills the space it is given. `"contain"` (the default)
   * keeps the frame's shape at any size; `"pixel"` takes only whole
   * multiples of its size, so every pixel is the same size.
   */
  fit?: 'contain' | 'pixel';
  /** Smooth the scaling instead of keeping pixels square (default false). */
  smooth?: boolean;
  /** Whether the program runs (default true); false pauses its frames. */
  running?: boolean;
  /** Its command-line arguments. */
  args?: string[];
  /** Its environment variables. */
  env?: Record<string, string>;
  /** Files it finds in its own folder: a path to a text, or to `{ base64 }`. */
  files?: Record<string, string | { base64: string }>;
  /** The memory it may grow to, in MB (default 256, at most 1024). */
  memory?: number;
  /** What the screen is called for a screen reader (default "WebAssembly program"). */
  label?: string;
  /** It has started: its handle (for softn.wasm.call), the functions it exports, and the imports SoftN does not give it. */
  onReady?: (info: { handle: string; exports: string[]; missing: string[] }) => void;
  /** A text the program posted. */
  onMessage?: (text: string) => void;
  /** The program exited, with its exit code. */
  onExit?: (code: number) => void;
  /** It could not start, or it stopped: why. */
  onError?: (message: string) => void;
  /** Styles for the box the screen is in. */
  style?: React.CSSProperties;
  /** Class for the box the screen is in. */
  className?: string;
}

/** A key's physical place (`KeyboardEvent.code`) as the USB HID code SDL's scancodes use. */
export const WASM_KEY_CODES: Readonly<Record<string, number>> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < 26; i++) map[`Key${String.fromCharCode(65 + i)}`] = 4 + i;
  for (let i = 1; i <= 9; i++) map[`Digit${i}`] = 29 + i;
  map.Digit0 = 39;
  for (let i = 1; i <= 12; i++) map[`F${i}`] = 57 + i;
  for (let i = 1; i <= 9; i++) map[`Numpad${i}`] = 88 + i;
  Object.assign(map, {
    Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48,
    Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57,
    PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78,
    ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, NumLock: 83, NumpadDivide: 84, NumpadMultiply: 85,
    NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88, Numpad0: 98, NumpadDecimal: 99, IntlBackslash: 100, ContextMenu: 101,
    ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227, ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
  });
  return Object.freeze(map);
})();

/** The keys that only change others: delivered as keys themselves, never a chord on their own. */
const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Shift', 'Alt', 'AltGraph', 'CapsLock', 'OS']);
/** The function keys stay the browser's too (F5 reloads, F11 is full screen): the program hears them, the browser acts on them. */
const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;
/** The largest program file, as for softn.wasm.load. */
const MAX_PROGRAM_BYTES = 64 << 20;

/** A Mac's keyboard, where Option types characters (Option+L is @ on a German layout) without reporting AltGraph. */
function onMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad/i.test(platform);
}

/** The rate the program's sound is made at; the page plays it at its own. */
const AUDIO_RATE = 48000;
/** Sound queued past this is dropped, so a program that makes it faster than it plays is not heard a minute late. */
const MAX_QUEUED_SECONDS = 1;
const MAX_OUTPUT_LINES = 1000;
const MAX_QUEUED_EVENTS = 512;

/** The program's sound, played back to back as it comes. */
class SoundQueue {
  #context: AudioContext | null = null;
  #next = 0;

  push(samples: Float32Array): void {
    if (typeof AudioContext === 'undefined') return;
    this.#context ??= new AudioContext();
    const context = this.#context;
    const frames = Math.floor(samples.length / 2);
    if (frames === 0) return;
    const start = Math.max(this.#next, context.currentTime + 0.03);
    if (start - context.currentTime > MAX_QUEUED_SECONDS) return;
    // An AudioBuffer may be at a rate other than the context's: it is resampled as it plays.
    const buffer = context.createBuffer(2, frames, AUDIO_RATE);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      left[i] = samples[i * 2];
      right[i] = samples[i * 2 + 1];
    }
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    node.start(start);
    this.#next = start + buffer.duration;
  }

  /** Seconds queued and not yet played. */
  queued(): number {
    return this.#context ? Math.max(0, this.#next - this.#context.currentTime) : 0;
  }

  /** A browser starts a page's sound only after a press: called from one. */
  resume(): void {
    if (this.#context?.state === 'suspended') void this.#context.resume().catch(() => {});
  }

  close(): void {
    void this.#context?.close().catch(() => {});
    this.#context = null;
  }
}

/** The program's bytes, read as they come and refused past what a program may be. */
async function readProgram(response: Response, src: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  const tooLarge = () => new Error(`${src} is larger than the 64 MB a program may be`);
  if (Number.isFinite(declared) && declared > MAX_PROGRAM_BYTES) throw tooLarge();
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_PROGRAM_BYTES) throw tooLarge();
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_PROGRAM_BYTES) {
      void reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

function filesOf(files: WasmAppProps['files']): { path: string; bytes: Uint8Array }[] {
  if (!files || typeof files !== 'object') return [];
  return Object.entries(files).map(([path, content]) => {
    if (typeof content === 'string') return { path, bytes: new TextEncoder().encode(content) };
    if (content && typeof content === 'object' && typeof content.base64 === 'string') {
      const binary = atob(content.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return { path, bytes };
    }
    throw new Error(`The file "${path}" is a text or { base64 }`);
  });
}

type Shown =
  | { kind: 'loading' }
  | { kind: 'running' }
  | { kind: 'output'; lines: string[]; code: number | null }
  | { kind: 'error'; message: string };

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function WasmApp({
  src,
  width = 320,
  height = 240,
  fit = 'contain',
  smooth = false,
  running = true,
  args,
  env,
  files,
  memory,
  label = 'WebAssembly program',
  onReady,
  onMessage,
  onExit,
  onError,
  style,
  className,
}: WasmAppProps): React.ReactElement {
  const boxRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const programRef = useRef<WasmProgram | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const eventsRef = useRef<WasmInputEvent[]>([]);
  const heldRef = useRef(new Set<number>());
  /** The gamepads the program has been told of, let go of when the focus leaves as held keys are. */
  const padsRef = useRef(new Set<number>());
  const pointerIdsRef = useRef(new Map<number, number>());
  const soundRef = useRef<SoundQueue | null>(null);
  const [shown, setShown] = useState<Shown>({ kind: 'loading' });
  const [frameSize, setFrameSize] = useState({ w: Math.max(1, width), h: Math.max(1, height) });
  const frameSizeRef = useRef(frameSize);
  frameSizeRef.current = frameSize;
  const [pixelBox, setPixelBox] = useState<{ w: number; h: number } | null>(null);
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);
  const appId = useAppId();
  const appShown = useAppActive();
  const assets = useAppAssets();
  const egress = useEgressConfig();
  const url = useBundleSrc(src);

  // What the handlers say now, read when they are called: a page passes new functions at every draw.
  const handlers = useRef({ onReady, onMessage, onExit, onError });
  handlers.current = { onReady, onMessage, onExit, onError };
  const live = useRef({ running, appShown });
  live.current = { running, appShown };

  // Whole multiples of the frame for fit="pixel", from the space the box has.
  useIsomorphicLayoutEffect(() => {
    if (fit !== 'pixel') {
      setPixelBox(null);
      return;
    }
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const { w, h } = frameSizeRef.current;
      const room = Math.min(box.clientWidth / w, box.clientHeight / h);
      const scale = room >= 1 ? Math.floor(room) : room;
      setPixelBox(scale > 0 ? { w: w * scale, h: h * scale } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [fit, frameSize.w, frameSize.h]);

  const startKey = JSON.stringify([url ?? null, args ?? [], env ?? {}, files ?? {}, memory ?? null]);

  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;
    // Made once with the component: the same objects for every start.
    const held = heldRef.current;
    const pads = padsRef.current;
    const pointerIds = pointerIdsRef.current;
    // Taking the component off the page stops its program, starting or running, and its download.
    const stopping = new AbortController();
    let cancelled = false;
    /** The program exited or stopped: no more frames are asked of it. */
    let ended = false;
    let program: WasmProgram | null = null;
    let raf = 0;
    const output: string[] = [];
    const fail = (message: string) => {
      if (cancelled) return;
      setShown({ kind: 'error', message });
      handlers.current.onError?.(message);
    };
    setShown({ kind: 'loading' });
    eventsRef.current = [];

    // A canvas of its own each start: one handed to a worker cannot be handed again.
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', objectFit: 'contain', touchAction: 'none' });
    screen.appendChild(canvas);
    canvasRef.current = canvas;
    const offscreen =
      typeof canvas.transferControlToOffscreen === 'function' && typeof OffscreenCanvas !== 'undefined' ? canvas.transferControlToOffscreen() : null;
    const fallback = offscreen ? null : canvas.getContext('2d');
    const sound = new SoundQueue();
    soundRef.current = sound;

    const frames = (started: number) => {
      let inFlight = false;
      let lastSize = '';
      const loop = () => {
        if (cancelled || ended || !program) return;
        raf = requestAnimationFrame(loop);
        if (inFlight || !live.current.running || !live.current.appShown) return;
        const events = eventsRef.current;
        eventsRef.current = [];
        const rect = screen.getBoundingClientRect();
        const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
        const size = `${Math.round(rect.width * ratio)}x${Math.round(rect.height * ratio)}`;
        if (size !== lastSize && rect.width > 0) {
          lastSize = size;
          events.unshift({ kind: 'resize', width: Math.round(rect.width * ratio), height: Math.round(rect.height * ratio) });
        }
        // Gamepads, as keys, while the program has the focus: two programs on a page would both take one otherwise.
        if (focusedRef.current && program.exports.some((e) => e.name === 'gamepad') && typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
          try {
            for (const pad of navigator.getGamepads() ?? []) {
              if (!pad || pad.connected === false) continue;
              const buttons = pad.buttons.reduce((bits, b, i) => (b.pressed && i < 31 ? bits | (1 << i) : bits), 0);
              events.push({ kind: 'gamepad', index: pad.index, buttons, axes: [0, 1, 2, 3].map((i) => pad.axes[i] ?? 0) });
              pads.add(pad.index);
            }
          } catch {
            // A page that is not allowed gamepads has none.
          }
        }
        inFlight = true;
        void program.frame(performance.now() - started, events, sound.queued()).finally(() => {
          inFlight = false;
        });
      };
      raf = requestAnimationFrame(loop);
    };

    void (async () => {
      if (!url) {
        fail(src ? `This app may not load "${src}"` : 'WasmApp needs a src: the .wasm file to run');
        return;
      }
      // When a bundle asset resolver is active, never allow an unresolved relative/root-relative
      // path to fall through and probe host same-origin routes.
      const isBlobOrData = /^(?:blob|data):/i.test(url);
      if (assets && namesBundleFile(src) && !isBlobOrData && url === src) {
        fail(`This app may not load "${src}"`);
        return;
      }
      // Judged as the renderer judges an address (a protocol-relative one, or one spelled with
      // backslashes or spaces, is as remote as https://); one that is not remote is allowed.
      if (!describeMarkupEgress(url, egress).allowed) {
        fail(`This app's permissions do not reach ${url}`);
        return;
      }
      let bytes: Uint8Array;
      try {
        // Every non-blob/data fetch is uncredentialed, non-redirecting, and referrer-free so
        // untrusted bundles can never probe host-authenticated same-origin endpoints or follow
        // open redirects to unpermitted hosts.
        const response = await fetch(
          url,
          isBlobOrData
            ? { signal: stopping.signal }
            : { redirect: 'error', referrerPolicy: 'no-referrer', credentials: 'omit', signal: stopping.signal }
        );
        if (!response.ok) throw new Error(`${src} could not be read`);
        bytes = await readProgram(response, src);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        return;
      }
      if (cancelled) return;
      try {
        program = await startWasmProgram({
          bytes,
          name: src.slice(src.lastIndexOf('/') + 1) || 'program.wasm',
          appId,
          signal: stopping.signal,
          canvas: offscreen,
          args,
          env,
          files: filesOf(files),
          memoryMB: memory,
          audioRate: AUDIO_RATE,
          onConsole: (stream, line) => {
            if (output.length < MAX_OUTPUT_LINES) output.push(line);
            if (stream === 'err') console.warn(`[${src}] ${line}`);
            // eslint-disable-next-line no-console -- the program's own printing, as an app's print() output is forwarded
            else console.log(`[${src}] ${line}`);
          },
          onPost: (text) => handlers.current.onMessage?.(text),
          onSize: (w, h) => {
            if (!cancelled) setFrameSize({ w, h });
          },
          onPixels: (w, h, buffer) => {
            if (!fallback) return;
            if (canvas.width !== w || canvas.height !== h) {
              canvas.width = w;
              canvas.height = h;
            }
            fallback.putImageData(new ImageData(new Uint8ClampedArray(buffer), w, h), 0, 0);
          },
          onAudio: (samples) => sound.push(samples),
          onExit: (code) => {
            ended = true;
            if (cancelled) return;
            setShown((now) => (now.kind === 'running' ? { kind: 'output', lines: [...output], code } : now));
            handlers.current.onExit?.(code);
          },
          onCrash: (message) => {
            ended = true;
            fail(message);
          },
        });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        return;
      }
      if (cancelled) {
        program.stop();
        return;
      }
      programRef.current = program;
      handlers.current.onReady?.({
        handle: program.handle,
        exports: program.exports.filter((e) => e.kind === 'function').map((e) => e.name),
        missing: program.missing,
      });
      if (!program.drawsFrames || program.exitCode !== null) {
        // Run once and done: what it printed is what it shows.
        setShown({ kind: 'output', lines: output, code: program.exitCode });
        if (program.exitCode !== null) handlers.current.onExit?.(program.exitCode);
        return;
      }
      setShown({ kind: 'running' });
      frames(performance.now());
    })();

    return () => {
      cancelled = true;
      stopping.abort();
      cancelAnimationFrame(raf);
      programRef.current = null;
      program?.stop();
      sound.close();
      if (soundRef.current === sound) soundRef.current = null;
      canvas.remove();
      if (canvasRef.current === canvas) canvasRef.current = null;
      held.clear();
      pads.clear();
      pointerIds.clear();
    };
    // Started again when what the program is, or what it is started with, changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startKey]);

  const exportsOf = (name: string) => programRef.current?.exports.some((e) => e.name === name) ?? false;

  /** Queues an event for the next frame; past MAX_QUEUED_EVENTS only what lets go of a key or a pad (`release`), which nothing may drop. */
  const queue = (event: WasmInputEvent, release = false) => {
    if (!programRef.current) return;
    const events = eventsRef.current;
    // A move replaces the move before it that the program has not yet seen.
    if (event.kind === 'pointer' && event.phase === 0) {
      const prev = events[events.length - 1];
      if (prev && prev.kind === 'pointer' && prev.phase === 0 && prev.id === event.id) {
        events[events.length - 1] = event;
        return;
      }
    }
    if (release || events.length < MAX_QUEUED_EVENTS) events.push(event);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // A program that takes no keys keeps none from the browser.
    if (!exportsOf('key') && !exportsOf('text')) return;
    const modifier = MODIFIER_KEYS.has(event.key);
    // AltGr types characters (@, €, { on many layouts) and reports itself as Ctrl and Alt on Windows;
    // on a Mac, Option types them (Option+L is @ on a German layout) and reports only Alt.
    const altGraph = typeof event.getModifierState === 'function' && event.getModifierState('AltGraph');
    const optionTyping = event.altKey && !event.ctrlKey && !event.metaKey && [...event.key].length === 1 && onMac();
    // A chord of the browser's or the system's stays theirs (Ctrl or Cmd, or Alt, with another key),
    // and Tab moves on. A modifier pressed on its own is the program's to hear.
    if ((!modifier && !altGraph && !optionTyping && (event.metaKey || event.ctrlKey || event.altKey)) || event.key === 'Tab') return;
    const code = WASM_KEY_CODES[event.code] ?? 0;
    if (code !== 0 && !heldRef.current.has(code)) {
      heldRef.current.add(code);
      queue({ kind: 'key', code, down: true });
    }
    // One character, an astral one (a surrogate pair) included.
    if (!modifier && [...event.key].length === 1) queue({ kind: 'text', codepoint: event.key.codePointAt(0) ?? 0 });
    // The program takes the key from the browser (arrows and Space do not scroll the page), but
    // for a modifier on its own and the function keys, which stay the browser's as well.
    if (!modifier && !FUNCTION_KEY.test(event.key)) event.preventDefault();
    soundRef.current?.resume();
  };

  const onKeyUp = (event: React.KeyboardEvent) => {
    // Whatever is held now, so a key let go while Ctrl was down is not held for ever.
    const code = WASM_KEY_CODES[event.code] ?? 0;
    if (code !== 0 && heldRef.current.delete(code)) {
      queue({ kind: 'key', code, down: false }, true);
      event.preventDefault();
    }
  };

  /** The focus has left: every key held is let go, and every gamepad reads as let go. */
  const releaseAll = () => {
    for (const code of heldRef.current) queue({ kind: 'key', code, down: false }, true);
    heldRef.current.clear();
    for (const index of padsRef.current) queue({ kind: 'gamepad', index, buttons: 0, axes: [0, 0, 0, 0] }, true);
    padsRef.current.clear();
  };

  /** Where the pointer is on the frame, in its own pixels, with the space round a contained frame left out. */
  const pointerAt = (event: React.PointerEvent): { x: number; y: number } => {
    const canvas = canvasRef.current;
    const { w, h } = frameSizeRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / w, rect.height / h) || 1;
    const left = rect.left + (rect.width - w * scale) / 2;
    const top = rect.top + (rect.height - h * scale) / 2;
    return { x: (event.clientX - left) / scale, y: (event.clientY - top) / scale };
  };

  const onPointer = (event: React.PointerEvent, step: 0 | 1 | 2 | 3) => {
    const ids = pointerIdsRef.current;
    let id = event.pointerType === 'mouse' ? 0 : ids.get(event.pointerId);
    if (id === undefined) {
      id = 1;
      const taken = new Set(ids.values());
      while (taken.has(id)) id++;
      ids.set(event.pointerId, id);
    }
    if (step === 1) {
      boxRef.current?.focus({ preventScroll: true });
      soundRef.current?.resume();
      try {
        (event.currentTarget as Element).setPointerCapture(event.pointerId);
      } catch {
        // A pointer the browser has already let go of.
      }
    }
    const { x, y } = pointerAt(event);
    queue({ kind: 'pointer', id, phase: step, x, y, buttons: event.buttons });
    if (step >= 2 && event.pointerType !== 'mouse') ids.delete(event.pointerId);
  };

  // The frame's own shape, kept at any width.
  const ratio = `${frameSize.w} / ${frameSize.h}`;
  const showScreen = shown.kind === 'running' || shown.kind === 'loading';
  const screenPlace: React.CSSProperties = pixelBox
    ? { left: '50%', top: '50%', width: pixelBox.w, height: pixelBox.h, transform: 'translate(-50%, -50%)' }
    : { inset: 0 };

  return (
    <div
      ref={boxRef}
      className={className}
      role="application"
      aria-label={label}
      aria-roledescription="program"
      tabIndex={0}
      data-softn-wasm-app=""
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onFocus={() => {
        focusedRef.current = true;
        setFocused(true);
      }}
      onBlur={() => {
        focusedRef.current = false;
        setFocused(false);
        releaseAll();
      }}
      onWheel={(e) => {
        if (!exportsOf('wheel')) return;
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        queue({ kind: 'wheel', dx: e.deltaX * unit, dy: e.deltaY * unit });
      }}
      // The whole box takes the pointer, the space round a frame shown at a
      // whole multiple too: a press there is at a point just off the frame.
      onPointerDown={(e) => onPointer(e, 1)}
      onPointerMove={(e) => onPointer(e, 0)}
      onPointerUp={(e) => onPointer(e, 2)}
      onPointerCancel={(e) => onPointer(e, 3)}
      onContextMenu={(e) => {
        if (exportsOf('pointer')) e.preventDefault();
      }}
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: style?.height !== undefined ? undefined : ratio,
        // A program's screen is black in either theme, so what is written on it is light in either.
        background: 'var(--color-black, black)',
        borderRadius: 8,
        overflow: 'hidden',
        outline: focused ? '2px solid var(--color-primary-500, royalblue)' : 'none',
        outlineOffset: 2,
        // A finger on a running program is the program's, not a scroll of the page; printed output still scrolls.
        touchAction: shown.kind === 'running' ? 'none' : undefined,
        ...style,
      }}
    >
      <div
        ref={screenRef}
        style={{
          position: 'absolute',
          ...screenPlace,
          display: showScreen ? 'block' : 'none',
          imageRendering: smooth ? 'auto' : 'pixelated',
        }}
      />
      {shown.kind === 'loading' && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--color-white, white)' }}>
          <LoadingIndicator label={`Starting ${label}`} />
        </div>
      )}
      {shown.kind === 'error' && (
        <div role="alert" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 16, color: 'var(--color-white, white)', fontSize: 14, textAlign: 'center' }}>
          {shown.message}
        </div>
      )}
      {shown.kind === 'output' && (
        <pre
          style={{
            position: 'absolute',
            inset: 0,
            margin: 0,
            padding: 12,
            overflow: 'auto',
            color: 'var(--color-white, white)',
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          }}
        >
          {shown.lines.join('\n')}
          {shown.code !== null && shown.code !== 0 ? `\n(exited with code ${shown.code})` : ''}
        </pre>
      )}
    </div>
  );
}

export default WasmApp;
