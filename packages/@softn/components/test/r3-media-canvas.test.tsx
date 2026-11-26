/**
 * Round three of the media and canvas components: what was still wrong in
 * AudioStream, PixelCanvas, Microphone, Camera, Loop and Controls after the
 * earlier passes. Each test is a failure a page could actually reach — blocks
 * played over each other, a callback that never came, a busy loop asked for
 * by a value that meant "never" — or a count of work redone for nothing.
 *
 * Every media API is a fake; see each block's own stubs. The harness is the
 * same `mount` the other component tests use.
 */

import React, { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type Mounted } from './dom';
import { AudioStream } from '../src/utility/AudioStream';
import { PixelCanvas } from '../src/utility/PixelCanvas';
import { Microphone } from '../src/utility/Microphone';
import { Camera } from '../src/utility/Camera';
import { Loop } from '../src/utility/Loop';
import { Controls, type ControlsValue } from '../src/utility/Controls';

const b64 = (bytes: ArrayLike<number>) => Buffer.from(Uint8Array.from(bytes)).toString('base64');

/* -------------------------------------------------------------------------- */
/* PixelCanvas                                                                 */
/* -------------------------------------------------------------------------- */

describe('PixelCanvas', () => {
  interface FakeImageData { data: Uint8ClampedArray; width: number; height: number }
  const puts: FakeImageData[] = [];
  /**
   * Readbacks of the 1x1 probe canvas a palette colour the fast paths do not
   * know (`hsl()`) is parsed through: one per entry parsed, so a count of
   * palette parses.
   */
  let probeReads = 0;
  let frames: FrameRequestCallback[] = [];
  const realGetContext = HTMLCanvasElement.prototype.getContext;
  const realRaf = globalThis.requestAnimationFrame;
  const realCaf = globalThis.cancelAnimationFrame;

  beforeAll(() => {
    (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = function fake(this: HTMLCanvasElement) {
      return {
        canvas: this,
        fillStyle: '#000000',
        createImageData: (w: number, h: number): FakeImageData => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: (image: FakeImageData) => {
          puts.push({ ...image, data: image.data.slice() });
        },
        clearRect() {},
        fillRect() {},
        getImageData: () => {
          probeReads += 1;
          return { data: new Uint8ClampedArray([1, 2, 3, 255]) };
        },
      };
    };
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => frames.push(cb)) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  });

  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = realGetContext;
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCaf;
  });

  beforeEach(() => {
    puts.length = 0;
    probeReads = 0;
    frames = [];
  });

  /** One display frame: every callback waiting on requestAnimationFrame runs. */
  function pump(time: number): void {
    const waiting = frames.splice(0, frames.length);
    act(() => {
      waiting.forEach((cb) => cb(time));
    });
  }

  const pixel = (image: FakeImageData | undefined) => (image ? Array.from(image.data.slice(0, 4)) : null);

  // PixelCanvasFrame.palette: "Overrides the `palette` prop for as long as it
  // is supplied." An array palette in a frame was applied only while the
  // lookup table was empty, so beside a `palette` prop (or after a frame had
  // fallen back to greyscale) it was never applied at all.
  it('draws through the palette a frame carries, over the palette prop', () => {
    const view = mount(
      <PixelCanvas
        width={1}
        height={1}
        palette={['#000000', '#ffffff']}
        getFrame={() => ({ w: 1, h: 1, format: 'p8', pixels: b64([2]), palette: ['#ff0000', '#00ff00', '#0000ff'] })}
      />
    );
    pump(0);
    expect(pixel(puts.at(-1))).toEqual([0, 0, 255, 255]);
    view.unmount();
  });

  // A template writes its palette inline, so it is a new array at every draw.
  // The frame path cleared the prop's signature when a frame brought its own
  // palette, so from then on every draw re-parsed the prop's palette, and the
  // next frame (its revision now looking new) re-parsed its own: both, at
  // every draw of the page, to show the same colours.
  it('does not parse either palette again when the page draws again with the same ones', () => {
    let counter = 0;
    const Host = (_: { n: number }) => (
      <PixelCanvas
        width={1}
        height={1}
        palette={['hsl(0, 100%, 50%)']}
        getFrame={() => ({ w: 1, h: 1, format: 'p8', pixels: b64([0]), palette: ['hsl(120, 100%, 50%)'], paletteRev: 1, frame: counter })}
      />
    );
    const view = mount(<Host n={0} />);
    counter = 1;
    pump(0);
    expect(puts).toHaveLength(1);
    const settled = probeReads;
    for (let n = 1; n <= 10; n += 1) {
      view.rerender(<Host n={n} />);
      counter += 1;
      pump(n * 16);
    }
    expect(puts).toHaveLength(11);
    expect(probeReads - settled).toBe(0);
    view.unmount();
  });

  // The pushed-frame effect listed `palette` among its dependencies, so an
  // inline palette (a new array at every draw) decoded and put the same frame
  // again at every draw of the page.
  it('does not repaint a pushed frame when the page draws again with the same palette', () => {
    const at = (palette: string[]) => <PixelCanvas width={1} height={1} palette={palette} frame={b64([0])} />;
    const view = mount(at(['#ff0000']));
    expect(puts).toHaveLength(1);
    for (let n = 0; n < 10; n += 1) view.rerender(at(['#ff0000']));
    expect(puts).toHaveLength(1);
    // A palette that does change still repaints what is up.
    view.rerender(at(['#00ff00']));
    expect(puts).toHaveLength(2);
    expect(pixel(puts.at(-1))).toEqual([0, 255, 0, 255]);
    view.unmount();
  });
});

/* -------------------------------------------------------------------------- */
/* AudioStream                                                                 */
/* -------------------------------------------------------------------------- */

describe('AudioStream', () => {
  /** Every block the component started, with where it lands on the audio clock. */
  let scheduled: Array<{ when: number; duration: number }>;
  let contexts: FakeAudioContext[];

  class FakeBuffer {
    private channels: Float32Array[];
    constructor(public numberOfChannels: number, public length: number, public sampleRate: number) {
      this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
    }
    getChannelData(i: number) { return this.channels[i]; }
    get duration() { return this.length / this.sampleRate; }
  }

  class FakeSource {
    buffer: FakeBuffer | null = null;
    onended: (() => void) | null = null;
    connect = vi.fn();
    disconnect = vi.fn();
    start = vi.fn((when: number) => {
      scheduled.push({ when, duration: this.buffer ? this.buffer.duration : 0 });
    });
    stop = vi.fn();
  }

  class FakeAudioContext {
    state = 'running';
    sampleRate = 48000;
    /** A clock that has been going a while, as it has by the time a page plays. */
    currentTime = 1;
    baseLatency = 0;
    destination = {};
    constructor() { contexts.push(this); }
    createGain = vi.fn(() => ({ gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }));
    createBuffer = vi.fn((ch: number, len: number, rate: number) => new FakeBuffer(ch, len, rate));
    createBufferSource = vi.fn(() => new FakeSource());
    resume = vi.fn(() => Promise.resolve());
    close = vi.fn(() => Promise.resolve());
  }

  let mounted: Mounted | null = null;

  beforeEach(() => {
    scheduled = [];
    contexts = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const settle = () =>
    act(async () => {
      vi.advanceTimersByTime(40);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

  /** Overlapping blocks are the same stretch of the clock played twice. */
  function overlaps(): Array<[number, number]> {
    const sorted = [...scheduled].sort((a, b) => a.when - b.when);
    const found: Array<[number, number]> = [];
    for (let i = 1; i < sorted.length; i += 1) {
      const before = sorted[i - 1];
      if (sorted[i].when < before.when + before.duration - 1e-9) found.push([before.when, sorted[i].when]);
    }
    return found;
  }

  // A script function running in a worker answers getSamples with a promise,
  // so a pump waits between blocks. One that found `running` false when its
  // wait ended returned without saving the cursor it had advanced, and the
  // next pump scheduled from the old cursor: on top of the block already
  // queued there.
  it('does not play a block over one an interrupted pump had already queued', async () => {
    const answers: Array<() => void> = [];
    // Half of what is asked, so one pump takes more than one block.
    const getSamples = vi.fn(
      (want: number) =>
        new Promise<number[]>((resolve) => answers.push(() => resolve(new Array(Math.ceil(want / 2) * 2).fill(0.1))))
    );
    const answer = () =>
      act(async () => {
        answers.shift()?.();
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
    const props = { getSamples, bufferMs: 90, channels: 2 as const, showControls: false };

    mounted = mount(<AudioStream {...props} running />);
    await settle();
    await answer(); // the first block is queued; the pump asks for a second
    expect(scheduled).toHaveLength(1);
    expect(answers).toHaveLength(1);

    // Paused while the producer is working on the second block.
    mounted.rerender(<AudioStream {...props} running={false} />);
    await answer(); // arrives to a paused stream: dropped, as it should be

    // And going again before the first block has played.
    mounted.rerender(<AudioStream {...props} running />);
    await settle();
    await answer();
    await answer();

    expect(scheduled.length).toBeGreaterThan(1);
    expect(overlaps()).toEqual([]);
  });

  // `void pump()` at every tick: a getSamples that threw (or a promise that
  // rejected) made every pump an unhandled rejection, thirty-odd a second
  // for as long as the stream ran. SoftN's own functions resolve whatever
  // happens; a page using the component with a function of its own does not.
  it('survives a getSamples that throws, says so once, and keeps asking', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let calls = 0;
      const getSamples = vi.fn((want: number) => {
        calls += 1;
        if (calls % 2 === 1) throw new Error('producer bug');
        return new Array(want * 2).fill(0);
      });
      mounted = mount(<AudioStream getSamples={getSamples} bufferMs={90} channels={2} showControls={false} running />);
      for (let i = 0; i < 6; i += 1) await settle();
      await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });

      expect(unhandled).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(calls).toBeGreaterThan(3);
      expect(scheduled.length).toBeGreaterThan(0);
      expect(overlaps()).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      warn.mockRestore();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Microphone                                                                  */
/* -------------------------------------------------------------------------- */

describe('Microphone', () => {
  let pending: Array<(stream: FakeStream) => void>;
  let handedOut: FakeStream[];
  let captureNodes: FakeWorkletNode[];

  class FakeTrack {
    readyState = 'live';
    stop() { this.readyState = 'ended'; }
  }
  class FakeStream {
    tracks = [new FakeTrack()];
    getTracks() { return this.tracks; }
  }
  class FakeWorkletNode {
    port: { onmessage: ((event: { data: Float32Array }) => void) | null } = { onmessage: null };
    disconnect = vi.fn();
    constructor() { captureNodes.push(this); }
  }
  class FakeAudioContext {
    state = 'running';
    sampleRate: number;
    audioWorklet = { addModule: vi.fn(() => Promise.resolve()) };
    destination = {};
    constructor(options?: { sampleRate?: number }) { this.sampleRate = options?.sampleRate ?? 44100; }
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
    createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }));
    resume = vi.fn(() => Promise.resolve());
    close = vi.fn(() => Promise.resolve());
  }

  let mounted: Mounted | null = null;

  beforeEach(() => {
    pending = [];
    handedOut = [];
    captureNodes = [];
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(() => new Promise<FakeStream>((resolve) => pending.push((s) => { handedOut.push(s); resolve(s); }))),
      },
    });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() });
    // jsdom has no canvas backend; the meter draws nothing.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const flush = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
  const grant = async () => {
    pending.shift()?.(new FakeStream());
    await flush();
  };
  const push = (block: Float32Array) =>
    act(async () => { captureNodes[captureNodes.length - 1].port.onmessage?.({ data: block }); });
  const show = (element: React.ReactElement) => {
    if (mounted) mounted.rerender(element);
    else mounted = mount(element);
  };

  // onStop: "Called when recording stops, just before onCapture". A clip cut
  // short by the microphone closing (`active` false, the tab hidden, the
  // grant withdrawn, the component gone) was handed over by onCapture, with
  // no onStop before it: a page that shows "Recording" from onStart to onStop
  // went on showing it.
  it('says the recording stopped when the microphone closes in the middle of one', async () => {
    const said: string[] = [];
    const handlers = { onStart: () => said.push('start'), onStop: () => said.push('stop'), onCapture: () => said.push('capture') };
    show(<Microphone mode="clip" sampleRate={8000} autoStart {...handlers} />);
    await grant();
    await push(new Float32Array(800).fill(0.5));
    show(<Microphone mode="clip" sampleRate={8000} active={false} {...handlers} />);
    await flush();
    expect(said).toEqual(['start', 'stop', 'capture']);
    expect(handedOut[0].tracks[0].readyState).toBe('ended');
  });

  // A prop bound to a variable not set yet arrives as `null`, which the
  // defaults do not stand in for: `frameSize` null was `Math.max(1, 0)`, a
  // window of one sample, and so an onSamples call into the app's logic for
  // every sample — 48,000 a second.
  it('takes a frame size that is not a number as the default one', async () => {
    const onSamples = vi.fn();
    show(<Microphone mode="live" frameSize={null as unknown as number} onSamples={onSamples} />);
    await grant();
    await push(new Float32Array(2048).fill(0.25));
    expect(onSamples).toHaveBeenCalledTimes(1);
    expect(onSamples.mock.calls[0][0].samples).toHaveLength(2048);
  });

  // `maxSeconds` null was a cap of 0 s, so a clip stopped at its first block
  // of audio; NaN was no cap at all, where the cap is what keeps a forgotten
  // microphone from filling memory. Either is the default minute.
  it('does not stop a clip at its first block when the recording limit is null', async () => {
    const onStop = vi.fn();
    show(<Microphone mode="clip" sampleRate={8000} maxSeconds={null as unknown as number} autoStart onStop={onStop} />);
    await grant();
    await push(new Float32Array(800).fill(0.5));
    await push(new Float32Array(800).fill(0.5));
    expect(onStop).not.toHaveBeenCalled();
  });

  it('still caps a clip at the default minute when the recording limit is NaN', async () => {
    const onStop = vi.fn();
    const onCapture = vi.fn();
    show(<Microphone mode="clip" sampleRate={8000} maxSeconds={Number.NaN} autoStart onStop={onStop} onCapture={onCapture} />);
    await grant();
    // Sixty-one seconds at 8 kHz: past the default minute.
    await push(new Float32Array(8000 * 61).fill(0.1));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onCapture.mock.calls[0][0].sampleCount).toBe(8000 * 61);
  });
});

/* -------------------------------------------------------------------------- */
/* Camera                                                                      */
/* -------------------------------------------------------------------------- */

describe('Camera', () => {
  let pending: Array<(stream: unknown) => void>;
  let mounted: Mounted | null = null;

  beforeEach(() => {
    pending = [];
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(() => new Promise((resolve) => pending.push(resolve))),
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      writable: true,
      value: vi.fn(() => Promise.resolve()),
    });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Open a live camera whose video reports a 320x240 picture, and count what each frame costs. */
  async function openLive(element: React.ReactElement) {
    mounted = mount(element);
    const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
    pending.shift()?.({ getTracks: () => [track], getVideoTracks: () => [track] });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const video = mounted.container.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 320 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 240 });
    const canvas = mounted.container.querySelector('canvas') as HTMLCanvasElement;
    const counts = { sizeWrites: 0, draws: 0 };
    let width = 300;
    let height = 150;
    Object.defineProperty(canvas, 'width', { configurable: true, get: () => width, set: (v: number) => { counts.sizeWrites += 1; width = v; } });
    Object.defineProperty(canvas, 'height', { configurable: true, get: () => height, set: (v: number) => { counts.sizeWrites += 1; height = v; } });
    canvas.getContext = vi.fn(() => ({ drawImage: () => { counts.draws += 1; } })) as unknown as HTMLCanvasElement['getContext'];
    canvas.toDataURL = vi.fn(() => 'data:image/jpeg;base64,xxx');
    return counts;
  }

  // `Math.max(16, Math.round(1000 / frameRate))`: 0 or null make that
  // Infinity, NaN makes it NaN, and a timer reads either as 0 ms (a browser's
  // `long` conversion; Node makes it 1 ms). Live mode then drew and encoded a
  // JPEG as fast as timers run, where "no rate" was meant — or an unset
  // variable, which `null` is and the default does not stand in for. Real
  // timers here: vitest's fake clock runs such an interval once and stops,
  // which is neither.
  it('does not take frames as fast as timers run when the frame rate is 0 or missing', async () => {
    for (const frameRate of [0, null, Number.NaN]) {
      const onFrame = vi.fn();
      await openLive(<Camera mode="live" frameRate={frameRate as unknown as number} onFrame={onFrame} />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
      // The default rate, ten a second, takes one frame in 150 ms.
      expect(onFrame.mock.calls.length, `frameRate ${String(frameRate)}`).toBeLessThanOrEqual(3);
      mounted?.unmount();
      mounted = null;
    }
  });

  // captureFrame set the canvas's width and height on every frame. Setting
  // either, even to what it already is, clears the bitmap and resets the
  // context: work thrown away at once by a drawImage over all of it.
  it('sizes its capture canvas when the picture changes size, not at every frame', async () => {
    vi.useFakeTimers();
    const counts = await openLive(<Camera mode="live" frameRate={10} onFrame={() => {}} />);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(counts.draws).toBeGreaterThanOrEqual(9);
    expect(counts.sizeWrites).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Loop                                                                        */
/* -------------------------------------------------------------------------- */

describe('Loop', () => {
  // `interval={1000 / speed}` with a speed of 0 is Infinity, which a timer
  // reads as 0 ms (a browser's `long` conversion; Node makes it 1 ms), and
  // NaN and null are read the same way. The timer form then ticked as fast as
  // timers run, a call into the app's logic each time, where "never" or the
  // default second was meant. Real timers: vitest's fake clock does not read
  // these delays the way either runtime does.
  it('does not tick as fast as timers run when the interval is Infinity, NaN or null', async () => {
    for (const interval of [Number.POSITIVE_INFINITY, Number.NaN, null]) {
      const onTick = vi.fn();
      const view = mount(<Loop interval={interval as unknown as number} running onTick={onTick} />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
      view.unmount();
      // Infinity is never; a missing interval is the default second.
      expect(onTick.mock.calls.length, `interval ${String(interval)}`).toBe(0);
    }
  });

  it('still ticks at an ordinary interval', async () => {
    const onTick = vi.fn();
    const view = mount(<Loop interval={20} running onTick={onTick} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 130)); });
    view.unmount();
    expect(onTick.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

/* -------------------------------------------------------------------------- */
/* Controls                                                                    */
/* -------------------------------------------------------------------------- */

describe('Controls', () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    mounted?.unmount();
    mounted = null;
  });

  function key(type: 'keydown' | 'keyup', name: string, code: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent(type, { key: name, code, bubbles: true, cancelable: true, ...init });
    act(() => {
      document.body.dispatchEvent(event);
    });
    return event;
  }

  /** The record as the page's state holds it, written back as `:bind` would. */
  function Bound({ seen, enabled = true }: { seen: { pad: ControlsValue; presses: string[] }; enabled?: boolean }) {
    const [pad, setPad] = React.useState<ControlsValue>({ presses: {} });
    seen.pad = pad;
    return (
      <Controls
        keys={{ left: 'ArrowLeft', right: 'ArrowRight' }}
        enabled={enabled}
        value={pad}
        onChange={setPad}
        onPress={(action) => seen.presses.push(action)}
      />
    );
  }

  // A key already down when the controls begin to listen — turned back on
  // as a menu closes, or the window given back its focus — arrives as its
  // repeats, and a repeat was dropped as a key already held. It was not
  // held here, so the player held Right and stood still until they let go
  // and pressed again. (A gamepad's button held through the same is read as
  // held at once.)
  it('holds a key that was already down when it began to listen, from its repeats', () => {
    const seen = { pad: { presses: {} } as ControlsValue, presses: [] as string[] };
    mounted = mount(<Bound seen={seen} enabled={false} />);
    key('keydown', 'ArrowRight', 'ArrowRight');
    expect(seen.pad.right).toBeFalsy();
    mounted.rerender(<Bound seen={seen} enabled />);
    expect(key('keydown', 'ArrowRight', 'ArrowRight', { repeat: true }).defaultPrevented).toBe(true);
    expect(seen.pad.right).toBe(true);
    // Once held, a repeat is a key still down: no second press.
    key('keydown', 'ArrowRight', 'ArrowRight', { repeat: true });
    expect(seen.pad.presses.right).toBe(1);
    expect(seen.presses).toEqual(['right']);
    key('keyup', 'ArrowRight', 'ArrowRight');
    expect(seen.pad.right).toBe(false);

    // The same after the window had lost its focus, with the key held through it.
    key('keydown', 'ArrowLeft', 'ArrowLeft');
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(seen.pad.left).toBe(false);
    key('keydown', 'ArrowLeft', 'ArrowLeft', { repeat: true });
    expect(seen.pad.left).toBe(true);
  });
});
