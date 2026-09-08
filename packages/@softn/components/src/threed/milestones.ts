/**
 * The three moments a scene reports, and the marks that let the bench see
 * them.
 *
 * `onReady` fired after the first frame — before any model had arrived, so
 * a game that waited for it to drop its loading screen showed an empty
 * world with figures popping in later. But "the renderer works" is a real
 * moment too, and the audit asks for the moments to be kept apart rather
 * than for one to be redefined:
 *
 * - renderer ready: the WebGL context exists and drew a frame.
 * - assets ready: every model the scene opened with has settled, loaded
 *   or failed. Failure counts, because a scene missing one model is still
 *   the scene to show, and the failure is reported on its own channel.
 * - first frame: the first frame drawn after that — the first useful one.
 *
 * Each is also a `performance.mark`, an instant rather than a start/end
 * pair; scripts/bench/measure.mjs reports unpaired `softn:` marks as
 * points in time.
 */

export const MARK_RENDERER_READY = 'softn:scene3d-renderer-ready';
export const MARK_ASSETS_READY = 'softn:scene3d-assets-ready';
export const MARK_FIRST_FRAME = 'softn:scene3d-first-frame';

export function markInstant(name: string): void {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    try {
      performance.mark(name);
    } catch {
      // A User Timing implementation that refuses a name is not worth a frame.
    }
  }
}

/**
 * The set of models the first reconcile started, drained as each settles
 * or is removed. `fire` runs once, when the set is empty — immediately
 * after the first reconcile if it started nothing.
 */
export class RequiredAssets {
  private readonly pending = new Set<string>();
  private begun = false;
  private fired = false;

  constructor(private readonly fire: () => void) {}

  get hasBegun(): boolean {
    return this.begun;
  }

  get isReady(): boolean {
    return this.fired;
  }

  /** The first reconcile is over; these ids are loading. */
  begin(ids: Iterable<string>): void {
    if (this.begun) return;
    this.begun = true;
    for (const id of ids) this.pending.add(id);
    this.check();
  }

  /** `id` loaded, failed, or left the scene. */
  settle(id: string): void {
    if (!this.pending.delete(id)) return;
    this.check();
  }

  private check(): void {
    if (this.fired || !this.begun || this.pending.size > 0) return;
    this.fired = true;
    this.fire();
  }
}
