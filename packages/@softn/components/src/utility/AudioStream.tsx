/**
 * AudioStream Component
 *
 * A sink for sound that is being *generated* rather than played back.
 *
 * SoftN's `softn.audio` API plays files: you hand it a URL or a data URL and it
 * makes a noise. That covers a click, a jingle and a voice note, and it covers
 * nothing that produces its audio as it goes. A `.logic` script has no
 * `AudioContext`, no `AudioWorklet` and no `Blob` (see the bundle contract's
 * "missing globals"), so a synthesiser, a modem, a chiptune player or an
 * emulator has no way to be heard at all — the samples exist inside the VM and
 * stop there.
 *
 * This is that missing primitive. The script produces blocks of PCM; the
 * component owns the audio clock and queues them back to back so they play as
 * one continuous stream. It knows nothing about what the samples mean.
 *
 * Three things shape the implementation:
 *
 * 1. **Gapless means explicit times.** Each block is scheduled with
 *    `start(when)` at a cursor the component tracks itself, not when the
 *    previous node's `onended` fires. `onended` arrives on the main thread a
 *    few milliseconds late and after a task queue that may be busy, so a
 *    chain built on it clicks on every block. The cursor is audio-clock time
 *    and lands the next block on the sample immediately after the last one.
 *
 * 2. **Typed arrays cannot cross the VM boundary.** Everything coming out of a
 *    script is deep-cloned through an allowlist that admits plain objects,
 *    arrays, strings and numbers; a `Uint8Array` arrives as `null`. PCM
 *    therefore travels as base64, which is what `Uint8Array.prototype.toBase64`
 *    produces inside `.logic` and what this component decodes here — into a
 *    scratch buffer it reuses, so the steady state allocates nothing per block
 *    beyond the `AudioBuffer` itself.
 *
 * 3. **Audio blocks must not re-render React.** At an 80ms lead this pulls
 *    roughly forty times a second; a `setState` per block is forty renders a
 *    second of the whole subtree. All per-block state lives in refs, and the
 *    component renders only when its status changes.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

/** Sample formats the component understands, after normalisation. */
type PcmFormat = 'i16' | 'f32';

/**
 * A block of PCM, in the richer of the two shapes `getSamples` may return.
 *
 * The plain-string shape is the same thing with everything except `pcm`
 * defaulted from the component's props. Producers that resample, that vary
 * their block length, or that need to report starvation should return the
 * object.
 */
export interface AudioStreamBlock {
  /** Base64 of the interleaved PCM for this block. */
  pcm?: string | null;
  /** Accepted as an alias for `pcm`, for producers that named it `data`. */
  data?: string | null;
  /** Interleaved samples as plain numbers, -1..1. An alternative to `pcm`. */
  samples?: number[] | null;
  /**
   * Frames (one frame = one sample per channel) actually delivered.
   *
   * Authoritative when present, and worth sending: a producer whose frame
   * count is fractional per video frame — 803.65 at 48kHz for a 59.7275Hz console —
   * delivers a different count on consecutive calls, and a consumer that
   * assumed a constant would drift.
   */
  frames?: number;
  /** Rate the PCM is at. Defaults to the context rate. */
  rate?: number;
  /** Accepted as an alias for `rate`. */
  sampleRate?: number;
  /** Channels interleaved in `pcm`. Defaults to the `channels` prop. */
  channels?: number;
  /** `'i16'`/`'s16le'`/`'pcm16'` or `'f32'`/`'float32'`. Defaults to the `format` prop. */
  format?: string;
  /** The producer's own starvation counter, passed through to `onUnderrun`. */
  underruns?: number;
}

/** What `getSamples` may hand back. `null`, `undefined` or 0 frames means silence. */
export type AudioStreamResult =
  | string
  | number[]
  | AudioStreamBlock
  | null
  | undefined;

export interface AudioStreamReadyInfo {
  /** The rate the graph actually runs at. Identical to the first argument. */
  sampleRate: number;
  /** Channels the component will ask for by default. */
  channels: number;
  /** Target lead buffer, in milliseconds. */
  bufferMs: number;
  /** The context's own processing latency, in seconds. */
  baseLatency: number;
}

export interface AudioStreamUnderrunInfo {
  /** How many times this component has starved since it started. */
  underruns: number;
  /** The producer's own counter, if it reported one. */
  producerUnderruns: number;
  /** Audio still queued when the starvation was noticed, in milliseconds. */
  queuedMs: number;
  /** The rate the graph is running at. */
  sampleRate: number;
}

export interface AudioStreamProps {
  /**
   * Called when the scheduler needs more audio.
   *
   * Receives the number of frames that would fill the lead buffer, and returns
   * either a base64 string of interleaved PCM, an {@link AudioStreamBlock}, or
   * `null`/`undefined` for "nothing right now". Returning nothing is a normal,
   * cheap answer — the component simply asks again — and is the right answer
   * when the producer has no samples ready. Do not pad with silence: silence
   * inserted mid-stream lands as a click, whereas a short queue does not.
   *
   * May be synchronous or return a promise; script functions running in a
   * worker are asynchronous and are awaited.
   *
   * Called on the component's own schedule, driven by how far ahead the queue
   * runs — not on a frame timer. It keeps running while the tab is in the
   * background, where `requestAnimationFrame` does not.
   */
  getSamples?: (wantFrames: number) => AudioStreamResult | Promise<AudioStreamResult>;
  /**
   * Rate to ask the audio system for, in Hz (default 48000).
   *
   * A request, not a promise: the browser and the output device both get a
   * say, and Safari refuses rates it cannot do natively rather than
   * resampling. `onReady` reports the rate actually in use, and a producer
   * should generate at that rate rather than assume this one.
   */
  sampleRate?: number;
  /** Channels in the PCM the producer will send: 1 or 2 (default 2) */
  channels?: 1 | 2;
  /** Sample format of the PCM (default 'i16' — signed 16-bit, little-endian) */
  format?: PcmFormat;
  /**
   * Target lead buffer in milliseconds (default 80).
   *
   * The queue is kept roughly this far ahead of the playhead. Larger is safer
   * — it is how much main-thread stall the stream survives without a gap —
   * and smaller is more responsive, which matters when the audio answers an
   * input. 80ms survives an ordinary garbage collection; below about 30ms an
   * unlucky layout is audible.
   */
  bufferMs?: number;
  /** Whether the stream is pulling audio (default true) */
  running?: boolean;
  /** Silence the output without stopping the stream (default false) */
  muted?: boolean;
  /** Output gain, 0..1 (default 1) */
  volume?: number;
  /**
   * Called once the graph is actually running, with the real context rate.
   *
   * This is the moment a producer should configure itself: until it has fired
   * there is no audio clock to match. The second argument carries the rest of
   * the graph's shape for producers that need it.
   */
  onReady?: (sampleRate: number, info: AudioStreamReadyInfo) => void;
  /** Called when the queue starves, at most a few times a second */
  onUnderrun?: (count: number, info: AudioStreamUnderrunInfo) => void;
  /** Called when the audio graph cannot be built */
  onError?: (error: string) => void;
  /** Show the built-in status strip and the unlock button (default true) */
  showControls?: boolean;
  /** Label on the button shown while the browser is blocking audio */
  unlockLabel?: string;
  /** Inline styles for the status strip */
  style?: React.CSSProperties;
  /** CSS class for the status strip */
  className?: string;
  /** Rendered below the status strip */
  children?: React.ReactNode;
}

/** How the component reports itself while it is not playing. */
type StreamStatus = 'idle' | 'blocked' | 'running' | 'error';

/**
 * Nodes are kept in a fixed ring rather than a Set so that scheduling a block
 * allocates nothing. Finished nodes drop out through a single shared `onended`
 * handler; the ring exists so that teardown can reach whatever is still
 * playing. 128 slots is far more than a lead buffer can hold.
 */
const SOURCE_RING_SIZE = 128;

/** Bounds the work one pump can do if a producer hands back very short blocks. */
const MAX_BLOCKS_PER_PUMP = 32;

/** Blocks discarded, at most, when catching up after the tab was backgrounded. */
const MAX_STALE_BLOCKS = 32;

/**
 * How long one pump may hold the main thread, in milliseconds.
 *
 * Both loops in `pump` are bounded by a block COUNT. That is the right bound
 * for a source that hands back audio it already has: thirty-two blocks drain in
 * microseconds. It is the wrong bound for a source that has to make the audio —
 * an emulator, a synthesiser — because for those the loop's own cost decides
 * whether it can ever finish.
 *
 * The fill loop runs until the cursor is a full lead ahead of `currentTime`,
 * re-reading the clock after every block. If a block takes longer to produce
 * than the audio it contains, the clock gains on the cursor with every
 * iteration and the exit condition recedes: all thirty-two blocks run, after
 * the stale-drop loop before it ran its thirty-two. Each pump then holds the
 * thread for seconds, the audio clock falls that far behind while it does, and
 * the next pump repeats it. requestAnimationFrame ran four times a second, the
 * emulator's own counter read 0.1 fps, and it looked like the machine was
 * hundreds of times too slow. It was fully busy the whole time.
 *
 * It needs the source to be slower than real time to start, which is why an
 * x86 desktop never sees it and a Snapdragon laptop always does. Reproduced on
 * the desktop with Chrome's CPU throttle at 4x: single tasks of 22 seconds.
 *
 * So the pump also has a wall-clock budget, checked between blocks in both
 * loops. A fast source never notices — it is done long before this — and a slow
 * one gets one block per tick and an underrun, which this component already
 * treats as the right thing when audio is short: come back next tick, never
 * pad, never pile up. Half a 60Hz frame leaves the display the other half.
 */
const PUMP_BUDGET_MS = 8;

/** Smallest request worth making, as a fraction of a second. */
const MIN_WANT_SECONDS = 0.005;

/** Underrun callbacks are counted always but reported at most this often. */
const UNDERRUN_REPORT_INTERVAL = 0.25;

/** The slot a source node occupies, stamped on the node to avoid a lookup. */
const SLOT_KEY = '__softnAudioStreamSlot';

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** char code -> 6-bit value, -1 for padding, whitespace and anything else. */
const B64_LOOKUP = (() => {
  const table = new Int8Array(256).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i += 1) {
    table[B64_ALPHABET.charCodeAt(i)] = i;
  }
  // URL-safe base64 costs two entries and saves a producer from having to know
  // which flavour it emitted.
  table['-'.charCodeAt(0)] = 62;
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

/**
 * Whether typed-array views over the scratch buffer can be trusted directly.
 *
 * Every platform this runs on is little-endian, so this is true and the fast
 * path is taken; the check costs one allocation at module load and means the
 * component is not silently wrong if that ever stops being true.
 */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Accept the several spellings a producer might reasonably use. */
function normaliseFormat(format: string, fallback: PcmFormat): PcmFormat {
  switch (format.toLowerCase()) {
    case 'i16':
    case 's16':
    case 's16le':
    case 'int16':
    case 'pcm16':
    case 'pcm_s16le':
      return 'i16';
    case 'f32':
    case 'f32le':
    case 'float':
    case 'float32':
      return 'f32';
    default:
      return fallback;
  }
}

/**
 * Base64 into an existing byte array, returning how many bytes were written.
 *
 * Not `atob`: that allocates a string as long as the decoded audio, on every
 * block, purely to be read once and thrown away. This writes straight into the
 * reused scratch buffer. Characters outside the alphabet — padding, newlines
 * from a wrapped encoder — are skipped rather than rejected.
 */
function decodeBase64Into(source: string, out: Uint8Array): number {
  let written = 0;
  let accumulator = 0;
  let bits = 0;
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    const value = code > 255 ? -1 : B64_LOOKUP[code];
    if (value < 0) continue;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (written >= out.length) return written;
      out[written] = (accumulator >>> bits) & 0xff;
      written += 1;
    }
  }
  return written;
}

/**
 * The reused decode target, plus aligned views over the same memory.
 *
 * The views are built once per growth, not per block, and exist so the
 * interleaved samples can be read as numbers without a `DataView` call per
 * sample on the platforms where that is safe.
 */
interface Scratch {
  bytes: Uint8Array;
  i16: Int16Array;
  f32: Float32Array;
  view: DataView;
}

function makeScratch(byteLength: number): Scratch {
  // A multiple of four keeps the Float32Array view constructible.
  const capacity = Math.max(8192, ((byteLength + 3) >>> 2) << 2);
  const buffer = new ArrayBuffer(capacity);
  return {
    bytes: new Uint8Array(buffer),
    i16: new Int16Array(buffer, 0, capacity >>> 1),
    f32: new Float32Array(buffer, 0, capacity >>> 2),
    view: new DataView(buffer),
  };
}

/** Cheap "did this block contain anything" test, without decoding it. */
function hasAudio(result: AudioStreamResult): boolean {
  if (!result) return false;
  if (typeof result === 'string') return result.length > 0;
  if (Array.isArray(result)) return result.length > 0;
  const block = result as AudioStreamBlock;
  if (typeof block.frames === 'number') return block.frames > 0;
  if (typeof block.pcm === 'string') return block.pcm.length > 0;
  if (typeof block.data === 'string') return block.data.length > 0;
  if (Array.isArray(block.samples)) return block.samples.length > 0;
  return false;
}

export function AudioStream({
  getSamples,
  sampleRate = 48000,
  channels = 2,
  format = 'i16',
  bufferMs = 80,
  running = true,
  muted = false,
  volume = 1,
  onReady,
  onUnderrun,
  onError,
  showControls = true,
  unlockLabel = 'Tap to enable sound',
  style,
  className,
  children,
}: AudioStreamProps): React.ReactElement | null {
  const contextRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const requestedRateRef = useRef(sampleRate);
  const actualRateRef = useRef(sampleRate);

  /** Playing and recently-played nodes, so teardown can reach them. */
  const ringRef = useRef<Array<AudioBufferSourceNode | null>>(
    new Array<AudioBufferSourceNode | null>(SOURCE_RING_SIZE).fill(null)
  );
  const ringIndexRef = useRef(0);

  /**
   * Context time at which the next block starts — the whole scheduler.
   *
   * Zero means "nothing scheduled yet", which is deliberately distinct from a
   * cursor that has fallen into the past: the first fill is not an underrun.
   */
  const cursorRef = useRef(0);
  const startedRef = useRef(false);
  const pumpingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Wall time the last pump took. Feeds the tick's back-off; see PUMP_BUDGET_MS. */
  const lastPumpMsRef = useRef(0);
  const listeningForGestureRef = useRef(false);
  const lastResumeAttemptRef = useRef(0);
  const readyFiredRef = useRef(false);
  const scratchRef = useRef<Scratch | null>(null);
  const underrunsRef = useRef(0);
  const producerUnderrunsRef = useRef(0);
  const lastUnderrunReportRef = useRef(-Infinity);
  const runningRef = useRef(running);
  const bufferFailedRef = useRef(false);

  // Callbacks and tunables live in refs so a host that passes a fresh closure
  // every render does not rebuild the audio graph. Rebuilding it would drop the
  // queue — an audible gap — and, on a page that has not had a user gesture
  // since, would leave the new context suspended with no way back.
  const handlers = useRef({ getSamples, onReady, onUnderrun, onError });
  handlers.current = { getSamples, onReady, onUnderrun, onError };
  const settings = useRef({ channels, format, bufferMs });
  settings.current = { channels, format, bufferMs };

  const [status, setStatus] = useState<StreamStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [reportedRate, setReportedRate] = useState<number | null>(null);

  const fail = useCallback((message: string) => {
    setError(message);
    setStatus('error');
    handlers.current.onError?.(message);
  }, []);

  /**
   * Retire a finished node.
   *
   * One shared handler rather than a closure per block: a closure per block is
   * an allocation per block, which is the thing this component is trying not to
   * do. The node carries its own ring slot so the handler does not have to
   * search for it.
   */
  const handleEnded = useCallback((event: Event) => {
    const node = event.target as (AudioBufferSourceNode & { [SLOT_KEY]?: number }) | null;
    if (!node) return;
    try {
      node.disconnect();
    } catch {
      // Already disconnected by teardown; nothing to undo.
    }
    const slot = node[SLOT_KEY];
    const ring = ringRef.current;
    if (typeof slot === 'number' && ring[slot] === node) ring[slot] = null;
  }, []);

  const stopPump = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * The one-shot listeners that wait for the user gesture the autoplay policy
   * requires. Declared here, above teardown, because teardown removes them.
   */
  const gestureHandlerRef = useRef<(() => void) | null>(null);

  const detachGestureListeners = useCallback(() => {
    const handler = gestureHandlerRef.current;
    listeningForGestureRef.current = false;
    if (!handler || typeof window === 'undefined') return;
    gestureHandlerRef.current = null;
    window.removeEventListener('pointerdown', handler, true);
    window.removeEventListener('touchend', handler, true);
    window.removeEventListener('keydown', handler, true);
  }, []);

  /** Close the graph completely. Safe to call more than once. */
  const teardown = useCallback(() => {
    stopPump();
    detachGestureListeners();

    const ring = ringRef.current;
    for (let i = 0; i < ring.length; i += 1) {
      const node = ring[i];
      if (!node) continue;
      node.onended = null;
      try {
        // Every node in the ring has been started, so this is legal; it is
        // wrapped because a context already closing rejects the call.
        node.stop();
      } catch {
        // Nothing to undo — it is going away with the context regardless.
      }
      try {
        node.disconnect();
      } catch {
        // Same.
      }
      ring[i] = null;
    }
    ringIndexRef.current = 0;

    if (gainRef.current) {
      try {
        gainRef.current.disconnect();
      } catch {
        // The context may already be closing.
      }
      gainRef.current = null;
    }

    const context = contextRef.current;
    contextRef.current = null;
    if (context) {
      void context.close().catch(() => {
        // Closing an already-closed context rejects; there is nothing to do.
      });
    }

    cursorRef.current = 0;
    startedRef.current = false;
    pumpingRef.current = false;
    readyFiredRef.current = false;
    underrunsRef.current = 0;
    producerUnderrunsRef.current = 0;
    lastUnderrunReportRef.current = -Infinity;
    bufferFailedRef.current = false;
  }, [stopPump, detachGestureListeners]);

  const applyGain = useCallback((targetVolume: number, isMuted: boolean) => {
    const gain = gainRef.current;
    const context = contextRef.current;
    if (!gain || !context) return;
    const target = isMuted ? 0 : clamp(targetVolume, 0, 1);
    try {
      // A ramp rather than a jump: setting `.value` mid-block steps the
      // waveform, and a step is a click.
      gain.gain.setTargetAtTime(target, context.currentTime, 0.015);
    } catch {
      gain.gain.value = target;
    }
  }, []);

  const noteUnderrun = useCallback((queuedSeconds: number) => {
    underrunsRef.current += 1;
    const context = contextRef.current;
    const now = context ? context.currentTime : 0;
    // Starvation lasting a second would otherwise fire forty callbacks into the
    // scripting VM, each of which is a host boundary crossing that makes the
    // starvation worse.
    if (now - lastUnderrunReportRef.current < UNDERRUN_REPORT_INTERVAL) return;
    lastUnderrunReportRef.current = now;
    handlers.current.onUnderrun?.(underrunsRef.current, {
      underruns: underrunsRef.current,
      producerUnderruns: producerUnderrunsRef.current,
      queuedMs: Math.max(0, queuedSeconds) * 1000,
      sampleRate: actualRateRef.current,
    });
  }, []);

  /**
   * Turn one result from `getSamples` into a scheduled node.
   *
   * Returns the duration scheduled, in seconds, or 0 when the block carried no
   * audio. Everything here is on the pull path and runs tens of times a second:
   * the only allocation is the AudioBuffer, which cannot be reused because the
   * node that consumes it owns it until it has finished playing.
   */
  const scheduleBlock = useCallback(
    (
      context: AudioContext,
      destination: AudioNode,
      result: AudioStreamResult,
      when: number
    ): number => {
      const config = settings.current;
      let base64: string | null = null;
      let numbers: number[] | null = null;
      let blockFormat: PcmFormat = config.format;
      let blockChannels = clamp(Math.round(config.channels), 1, 8);
      let blockRate = actualRateRef.current;
      let declaredFrames = -1;

      if (typeof result === 'string') {
        base64 = result;
      } else if (Array.isArray(result)) {
        numbers = result;
      } else if (result && typeof result === 'object') {
        const block = result as AudioStreamBlock;
        if (typeof block.pcm === 'string') base64 = block.pcm;
        else if (typeof block.data === 'string') base64 = block.data;
        else if (Array.isArray(block.samples)) numbers = block.samples;

        if (typeof block.format === 'string') {
          blockFormat = normaliseFormat(block.format, config.format);
        }
        if (typeof block.channels === 'number' && block.channels >= 1) {
          blockChannels = clamp(Math.round(block.channels), 1, 8);
        }
        const rate = typeof block.rate === 'number' ? block.rate : block.sampleRate;
        if (typeof rate === 'number' && rate > 0) blockRate = rate;
        if (typeof block.frames === 'number') {
          declaredFrames = Math.max(0, Math.floor(block.frames));
        }
        if (typeof block.underruns === 'number') {
          producerUnderrunsRef.current = block.underruns;
        }
      }

      if (declaredFrames === 0) return 0;
      if (base64 === null && numbers === null) return 0;

      // A buffer's rate has to be one the audio system will accept; a producer
      // that reported nonsense gets the context rate rather than an exception.
      if (!(blockRate >= 3000 && blockRate <= 384000)) blockRate = context.sampleRate;

      const bytesPerSample = blockFormat === 'f32' ? 4 : 2;
      let frames: number;
      let scratch: Scratch | null = null;
      let byteLength = 0;

      if (base64 !== null) {
        if (base64.length === 0) return 0;
        // Four base64 characters carry three bytes; the +3 covers the tail.
        const needed = ((base64.length * 3) >>> 2) + 3;
        if (!scratchRef.current || scratchRef.current.bytes.length < needed) {
          // Grow geometrically so a producer with a slowly rising block size
          // does not reallocate on every call.
          const previous = scratchRef.current ? scratchRef.current.bytes.length : 0;
          scratchRef.current = makeScratch(Math.max(needed, previous * 2));
        }
        scratch = scratchRef.current;
        byteLength = decodeBase64Into(base64, scratch.bytes);
        const available = Math.floor(byteLength / (bytesPerSample * blockChannels));
        frames = declaredFrames >= 0 ? Math.min(declaredFrames, available) : available;
      } else {
        const available = Math.floor((numbers as number[]).length / blockChannels);
        frames = declaredFrames >= 0 ? Math.min(declaredFrames, available) : available;
      }

      if (frames <= 0) return 0;

      let buffer: AudioBuffer;
      try {
        buffer = context.createBuffer(blockChannels, frames, blockRate);
      } catch (err) {
        // One report, not one per block: a producer emitting a shape the audio
        // system will not take would otherwise flood the host with callbacks.
        if (!bufferFailedRef.current) {
          bufferFailedRef.current = true;
          fail(
            `Cannot buffer ${blockChannels}ch ${frames} frames at ${blockRate}Hz: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
        return 0;
      }

      // De-interleave straight into the buffer's own channel arrays.
      // `getChannelData` hands back the real storage, so there is no scratch
      // float array and no copy — writing into it before the node starts is
      // exactly what it is for.
      if (numbers !== null) {
        const source = numbers;
        for (let channel = 0; channel < blockChannels; channel += 1) {
          const out = buffer.getChannelData(channel);
          let index = channel;
          for (let frame = 0; frame < frames; frame += 1) {
            const value = source[index];
            out[frame] = typeof value === 'number' ? value : 0;
            index += blockChannels;
          }
        }
      } else if (scratch) {
        if (blockFormat === 'i16') {
          if (LITTLE_ENDIAN) {
            const samples = scratch.i16;
            for (let channel = 0; channel < blockChannels; channel += 1) {
              const out = buffer.getChannelData(channel);
              let index = channel;
              for (let frame = 0; frame < frames; frame += 1) {
                // 32768, not 32767: it is the magnitude of the most negative
                // sample, so full-scale maps to exactly -1.0 and nothing clips.
                out[frame] = samples[index] / 32768;
                index += blockChannels;
              }
            }
          } else {
            const view = scratch.view;
            for (let channel = 0; channel < blockChannels; channel += 1) {
              const out = buffer.getChannelData(channel);
              let offset = channel * 2;
              for (let frame = 0; frame < frames; frame += 1) {
                out[frame] = view.getInt16(offset, true) / 32768;
                offset += blockChannels * 2;
              }
            }
          }
        } else if (LITTLE_ENDIAN) {
          const samples = scratch.f32;
          for (let channel = 0; channel < blockChannels; channel += 1) {
            const out = buffer.getChannelData(channel);
            let index = channel;
            for (let frame = 0; frame < frames; frame += 1) {
              out[frame] = samples[index];
              index += blockChannels;
            }
          }
        } else {
          const view = scratch.view;
          for (let channel = 0; channel < blockChannels; channel += 1) {
            const out = buffer.getChannelData(channel);
            let offset = channel * 4;
            for (let frame = 0; frame < frames; frame += 1) {
              out[frame] = view.getFloat32(offset, true);
              offset += blockChannels * 4;
            }
          }
        }
      }

      const node = context.createBufferSource() as AudioBufferSourceNode & {
        [SLOT_KEY]?: number;
      };
      node.buffer = buffer;
      node.connect(destination);
      node.onended = handleEnded;

      const slot = ringIndexRef.current;
      ringRef.current[slot] = node;
      node[SLOT_KEY] = slot;
      ringIndexRef.current = (slot + 1) % SOURCE_RING_SIZE;

      node.start(when);
      startedRef.current = true;

      // The block's own rate, not the context's: a buffer at a different rate
      // is resampled on playback, and its duration in context time is still
      // frames divided by the rate it was authored at.
      return frames / blockRate;
    },
    [fail, handleEnded]
  );

  /**
   * Fill the queue back up to the lead buffer.
   *
   * Async because a script function running in a worker returns a promise; the
   * synchronous case never awaits, so the common path costs nothing. Re-entry
   * is refused rather than queued: two pumps interleaving would both advance
   * the cursor and the blocks would overlap.
   */
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    const context = contextRef.current;
    const gain = gainRef.current;
    if (!context || !gain || context.state !== 'running' || !runningRef.current) return;
    const produce = handlers.current.getSamples;
    if (typeof produce !== 'function') return;

    pumpingRef.current = true;
    const startedAt = performance.now();
    const overBudget = () => performance.now() - startedAt > PUMP_BUDGET_MS;
    try {
      const lead = clamp(settings.current.bufferMs, 10, 2000) / 1000;
      // Far enough behind that the queue cannot be caught up by playing what is
      // waiting: the tab was backgrounded, or the machine stalled hard.
      const staleAfter = Math.max(lead * 4, 0.5);

      let now = context.currentTime;
      let cursor = cursorRef.current;

      if (cursor < now) {
        const behind = now - cursor;
        const wasPlaying = startedRef.current && cursor > 0;
        if (wasPlaying) noteUnderrun(0);

        if (wasPlaying && behind > staleAfter) {
          // Everything the producer is holding is now older than the playhead.
          // Playing it would put the stream permanently late — a fixed offset
          // that never recovers, which for anything interactive is worse than
          // the gap. Discard it and restart from the current instant.
          const dropWant = Math.max(1, Math.round(lead * actualRateRef.current));
          for (let dropped = 0; dropped < MAX_STALE_BLOCKS; dropped += 1) {
            // Dropping is only cheap for a source that already has the audio. One
            // that must make it pays a full block per iteration, and the cursor
            // resync below is what actually repairs the timing anyway.
            if (overBudget()) break;
            const pending = produce(dropWant);
            const stale: AudioStreamResult = isThenable(pending)
              ? ((await pending) as AudioStreamResult)
              : (pending as AudioStreamResult);
            if (contextRef.current !== context || !runningRef.current) return;
            if (!hasAudio(stale)) break;
          }
          now = context.currentTime;
        }

        // Start just far enough ahead that the block cannot land in the past
        // between here and `start()`. Scheduling at a time already gone plays
        // the block immediately and truncated, which is the pile-up this
        // resync exists to prevent.
        cursor = now + Math.max(0.015, context.baseLatency || 0);
      }

      for (let i = 0; i < MAX_BLOCKS_PER_PUMP; i += 1) {
        const queued = cursor - now;
        if (queued >= lead) break;
        if (i > 0 && overBudget()) {
          // Out of time before the lead was filled: the source cannot outrun
          // the clock right now. An underrun is the honest result — see
          // PUMP_BUDGET_MS — and the next tick gets its own budget.
          if (startedRef.current) noteUnderrun(cursor - now);
          break;
        }

        const wantSeconds = Math.max(MIN_WANT_SECONDS, lead - queued);
        const want = Math.max(1, Math.round(wantSeconds * actualRateRef.current));

        const pending = produce(want);
        const result: AudioStreamResult = isThenable(pending)
          ? ((await pending) as AudioStreamResult)
          : (pending as AudioStreamResult);

        // The await above can outlive the graph: unmount, a `sampleRate`
        // change, or `running` going false while the worker was busy. Anything
        // scheduled now would be scheduled on a dead context.
        if (
          contextRef.current !== context ||
          !runningRef.current ||
          context.state !== 'running'
        ) {
          return;
        }

        const scheduled = scheduleBlock(context, gain, result, cursor);
        if (scheduled <= 0) {
          // Nothing ready. Do not pad with silence — a silent block is a click
          // where the real samples were going to be. Come back next tick.
          if (startedRef.current) noteUnderrun(cursor - now);
          break;
        }
        cursor += scheduled;
        now = context.currentTime;
      }

      cursorRef.current = cursor;
    } finally {
      lastPumpMsRef.current = performance.now() - startedAt;
      pumpingRef.current = false;
    }
  }, [noteUnderrun, scheduleBlock]);

  const markRunning = useCallback(() => {
    const context = contextRef.current;
    if (!context) return;
    // The gesture that was being waited for has happened (or was never needed).
    detachGestureListeners();
    setStatus('running');
    setError(null);
    if (!readyFiredRef.current) {
      readyFiredRef.current = true;
      actualRateRef.current = context.sampleRate;
      setReportedRate(context.sampleRate);
      handlers.current.onReady?.(context.sampleRate, {
        sampleRate: context.sampleRate,
        channels: settings.current.channels,
        bufferMs: settings.current.bufferMs,
        baseLatency: context.baseLatency || 0,
      });
    }
  }, [detachGestureListeners]);

  /**
   * Ask the context to run, and report honestly when it will not.
   *
   * A context built before the page has seen a user gesture starts suspended
   * and stays suspended, and `resume()` outside a gesture resolves without
   * doing anything on some browsers and rejects on others. Neither is an
   * error: the component reports "not started" and waits.
   */
  const attemptResume = useCallback(() => {
    const context = contextRef.current;
    if (!context) return;
    if (context.state === 'running') {
      markRunning();
      return;
    }
    if (context.state === 'closed') return;
    void context
      .resume()
      .then(() => {
        if (contextRef.current !== context) return;
        if (context.state === 'running') {
          markRunning();
          void pump();
        }
      })
      .catch(() => {
        // Still blocked. The gesture listeners will try again.
      });
  }, [markRunning, pump]);

  const attachGestureListeners = useCallback(() => {
    if (listeningForGestureRef.current || typeof window === 'undefined') return;
    listeningForGestureRef.current = true;
    const handler = () => {
      attemptResume();
    };
    gestureHandlerRef.current = handler;
    // Capture phase, so a gesture consumed by something else still unlocks the
    // audio; passive, so this never delays a scroll.
    const options = { capture: true, passive: true } as AddEventListenerOptions;
    window.addEventListener('pointerdown', handler, options);
    window.addEventListener('touchend', handler, options);
    window.addEventListener('keydown', handler, options);
  }, [attemptResume]);

  /** Build the graph if it is not already up, or rebuild it at a new rate. */
  const ensureContext = useCallback((): boolean => {
    if (contextRef.current && requestedRateRef.current === sampleRate) return true;
    if (contextRef.current) {
      // The rate is fixed for a context's lifetime, so a new one is the only
      // way to honour a changed request.
      teardown();
    }

    const globals = globalThis as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AudioContextCtor = globals.AudioContext ?? globals.webkitAudioContext;
    if (!AudioContextCtor) {
      fail('This browser has no Web Audio support');
      return false;
    }

    let context: AudioContext;
    try {
      // `latencyHint: 'interactive'` asks for the smallest device buffer the
      // system will give, which is what a generated stream wants: the lead
      // buffer here is under this component's control, the device buffer is not.
      context = new AudioContextCtor({ sampleRate, latencyHint: 'interactive' });
    } catch {
      try {
        // Safari refuses rates it cannot do natively rather than resampling.
        // A running graph at the wrong rate beats no graph: `onReady` reports
        // what it actually got, and the producer retunes.
        context = new AudioContextCtor();
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Could not open an audio output');
        return false;
      }
    }

    const gain = context.createGain();
    gain.gain.value = muted ? 0 : clamp(volume, 0, 1);
    gain.connect(context.destination);

    contextRef.current = context;
    gainRef.current = gain;
    requestedRateRef.current = sampleRate;
    actualRateRef.current = context.sampleRate;
    cursorRef.current = 0;
    startedRef.current = false;
    readyFiredRef.current = false;
    bufferFailedRef.current = false;
    setError(null);

    if (context.state === 'running') {
      markRunning();
    } else {
      setStatus('blocked');
      attachGestureListeners();
      attemptResume();
    }
    return true;
  }, [
    sampleRate,
    muted,
    volume,
    fail,
    teardown,
    markRunning,
    attachGestureListeners,
    attemptResume,
  ]);

  /**
   * The clock that keeps the queue full.
   *
   * A timer rather than `requestAnimationFrame`: rAF stops in a background tab
   * and the audio would stop with it, and it is tied to the display rate, which
   * has nothing to do with how fast the queue drains. A timer is throttled in
   * the background too, but the lead buffer plus the resync above turn that into
   * a recoverable gap rather than a dead stream.
   */
  const tick = useCallback(() => {
    timerRef.current = null;
    const context = contextRef.current;
    if (!context || !runningRef.current) return;

    if (context.state === 'running') {
      // A context can reach 'running' without going through `attemptResume` —
      // iOS returns from an interruption on its own. `onReady` is the producer's
      // only notification of the real rate, so it has to be true that it fired
      // before the first pull, whichever way the graph started.
      if (!readyFiredRef.current) markRunning();
      void pump();
    } else {
      // Contexts also suspend for reasons that are not autoplay policy — an
      // interruption on iOS, an output device disappearing. Retry gently.
      const stamp = Date.now();
      if (stamp - lastResumeAttemptRef.current > 1000) {
        lastResumeAttemptRef.current = stamp;
        attemptResume();
      }
    }

    // A third of the lead: often enough that a single missed tick cannot empty
    // the queue, rare enough not to be a busy loop.
    let interval = clamp(settings.current.bufferMs / 3, 8, 60);
    // A pump that blew its budget means the source is slower than the clock.
    // Re-arming the timer at the usual cadence would run it back to back and
    // hand the whole thread to audio anyway, one block at a time. Waiting at
    // least as long as it took keeps audio to half the thread; the display
    // gets the rest, and audio underruns — which is the intended trade.
    if (lastPumpMsRef.current > PUMP_BUDGET_MS) {
      interval = Math.max(interval, Math.min(lastPumpMsRef.current, 250));
    }
    timerRef.current = setTimeout(tick, interval);
  }, [pump, attemptResume, markRunning]);

  const startPump = useCallback(() => {
    if (timerRef.current !== null) return;
    tick();
  }, [tick]);

  // Start and stop pulling.
  //
  // `running` going false stops the pull but deliberately leaves the queued
  // blocks to play out: they are at most one lead buffer long, and cutting them
  // off mid-waveform is a click. Unmount is the only hard stop.
  useEffect(() => {
    runningRef.current = running;
    if (!running) {
      stopPump();
      if (status === 'running' || status === 'blocked') setStatus('idle');
      return;
    }
    if (!ensureContext()) return;
    setStatus((current) => (current === 'idle' ? 'blocked' : current));
    attemptResume();
    startPump();
    return () => {
      stopPump();
    };
    // `ensureContext` and friends are rebuilt whenever the host passes a new
    // volume or a fresh callback; running them again would tear the graph down
    // and lose the queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, sampleRate]);

  // Once the graph exists, the status transition tells us it is worth applying
  // gain; before that there is no node to apply it to.
  useEffect(() => {
    applyGain(volume, muted);
  }, [volume, muted, status, applyGain]);

  // Full teardown. Declared last so that on a StrictMode remount the cleanups
  // run stop-pump-then-close, and the effect above rebuilds afterwards.
  useEffect(() => {
    return () => {
      teardown();
    };
  }, [teardown]);

  if (!showControls) {
    return children ? <>{children}</> : null;
  }

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    ...style,
  };

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.75rem',
    color: '#94a3b8',
    fontVariantNumeric: 'tabular-nums',
  };

  const dotColor =
    status === 'running'
      ? '#22c55e'
      : status === 'error'
        ? '#ef4444'
        : status === 'blocked'
          ? '#f59e0b'
          : '#475569';

  return (
    <div className={className} style={containerStyle}>
      {status === 'blocked' && running ? (
        <button
          type="button"
          onClick={attemptResume}
          style={{
            alignSelf: 'flex-start',
            padding: '0.375rem 0.75rem',
            borderRadius: '0.5rem',
            border: '1px solid rgba(148, 163, 184, 0.35)',
            background: 'transparent',
            color: '#e2e8f0',
            fontSize: '0.8125rem',
            cursor: 'pointer',
          }}
        >
          {unlockLabel}
        </button>
      ) : (
        <div style={rowStyle}>
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: dotColor,
              flex: '0 0 auto',
            }}
          />
          <span>
            {status === 'error'
              ? error
              : status === 'running'
                ? `${reportedRate ?? actualRateRef.current} Hz · ${channels === 1 ? 'mono' : 'stereo'}${muted ? ' · muted' : ''}`
                : running
                  ? 'Starting audio...'
                  : 'Audio stopped'}
          </span>
        </div>
      )}
      {children}
    </div>
  );
}

export default AudioStream;
