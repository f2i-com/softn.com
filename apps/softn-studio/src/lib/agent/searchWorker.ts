/// <reference lib="webworker" />
/** `search_files` off the page, where a pattern that never ends can be ended (searchLines.ts). */
import { searchLines } from './searchLines';

self.onmessage = (event: MessageEvent<{ pattern: string; flags: string; files: Array<[string, string]> }>) => {
  const { pattern, flags, files } = event.data;
  try {
    self.postMessage(searchLines(pattern, flags, files));
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
