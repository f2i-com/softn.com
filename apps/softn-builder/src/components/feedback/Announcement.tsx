/**
 * What was just done, said to a screen reader and drawn for nobody: "Deleted
 * Heading.", "Duplicated Card. The copy is selected.", where a move made
 * from the keyboard went.
 *
 * The canvas has one of these. On a phone a panel is a sheet over the
 * canvas, and everything behind an open sheet is taken out of reach (App.tsx
 * makes it inert and hides it from a screen reader): pressing Delete in the
 * Properties sheet said "Deleted Heading." into a region nobody could hear.
 * A sheet has one of its own (`fresh`), inside the dialog it is, which says
 * what is done while the sheet is open and starts with nothing: what was
 * said before it opened is not said again as it opens.
 */

import React, { useState } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';

// Read by a screen reader, seen by nobody.
const HIDDEN: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
};

export function Announcement({ fresh = false }: { fresh?: boolean }) {
  const announcement = useCanvasStore((s) => s.announcement);
  const said = useCanvasStore((s) => s.announced);
  // How many things had been said when this one was mounted.
  const [before] = useState(said);
  const text = fresh && said === before ? '' : announcement;
  return (
    <div role="status" aria-live="polite" data-canvas-announcement="" style={HIDDEN}>
      {/* A new element for each thing said: the same words twice ("Deleted Button." of a second
          Button) are a change to the region, and are read out again. */}
      {text && <span key={said}>{text}</span>}
    </div>
  );
}
