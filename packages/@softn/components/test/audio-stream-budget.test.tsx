/**
 * AudioStream's pump must not hold the main thread for a source that is slower
 * than the audio clock.
 *
 * Both loops in `pump` are bounded by a block COUNT — thirty-two — which is the
 * right bound for a source handing back audio it already has and the wrong one
 * for a source that must make it. The fill loop runs until the cursor is a lead
 * ahead of `currentTime`, re-reading the clock after each block; when a block
 * takes longer to produce than the audio it contains, the clock gains on the
 * cursor every iteration and the loop runs all thirty-two. On a Snapdragon
 * laptop that was a single 6.1-second task, four requestAnimationFrames a
 * second, and an emulator reporting 0.1 fps while fully busy.
 *
 * The source below is exactly that shape: each call burns real wall time and
 * advances the fake clock by MORE than the audio it returns, so the fill can
 * never catch up. What is pinned is that one pump stops after its wall-clock
 * budget rather than after thirty-two blocks.
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
  copyToChannel(src: Float32Array, i: number) { this.channels[i].set(src.subarray(0, this.length)); }
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
  /** The test drives this: it is the audio clock the pump races against. */
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

/** Burn real wall time, because the budget is measured in it. */
function burn(ms: number) {
  const t = performance.now();
  while (performance.now() - t < ms) { /* spin */ }
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

describe('AudioStream pump budget', () => {
  it('stops filling after its wall-clock budget when the source cannot outrun the clock', async () => {
    const calls: number[] = [];
    // Each block costs 3 ms of wall time and yields 10 ms of audio (480 frames
    // at 48 kHz) — but the clock jumps 20 ms per call, so the lead recedes.
    const getSamples = vi.fn((want: number) => {
      calls.push(want);
      burn(3);
      const ctx = contexts[0];
      if (ctx) ctx.currentTime += 0.02;
      return new Array(480 * 2).fill(0);
    });

    mounted = mount(
      React.createElement(AudioStream, { getSamples, bufferMs: 90, channels: 2, running: true })
    );
    // resume() resolves on a microtask and the first pump follows it.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // The first tick, and the pump it runs.
    await act(async () => { vi.advanceTimersByTime(40); await Promise.resolve(); });

    expect(calls.length).toBeGreaterThan(0);
    // Unbounded, this loop makes thirty-two calls per pump. With an 8 ms budget
    // and 3 ms per call it makes about three; six leaves room for slow CI.
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  it('still fills the lead in one pump when the source is fast', async () => {
    const calls: number[] = [];
    // Cheap, and the clock stays still — the ordinary case.
    const getSamples = vi.fn((want: number) => {
      calls.push(want);
      return new Array(want * 2).fill(0);
    });
    mounted = mount(
      React.createElement(AudioStream, { getSamples, bufferMs: 90, channels: 2, running: true })
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(40); await Promise.resolve(); });

    // The lead is 90 ms; a fast source fills it in a handful of blocks, well
    // inside the budget, and the loop exits because the lead is met — not
    // because time ran out.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThan(32);
    const framesScheduled = contexts[0].createBufferSource.mock.calls.length;
    expect(framesScheduled).toBe(calls.length);
  });
});
