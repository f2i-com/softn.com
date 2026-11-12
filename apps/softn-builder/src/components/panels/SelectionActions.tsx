/**
 * The row of buttons in the property panel's header for what is selected:
 * move up, move down, duplicate, delete (selectionMoves.ts).
 *
 * A button whose move is not possible is dimmed and says so to a screen
 * reader (`aria-disabled`), and stays where Tab finds it. It is not given
 * the `disabled` attribute: the last press of Move up is always the one
 * that makes it impossible, and the button would go out of the Tab order
 * with the focus still on it. Pressed all the same, a move says why it was
 * not made, as the key does.
 */

import { useMemo } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { moveSelected } from '../../utils/keyboardMoves';
import { isApplePlatform, withMod } from '../../utils/platformKeys';
import { deleteSelection, duplicateSelection, selectionMoves } from './selectionMoves';

const ICONS = {
  up: <path d="M8 13V3.5M3.5 7.5 8 3l4.5 4.5" />,
  down: <path d="M8 3v9.5M3.5 8.5 8 13l4.5-4.5" />,
  duplicate: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-1A1.5 1.5 0 0 0 9 3H4.5A1.5 1.5 0 0 0 3 4.5V9a1.5 1.5 0 0 0 1.5 1.5h1" />
    </>
  ),
  remove: <path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.6 8a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8M6.75 7v4M9.25 7v4" />,
};

interface ActionProps {
  action: keyof typeof ICONS;
  name: string;
  /** The key that does the same, as a tooltip reads it. */
  keys: string;
  /** The same key as `aria-keyshortcuts` writes it. */
  shortcut: string;
  possible: boolean;
  onPress: () => void;
}

function Action({ action, name, keys, shortcut, possible, onPress }: ActionProps) {
  return (
    <button
      type="button"
      className="bl-pp-act"
      data-selection-action={action}
      aria-label={name}
      aria-keyshortcuts={shortcut}
      aria-disabled={possible ? undefined : true}
      title={`${name} (${keys})`}
      onClick={onPress}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {ICONS[action]}
      </svg>
    </button>
  );
}

interface SelectionActionsProps {
  /** After a delete: the buttons are gone with the selection, and the panel puts the focus somewhere of its own. */
  onDeleted?: () => void;
}

export function SelectionActions({ onDeleted }: SelectionActionsProps) {
  const elements = useCanvasStore((s) => s.elements);
  const rootId = useCanvasStore((s) => s.rootId);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const can = useMemo(() => selectionMoves(elements, rootId, selectedIds), [elements, rootId, selectedIds]);

  return (
    <div className="bl-pp-actions" role="group" aria-label="What is selected">
      {/* Not possible, it is pressed all the same: the move is refused where the key's is, and says why. */}
      <Action action="up" name="Move up" keys="Alt+Shift+↑" shortcut="Alt+Shift+ArrowUp" possible={can.up} onPress={() => moveSelected('up')} />
      <Action action="down" name="Move down" keys="Alt+Shift+↓" shortcut="Alt+Shift+ArrowDown" possible={can.down} onPress={() => moveSelected('down')} />
      <Action
        action="duplicate"
        name="Duplicate"
        keys={withMod('D')}
        shortcut={isApplePlatform() ? 'Meta+D' : 'Control+D'}
        possible={can.duplicate}
        onPress={() => duplicateSelection()}
      />
      <Action
        action="remove"
        name="Delete"
        keys="Del"
        shortcut="Delete"
        possible={can.remove}
        onPress={() => {
          if (deleteSelection()) onDeleted?.();
        }}
      />
    </div>
  );
}
