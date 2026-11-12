/**
 * Where the editor was left for each app, and how wide the person made it:
 * opened again, after a reload or another day, it is where it was. In the
 * host's own keys, which no app's `localStorage` reaches.
 */

const PLACE_KEY = 'softn.web.editor';
const WIDTH_KEY = 'softn.web.editor.width';
/** How many apps' places are remembered; the one edited longest ago goes first. */
const PLACES_KEPT = 24;

export interface EditorPlace {
  /** The file that was showing. */
  file?: string;
  /** Where the caret was in it. */
  caret?: number;
  /** How far it was scrolled. */
  scroll?: number;
}

type Places = Array<[string, EditorPlace]>;

function places(): Places {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PLACE_KEY) ?? '[]');
    return Array.isArray(value) ? (value.filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] !== null && typeof entry[1] === 'object') as Places) : [];
  } catch {
    return [];
  }
}

export function editorPlace(origin: string): EditorPlace {
  return places().find(([app]) => app === origin)?.[1] ?? {};
}

export function noteEditorPlace(origin: string, place: EditorPlace): void {
  try {
    const rest = places().filter(([app]) => app !== origin);
    localStorage.setItem(PLACE_KEY, JSON.stringify([...rest, [origin, place]].slice(-PLACES_KEPT)));
  } catch {
    // Storage refused: the editor opens at the app's main page.
  }
}

/** The editor's width beside the app, in pixels, as the person last dragged it; null for the width it starts at. */
export function editorWidth(): number | null {
  try {
    const width = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(width) && width >= 280 ? width : null;
  } catch {
    return null;
  }
}

export function noteEditorWidth(width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Storage refused: it starts at its own width next time.
  }
}
