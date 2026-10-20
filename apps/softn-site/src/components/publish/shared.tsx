import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError } from '../../lib/api';
import type { Inspection } from '../../lib/inspectBundle';
import { onDroppedBundles, takeDroppedBundles } from '../../lib/dropped';
import { createSelectionController, type SelectionController, type SelectionItem, type SelectionState } from '../../lib/selection';

/** Where the author's name is remembered between publishes. */
export const AUTHOR_KEY = 'softn.site.author';

export interface CategoriesStatus {
  /** Why the categories request failed, when it did; the page still renders. */
  categoriesError: string | null;
  onRetryCategories: () => void;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError && err.retryAfter) return `${err.message} Try again in about ${Math.ceil(err.retryAfter / 60)} minutes.`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * The chosen bundle(s) as one versioned object — see lib/selection.ts for
 * why the File and its inspection are never two states. One controller per
 * mounted page; React reads its snapshot.
 */
export function useSelection(): [SelectionState, SelectionController] {
  const ref = useRef<SelectionController | null>(null);
  if (!ref.current) ref.current = createSelectionController();
  const controller = ref.current;
  const state = useSyncExternalStore(controller.subscribe, controller.state, controller.state);
  return [state, controller];
}

/** The one item of a single-file selection, or null while there is none or a batch is chosen. */
export function singleItem(state: SelectionState): SelectionItem | null {
  return state.mode === 'single' ? state.items[0] : null;
}

/**
 * Bundles dropped on another page of the site were stashed for this one; a
 * drop beside the zone while this page is up is stashed the same way. `take`
 * gets them on mount and on every later stash, and should be stable.
 */
export function useDroppedBundles(take: (files: File[]) => void): void {
  useEffect(() => {
    const takeStashed = () => {
      const dropped = takeDroppedBundles();
      if (dropped.length > 0) take(dropped);
    };
    takeStashed();
    return onDroppedBundles(takeStashed);
  }, [take]);
}

/**
 * What the directory will refuse and what will make the listing worse,
 * while the file is still the author's to fix. Errors keep the submit
 * button off; warnings only say so.
 */
export function PrepublishReport({ info, extra = [] }: { info: Inspection | null; extra?: string[] }): React.ReactElement | null {
  if (!info) return null;
  const lines = [...info.report, ...extra.map((text) => ({ level: 'warn' as const, text }))];
  if (lines.length === 0) return null;
  const errors = lines.filter((l) => l.level === 'error').length;
  const notes = lines.length - errors;
  return (
    <section className="prepublish" aria-label="Pre-publish report">
      <p className="prepublish-head">
        {errors > 0 ? `${errors} thing${errors === 1 ? '' : 's'} the directory will refuse` : 'Before you publish'}
        {notes > 0 && ` · ${notes} ${notes === 1 ? 'note' : 'notes'}`}
      </p>
      <ul className="prepublish-list">
        {lines.map((line, i) => (
          <li key={i} className={`prepublish-${line.level}`}>
            {line.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A screenshot resized to fit the card, as a PNG (or JPEG when it came in as one). */
async function fitImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const maxW = 1280;
  const maxH = 800;
  const scale = Math.min(1, maxW / bitmap.width, maxH / bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), type, 0.9));
}

/**
 * The chosen screenshot, fitted, or null with `say` told why not. A file
 * that is not the image its name and type claim makes the decode throw, and
 * nothing was listening: choosing it did nothing, with no word why.
 */
async function fitChosenImage(f: File, say: (problem: string) => void): Promise<Blob | null> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) {
    say('A thumbnail is a PNG, JPEG, WebP or GIF.');
    return null;
  }
  try {
    return await fitImage(f);
  } catch {
    say(`${f.name} could not be read as a picture. Choose a PNG, JPEG, WebP or GIF that opens in this browser.`);
    return null;
  }
}

export interface ChosenThumbnail {
  blob: Blob;
  /** An object URL of the blob, for the preview; revoked when it is replaced. */
  url: string;
}

/**
 * The screenshot chosen for the card, fitted in this browser. `take` fits a
 * picked file and replaces the one before it; a file that is not a picture
 * is reported through `say` and changes nothing. `clear` lets it go.
 */
export function useThumbnail(say: (problem: string) => void): { thumb: ChosenThumbnail | null; take: (f: File) => Promise<void>; clear: () => void } {
  const [thumb, setThumb] = useState<ChosenThumbnail | null>(null);
  const take = async (f: File) => {
    const blob = await fitChosenImage(f, say);
    if (!blob) return;
    if (thumb) URL.revokeObjectURL(thumb.url);
    setThumb({ blob, url: URL.createObjectURL(blob) });
  };
  const clear = () => setThumb(null);
  return { thumb, take, clear };
}
