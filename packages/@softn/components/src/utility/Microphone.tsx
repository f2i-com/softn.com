/**
 * Microphone Component
 *
 * The listening half of Camera. Opens an input device with getUserMedia and
 * hands the script back sound in the three shapes anything actually wants it:
 * a finished recording, a running window of samples, and a level.
 *
 * Recordings come out as uncompressed 16-bit WAV rather than whatever
 * MediaRecorder feels like producing. MediaRecorder gives you Opus, and Opus is
 * a *speech* codec — it reproduces what a voice sounds like, not what the
 * waveform was. That is fine for a voice note and useless for anything that
 * treats sound as a signal: level analysis, pitch detection, or data over
 * audio. A WAV is what came off the microphone, so it can be played, saved, or
 * taken apart again sample by sample.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { isCapabilityAllowed, pcmToWavDataUrl, useCapability } from '@softn/core';

/** One per run of the start effect — see the effect at the bottom for why. */
interface StartAttempt {
  cancelled: boolean;
}

/**
 * The reason a media call failed, in words.
 *
 * Not `err instanceof Error`: every getUserMedia rejection is a DOMException,
 * and DOMException does not inherit from Error. Camera learned this the hard
 * way — the check never matched, and "permission denied" / "no microphone
 * attached" / "device already in use" all came out as one generic sentence.
 */
function describeMediaError(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null) {
    const { name, message } = err as { name?: unknown; message?: unknown };
    if (typeof message === 'string' && message) return message;
    if (typeof name === 'string' && name) return name;
  }
  return fallback;
}

/**
 * The AudioWorklet that does the actual capture, as source text.
 *
 * It is a string because a worklet can only be loaded from a URL, and the only
 * URL a bundled component can mint for itself is a blob. Worth the awkwardness:
 * the alternative — ScriptProcessorNode — runs the same work on the main
 * thread, and a garbage collection at the wrong moment there is a hole in the
 * recording rather than a dropped frame.
 *
 * It forwards raw blocks and never accumulates: who keeps what is the
 * component's decision, and a worklet that buffered a long recording would grow
 * without limit inside the audio thread.
 */
const CAPTURE_WORKLET = `
class SoftNCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // No input yet (the graph is still connecting) is normal, not an error.
    // Returning true keeps the node alive waiting for it.
    if (!channel || channel.length === 0) return true;
    // The buffer the audio thread handed us is reused for the next block, so
    // it has to be copied before it crosses the port.
    const copy = new Float32Array(channel.length);
    copy.set(channel);
    this.port.postMessage(copy, [copy.buffer]);
    return true;
  }
}
registerProcessor('softn-capture', SoftNCaptureProcessor);
`;

/** Samples per ScriptProcessorNode block when the worklet route is unavailable. */
const FALLBACK_BLOCK_SAMPLES = 4096;

/** Refuse to grow a recording past this, so a forgotten mic cannot exhaust memory. */
const DEFAULT_MAX_SECONDS = 60;

/** Root-mean-square of a block, which is what a level meter is measuring. */
function blockRms(block: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < block.length; i += 1) sum += block[i] * block[i];
  return block.length === 0 ? 0 : Math.sqrt(sum / block.length);
}

function blockPeak(block: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < block.length; i += 1) {
    const magnitude = block[i] < 0 ? -block[i] : block[i];
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

export interface MicrophoneProps {
  /**
   * What the microphone is for (default 'clip').
   *
   * - `clip` — record until stopped, then report a WAV in `onCapture`
   * - `live` — report windows of samples continuously in `onSamples`
   * - `level` — report loudness only; the cheapest mode, and the samples never
   *   leave the component
   */
  mode?: 'clip' | 'live' | 'level';
  /** Whether the microphone is open (default true) */
  active?: boolean;
  /**
   * Sample rate to ask the audio system for, in Hz (default 48000).
   *
   * A request, not a promise: hardware and browser both get a say. Every
   * callback reports the rate actually in use, and code that cares about
   * absolute frequencies must read that rather than assume this.
   */
  sampleRate?: number;
  /** Samples per `onSamples` callback in live mode (default 2048) */
  frameSize?: number;
  /**
   * Browser voice processing — echo cancellation, noise suppression and
   * automatic gain control (default true).
   *
   * On is right for speech: it is what makes a voice note sound like a voice
   * note. Off is right for anything measuring the sound rather than listening
   * to it. All three are trained on speech and treat a steady tone as noise to
   * be removed, so a level meter reads low, a tuner drifts, and data sent over
   * audio arrives as silence. One switch, because they fail together.
   */
  processing?: boolean;
  /** Whether to show the built-in record button (default true) */
  showControls?: boolean;
  /** Whether to show the built-in level meter (default true) */
  showMeter?: boolean;
  /** Stop a clip automatically after this many seconds (default 60) */
  maxSeconds?: number;
  /** Start recording as soon as the microphone opens, in clip mode (default false) */
  autoStart?: boolean;
  /** Width in pixels, or any CSS width (default '100%') */
  width?: number | string;
  /** Height of the meter strip in pixels (default 64) */
  height?: number;
  /** Called when a clip finishes recording */
  onCapture?: (data: {
    dataUrl: string;
    duration: number;
    sampleRate: number;
    sampleCount: number;
    mimeType: string;
  }) => void;
  /**
   * Called with each window of samples in live mode.
   *
   * `samples` is a plain array, not a Float32Array: everything crossing into
   * the scripting VM is deep-cloned through an allowlist that admits plain
   * objects and arrays and drops everything else, so a typed array would arrive
   * as null.
   */
  onSamples?: (data: { samples: number[]; sampleRate: number; timestamp: number }) => void;
  /** Called about 20 times a second with the current loudness, 0..1 */
  onLevel?: (data: { level: number; peak: number; clipping: boolean }) => void;
  /** Called when recording starts */
  onStart?: () => void;
  /** Called when recording stops, just before onCapture */
  onStop?: () => void;
  /** Called when the microphone cannot be opened, or capture fails */
  onError?: (error: string) => void;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Rendered below the meter */
  children?: React.ReactNode;
}

export function Microphone({
  mode = 'clip',
  active = true,
  sampleRate = 48000,
  frameSize = 2048,
  processing = true,
  showControls = true,
  showMeter = true,
  maxSeconds = DEFAULT_MAX_SECONDS,
  autoStart = false,
  width = '100%',
  height = 64,
  onCapture,
  onSamples,
  onLevel,
  onStart,
  onStop,
  onError,
  style,
  children,
}: MicrophoneProps): React.ReactElement {
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nodeRef = useRef<AudioWorkletNode | ScriptProcessorNode | null>(null);
  const workletUrlRef = useRef<string | null>(null);

  /** Blocks of the clip being recorded, joined only when it stops. */
  const clipRef = useRef<Float32Array[]>([]);
  const clipLengthRef = useRef(0);
  /** Leftover samples not yet long enough to fill an onSamples window. */
  const windowRef = useRef<Float32Array | null>(null);
  const windowFillRef = useRef(0);
  /** The rate the audio system actually gave us, which may not be the one asked for. */
  const actualRateRef = useRef(sampleRate);
  const recordingRef = useRef(false);
  const lastLevelPostRef = useRef(0);
  /** Bars for the meter's scrolling history. */
  const historyRef = useRef<number[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Callbacks live in refs so that a host passing a fresh closure every render
  // does not tear down and reopen the microphone. Reopening mid-recording would
  // lose the recording, and on some systems flashes the OS recording indicator.
  const handlers = useRef({ onCapture, onSamples, onLevel, onStart, onStop, onError });
  handlers.current = { onCapture, onSamples, onLevel, onStart, onStop, onError };
  const settings = useRef({ mode, frameSize, maxSeconds });
  settings.current = { mode, frameSize, maxSeconds };

  // Same exposure as <Camera>: openMicrophone calls getUserMedia from a mount
  // effect, and permission.json's `mic` entry gates the softn.* API rather than
  // this. Held on the host's published decision, so an entry page cannot raise
  // the browser's microphone prompt over an unanswered bar, and a bundle that
  // never declared `mic` cannot open the device on an origin some other bundle
  // was granted it for. The device opens on the render that follows the grant,
  // with no reload, and closes on the render that withdraws it.
  const micGrant = useCapability('mic');
  const consentPending = micGrant === 'pending';
  const permitted = active && isCapabilityAllowed(micGrant);

  const [isOpen, setIsOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  /** Join the recorded blocks and report the clip. Returns nothing; reports via onCapture. */
  const finishClip = useCallback(() => {
    const blocks = clipRef.current;
    const total = clipLengthRef.current;
    clipRef.current = [];
    clipLengthRef.current = 0;

    if (total === 0) return;

    const samples = new Float32Array(total);
    let offset = 0;
    for (const block of blocks) {
      samples.set(block, offset);
      offset += block.length;
    }

    const rate = actualRateRef.current;
    handlers.current.onCapture?.({
      dataUrl: pcmToWavDataUrl(samples, rate),
      duration: total / rate,
      sampleRate: rate,
      sampleCount: total,
      mimeType: 'audio/wav',
    });
  }, []);

  const stopRecording = useCallback(() => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setIsRecording(false);
    setElapsed(0);
    handlers.current.onStop?.();
    finishClip();
  }, [finishClip]);

  const startRecording = useCallback(() => {
    if (recordingRef.current || !streamRef.current) return;
    clipRef.current = [];
    clipLengthRef.current = 0;
    recordingRef.current = true;
    setIsRecording(true);
    setElapsed(0);
    handlers.current.onStart?.();
  }, []);

  /**
   * Every captured block passes through here, on the audio callback path.
   *
   * Deliberately allocation-light and branch-first: this runs every few
   * milliseconds, and work done here is work not being done on the recording.
   */
  const consumeBlock = useCallback((block: Float32Array) => {
    const { mode: currentMode, frameSize: currentFrame, maxSeconds: cap } = settings.current;
    const rate = actualRateRef.current;

    // Level is reported in every mode: it is what drives the meter, and it is
    // the one thing a host always wants to know about a live microphone.
    const rms = blockRms(block);
    const peak = blockPeak(block);
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    // Everything that touches React state is behind this gate, and it is not an
    // optimisation. A worklet delivers 128 samples at a time — 375 blocks a
    // second at 48 kHz — so a setState per block is 375 renders a second, which
    // is enough on its own to make the recording stutter.
    const paint = now - lastLevelPostRef.current >= 50;
    if (paint) {
      lastLevelPostRef.current = now;
      // Perceptual, not linear: RMS of ordinary speech sits around 0.05, so a
      // bar drawn straight from it never leaves the floor.
      const shaped = Math.min(1, Math.sqrt(rms) * 1.6);
      setLevel(shaped);
      historyRef.current.push(shaped);
      if (historyRef.current.length > 240) historyRef.current.shift();
      handlers.current.onLevel?.({ level: rms, peak, clipping: peak >= 0.99 });
    }

    if (currentMode === 'level') return;

    if (currentMode === 'clip') {
      if (!recordingRef.current) return;
      // The block belongs to the audio thread's next callback, so it is copied
      // rather than retained.
      clipRef.current.push(block.slice());
      clipLengthRef.current += block.length;
      if (paint) setElapsed(clipLengthRef.current / rate);
      if (clipLengthRef.current >= cap * rate) {
        // Stopping from inside the audio path is safe — it only flips a flag
        // and hands the joined samples to the host.
        stopRecording();
      }
      return;
    }

    // Live: re-block the stream into fixed windows. The audio system's block
    // size is its own business (128 for a worklet, 4096 for the fallback), and
    // a host asking for 2048-sample windows should get 2048-sample windows
    // whichever route the samples arrived by.
    const size = Math.max(1, Math.floor(currentFrame));
    if (!windowRef.current || windowRef.current.length !== size) {
      windowRef.current = new Float32Array(size);
      windowFillRef.current = 0;
    }
    let consumed = 0;
    while (consumed < block.length) {
      const room = size - windowFillRef.current;
      const take = Math.min(room, block.length - consumed);
      windowRef.current.set(block.subarray(consumed, consumed + take), windowFillRef.current);
      windowFillRef.current += take;
      consumed += take;

      if (windowFillRef.current === size) {
        // A plain array, because sanitizeArgs drops typed arrays at the VM
        // boundary — see the onSamples docs.
        handlers.current.onSamples?.({
          samples: Array.from(windowRef.current),
          sampleRate: rate,
          timestamp: now,
        });
        windowFillRef.current = 0;
      }
    }
  }, [stopRecording]);

  /** Close the device and tear the graph down. Safe to call more than once. */
  const cleanup = useCallback(() => {
    if (recordingRef.current) {
      // A recording interrupted by the microphone closing is still a recording;
      // throwing it away would lose whatever the user had already said.
      recordingRef.current = false;
      finishClip();
    }
    const node = nodeRef.current;
    if (node) {
      node.disconnect();
      if ('port' in node) node.port.onmessage = null;
      else (node as ScriptProcessorNode).onaudioprocess = null;
      nodeRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (contextRef.current) {
      void contextRef.current.close().catch(() => {
        // Closing an already-closed context throws; nothing to do about it.
      });
      contextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (workletUrlRef.current) {
      URL.revokeObjectURL(workletUrlRef.current);
      workletUrlRef.current = null;
    }
    windowRef.current = null;
    windowFillRef.current = 0;
    historyRef.current = [];
    setIsOpen(false);
    setIsRecording(false);
    setLevel(0);
    setElapsed(0);
  }, [finishClip]);

  /** Wire the capture node, preferring the worklet and falling back if it will not load. */
  const attachCapture = useCallback(async (context: AudioContext, source: MediaStreamAudioSourceNode) => {
    const AudioWorkletNodeCtor = (globalThis as { AudioWorkletNode?: typeof AudioWorkletNode }).AudioWorkletNode;
    if (context.audioWorklet && typeof AudioWorkletNodeCtor === 'function' && typeof URL.createObjectURL === 'function') {
      try {
        const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
        workletUrlRef.current = url;
        await context.audioWorklet.addModule(url);
        const node = new AudioWorkletNodeCtor(context, 'softn-capture');
        node.port.onmessage = (event: MessageEvent) => consumeBlock(event.data as Float32Array);
        source.connect(node);
        // Not connected to the destination: a microphone routed to the speakers
        // is a feedback loop. The worklet pulls input regardless of whether
        // anything downstream is listening.
        return node;
      } catch {
        // A page whose content security policy forbids blob: scripts lands
        // here. Falling back is better than refusing to record.
        if (workletUrlRef.current) {
          URL.revokeObjectURL(workletUrlRef.current);
          workletUrlRef.current = null;
        }
      }
    }

    const processor = context.createScriptProcessor(FALLBACK_BLOCK_SAMPLES, 1, 1);
    processor.onaudioprocess = (event) => {
      consumeBlock(event.inputBuffer.getChannelData(0));
    };
    source.connect(processor);
    // ScriptProcessorNode, unlike the worklet, only runs when it is connected
    // to something. A zero-gain sink keeps it pulling without being audible.
    const mute = context.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(context.destination);
    return processor;
  }, [consumeBlock]);

  const openMicrophone = useCallback(async (attempt: StartAttempt) => {
    cleanup();
    if (!permitted) return;
    // A previous failure must not outlive the attempt that caused it, or the
    // component shows its error box forever and toggling `active` never clears it.
    setError(null);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser has no microphone support');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: processing,
          noiseSuppression: processing,
          autoGainControl: processing,
          sampleRate: { ideal: sampleRate },
          channelCount: { ideal: 1 },
        },
      });

      // The await above can outlive this attempt: the permission prompt sits
      // there while the user navigates away, then they press Allow. Cleanup has
      // already run by then, so without this the microphone turns on with
      // nothing listening, streamRef is dead, and no code path can reach the
      // tracks to stop them — the OS recording indicator stays lit for the rest
      // of the session, and every open/close cycle leaks another device.
      if (attempt.cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      const AudioContextCtor =
        (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) throw new Error('This browser has no Web Audio support');

      // Asking the context for the rate is what actually resamples: the
      // getUserMedia constraint above is widely ignored, and a graph running at
      // the hardware rate would hand back 44100 samples labelled 48000.
      let context: AudioContext;
      try {
        context = new AudioContextCtor({ sampleRate });
      } catch {
        // Safari refuses rates it cannot do natively rather than resampling.
        context = new AudioContextCtor();
      }
      contextRef.current = context;
      actualRateRef.current = context.sampleRate;

      // A context created before a user gesture starts suspended, and a
      // suspended context never pulls a single sample.
      if (context.state === 'suspended') await context.resume();
      if (attempt.cancelled) { cleanup(); return; }

      const source = context.createMediaStreamSource(stream);
      sourceRef.current = source;
      nodeRef.current = await attachCapture(context, source);
      if (attempt.cancelled) { cleanup(); return; }

      setIsOpen(true);
      if (settings.current.mode === 'clip' && autoStart) startRecording();
    } catch (err) {
      if (attempt.cancelled) return;
      const message = describeMediaError(err, 'Failed to access microphone');
      setError(message);
      handlers.current.onError?.(message);
    }
  }, [permitted, processing, sampleRate, autoStart, cleanup, attachCapture, startRecording]);

  // Open and close the device.
  //
  // The cancellation flag belongs to this one run of the effect, not to the
  // component. A shared ref would be cleared by a remount — immediately, under
  // StrictMode — while the previous run's getUserMedia was still in flight, and
  // both attempts would then go on to claim the hardware.
  useEffect(() => {
    const attempt: StartAttempt = { cancelled: false };
    if (permitted) {
      void openMicrophone(attempt);
    } else {
      cleanup();
    }
    return () => {
      // Set before cleanup, so a getUserMedia still in flight stops its own
      // tracks when it lands rather than handing them to a dead component.
      attempt.cancelled = true;
      cleanup();
    };
    // openMicrophone is deliberately absent: it is rebuilt whenever the host
    // passes a fresh callback, and reopening the device for that would drop
    // whatever was being recorded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permitted, processing, sampleRate]);

  // Draw the meter. Canvas rather than a row of divs because this repaints
  // twenty times a second, and that many React elements churning is visible.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !showMeter) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cssWidth = canvas.clientWidth || 300;
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, height);

    const history = historyRef.current;
    const barWidth = 3;
    const gap = 1;
    const visible = Math.floor(cssWidth / (barWidth + gap));
    const start = Math.max(0, history.length - visible);
    const middle = height / 2;

    for (let i = start; i < history.length; i += 1) {
      const value = history[i];
      const x = (i - start) * (barWidth + gap);
      const half = Math.max(1, (value * height) / 2);
      // Recent bars are the brightest; the tail fades so the direction of time
      // is obvious without an axis.
      const age = (history.length - i) / Math.max(1, visible);
      ctx.fillStyle = value > 0.92
        ? `rgba(239, 68, 68, ${1 - age * 0.6})`
        : `rgba(99, 102, 241, ${1 - age * 0.6})`;
      ctx.fillRect(x, middle - half, barWidth, half * 2);
    }
  }, [level, showMeter, height]);

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.625rem',
    width,
    padding: '0.75rem',
    borderRadius: '0.75rem',
    background: 'var(--softn-surface, #0f172a)',
    ...style,
  };

  // "Opening microphone..." forever is what this used to look like. Say which
  // button turns it on instead — or, for a bundle that never declared the
  // device, which line its author has to add.
  const refusal = consentPending
    ? 'The microphone stays off until you choose Allow in the permission bar at the top of this app.'
    : !isCapabilityAllowed(micGrant)
      ? 'This app has not declared microphone access. Its permission.json needs { "mic": { "enabled": true } }.'
      : null;
  if (refusal !== null) {
    return (
      <div style={containerStyle}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: height,
            padding: '1rem',
            textAlign: 'center',
            color: '#94a3b8',
            fontSize: '0.875rem',
            lineHeight: 1.5,
          }}
        >
          {refusal}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={containerStyle}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: height,
            padding: '1rem',
            textAlign: 'center',
            color: '#ef4444',
            fontSize: '0.875rem',
          }}
        >
          {error}
        </div>
      </div>
    );
  }

  const secondsLabel = `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}`;

  return (
    <div style={containerStyle}>
      {showMeter && (
        <div style={{ position: 'relative', width: '100%', height }}>
          <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height }} />
          {!isOpen && active && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#94a3b8',
                fontSize: '0.8125rem',
              }}
            >
              Opening microphone...
            </div>
          )}
        </div>
      )}

      {showControls && mode === 'clip' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            type="button"
            disabled={!isOpen}
            onClick={() => (isRecording ? stopRecording() : startRecording())}
            title={isRecording ? 'Stop recording' : 'Start recording'}
            style={{
              width: 40,
              height: 40,
              flex: '0 0 auto',
              border: 'none',
              borderRadius: '50%',
              cursor: isOpen ? 'pointer' : 'not-allowed',
              opacity: isOpen ? 1 : 0.4,
              backgroundColor: isRecording ? '#ef4444' : '#e2e8f0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background-color 0.15s',
            }}
          >
            <span
              style={{
                display: 'block',
                width: isRecording ? 14 : 18,
                height: isRecording ? 14 : 18,
                borderRadius: isRecording ? 3 : '50%',
                backgroundColor: isRecording ? '#fff' : '#ef4444',
                transition: 'all 0.15s',
              }}
            />
          </button>
          <span style={{ fontSize: '0.8125rem', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
            {isRecording ? secondsLabel : `${actualRateRef.current} Hz`}
          </span>
          {isRecording && (
            <span
              style={{
                marginLeft: 'auto',
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: '#ef4444',
                animation: 'softn-mic-blink 1s infinite',
              }}
            />
          )}
        </div>
      )}

      {children}

      <style>{`
        @keyframes softn-mic-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.25; }
        }
      `}</style>
    </div>
  );
}

export default Microphone;
