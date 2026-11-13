/**
 * A scene's readout: how fast it is drawn, and how much it draws.
 *
 * An author could not see a frame rate, nor tell whether a slow scene was
 * slow for having too many separate things in it (draw calls) or too much
 * geometry (triangles). The scene counts its own frames and reads the
 * renderer's counters, and says so about once a second. Nothing is counted
 * unless the app asked.
 */

/** What a renderer counted for the frame it last drew (three's `renderer.info.render`). */
interface RenderCounts {
  calls: number;
  triangles: number;
}

export interface StatsReadout {
  fps: number;
  drawCalls: number;
  triangles: number;
}

/** How often the readout is given, in seconds. */
const EVERY = 1;

export class StatsMeter {
  private frames = 0;
  private seconds = 0;

  /** Start counting afresh: the readout was just asked for, or the scene was not being drawn. */
  reset(): void {
    this.frames = 0;
    this.seconds = 0;
  }

  /**
   * Count a frame that came `seconds` after the one before. The readout,
   * once a second's worth of frames has been counted; null otherwise.
   * `counts` is of the frame just drawn.
   */
  frame(seconds: number, counts: RenderCounts | undefined): StatsReadout | null {
    // A frame with no time before it (the first the scene draws) is no measure of a rate.
    if (!(seconds > 0) || !Number.isFinite(seconds)) return null;
    this.frames += 1;
    this.seconds += seconds;
    if (this.seconds < EVERY) return null;
    const readout: StatsReadout = {
      fps: Math.round((this.frames / this.seconds) * 10) / 10,
      drawCalls: counts?.calls ?? 0,
      triangles: counts?.triangles ?? 0,
    };
    this.reset();
    return readout;
  }
}
