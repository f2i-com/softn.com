export class LocalSystemSpeechHost {
  constructor(options?: Record<string, unknown>);
  capabilities(): { available: boolean; voices: Array<{voiceURI: string; name: string; lang: string; local: true}>; reason?: string };
  handle(kind: string, args?: string[]): Promise<unknown>;
  speak(options: unknown): Promise<Record<string, unknown>>;
  whenEnded(handle: string): Promise<Record<string, unknown>>;
  stop(handle?: string): Record<string, unknown>;
  dispose(): void;
  active: {handle: string; startedAt: number | null} | null;
  outcomes: Map<string, {handle: string; status: string; durationMs: number}>;
}
