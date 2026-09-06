import React, { useEffect, useState } from 'react';
import { navigate } from '../lib/router';
import { dragHasFiles, stashDroppedBundles } from '../lib/dropped';

/**
 * Drop `.softn` files on any page and they go to the publish page, one or a
 * folder's worth. While a file drag is over the window an overlay says so.
 * The publish page has its own zone and is left to it (`active` is false
 * there); a drag of anything but files — text, a link — is ignored.
 */
export function DropAnywhere({ active }: { active: boolean }): React.ReactElement | null {
  const [over, setOver] = useState(false);

  useEffect(() => {
    if (!active) return undefined;
    // dragenter/dragleave fire for every element the pointer crosses, so the
    // overlay follows a depth count rather than the last event.
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      depth += 1;
      setOver(true);
    };
    const move = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const drop = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      if (stashDroppedBundles(e.dataTransfer?.files ?? []) > 0) navigate('/publish');
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', move);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', move);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      setOver(false);
    };
  }, [active]);

  if (!active || !over) return null;
  return (
    <div className="drop-anywhere" role="status" aria-live="polite">
      <div className="drop-anywhere-card">
        <strong>Drop .softn files to publish them</strong>
        <span className="muted">One or many: they go to the publish page, ready to go in.</span>
      </div>
    </div>
  );
}
