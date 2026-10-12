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
 *
 * A minute that starts over is no end on its own: a server sending a byte
 * every 59 seconds kept the page loading for as long as the bundle cap (32 MB)
 * allowed, which at that rate is years. So the whole load also has a ceiling
 * that nothing resets, half an hour. That is long enough for a real slow
 * connection: 32 MB arrives in it at about 18 KB a second, a slow mobile
 * connection, and a bundle of a few megabytes at about 2 KB a second.
 */
export const STALL_MS = 60_000;
export const STALLED_MESSAGE = 'The application stopped downloading: nothing arrived for a minute. Check the connection and try again.';
export const DOWNLOAD_CEILING_MS = 30 * 60_000;
export const TOO_SLOW_MESSAGE = 'The application took more than 30 minutes to download, so the download was stopped. Check the connection and try again.';

export interface StallWatch {
  /** Something arrived: the minute starts over. */
  touch(): void;
  /** The load is over, one way or the other. */
  stop(): void;
}

export function watchForStall(controller: AbortController, ms: number = STALL_MS, ceilingMs: number = DOWNLOAD_CEILING_MS): StallWatch {
  const stall = () => controller.abort(new Error(STALLED_MESSAGE));
  let timer = setTimeout(stall, ms);
  const ceiling = setTimeout(() => controller.abort(new Error(TOO_SLOW_MESSAGE)), ceilingMs);
  return {
    touch() {
      clearTimeout(timer);
      timer = setTimeout(stall, ms);
    },
    stop() {
      clearTimeout(timer);
      clearTimeout(ceiling);
    },
  };
}
