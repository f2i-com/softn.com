/**
 * Microphone lifecycle and capture.
 *
 * The same class of failure Camera was fixed for — hardware left running with
 * nothing listening, a permission race across a remount, an error box nothing
 * can clear — plus the ones specific to sound: samples that arrive in the wrong
 * shape for the scripting VM, windows that are not the size the host asked for,
 * and a recording thrown away because the component went first.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { Microphone } from '../src/utility/Microphone';

let container: HTMLDivElement;
let root: Root;

/** Every stream getUserMedia has handed out, so leaks are visible. */
let handedOut: FakeStream[];
/** Resolvers for pending getUserMedia calls, so the race can be staged. */
let pending: Array<(stream: FakeStream) => void>;
/** The capture nodes currently wired up, so a test can push audio through them. */
let captureNodes: FakeWorkletNode[];
let contexts: FakeAudioContext[];

class FakeTrack {
  readyState = 'live';
  stop() { this.readyState = 'ended'; }
}
class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}

class FakePort {
  onmessage: ((event: { data: Float32Array }) => void) | null = null;
}
class FakeWorkletNode {
  port = new FakePort();
  disconnect = vi.fn();
  constructor(public context: FakeAudioContext, public name: string) {
    captureNodes.push(this);
  }
  /** Deliver a block the way the audio thread would. */
  emit(block: Float32Array) {
    this.port.onmessage?.({ data: block });
  }
}

class FakeAudioContext {
  state = 'running';
  sampleRate: number;
  closed = false;
  audioWorklet = { addModule: vi.fn(() => Promise.resolve()) };
  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 44100;
    contexts.push(this);
  }
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createScriptProcessor = vi.fn(() => ({
    onaudioprocess: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }));
  destination = {};
  resume = vi.fn(() => Promise.resolve());
  close = vi.fn(() => { this.closed = true; return Promise.resolve(); });
}

/** A block of constant amplitude, so RMS and peak are predictable. */
const tone = (length: number, amplitude = 0.5) => new Float32Array(length).fill(amplitude);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  handedOut = [];
  pending = [];
  captureNodes = [];
  contexts = [];

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(
        () =>
          new Promise<FakeStream>((resolve) => {
            pending.push((s) => {
              handedOut.push(s);
              resolve(s);
            });
          })
      ),
    },
  });

  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:fake'),
    revokeObjectURL: vi.fn(),
  });
  // jsdom has no canvas backend; the meter must not be what breaks a test.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as HTMLCanvasElement['getContext'];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = (node: React.ReactElement) => act(() => root.render(node));
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
};
/** Hand a stream to the oldest getUserMedia call still waiting, then settle. */
const grant = async () => {
  const next = pending.shift();
  if (next) next(new FakeStream());
  await flush();
};
/** Push a block through the live capture node. */
const push = async (block: Float32Array) => {
  await act(async () => {
    captureNodes[captureNodes.length - 1].emit(block);
  });
};

describe('Microphone opening the device', () => {
  it('reports why a microphone will not open, in the browser\'s own words', async () => {
    // getUserMedia rejects with a DOMException, which does not inherit from
    // Error — so an `instanceof Error` check would swallow "Permission denied"
    // and report a generic failure instead.
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
    );
    const onError = vi.fn();
    mount(<Microphone onError={onError} />);
    await flush();

    expect(container.textContent).toContain('Permission denied');
    expect(onError).toHaveBeenCalledWith('Permission denied');
  });

  it('clears a previous failure when it opens again', async () => {
    const gum = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    gum.mockImplementationOnce(() => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')));
    mount(<Microphone />);
    await flush();
    expect(container.textContent).toContain('Permission denied');

    mount(<Microphone active={false} />);
    await flush();
    mount(<Microphone active />);
    await grant();

    expect(container.textContent).not.toContain('Permission denied');
  });

  it('runs the graph at the rate it was asked for', async () => {
    // The getUserMedia sampleRate constraint is widely ignored; asking the
    // AudioContext is what actually resamples. Without it the component would
    // hand back 44100 samples labelled 48000, and anything reading absolute
    // frequencies would be wrong by 9%.
    mount(<Microphone sampleRate={48000} />);
    await grant();
    expect(contexts[0].sampleRate).toBe(48000);
  });

  it('turns off the voice processing when asked, and leaves it on otherwise', async () => {
    // Echo cancellation, noise suppression and gain control are all trained on
    // speech and treat a steady tone as noise to remove. An app measuring sound
    // rather than listening to it needs them off, or it measures the filter.
    mount(<Microphone processing={false} />);
    await grant();
    const gum = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    expect(gum.mock.calls[0][0].audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });

    mount(<Microphone active={false} />);
    await flush();
    mount(<Microphone processing />);
    await grant();
    expect(gum.mock.calls[gum.mock.calls.length - 1][0].audio).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });
});

describe('Microphone across a remount', () => {
  it('does not let a later mount revive a cancelled attempt', async () => {
    // What StrictMode does on every mount in development. A cancellation flag
    // belonging to the component rather than to the effect run would be cleared
    // by this second mount while the first request was still in flight, and
    // both attempts would go on to claim the hardware.
    mount(<Microphone />);
    mount(<Microphone active={false} />);
    mount(<Microphone active />);

    await grant(); // the first, long-cancelled request

    expect(handedOut[0].getTracks()[0].readyState,
      'a stream nobody is waiting for any more must be stopped, not adopted').toBe('ended');
  });

  it('stops the microphone when it is unmounted mid-request', async () => {
    mount(<Microphone />);
    act(() => root.unmount());
    await grant();

    expect(handedOut[0].getTracks()[0].readyState).toBe('ended');
    root = createRoot(container);
  });

  it('closes the device and the audio context when switched off', async () => {
    // A live AudioContext holds the OS recording indicator on even after the
    // tracks stop, so both have to go.
    mount(<Microphone />);
    await grant();
    expect(handedOut[0].getTracks()[0].readyState).toBe('live');

    mount(<Microphone active={false} />);
    await flush();
    expect(handedOut[0].getTracks()[0].readyState).toBe('ended');
    expect(contexts[0].closed).toBe(true);
  });
});

describe('Microphone live mode', () => {
  it('delivers windows of exactly the size asked for, whatever the audio system gives it', async () => {
    // A worklet delivers 128 samples at a time and the fallback delivers 4096.
    // Neither is what a host asked for, and DSP that assumes a fixed window
    // silently corrupts when the block size changes underneath it.
    const onSamples = vi.fn();
    mount(<Microphone mode="live" frameSize={256} onSamples={onSamples} />);
    await grant();

    await push(tone(128));
    expect(onSamples, 'half a window is not a window').not.toHaveBeenCalled();

    await push(tone(128));
    expect(onSamples).toHaveBeenCalledTimes(1);
    expect(onSamples.mock.calls[0][0].samples).toHaveLength(256);

    // 600 more samples spans two further windows with 88 left over.
    await push(tone(600));
    expect(onSamples).toHaveBeenCalledTimes(3);
    for (const call of onSamples.mock.calls) {
      expect(call[0].samples).toHaveLength(256);
    }
  });

  it('hands samples over as a plain array', async () => {
    // Everything crossing into the scripting VM is deep-cloned through an
    // allowlist that admits plain objects and arrays and drops the rest. A
    // Float32Array would arrive in .logic as null, and the failure would look
    // like a silent microphone rather than a marshalling bug.
    const onSamples = vi.fn();
    mount(<Microphone mode="live" frameSize={64} onSamples={onSamples} />);
    await grant();
    await push(tone(64, 0.25));

    const delivered = onSamples.mock.calls[0][0].samples;
    expect(Array.isArray(delivered)).toBe(true);
    expect(ArrayBuffer.isView(delivered)).toBe(false);
    expect(delivered[0]).toBeCloseTo(0.25, 5);
  });

  it('reports the rate the graph is actually running at', async () => {
    const onSamples = vi.fn();
    mount(<Microphone mode="live" frameSize={32} sampleRate={16000} onSamples={onSamples} />);
    await grant();
    await push(tone(32));
    expect(onSamples.mock.calls[0][0].sampleRate).toBe(16000);
  });

  it('does not accumulate a recording it was never asked for', async () => {
    // Live mode is for streaming. Keeping the blocks as well would grow without
    // limit for as long as the microphone is open.
    const onCapture = vi.fn();
    mount(<Microphone mode="live" frameSize={32} onCapture={onCapture} />);
    await grant();
    await push(tone(320));

    mount(<Microphone mode="live" active={false} />);
    await flush();
    expect(onCapture).not.toHaveBeenCalled();
  });
});

describe('Microphone clip mode', () => {
  it('captures a playable WAV of what it heard', async () => {
    const onCapture = vi.fn();
    mount(<Microphone mode="clip" sampleRate={8000} autoStart onCapture={onCapture} />);
    await grant();
    await push(tone(800, 0.5));

    const button = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { button.click(); });

    expect(onCapture).toHaveBeenCalledTimes(1);
    const clip = onCapture.mock.calls[0][0];
    expect(clip.mimeType).toBe('audio/wav');
    expect(clip.sampleCount).toBe(800);
    expect(clip.sampleRate).toBe(8000);
    expect(clip.duration).toBeCloseTo(0.1, 5);
    expect(clip.dataUrl.startsWith('data:audio/wav;base64,')).toBe(true);

    // Decode the header back and check it describes what we recorded — a WAV
    // with the wrong rate or length in its header plays at the wrong speed or
    // is truncated, and neither is visible from the data URL.
    const bytes = Uint8Array.from(atob(clip.dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('WAVE');
    expect(view.getUint16(20, true), 'format must be uncompressed PCM').toBe(1);
    expect(view.getUint16(22, true), 'mono').toBe(1);
    expect(view.getUint32(24, true), 'sample rate').toBe(8000);
    expect(view.getUint16(34, true), 'bits per sample').toBe(16);
    expect(view.getUint32(40, true), 'data length in bytes').toBe(1600);
    expect(view.getInt16(44, true)).toBe(Math.round(0.5 * 32767));
  });

  it('keeps nothing before recording starts', async () => {
    const onCapture = vi.fn();
    mount(<Microphone mode="clip" sampleRate={8000} onCapture={onCapture} />);
    await grant();
    await push(tone(4000)); // heard, but not being recorded

    const button = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { button.click(); }); // start
    await push(tone(800));
    await act(async () => { button.click(); }); // stop

    expect(onCapture.mock.calls[0][0].sampleCount).toBe(800);
  });

  it('saves what it had when the microphone closes mid-recording', async () => {
    // A recording interrupted by the component going away is still a
    // recording. Dropping it loses whatever the user had already said, with no
    // warning and no way back.
    const onCapture = vi.fn();
    mount(<Microphone mode="clip" sampleRate={8000} autoStart onCapture={onCapture} />);
    await grant();
    await push(tone(1600));

    mount(<Microphone mode="clip" active={false} onCapture={onCapture} />);
    await flush();

    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(onCapture.mock.calls[0][0].sampleCount).toBe(1600);
  });

  it('stops itself rather than recording until memory runs out', async () => {
    const onCapture = vi.fn();
    const onStop = vi.fn();
    mount(
      <Microphone mode="clip" sampleRate={8000} maxSeconds={0.5} autoStart onCapture={onCapture} onStop={onStop} />
    );
    await grant();
    await push(tone(3000)); // 0.375 s — under the cap
    expect(onStop).not.toHaveBeenCalled();

    await push(tone(2000)); // takes it past 0.5 s
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onCapture).toHaveBeenCalledTimes(1);

    // Blocks arriving after the cap belong to nobody.
    await push(tone(2000));
    expect(onCapture).toHaveBeenCalledTimes(1);
  });
});

describe('Microphone level reporting', () => {
  it('reports loudness in every mode, including the one that keeps no samples', async () => {
    const onLevel = vi.fn();
    mount(<Microphone mode="level" onLevel={onLevel} />);
    await grant();
    await push(tone(1024, 0.5));

    expect(onLevel).toHaveBeenCalled();
    const { level, peak, clipping } = onLevel.mock.calls[0][0];
    expect(level).toBeCloseTo(0.5, 3); // RMS of a constant block is its amplitude
    expect(peak).toBeCloseTo(0.5, 3);
    expect(clipping).toBe(false);
  });

  it('does not report once per audio block', async () => {
    // An AudioWorklet delivers 128 samples at a time — 375 blocks a second at
    // 48 kHz. Reporting each one is 375 React renders a second, which is enough
    // on its own to make the recording it is metering stutter.
    const onLevel = vi.fn();
    mount(<Microphone mode="level" onLevel={onLevel} />);
    await grant();

    for (let i = 0; i < 60; i += 1) await push(tone(128));

    expect(onLevel.mock.calls.length,
      'sixty blocks arriving inside one frame should not be sixty updates').toBeLessThan(10);
    expect(onLevel).toHaveBeenCalled();
  });

  it('flags a signal that is hitting the rails', async () => {
    const onLevel = vi.fn();
    mount(<Microphone mode="level" onLevel={onLevel} />);
    await grant();
    await push(tone(1024, 1));
    expect(onLevel.mock.calls[0][0].clipping).toBe(true);
  });
});

describe('Microphone when the worklet cannot be used', () => {
  it('falls back rather than refusing to record', async () => {
    // A page whose content security policy forbids blob: scripts cannot load
    // the worklet module. That is a reason to use the older node, not a reason
    // to have no microphone.
    const failing = class extends FakeAudioContext {
      audioWorklet = { addModule: vi.fn(() => Promise.reject(new Error('blocked by CSP'))) };
    };
    vi.stubGlobal('AudioContext', failing);

    const onError = vi.fn();
    mount(<Microphone onError={onError} />);
    await grant();

    expect(onError).not.toHaveBeenCalled();
    expect(contexts[0].createScriptProcessor).toHaveBeenCalled();
    expect(container.textContent).not.toContain('blocked by CSP');
  });
});
