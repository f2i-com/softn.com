/**
 * Where each stretch of a composed page was written: which of the bundle's
 * files, and where in it.
 *
 * A renderer is given one text, the composed page: the main page with every
 * imported page put where it is used, its stylesheets in the place of their
 * links, its declarations gathered and its logic taken out. A node of that
 * text knows its place in it and in no file. A host that edits an app as it
 * runs needs the file: to show the lines that drew an element, and to change
 * them.
 *
 * The composer says what it does as it does it (`ComposeTrace`), and this
 * follows along: each text is kept with the stretches of it that are still a
 * file's own words, and every replacement moves them. Nothing is guessed from
 * the result. What comes out is checked all the same, each stretch against
 * the file it names, and one that does not read the same there is dropped:
 * a place this gives is a place the text is.
 *
 * Only an editing host asks for this (`@softn/core/edit`); a page composed
 * without it pays nothing.
 */

import { composeBundleSource, type ComposedBundleSource, type ComposeTrace, type TraceEdit } from '../bundle/source-composer';

/** A stretch of the composed page that is a file's own text: `source[start, end)` is `file[fileStart, …)`. */
export interface SourceOrigin {
  start: number;
  end: number;
  file: string;
  fileStart: number;
}

export interface ComposedWithOrigins extends ComposedBundleSource {
  /** The stretches of `source` written in a file, in order and apart. What is between them the composer wrote. */
  origins: SourceOrigin[];
}

interface Span {
  at: number;
  length: number;
  file: string;
  from: number;
}

/** A text, and the stretches of it that are a file's own, in order and apart. */
interface Traced {
  text: string;
  spans: Span[];
}

/** The stretches of `of` inside [start, end), placed from `at` in a text being made. */
function keep(of: Traced, cursor: { i: number }, start: number, end: number, at: number, into: Span[]): void {
  const spans = of.spans;
  while (cursor.i < spans.length && spans[cursor.i].at + spans[cursor.i].length <= start) cursor.i++;
  for (let i = cursor.i; i < spans.length && spans[i].at < end; i++) {
    const span = spans[i];
    const from = Math.max(span.at, start);
    const to = Math.min(span.at + span.length, end);
    if (to > from) into.push({ at: at + (from - start), length: to - from, file: span.file, from: span.from + (from - span.at) });
  }
}

function isTraced(value: unknown): value is Traced {
  return typeof value === 'object' && value !== null && typeof (value as Traced).text === 'string' && Array.isArray((value as Traced).spans);
}

/**
 * The composer's follower. It never throws into the composer: a step it
 * cannot follow ends the following, and the page is composed as ever with no
 * origins known.
 */
class OriginTrace implements ComposeTrace<Traced | undefined> {
  lost = false;
  result: Traced | undefined;

  file(path: string, text: string): Traced {
    return { text, spans: text.length > 0 ? [{ at: 0, length: text.length, file: path, from: 0 }] : [] };
  }

  edit(of: Traced | undefined, edits: ReadonlyArray<TraceEdit<Traced | undefined>>): Traced | undefined {
    if (this.lost || !isTraced(of)) return this.lose();
    if (edits.length === 0) return of;
    const spans: Span[] = [];
    const cursor = { i: 0 };
    let text = '';
    let copied = 0;
    for (const [start, end, by] of edits) {
      if (!(start >= copied && end >= start && end <= of.text.length)) return this.lose();
      keep(of, cursor, copied, start, text.length, spans);
      text += of.text.slice(copied, start);
      if (typeof by === 'string') {
        text += by;
      } else {
        if (!isTraced(by)) return this.lose();
        for (const span of by.spans) spans.push({ ...span, at: span.at + text.length });
        text += by.text;
      }
      copied = end;
    }
    keep(of, cursor, copied, of.text.length, text.length, spans);
    text += of.text.slice(copied);
    return { text, spans };
  }

  added(of: Traced | undefined, text: string): Traced | undefined {
    if (this.lost || !isTraced(of)) return this.lose();
    if (text === of.text) return of;
    const added = text.length - of.text.length;
    if (added < 0) return this.lose();
    let at = 0;
    while (at < of.text.length && of.text.charCodeAt(at) === text.charCodeAt(at)) at++;
    // What was put in may begin as what follows it does, and `at` is then
    // past where it went: the text after reads the same either way.
    if (text.slice(at + added) !== of.text.slice(at)) return this.lose();
    return this.edit(of, [[at, at, text.slice(at, at + added)]]);
  }

  done(of: Traced | undefined, source: string): void {
    this.result = !this.lost && isTraced(of) && source.startsWith(of.text) ? of : undefined;
  }

  private lose(): undefined {
    this.lost = true;
    return undefined;
  }
}

/**
 * Compose a bundle's page as `composeBundleSource` does, and say where each
 * stretch of it was written. The page is the same text either way.
 */
export function composeBundleOrigins(
  textFiles: ReadonlyMap<string, string>,
  mainFilePath: string,
  manifestLogicPaths: readonly string[] = []
): ComposedWithOrigins {
  const trace = new OriginTrace();
  const composed = composeBundleSource(textFiles, mainFilePath, manifestLogicPaths, trace as ComposeTrace);
  const origins: SourceOrigin[] = [];
  for (const span of trace.result?.spans ?? []) {
    // Held to the file: a stretch that does not read there as it reads here is no origin.
    const written = textFiles.get(span.file);
    if (written === undefined || written.slice(span.from, span.from + span.length) !== composed.source.slice(span.at, span.at + span.length)) continue;
    const last = origins[origins.length - 1];
    if (last && last.file === span.file && last.end === span.at && last.fileStart + (last.end - last.start) === span.from) {
      last.end = span.at + span.length;
    } else {
      origins.push({ start: span.at, end: span.at + span.length, file: span.file, fileStart: span.from });
    }
  }
  return { ...composed, origins };
}

/** The file a place of the composed page was written in, and where in it; null for what the composer wrote. */
export function originOf(origins: readonly SourceOrigin[], offset: number): { file: string; offset: number } | null {
  let low = 0;
  let high = origins.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (origins[middle].end <= offset) low = middle + 1;
    else high = middle;
  }
  const origin = origins[low];
  return origin && origin.start <= offset ? { file: origin.file, offset: origin.fileStart + (offset - origin.start) } : null;
}

/** Every place of the composed page a place of a file is drawn from: more than one for a page used more than once. */
export function placesOf(origins: readonly SourceOrigin[], file: string, fileOffset: number): number[] {
  const places: number[] = [];
  for (const origin of origins) {
    const within = fileOffset - origin.fileStart;
    if (origin.file === file && within >= 0 && within < origin.end - origin.start) places.push(origin.start + within);
  }
  return places;
}
