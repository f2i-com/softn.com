/**
 * softn.mic — recording from a .logic script.
 *
 * These drive the real VM, so what they pin is the whole path: script calls the
 * bridge, the bridge calls the host, the host opens the device. The cases worth
 * having are the ones an author cannot see going wrong — a bundle recording
 * without having asked permission, a declared cap the script talks its way
 * past, and a microphone still open after the app that opened it has gone.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createScriptRuntime,
  createMockXDBModule,
  createMockNavModule,
  createConsoleModule,
  type ScriptContext,
  type PermissionConfig,
} from '../src/runtime/script-runtime';
import type { ScriptBlock } from '../src/parser/ast';

let streams: FakeStream[];
let contexts: FakeAudioContext[];
/** What getUserMedia should do next. */
let mediaBehaviour: () => Promise<FakeStream>;

class FakeTrack {
  readyState = 'live';
  stop() { this.readyState = 'ended'; }
}
class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}

class FakeProcessor {
  onaudioprocess: ((e: { inputBuffer: { getChannelData(n: number): Float32Array } }) => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  /** Deliver a block the way the audio thread would. */
  feed(block: Float32Array) {
    this.onaudioprocess?.({ inputBuffer: { getChannelData: () => block } });
  }
}

class FakeAudioContext {
  state = 'running';
  sampleRate: number;
  closed = false;
  processors: FakeProcessor[] = [];
  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 44100;
    contexts.push(this);
  }
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createScriptProcessor = vi.fn(() => {
    const p = new FakeProcessor();
    this.processors.push(p);
    return p;
  });
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }));
  destination = {};
  resume = vi.fn(() => Promise.resolve());
  close = vi.fn(() => { this.closed = true; return Promise.resolve(); });
}

const tone = (n: number, amplitude = 0.5) => new Float32Array(n).fill(amplitude);

beforeEach(() => {
  streams = [];
  contexts = [];
  mediaBehaviour = () => {
    const s = new FakeStream();
    streams.push(s);
    return Promise.resolve(s);
  };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(() => mediaBehaviour()) } });
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function script(code: string): ScriptBlock {
  return { type: 'ScriptBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } };
}

interface RuntimeInternals { setPermissionConfig(config: PermissionConfig): void }

function makeRuntime(config?: PermissionConfig) {
  const state: Record<string, unknown> = {};
  const context: ScriptContext = {
    state,
    setState: (path: string, value: unknown) => { state[path] = value; },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
  const runtime = createScriptRuntime(context, undefined, 'mic-test');
  if (config) (runtime as unknown as RuntimeInternals).setPermissionConfig(config);
  return Object.assign(runtime, { state });
}

const allowMic = (extra: Record<string, unknown> = {}): PermissionConfig =>
  ({ permissions: { mic: { enabled: true, ...extra } } }) as PermissionConfig;

/** Wait for the audio graph to exist — mic.record awaits getUserMedia first. */
async function graphReady() {
  for (let i = 0; i < 20 && contexts.length === 0; i += 1) await Promise.resolve();
}

/** Push audio into the recording the runtime has open, then stop it early. */
async function recordThenStop(halt: () => Promise<unknown>, block: Float32Array) {
  await graphReady();
  contexts[0].processors[0].feed(block);
  await halt();
}

describe('softn.mic.record without permission', () => {
  it('refuses a bundle that ships no permission.json', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(script(`
      let problem = ""
      function listen() {
        softn.mic.record({ seconds: 1 }, function(r) { problem = r.error || "" })
      }
    `));

    await result.functions.listen();
    expect(String(runtime.state.problem)).toMatch(/permission\.json/i);
    expect(navigator.mediaDevices.getUserMedia,
      'the device must not open before the check').not.toHaveBeenCalled();
  });

  it('refuses a bundle that declared everything except the microphone', async () => {
    const runtime = makeRuntime({ permissions: { camera: { enabled: true }, net: { enabled: true } } } as PermissionConfig);
    const result = await runtime.loadScript(script(`
      let problem = ""
      function listen() {
        softn.mic.record({}, function(r) { problem = r.error || "" })
      }
    `));

    await result.functions.listen();
    expect(String(runtime.state.problem)).toMatch(/microphone access not permitted/i);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
});

describe('softn.mic.record with permission', () => {
  it('hands the script a WAV of what it heard', async () => {
    const runtime = makeRuntime(allowMic());
    const result = await runtime.loadScript(script(`
      let clip = ""
      let rate = 0
      let count = 0
      function listen() {
        softn.mic.record({ seconds: 30, sampleRate: 8000 }, function(r) {
          clip = r.dataUrl || ""
          rate = r.sampleRate || 0
          count = r.sampleCount || 0
        })
      }
      function halt() { softn.mic.stop() }
    `));

    const listening = result.functions.listen();
    await recordThenStop(result.functions.halt, tone(800));
    await listening;

    expect(runtime.state.rate).toBe(8000);
    expect(runtime.state.count).toBe(800);
    expect(String(runtime.state.clip).startsWith('data:audio/wav;base64,')).toBe(true);

    // Decode the header: a WAV with the wrong rate plays at the wrong speed,
    // and nothing about the data URL would show it.
    const bytes = Uint8Array.from(atob(String(runtime.state.clip).split(',')[1]), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint16(20, true), 'uncompressed PCM').toBe(1);
    expect(view.getUint32(24, true), 'sample rate').toBe(8000);
    expect(view.getUint32(40, true), 'data length').toBe(1600);
  });

  it('runs the graph at the rate the script asked for', async () => {
    // The getUserMedia sampleRate constraint is widely ignored; asking the
    // AudioContext is what actually resamples. Without it the handler would
    // return 44100 samples labelled 48000.
    const runtime = makeRuntime(allowMic());
    const result = await runtime.loadScript(script(`
      function listen() { softn.mic.record({ seconds: 30, sampleRate: 48000 }, function() {}) }
      function halt() { softn.mic.stop() }
    `));
    const listening = result.functions.listen();
    await recordThenStop(result.functions.halt, tone(10));
    await listening;
    expect(contexts[0].sampleRate).toBe(48000);
  });

  it('leaves the voice processing off when the script asks for raw sound', async () => {
    const runtime = makeRuntime(allowMic());
    const result = await runtime.loadScript(script(`
      function listen() { softn.mic.record({ seconds: 30, processing: false }, function() {}) }
      function halt() { softn.mic.stop() }
    `));
    const listening = result.functions.listen();
    await recordThenStop(result.functions.halt, tone(10));
    await listening;

    const constraints = (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(constraints.audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  it('closes the device when the recording ends', async () => {
    // The tracks and the context both have to go. A live AudioContext keeps the
    // browser's recording indicator lit even after the tracks stop.
    const runtime = makeRuntime(allowMic());
    const result = await runtime.loadScript(script(`
      function listen() { softn.mic.record({ seconds: 30 }, function() {}) }
      function halt() { softn.mic.stop() }
    `));
    const listening = result.functions.listen();
    await recordThenStop(result.functions.halt, tone(100));
    await listening;

    expect(streams[0].getTracks()[0].readyState).toBe('ended');
    expect(contexts[0].closed).toBe(true);
  });

  it('will not start a second recording over the top of the first', async () => {
    // Two recordings would fight over one device, and the second would take the
    // first's samples with it.
    const runtime = makeRuntime(allowMic());
    const result = await runtime.loadScript(script(`
      let second = ""
      function listen() { softn.mic.record({ seconds: 30 }, function() {}) }
      function listenAgain() {
        softn.mic.record({ seconds: 30 }, function(r) { second = r.reason || "" })
      }
      function halt() { softn.mic.stop() }
    `));

    const listening = result.functions.listen();
    await graphReady();
    await result.functions.listenAgain();

    expect(runtime.state.second).toBe('already recording');
    expect(contexts, 'the second attempt must not open another graph').toHaveLength(1);

    await result.functions.halt();
    await listening;
  });

  it('holds the script to the cap the bundle declared', async () => {
    // maxSeconds is what the consent dialog showed the user. A script asking
    // for longer is asking for something nobody approved.
    vi.useFakeTimers();
    const runtime = makeRuntime(allowMic({ maxSeconds: 2 }));
    const result = await runtime.loadScript(script(`
      let done = false
      function listen() {
        softn.mic.record({ seconds: 600 }, function() { done = true })
      }
    `));

    const listening = result.functions.listen();
    await graphReady();
    contexts[0].processors[0].feed(tone(100));

    await vi.advanceTimersByTimeAsync(2100);
    await listening;

    expect(runtime.state.done, 'the 2s cap should have ended it, not the 600s request').toBe(true);
    expect(streams[0].getTracks()[0].readyState).toBe('ended');
  });
});

describe('softn.mic when the microphone will not open', () => {
  it('reports the browser\'s own reason rather than a generic failure', async () => {
    // getUserMedia rejects with a DOMException, which does not inherit from
    // Error — reading .message directly is what keeps "Permission denied" from
    // becoming "could not open the microphone".
    mediaBehaviour = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    const runtime = makeRuntime(allowMic());
    const result = await runtime.loadScript(script(`
      let why = ""
      function listen() {
        softn.mic.record({ seconds: 1 }, function(r) { why = r.reason || "" })
      }
    `));

    await result.functions.listen();
    expect(runtime.state.why).toBe('Permission denied');
  });
});

describe('softn.mic across app teardown', () => {
  it('stops listening when the app that started it goes away', async () => {
    // A microphone left open outlives the app: the tracks stay live, the
    // recording indicator stays lit, and nothing on screen explains why.
    const runtime = makeRuntime(allowMic());
    const result = await runtime.loadScript(script(`
      function listen() { softn.mic.record({ seconds: 600 }, function() {}) }
    `));

    const listening = result.functions.listen();
    await graphReady();
    expect(streams[0].getTracks()[0].readyState).toBe('live');

    runtime.cleanup();
    await listening;

    expect(streams[0].getTracks()[0].readyState).toBe('ended');
    expect(contexts[0].closed).toBe(true);
  });
});
