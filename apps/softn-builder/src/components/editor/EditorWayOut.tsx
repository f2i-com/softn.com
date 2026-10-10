/**
 * The way out of a code editor, said beside it.
 *
 * Tab indents in a code editor and so never leaves it, which is where the
 * Tab key stopped: under the canvas, with Properties and the hierarchy
 * still to come. Two keys get out. F6 goes to the next panel (utils/
 * panelFocus.ts), and the editor's own key hands Tab back until it is
 * pressed again. Neither was said anywhere a person in the editor would
 * look.
 */

import React from 'react';
import { tabFocusKeyLabel } from '../../utils/platformKeys';

export function EditorWayOut({ style }: { style?: React.CSSProperties }): React.ReactElement {
  return (
    <span className="bl-kbd" data-editor-way-out="" style={style}>
      Tab indents here. F6 goes to the next panel; {tabFocusKeyLabel()} lets Tab leave.
    </span>
  );
}
