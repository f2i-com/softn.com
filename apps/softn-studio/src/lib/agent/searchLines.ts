/**
 * `search_files`: the lines of the project's text files a pattern matches.
 *
 * The pattern is the model's, and a project's text can suggest one, so it is
 * run in a worker that is ended at a deadline (searchWorker.ts). On the page
 * a pattern that backtracks without end (`^(\w+\s?)*$` over a line of thirty
 * characters runs for seconds, and each character more doubles it) held
 * Studio, its Stop button and its autosave with it, for as long as it ran.
 */

export interface SearchHits {
  hits: string[];
  /** Matches past the ones listed. */
  more: number;
}

/** How many matching lines are listed; the rest are counted. */
export const SEARCH_HIT_LIMIT = 50;

/** How long a search may run before it is ended and the pattern refused. */
export const SEARCH_DEADLINE_MS = 3000;

/** The search itself, wherever it runs. `files` are path and text, in the order to report them. */
export function searchLines(pattern: string, flags: string, files: Array<[string, string]>): SearchHits {
  const re = new RegExp(pattern, flags);
  const hits: string[] = [];
  let more = 0;
  for (const [path, content] of files) {
    content.split('\n').forEach((line, index) => {
      if (!re.test(line)) return;
      if (hits.length < SEARCH_HIT_LIMIT) hits.push(`${path}:${index + 1}: ${line.trim().slice(0, 200)}`);
      else more++;
    });
  }
  return { hits, more };
}

/**
 * The search, in a worker ended at `deadlineMs`: the hits, or `timedOut`.
 * Where there are no workers (a test, a server render) it runs here.
 */
export async function searchProject(
  pattern: string,
  flags: string,
  files: Array<[string, string]>,
  deadlineMs = SEARCH_DEADLINE_MS,
): Promise<SearchHits | { timedOut: true }> {
  if (typeof Worker === 'undefined') return searchLines(pattern, flags, files);
  const worker = new Worker(new URL('./searchWorker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<SearchHits | { timedOut: true }>((resolve, reject) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), deadlineMs);
      worker.onmessage = (event: MessageEvent<SearchHits | { error: string }>) => {
        clearTimeout(timer);
        if ('error' in event.data) reject(new Error(event.data.error));
        else resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event.message || 'The search could not run.'));
      };
      worker.postMessage({ pattern, flags, files });
    });
  } finally {
    worker.terminate();
  }
}
