/**
 * The references to a picture, or any other file the app carries, following
 * it when it is renamed or moved.
 *
 * A page names an asset by its path in the bundle: `asset("assets/logo.png")`
 * in an expression, or the path alone in an attribute. A page's imports and
 * its logic have always followed a rename (stores/filesStore.ts,
 * relinkLogicReferences); an asset's path did not, so renaming `logo.png`
 * left every page that showed it asking for a file that was no longer there,
 * and the Files panel could only say so afterwards.
 *
 * The same change is made to both things a page is held as, the tree the
 * canvas draws and the text the file keeps, so that the one is still what
 * the other is read as. A path is followed where it stands as a whole quoted
 * string (`"assets/logo.png"`, with any of the three quotes), which is how
 * an expression, an attribute and a line of logic each write it; for a
 * folder, where a quoted string starts with the folder's path and a slash
 * (`"assets/icons/" + name`). In the tree, an attribute given the path alone
 * holds it without its quotes, and is followed too. Words between tags are
 * not a reference, and are left as they are in both.
 */

import type { CanvasBlock, CanvasElement, LogicFileState, UIFileBaseline, UIFileState } from '../types/builder';

/** A file moved from one path to another, or a folder with everything under it. */
export interface AssetMove {
  from: string;
  to: string;
  /** A folder: every path under `from/` moves under `to/`. */
  folder: boolean;
}

/** The same move the other way round: what an undo makes. */
export function reversed(move: AssetMove): AssetMove {
  return { from: move.to, to: move.from, folder: move.folder };
}

/** `path` after the move: itself when the move does not touch it. */
export function movedAssetPath(path: string, move: AssetMove): string {
  if (!move.folder) return path === move.from ? move.to : path;
  return path.startsWith(`${move.from}/`) ? `${move.to}${path.slice(move.from.length)}` : path;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text` with every quoted path the move touches written as it is after it. The same string when there is none. */
export function followInText(text: string, move: AssetMove): string {
  if (!text.includes(move.from)) return text;
  const pattern = move.folder
    ? new RegExp(`(["'\`])${escaped(move.from)}/`, 'g')
    : new RegExp(`(["'\`])${escaped(move.from)}\\1`, 'g');
  return text.replace(pattern, (_whole, quote: string) => (move.folder ? `${quote}${move.to}/` : `${quote}${move.to}${quote}`));
}

/**
 * A value an element holds, after the move. `alone` is whether a string that
 * is the path and nothing else is a reference here: it is in an attribute,
 * and in what a list or a record given to one holds, and not in the words
 * between tags.
 */
function followInValue(value: unknown, move: AssetMove, alone: boolean): unknown {
  if (typeof value === 'string') {
    if (alone) {
      const moved = movedAssetPath(value, move);
      if (moved !== value) return moved;
    }
    return followInText(value, move);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const followed = followInValue(item, move, true);
      if (followed !== item) changed = true;
      return followed;
    });
    return changed ? next : value;
  }
  if (value !== null && typeof value === 'object') {
    let next: Record<string, unknown> | null = null;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const followed = followInValue(item, move, true);
      if (followed === item) continue;
      next ??= { ...(value as Record<string, unknown>) };
      next[key] = followed;
    }
    return next ?? value;
  }
  return value;
}

/** A record of texts (handlers, bindings) after the move; the same record when none changed. */
function followInTexts<T extends Record<string, string> | undefined>(texts: T, move: AssetMove): T {
  if (!texts) return texts;
  let next: Record<string, string> | null = null;
  for (const [key, text] of Object.entries(texts)) {
    const followed = followInText(text, move);
    if (followed === text) continue;
    next ??= { ...texts };
    next[key] = followed;
  }
  return (next ?? texts) as T;
}

function followInBlock(block: CanvasBlock | undefined, move: AssetMove): CanvasBlock | undefined {
  if (!block) return block;
  let next: CanvasBlock | null = null;
  for (const field of ['condition', 'iterable', 'keyExpression'] as const) {
    const text = block[field];
    if (text === undefined) continue;
    const followed = followInText(text, move);
    if (followed === text) continue;
    next ??= { ...block };
    next[field] = followed;
  }
  return next ?? block;
}

/** One element after the move; the same element when it names nothing that moved. */
function followInElement(element: CanvasElement, move: AssetMove): CanvasElement {
  let next: CanvasElement | null = null;
  const set = <K extends keyof CanvasElement>(key: K, value: CanvasElement[K]) => {
    if (value === element[key]) return;
    next ??= { ...element };
    next[key] = value;
  };

  let props: Record<string, unknown> | null = null;
  for (const [name, value] of Object.entries(element.props)) {
    // The words an element holds are not an attribute: only a quoted path in them is one.
    const followed = followInValue(value, move, name !== 'children');
    if (followed === value) continue;
    props ??= { ...element.props };
    props[name] = followed;
  }
  if (props) set('props', props);
  set('events', followInTexts(element.events, move));
  set('bindings', followInTexts(element.bindings, move));
  if (element.conditionalIf !== undefined) set('conditionalIf', followInText(element.conditionalIf, move));
  if (element.loopEach !== undefined) set('loopEach', followInText(element.loopEach, move));
  set('block', followInBlock(element.block, move));
  if (element.leadingComments?.some((comment) => followInText(comment.text, move) !== comment.text)) {
    set('leadingComments', element.leadingComments.map((comment) => ({ ...comment, text: followInText(comment.text, move) })));
  }
  return next ?? element;
}

/** A page's tree after the move. The same map when no element names anything that moved. */
export function followInElements(elements: Map<string, CanvasElement>, move: AssetMove): Map<string, CanvasElement> {
  let next: Map<string, CanvasElement> | null = null;
  for (const [id, element] of elements) {
    const followed = followInElement(element, move);
    if (followed === element) continue;
    next ??= new Map(elements);
    next.set(id, followed);
  }
  return next ?? elements;
}

/**
 * A page after the move: its tree, the text it keeps, and what it was read
 * as, which has to say the same or a canvas undone to the start would bring
 * the old path back with the old text. The same page when it names nothing
 * that moved.
 */
export function followInPage(file: UIFileState, move: AssetMove): UIFileState {
  const elements = followInElements(file.elements, move);
  const source = file.originalSource === undefined ? undefined : followInText(file.originalSource, move);
  if (elements === file.elements && source === file.originalSource) return file;
  let baseline: UIFileBaseline | undefined;
  if (file.baseline) {
    baseline = {
      ...file.baseline,
      source: followInText(file.baseline.source, move),
      elements: file.baseline.elements === file.elements ? elements : followInElements(file.baseline.elements, move),
    };
  }
  return {
    ...file,
    elements,
    ...(source !== undefined ? { originalSource: source } : {}),
    // The text is new: what was found in the old one is found again at the next canvas edit.
    ...(source !== file.originalSource ? { sourceFidelity: undefined } : {}),
    ...(file.baseline ? { baseline } : {}),
  };
}

/**
 * Every page and logic file after the move, with the ids of those it
 * changed. The same maps when nothing names what moved.
 */
export function followAssetMove(
  uiFiles: Map<string, UIFileState>,
  logicFiles: Map<string, LogicFileState>,
  move: AssetMove
): { uiFiles: Map<string, UIFileState>; logicFiles: Map<string, LogicFileState>; changed: string[] } {
  const changed: string[] = [];
  let pages: Map<string, UIFileState> | null = null;
  for (const [id, file] of uiFiles) {
    const followed = followInPage(file, move);
    if (followed === file) continue;
    pages ??= new Map(uiFiles);
    pages.set(id, followed);
    changed.push(id);
  }
  let logic: Map<string, LogicFileState> | null = null;
  for (const [id, file] of logicFiles) {
    const content = followInText(file.content, move);
    if (content === file.content) continue;
    logic ??= new Map(logicFiles);
    logic.set(id, { ...file, content });
    changed.push(id);
  }
  return { uiFiles: pages ?? uiFiles, logicFiles: logic ?? logicFiles, changed };
}
