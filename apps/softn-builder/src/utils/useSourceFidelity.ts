/**
 * The fidelity verdict for the active .ui file, for the editing surfaces
 * that show the source/visual capability badge.
 *
 * The verdict is what decides whether the canvas may write the file back
 * (see sourceFidelity.ts), and the store computes it on the first visual
 * edit. The badge wants it earlier — as soon as the file is open — so the
 * creator knows which editing mode is safe before touching anything. The
 * store's cached verdict is used when it has one; otherwise the source is
 * assessed here, a moment after it settles, because the source view
 * updates the store on every keystroke and assessing three parses per
 * keystroke would make typing drag.
 */

import { useEffect, useState } from 'react';
import type { SourceFidelity, UIFileState } from '../types/builder';
import { assessSourceFidelity } from './sourceParser';

const SETTLE_MS = 400;

export interface FileFidelityView {
  /** Null while unknown (no source, or not yet assessed). */
  fidelity: SourceFidelity | null;
  /** Reasons of a visual edit the store refused, if any. */
  blocked: string[] | null;
}

export function useSourceFidelity(file: UIFileState | null | undefined): FileFidelityView {
  const source = file?.originalSource;
  const cached = file?.sourceFidelity;
  const blocked = file?.visualEditBlocked ?? null;
  const [assessed, setAssessed] = useState<{ source: string; fidelity: SourceFidelity } | null>(null);

  useEffect(() => {
    if (source === undefined || cached) return;
    const timer = window.setTimeout(() => {
      setAssessed({ source, fidelity: assessSourceFidelity(source) });
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [source, cached]);

  if (source === undefined) return { fidelity: null, blocked };
  if (cached) return { fidelity: cached, blocked };
  if (assessed && assessed.source === source) return { fidelity: assessed.fidelity, blocked };
  return { fidelity: null, blocked };
}

/** One line for a notice: the first reason, and how many more there are. */
export function summariseReasons(reasons: string[]): string {
  if (reasons.length === 0) return '';
  const [first, ...rest] = reasons;
  return rest.length > 0 ? `${first} (+${rest.length} more)` : first;
}
