/**
 * Whether a scene should be drawing at all.
 *
 * The render loop used to run for as long as the component was mounted,
 * and softn-web keeps every open app mounted, hidden with `display: none`,
 * so a page with three 3D apps open drew all three at sixty frames a second
 * for the one on screen. The browser throttles a hidden tab's
 * requestAnimationFrame to nothing, but a hidden app in a visible tab is
 * invisible only to the user.
 *
 * Two signals decide it: the host's word on the app (AppScope.active) and
 * the document's own visibility. When either says no, the loop stops
 * scheduling frames and keeps every bit of state; when both say yes again
 * the clock is re-baselined before the first frame, so a figure whose
 * mixer would otherwise be handed the whole hidden interval as one delta
 * does not lurch to wherever the animation would have got to, and a
 * floating object, whose height is a function of the clock's elapsed time,
 * does not jump to where its phase would have been.
 */

import React from 'react';
import type * as THREE from 'three';

/** Whether the document is on screen, following `visibilitychange`. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = React.useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  );
  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const read = () => setVisible(document.visibilityState !== 'hidden');
    read();
    document.addEventListener('visibilitychange', read);
    return () => document.removeEventListener('visibilitychange', read);
  }, []);
  return visible;
}

/**
 * A requestAnimationFrame loop with a switch. The next frame is scheduled
 * before the current one is drawn, so a frame that throws does not end the
 * loop, and the handle held is always the one to cancel.
 */
export class FrameLoop {
  private handle = 0;
  private running = false;
  private disposed = false;

  constructor(
    private readonly clock: THREE.Clock,
    private readonly frame: () => void
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  setRunning(on: boolean): void {
    if (this.disposed || on === this.running) return;
    this.running = on;
    if (on) {
      // Discard the interval the loop was stopped for: the first delta after
      // a resume must be a frame's worth, not the hidden duration. Clock adds
      // every delta it measures to its elapsed time, which the float
      // animation reads as its phase, so the interval is taken back out of
      // that too — in two statements, because `a -= f()` reads `a` before
      // `f` has added to it.
      const skipped = this.clock.getDelta();
      this.clock.elapsedTime -= skipped;
      this.schedule();
    } else if (this.handle) {
      cancelAnimationFrame(this.handle);
      this.handle = 0;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    if (this.handle) cancelAnimationFrame(this.handle);
    this.handle = 0;
  }

  private schedule(): void {
    this.handle = requestAnimationFrame(this.tick);
  }

  private readonly tick = (): void => {
    this.handle = 0;
    if (!this.running || this.disposed) return;
    this.schedule();
    this.frame();
  };
}
