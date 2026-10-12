/**
 * The deadline a page gives its app's download: for the download to stop,
 * not to finish.
 *
 * The whole load used to have sixty seconds, so a bundle of a few megabytes
 * on a slow connection failed every time however steadily it was arriving,
 * and "Try again" did the same again. The minute now starts over with every
 * piece that arrives (`touch`), and a load where nothing arrives for a minute
 * is aborted with a reason a visitor can read, where "signal is aborted
 * without reason" was all Technical details said.
 */
export const STALL_MS = 60_000;
export const STALLED_MESSAGE = 'The application stopped downloading: nothing arrived for a minute. Check the connection and try again.';

export interface StallWatch {
  /** Something arrived: the minute starts over. */
  touch(): void;
  /** The load is over, one way or the other. */
  stop(): void;
}

export function watchForStall(controller: AbortController, ms: number = STALL_MS): StallWatch {
  const stall = () => controller.abort(new Error(STALLED_MESSAGE));
  let timer = setTimeout(stall, ms);
  return {
    touch() {
      clearTimeout(timer);
      timer = setTimeout(stall, ms);
    },
    stop() {
      clearTimeout(timer);
    },
  };
}
