/**
 * `softn.mic.*`: a recording from the default input, for an app that wants
 * one without putting a viewfinder on screen.
 *
 * Gated, unlike audio playback. audio.ts explains why playing an app's own
 * sound needs no capability: it reads nothing and sends nothing — and a
 * microphone is precisely the thing that fails that test.
 *
 * The `<Microphone>` component is the other route and opens the device
 * itself, the same way `<Camera>` does; in both cases the browser's own
 * permission prompt is what stands in front of the hardware.
 */

import type { PendingHostCall } from '../script-runtime-types';
import { pcmToWavDataUrl } from '../wav';
import type { HostGate } from './permissions';

export class AppMicrophone {
  /**
   * The recording in flight, if any.
   *
   * One at a time: two overlapping `softn.mic.record()` calls would fight over
   * the same device, and the second would take the first's samples with it.
   * `finish` is how both the duration timer and an early `mic.stop()` end the
   * same recording without either needing to know about the other.
   */
  private recording: { stop: (reason: 'complete' | 'stopped') => void } | null = null;
  /**
   * Device access can remain pending while the browser shows its permission
   * prompt. Reserve that interval too, so cleanup and a second record request
   * cannot lose track of a stream that has not been handed back yet.
   */
  private acquisition: { cancelled: boolean } | null = null;

  constructor(private readonly gate: HostGate) {}

  /**
   * Record from the default input and return it as a WAV data URL.
   *
   * Raw PCM rather than MediaRecorder's Opus: see runtime/wav.ts. Options are
   * `seconds` (default 5), `sampleRate` (default 48000) and `processing`
   * (default true — echo cancellation, noise suppression and gain control,
   * which are right for speech and wrong for anything measuring the sound).
   */
  async record(call: PendingHostCall): Promise<unknown> {
    this.gate.checkPermission('mic');

    if (this.recording || this.acquisition) {
      return { recorded: false, reason: 'already recording' };
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return { recorded: false, reason: 'no microphone support' };
    }

    const [optionsJson] = call.args;
    const options = optionsJson
      ? (JSON.parse(optionsJson) as {
          seconds?: number;
          sampleRate?: number;
          processing?: boolean;
        })
      : {};

    const processing = options.processing !== false;
    const wantedRate =
      typeof options.sampleRate === 'number' && options.sampleRate > 0 ? options.sampleRate : 48000;
    // A cap the bundle declared is a promise to the user that the consent
    // dialog showed them, so it wins over whatever the script asks for.
    const declaredCap = this.gate.permissionConfig()?.permissions.mic?.maxSeconds;
    const requested =
      typeof options.seconds === 'number' && options.seconds > 0 ? options.seconds : 5;
    const seconds = Math.min(
      requested,
      typeof declaredCap === 'number' && declaredCap > 0 ? declaredCap : 300
    );

    const acquisition = { cancelled: false };
    this.acquisition = acquisition;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: processing,
          noiseSuppression: processing,
          autoGainControl: processing,
          sampleRate: { ideal: wantedRate },
          channelCount: { ideal: 1 },
        },
      });
    } catch (err) {
      // A DOMException, which does not inherit from Error — reading `.message`
      // directly is what keeps "Permission denied" from becoming "failed".
      const name =
        typeof err === 'object' && err !== null
          ? ((err as { message?: string }).message ?? (err as { name?: string }).name)
          : undefined;
      if (this.acquisition === acquisition) this.acquisition = null;
      return { recorded: false, reason: name ?? 'could not open the microphone' };
    }

    if (this.acquisition === acquisition) this.acquisition = null;
    if (acquisition.cancelled || this.gate.disposed()) {
      stream.getTracks().forEach((track) => track.stop());
      return { recorded: false, reason: 'stopped' };
    }

    const AudioContextCtor =
      (
        globalThis as {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        }
      ).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      stream.getTracks().forEach((t) => t.stop());
      return { recorded: false, reason: 'no Web Audio support' };
    }

    // Asking the context for the rate is what actually resamples: the
    // getUserMedia constraint above is widely ignored, and a graph left at the
    // hardware rate would hand back 44100 samples labelled 48000.
    let context: AudioContext;
    try {
      try {
        context = new AudioContextCtor({ sampleRate: wantedRate });
      } catch {
        context = new AudioContextCtor();
      }
    } catch (err) {
      // Constructing an AudioContext can fail because the browser has reached
      // its context limit or disabled Web Audio. The microphone stream was
      // already granted at this point, so it must still be released.
      stream.getTracks().forEach((track) => track.stop());
      return { recorded: false, reason: String(err) };
    }
    const rate = context.sampleRate;

    const blocks: Float32Array[] = [];
    let total = 0;

    return new Promise<unknown>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let processor: ScriptProcessorNode | null = null;
      let source: MediaStreamAudioSourceNode | null = null;
      let sink: GainNode | null = null;

      const finish = (reason: 'complete' | 'stopped') => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.recording = null;

        if (processor) {
          processor.onaudioprocess = null;
          processor.disconnect();
        }
        if (source) source.disconnect();
        if (sink) sink.disconnect();
        void context.close().catch(() => {
          /* already closed */
        });
        stream.getTracks().forEach((t) => t.stop());

        const samples = new Float32Array(total);
        let offset = 0;
        for (const block of blocks) {
          samples.set(block, offset);
          offset += block.length;
        }

        resolve({
          recorded: total > 0,
          reason,
          dataUrl: pcmToWavDataUrl(samples, rate),
          sampleRate: rate,
          sampleCount: total,
          duration: total / rate,
          mimeType: 'audio/wav',
        });
      };

      try {
        source = context.createMediaStreamSource(stream);
        // ScriptProcessorNode rather than an AudioWorklet: a worklet has to be
        // loaded from a URL, and the only URL the runtime can mint for itself
        // is a blob — which a strict content security policy will refuse. The
        // component takes the worklet route and falls back to this one; here,
        // where there is no visible element to degrade, taking the reliable
        // route directly is worth the main-thread cost of a short recording.
        processor = context.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => {
          if (settled) return;
          // The buffer belongs to the next callback, so it is copied, not kept.
          const block = event.inputBuffer.getChannelData(0);
          blocks.push(new Float32Array(block));
          total += block.length;
        };
        source.connect(processor);
        // A ScriptProcessorNode only runs while connected to something. A
        // zero-gain sink keeps it pulling without routing the microphone to the
        // speakers, which would be a feedback loop.
        sink = context.createGain();
        sink.gain.value = 0;
        processor.connect(sink);
        sink.connect(context.destination);
      } catch (err) {
        settled = true;
        stream.getTracks().forEach((t) => t.stop());
        void context.close().catch(() => {});
        resolve({ recorded: false, reason: String(err) });
        return;
      }

      this.recording = { stop: finish };
      timer = setTimeout(() => finish('complete'), Math.round(seconds * 1000));
    });
  }

  /** End a recording early. The pending `mic.record` callback still fires. */
  async stop(): Promise<unknown> {
    if (this.recording) {
      this.recording.stop('stopped');
      return { stopped: true };
    }
    if (!this.acquisition) return { stopped: false, reason: 'not recording' };
    this.acquisition.cancelled = true;
    return { stopped: true };
  }

  async isRecording(): Promise<unknown> {
    return { recording: this.recording !== null || this.acquisition !== null };
  }

  /** Close any open microphone. Called from cleanup, and safe when idle. */
  close(): void {
    if (this.acquisition) this.acquisition.cancelled = true;
    this.recording?.stop('stopped');
  }
}
