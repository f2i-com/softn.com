/**
 * From an element on a running app to the lines that drew it, and back.
 *
 * The renderer notes which node of the composed page drew each element
 * (core's edit marks), and the composer says which file each stretch of that
 * page was written in (its origins). Together: the file and the place of the
 * element a person pressed, and every element on screen a place in a file
 * drew, for the outline.
 */

import { readManifest } from '@softn/core';
import { composeBundleOrigins, drawnAt, drawnFrom, originOf, placesOf, type EditMarks, type SourceOrigin } from '@softn/core/edit';

/** The page on screen, traced: where each stretch of it was written. */
export interface TracedPage {
  origins: SourceOrigin[];
}

/**
 * Trace the page that `files` compose: the main page, or `page` when a link
 * has put another on screen. Null when the files cannot be composed, or do
 * not compose the page that is showing (`showing`, when the host knows it):
 * a place in a different text is no place at all.
 */
export function tracePage(files: ReadonlyMap<string, string>, page: string | undefined, showing?: string): TracedPage | null {
  try {
    const manifest = readManifest(files);
    const composed = composeBundleOrigins(files, page ?? manifest.main, manifest.files.logic);
    if (showing !== undefined && composed.source !== showing) return null;
    return { origins: composed.origins };
  } catch {
    return null;
  }
}

/** An element of the app a person picked: where it is written. */
export interface Picked {
  file: string;
  /** Where its name begins in the file: just past its `<`. */
  nameStart: number;
  tag: string;
  /** A component, whose own elements are not in the source. */
  component: boolean;
}

export type PickResult = { picked: Picked } | { refused: string } | null;

/** What a press on `target` picks. */
export function pickAt(marks: EditMarks, traced: TracedPage | null, target: Element): PickResult {
  const from = drawnFrom(marks, target);
  if (!from) return null;
  if (from.node.loc.start < 0) return { refused: 'The app’s own code made this element, so no page has it to change.' };
  const origin = traced ? originOf(traced.origins, from.node.loc.start) : null;
  if (!origin) return { refused: 'This element cannot be traced to a page right now. Try again once the app has updated.' };
  return { picked: { file: origin.file, nameStart: origin.offset, tag: from.node.tag, component: from.component } };
}

/** The elements pressing on `target` would pick, for the outline under the pointer. */
export function outlineOf(marks: EditMarks, target: Element): Element[] | null {
  return drawnFrom(marks, target)?.elements ?? null;
}

export interface DrawnNow {
  /** Every element on screen the picked place drew. */
  elements: Element[];
  /** How many times it is drawn. */
  times: number;
  /** How many places of the page it is put in: more than one for an imported page used more than once. */
  places: number;
}

/** What a place in a file is drawing on the app now. */
export function drawnNow(marks: EditMarks, traced: TracedPage | null, root: Element | null, picked: Pick<Picked, 'file' | 'nameStart'>): DrawnNow {
  if (!traced || !root) return { elements: [], times: 0, places: 0 };
  const places = placesOf(traced.origins, picked.file, picked.nameStart);
  const drawn = places.flatMap((place) => drawnAt(marks, root, place));
  return { elements: drawn.flatMap((from) => from.elements), times: drawn.length, places: places.length };
}
