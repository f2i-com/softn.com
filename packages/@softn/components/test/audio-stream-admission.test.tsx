/**
 * AudioStream refuses a block before allocating for it.
 *
 * The channel count and the sample rate were checked; the amount was not. A
 * producer could hand back a block of any length and the host sized a scratch
 * buffer from it and built an AudioBuffer to match, outside anything the VM's
 * own memory budget could see. What is pinned: a block over the limit makes
 * no AudioBuffer and is reported once; an ordinary block still plays.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { mount, type Mounted } from './dom';
import { AudioStream } from '../src/utility/AudioStream';

let contexts: FakeAudioContext[] = [];

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
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioContext {
  state = 'running';
  sampleRate = 48000;
  currentTime = 0;
  baseLatency = 0;
  destination = {};
  constructor() { contexts.push(this); }
  createGain = vi.fn(() => ({
    gain: { value: 1, setTargetAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  createBuffer = vi.fn((ch: number, len: number, rate: number) => new FakeBuffer(ch, len, rate));
  createBufferSource = vi.fn(() => new FakeSource());
  resume = vi.fn(() => Promise.resolve());
  close = vi.fn(() => Promise.resolve());
}

let mounted: Mounted | null = null;

beforeEach(() => {
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

async function runFirstPump(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { vi.advanceTimersByTime(40); await Promise.resolve(); });
}

describe('AudioStream admission', () => {
  it('refuses a block longer than the limit before building a buffer, and says so once', async () => {
    const onError = vi.fn();
    // Three seconds of stereo at 48 kHz, every time it is asked.
    const getSamples = vi.fn(() => new Array(48000 * 3 * 2).fill(0));
    mounted = mount(
      React.createElement(AudioStream, { getSamples, bufferMs: 90, channels: 2, running: true, onError })
    );
    await runFirstPump();
    await act(async () => { vi.advanceTimersByTime(80); await Promise.resolve(); });

    expect(getSamples).toHaveBeenCalled();
    expect(contexts[0].createBuffer).not.toHaveBeenCalled();
    expect(contexts[0].createBufferSource).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toMatch(/exceeds/);
  });

  it('refuses an encoded block larger than the scratch limit without decoding it', async () => {
    const onError = vi.fn();
    // A base64 string that would decode to more than the scratch ceiling.
    const huge = 'A'.repeat(6 * 1024 * 1024);
    const getSamples = vi.fn(() => huge);
    mounted = mount(
      React.createElement(AudioStream, { getSamples, bufferMs: 90, channels: 2, running: true, onError })
    );
    await runFirstPump();

    expect(contexts[0].createBuffer).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toMatch(/bytes exceeds/);
  });

  it('still schedules an ordinary block', async () => {
    const onError = vi.fn();
    const getSamples = vi.fn((want: number) => new Array(want * 2).fill(0));
    mounted = mount(
      React.createElement(AudioStream, { getSamples, bufferMs: 90, channels: 2, running: true, onError })
    );
    await runFirstPump();

    expect(contexts[0].createBufferSource).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
