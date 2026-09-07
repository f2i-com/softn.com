/**
 * OPTIONAL TRUSTED SOFTN HOST MODULE. Never place this file in .logic or eval it.
 * Browser API dependencies are injectable for lifecycle tests.
 * All native speech users in the host must share this broker: the browser's
 * speech queue and cancel() operation are global to the browsing context.
 */
const owners = new WeakMap();
let sequence = 0;
const clean = (s, max) => typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '';
const clamp = (v, lo, hi, fallback) => typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const fail = reason => ({ started: false, reason });

export class LocalSystemSpeechHost {
  constructor({ synthesis = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance,
    // Native Window timers reject a LocalSystemSpeechHost receiver (Illegal invocation).
    // Wrappers keep their receiver intact; injected test schedulers stay supported.
    setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimer = id => globalThis.clearTimeout(id), now = Date.now,
    startTimeoutMs = 10000, maxDurationMs = 110000 } = {}) {
    this.synthesis = synthesis;
    this.Utterance = Utterance;
    this.setTimer = setTimer; this.clearTimer = clearTimer; this.now = now;
    this.startTimeoutMs = startTimeoutMs; this.maxDurationMs = maxDurationMs;
    this.active = null; this.outcomes = new Map(); this.disposed = false;
  }

  capabilities() {
    if (this.disposed || !this.synthesis || !this.Utterance) return { available: false, voices: [], reason: 'speech-unavailable' };
    let voices;
    try { voices = this.synthesis.getVoices().filter(v => v.localService === true && typeof v.voiceURI === 'string' && v.voiceURI.length <= 512); }
    catch { return { available: false, voices: [], reason: 'voice-enumeration-failed' }; }
    return {
      available: voices.length > 0,
      voices: voices.slice(0, 64).map(v => ({ voiceURI: v.voiceURI, name: clean(v.name, 100), lang: clean(v.lang, 32), local: true })),
      reason: voices.length ? undefined : 'no-local-voice-yet'
    };
  }

  async handle(kind, args = []) {
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string') || args.length > 1) return { error: 'invalid-speech-arguments' };
    switch (kind) {
      case 'audio.speechCapabilities': return this.capabilities();
      case 'audio.speak': {
        if (!args[0] || args[0].length > 20000) return fail('invalid-speech-payload');
        let options;
        try { options = JSON.parse(args[0]); } catch { return fail('invalid-speech-json'); }
        return this.speak(options);
      }
      case 'audio.whenSpeechEnded': return this.whenEnded(args[0]);
      case 'audio.stopSpeech': return this.stop(args[0]);
      default: return { error: 'unsupported-speech-call' };
    }
  }

  speak(options) {
    if (this.disposed) return Promise.resolve(fail('runtime-closed'));
    if (!this.synthesis || !this.Utterance) return Promise.resolve(fail('speech-unavailable'));
    if (!options || typeof options !== 'object' || Array.isArray(options) || typeof options.text !== 'string' || options.text.length > 2800) return Promise.resolve(fail('invalid-speech-text'));
    const text = clean(options.text, 2800);
    if (!text) return Promise.resolve(fail('empty-speech'));
    const requested = typeof options.voiceURI === 'string' ? options.voiceURI : '';
    let candidates;
    try { candidates = this.synthesis.getVoices().filter(v => v.localService === true); }
    catch { return Promise.resolve(fail('voice-enumeration-failed')); }
    const voice = requested ? candidates.find(v => v.voiceURI === requested) : candidates[0];
    if (!voice) return Promise.resolve(fail('no-matching-local-voice'));
    // Do not cancel or append to another runtime's native speech queue.
    if (owners.has(this.synthesis) || this.active || this.synthesis.speaking || this.synthesis.pending) return Promise.resolve(fail('speech-busy'));
    const handle = `softn-speech-${++sequence}`;
    let resolveStart, resolveEnd;
    const startPromise = new Promise(resolve => { resolveStart = resolve; });
    const endPromise = new Promise(resolve => { resolveEnd = resolve; });
    let utterance;
    try { utterance = new this.Utterance(text); }
    catch { return Promise.resolve(fail('utterance-creation-failed')); }
    utterance.voice = voice;
    utterance.lang = clean(voice.lang, 32);
    utterance.rate = clamp(options.rate, .75, 1.3, 1);
    utterance.pitch = clamp(options.pitch, .8, 1.2, 1);
    utterance.volume = clamp(options.volume, 0, 1, .72);
    const record = { handle, utterance, resolveStart, resolveEnd, endPromise, startedAt: null, settled: false, startTimer: null, endTimer: null };
    this.active = record;
    owners.set(this.synthesis, this);
    utterance.onstart = () => {
      if (record.settled || this.active !== record || this.disposed) return;
      record.startedAt = this.now();
      this.clearTimer(record.startTimer);
      record.resolveStart({ started: true, handle, local: true, voiceURI: voice.voiceURI });
      record.endTimer = this.setTimer(() => this.finish(record, 'error', 'speech-duration-limit', true), this.maxDurationMs);
    };
    utterance.onend = () => this.finish(record, 'ended');
    utterance.onerror = event => this.finish(record, 'error', clean(event?.error, 100) || 'speech-error', true);
    record.startTimer = this.setTimer(() => this.finish(record, 'error', 'speech-start-timeout', true), this.startTimeoutMs);
    try { this.synthesis.speak(utterance); }
    catch { this.finish(record, 'error', 'speech-start-failed', true); }
    return startPromise;
  }

  finish(record, status, reason, cancel = false) {
    if (record.settled) return;
    record.settled = true;
    this.clearTimer(record.startTimer); this.clearTimer(record.endTimer);
    record.utterance.onstart = null; record.utterance.onend = null; record.utterance.onerror = null;
    if (this.active === record) this.active = null;
    if (owners.get(this.synthesis) === this) {
      // Only the current broker owner can cancel. Other host code must not
      // bypass the broker and enqueue speech while this owner is active.
      if (cancel) { try { this.synthesis.cancel(); } catch { /* Still resolve waiters. */ } }
      owners.delete(this.synthesis);
    }
    const outcome = { handle: record.handle, status, ...(reason ? { reason } : {}),
      durationMs: record.startedAt === null ? 0 : Math.max(0, this.now() - record.startedAt) };
    this.outcomes.set(record.handle, outcome);
    while (this.outcomes.size > 32) this.outcomes.delete(this.outcomes.keys().next().value);
    if (record.startedAt === null) record.resolveStart({ started: false, handle: record.handle, reason: reason || status });
    record.resolveEnd(outcome);
  }

  whenEnded(handle) {
    if (typeof handle !== 'string') return Promise.resolve({ status: 'error', reason: 'invalid-speech-handle' });
    if (this.active?.handle === handle) return this.active.endPromise;
    return Promise.resolve(this.outcomes.get(handle) || { handle, status: 'error', reason: 'unknown-speech-handle' });
  }

  stop(handle) {
    const active = this.active;
    // An empty handle cancels only this runtime's own pending or active speech.
    if (!active || (handle && active.handle !== handle)) return { stopped: false, reason: 'not-owned-or-not-active' };
    this.finish(active, 'stopped', 'requested', true);
    return { stopped: true, handle: active.handle };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active) this.finish(this.active, 'stopped', 'runtime-closed', true);
    this.outcomes.clear();
  }
}
