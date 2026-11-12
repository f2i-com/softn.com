/**
 * What the error card offers beside its words, for a failure to open an app.
 *
 * `describeFailure` (@softn/runtime-shell) says what happened and what to do;
 * until now the card then offered one button, "Back to home", whatever it had
 * just said. "Check your connection … then try again" had nothing to try again
 * with, and by then the address had been rewritten to the runtime's home, so a
 * reload did not try again either. "Look for the app in the directory" had no
 * link to the directory.
 *
 * Read from the same message `describeFailure` reads, and in its order: a 404
 * is "not found" there before it can be "couldn't be downloaded", so it is
 * here too. test/failureActions.test.ts holds the two to each other.
 */
export interface FailureActions {
  /** Asking again may work: the download failed or arrived damaged, and the address is not at fault. */
  retry: boolean;
  /** Nothing is at that address: the directory is where to look. */
  browse: boolean;
}

/** Failures whose own words can hold the ones below without being them (failure.ts's first two rules). */
const NOT_AN_OPEN = /^Nothing was imported|could not be brought forward|^Nothing was changed|^Invalid manifest\.json:/;
/** A download that stopped part way reads as a damaged archive; a second download is the advice the card gives. */
const DAMAGED = /Invalid ZIP|end-of-central-directory|not a zip|corrupt/i;
const NOT_FOUND = /^Could not fetch \S+ \(HTTP (?:404|410)\b|is not a bundle — the server returned a web page/;
const DOWNLOAD_FAILED = /^Could not fetch|Failed to fetch|NetworkError|Load failed/;

export function failureActions(error: unknown): FailureActions {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (NOT_AN_OPEN.test(message)) return { retry: false, browse: false };
  if (DAMAGED.test(message)) return { retry: true, browse: false };
  if (NOT_FOUND.test(message)) return { retry: false, browse: true };
  return { retry: DOWNLOAD_FAILED.test(message), browse: false };
}
