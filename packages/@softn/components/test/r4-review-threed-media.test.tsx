/**
 * Round four, threed and media: what the review of round three's changes to
 * Scene3D, AudioStream, Camera, Controls, Loop, Microphone, PixelCanvas and
 * WasmApp found still wrong in the code around them. Each test failed before
 * its fix.
 *
 * Every media API is a fake; see each block's own stubs.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type Mounted } from './dom';
import { AudioStream } from '../src/utility/AudioStream';
import { Camera } from '../src/utility/Camera';
import { Microphone } from '../src/utility/Microphone';

/* -------------------------------------------------------------------------- */
/* AudioStream                                                                 */
/* -------------------------------------------------------------------------- */

describe('AudioStream unlocked by a tap while it is stopped', () => {
  /** Whether the page is inside a press, which is when a browser lets sound start. */
  let inGesture = false;
  let contexts: FakeAudioContext[];

  class FakeAudioContext {
    /** Made before any press, as on a first visit: the browser holds it. */
    state = 'suspended';
    sampleRate = 48000;
    currentTime = 1;
    baseLatency = 0;
    destination = {};
    constructor() {
      contexts.push(this);
    }
    createGain = vi.fn(() => ({ gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }));
    createBuffer = vi.fn((channels: number, length: number, rate: number) => ({
      numberOfChannels: channels,
      length,
      sampleRate: rate,
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    }));
    createBufferSource = vi.fn(() => ({ buffer: null, onended: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() }));
    /** Outside a press it answers and changes nothing, as Chrome's does. */
    resume = vi.fn(() => {
      if (inGesture) this.state = 'running';
      return Promise.resolve();
    });
    close = vi.fn(() => Promise.resolve());
  }

  let mounted: Mounted | null = null;

  beforeEach(() => {
    inGesture = false;
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

  // The listeners that wait for the press the autoplay policy needs stay
  // after `running` goes false. A press then (on the game's own menu, say)
  // unlocked the sound, which is right, and marked the stream running,
  // which it was not: the strip said "48000 Hz · stereo" over a stream that
  // pulled nothing, where a stopped one says "Audio stopped".
  it('says it is stopped, and runs when it is asked to', async () => {
    const getSamples = vi.fn((want: number) => new Array(want * 2).fill(0));
    const at = (running: boolean) => <AudioStream getSamples={getSamples} bufferMs={60} channels={2} running={running} />;
    mounted = mount(at(true));
    await settle();
    expect(mounted.container.textContent).toContain('Tap to enable sound');

    mounted.rerender(at(false));
    await settle();
    expect(mounted.container.textContent).toContain('Audio stopped');

    // A press anywhere on the page, while the stream is stopped.
    await act(async () => {
      inGesture = true;
      window.dispatchEvent(new Event('pointerdown'));
      inGesture = false;
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(contexts[0].state).toBe('running');
    expect(mounted.container.textContent).toContain('Audio stopped');
    expect(mounted.container.textContent).not.toContain('48000 Hz');
    expect(getSamples).not.toHaveBeenCalled();

    // Running again, it plays at once: the press already unlocked it.
    mounted.rerender(at(true));
    await settle();
    expect(mounted.container.textContent).toContain('48000 Hz');
    expect(getSamples).toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Microphone                                                                  */
/* -------------------------------------------------------------------------- */

describe('Microphone in live mode, given a window of no size', () => {
  let pending: Array<(stream: FakeStream) => void>;
  let captureNodes: FakeWorkletNode[];

  class FakeTrack {
    readyState = 'live';
    stop() {
      this.readyState = 'ended';
    }
  }
  class FakeStream {
    tracks = [new FakeTrack()];
    getTracks() {
      return this.tracks;
    }
  }
  class FakeWorkletNode {
    port: { onmessage: ((event: { data: Float32Array }) => void) | null } = { onmessage: null };
    disconnect = vi.fn();
    constructor() {
      captureNodes.push(this);
    }
  }
  class FakeAudioContext {
    state = 'running';
    sampleRate: number;
    audioWorklet = { addModule: vi.fn(() => Promise.resolve()) };
    destination = {};
    constructor(options?: { sampleRate?: number }) {
      this.sampleRate = options?.sampleRate ?? 48000;
    }
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
    createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }));
    resume = vi.fn(() => Promise.resolve());
    close = vi.fn(() => Promise.resolve());
  }

  let mounted: Mounted | null = null;
  const own = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

  beforeEach(() => {
    pending = [];
    captureNodes = [];
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(() => new Promise<FakeStream>((resolve) => pending.push(resolve))) },
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
    if (own) Object.defineProperty(navigator, 'mediaDevices', own);
    else delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
  });

  const flush = () =>
    act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

  // Round three made `null` and NaN the default window; 0, a negative or a
  // fraction still went through `Math.max(1, …)` to a window of one sample,
  // an onSamples call into the app's logic for every sample (48,000 a
  // second). A size bound to a variable that starts at 0 is one of those.
  it.each([0, -512, 0.5])('takes a frame size of %s as the default one', async (frameSize) => {
    const onSamples = vi.fn();
    mounted = mount(<Microphone mode="live" frameSize={frameSize} onSamples={onSamples} />);
    pending.shift()?.(new FakeStream());
    await flush();
    await act(async () => {
      captureNodes[captureNodes.length - 1].port.onmessage?.({ data: new Float32Array(2048).fill(0.25) });
    });
    expect(onSamples).toHaveBeenCalledTimes(1);
    expect(onSamples.mock.calls[0][0].samples).toHaveLength(2048);
  });

  it('still keeps a window of the size it is given', async () => {
    const onSamples = vi.fn();
    mounted = mount(<Microphone mode="live" frameSize={512} onSamples={onSamples} />);
    pending.shift()?.(new FakeStream());
    await flush();
    await act(async () => {
      captureNodes[captureNodes.length - 1].port.onmessage?.({ data: new Float32Array(2048).fill(0.25) });
    });
    expect(onSamples).toHaveBeenCalledTimes(4);
    expect(onSamples.mock.calls[0][0].samples).toHaveLength(512);
  });
});

/* -------------------------------------------------------------------------- */
/* Camera                                                                      */
/* -------------------------------------------------------------------------- */

describe('Camera where the browser offers no camera', () => {
  let mounted: Mounted | null = null;
  const own = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

  beforeEach(() => {
    // A page that is not a secure context (served over plain http) has no
    // `navigator.mediaDevices` at all.
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    if (own) Object.defineProperty(navigator, 'mediaDevices', own);
    else delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
  });

  // It showed "Cannot read properties of undefined (reading 'getUserMedia')",
  // in its box and to `onError`, where the Microphone says it in words.
  it('says so in words', async () => {
    const onError = vi.fn();
    mounted = mount(<Camera onError={onError} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onError).toHaveBeenCalledWith('This browser has no camera support');
    expect(mounted.container.textContent).toContain('This browser has no camera support');
    expect(mounted.container.textContent).not.toContain('getUserMedia');
  });
});
