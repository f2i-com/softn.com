/**
 * Sheet - a panel of the workspace opened over the canvas, on a screen too
 * narrow for the panel to stand beside it.
 *
 * On a phone the canvas keeps the screen, and Components, Properties, the
 * hierarchy, Files and the logic each come up from the bottom when asked for
 * and go away again: the page being built is never squeezed between panels.
 * It is a dialog in everything but its place: the page behind it is out of
 * reach while it is open (App.tsx), Escape and a press outside close it, and
 * the focus goes back to the button that opened it.
 *
 * The panel inside is the one that stands beside the canvas in a wide
 * window, header and all, and its own Hide button is what closes the sheet,
 * so nothing is named twice.
 */

import React from 'react';
import { useModalFocus } from '@softn/editor-shared/useModalFocus';
import { Announcement } from './feedback/Announcement';

interface SheetProps {
  /** The panel's name, for a screen reader: the panel's own header shows it. */
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** A sheet that needs the height: the logic editor, where lines are what is read. */
  tall?: boolean;
  /** A press anywhere in the sheet, for a panel whose rows are what closes it (a file, picked). */
  onPress?: (event: React.MouseEvent<HTMLDivElement>) => void;
}

export function Sheet({ title, onClose, children, tall = false, onPress }: SheetProps) {
  const sheetRef = useModalFocus(true, onClose);
  return (
    <div className="bl-sheet-backdrop" onClick={onClose}>
      <div
        ref={sheetRef}
        className="bl-sheet"
        data-sheet={title}
        data-tall={tall ? 'true' : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation();
          onPress?.(event);
        }}
      >
        {children}
        {/* What is done from the panel ("Deleted Heading.") is said here, inside the sheet:
            the canvas's own announcement is behind it, out of a screen reader's reach. */}
        <Announcement fresh />
      </div>
    </div>
  );
}
