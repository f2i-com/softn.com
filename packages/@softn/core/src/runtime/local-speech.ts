import { LocalSystemSpeechHost } from './local-system-speech.mjs';

/**
 * `softn.audio.speak` and its companions, on the device's own voices.
 *
 * The neural voices (Kokoro, on ONNX Runtime) went with ONNX Runtime. An app
 * that still asks for one is spoken by a system voice, and the answer says so
 * (`fallbackFrom: "kokoro"`), so speech an app depends on keeps working;
 * loading the neural model answers that it is not there.
 */
export interface LocalSpeechOptions {
  system?: LocalSystemSpeechHost;
}

const NEURAL_REMOVED = 'neural-speech-removed';

/** One runtime owns every handle and pending utterance, through the shared system-speech broker. */
export class LocalSpeechHost {
  private readonly system: LocalSystemSpeechHost;
  private disposed = false;

  constructor(options: LocalSpeechOptions = {}) {
    this.system = options.system || new LocalSystemSpeechHost();
  }

  capabilities(): Record<string, unknown> {
    return { ...this.system.capabilities(), neural: { supported: false, loaded: false, reason: NEURAL_REMOVED } };
  }

  async handle(kind: string, args: string[] = []): Promise<unknown> {
    if (!Array.isArray(args) || args.length > 1 || args.some((value) => typeof value !== 'string')) return { error: 'invalid-speech-arguments' };
    switch (kind) {
      case 'audio.speechCapabilities': return this.capabilities();
      case 'audio.loadSpeechModel': return { loaded: false, reason: NEURAL_REMOVED };
      case 'audio.releaseSpeechModel': return { released: true };
      case 'audio.speak': {
        if (!args[0] || args[0].length > 20000) return { started: false, reason: 'invalid-speech-payload' };
        let value: unknown;
        try { value = JSON.parse(args[0]); } catch { return { started: false, reason: 'invalid-speech-json' }; }
        return this.speak(value);
      }
      case 'audio.speechState': return this.state(args[0] || '');
      case 'audio.whenSpeechEnded': return this.system.whenEnded(args[0] || '');
      case 'audio.stopSpeech': return this.system.stop(args[0] || '');
      default: return { error: 'unsupported-speech-call' };
    }
  }

  async speak(value: unknown): Promise<Record<string, unknown>> {
    if (this.disposed) return { started: false, reason: 'runtime-closed' };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { started: false, reason: 'invalid-speech-options' };
    const options = value as Record<string, unknown>;
    const provider = options.provider === undefined ? 'system' : options.provider;
    if (provider === 'system') return this.system.speak(options);
    if (provider !== 'kokoro') return { started: false, reason: 'unsupported-speech-provider' };
    // A Kokoro voice id names nothing on the device, so the device's first
    // local voice speaks instead.
    const { voiceURI: _voice, provider: _provider, ...rest } = options;
    return { ...(await this.system.speak(rest)), fallbackFrom: 'kokoro' };
  }

  state(handle: string): Record<string, unknown> {
    const active = this.system.active;
    if (active?.handle === handle) {
      return { handle, provider: 'system', status: active.startedAt === null ? 'pending' : 'playing', amplitude: 0,
        positionMs: active.startedAt === null ? 0 : Date.now() - active.startedAt, durationMs: 0 };
    }
    const outcome = this.system.outcomes.get(handle);
    if (outcome) return { ...outcome, provider: 'system', amplitude: 0, positionMs: outcome.durationMs };
    return { handle, status: 'error', reason: 'unknown-speech-handle', amplitude: 0, positionMs: 0, durationMs: 0 };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.system.dispose();
  }
}
