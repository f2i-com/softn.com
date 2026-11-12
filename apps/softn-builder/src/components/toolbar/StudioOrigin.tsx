/**
 * Where the open project came from, when that is Studio, and the way back.
 *
 * A slim line over the toolbar: "From Studio: Reading list", and Back to
 * Studio, which hands the project back to the Studio project it came from
 * and takes this tab there (utils/studioVisit.ts). The project is the
 * Builder's own while it is here: Save and Export do what they always do.
 * The line is drawn only for a project that came that way, and only where
 * there is a Studio beside this Builder to go back to.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { toast } from '../../stores/notificationStore';
import type { ViewMode } from '../../utils/openProject';
import { STUDIO_URL } from '../../utils/siteUrls';
import { useStudioVisit, useStudioVisitStore } from '../../utils/studioLink';
import { backToStudio, studioOffered } from '../../utils/studioVisit';

export function StudioOrigin({ view }: { view: ViewMode }): React.ReactElement | null {
  const visit = useStudioVisit();
  const arriving = useStudioVisitStore((state) => state.arriving);
  const problem = useStudioVisitStore((state) => state.problem);
  const [leaving, setLeaving] = useState(false);

  const back = useCallback(async () => {
    if (leaving) return;
    setLeaving(true);
    const outcome = await backToStudio(view).catch((e: unknown) => ({ kind: 'stayed' as const, message: `The project could not be handed back to Studio: ${e instanceof Error ? e.message : String(e)}` }));
    if (outcome.kind === 'left') return;
    setLeaving(false);
    toast.error(outcome.message);
  }, [leaving, view]);
  // The browser's Back from Studio can show this page as it was left, on its way out: it is here again.
  useEffect(() => {
    const shown = (event: PageTransitionEvent) => {
      if (event.persisted) setLeaving(false);
    };
    window.addEventListener('pageshow', shown);
    return () => window.removeEventListener('pageshow', shown);
  }, []);

  if (!studioOffered()) return null;

  if (visit) {
    return (
      <div className="bl-origin" data-studio-origin="open" role="group" aria-label="Opened from Studio">
        <span className="bl-origin-from">
          From Studio: <strong title={visit.name}>{visit.name}</strong>
        </span>
        <button
          type="button"
          className="bl-btn bl-btn-sm"
          data-action="back-to-studio"
          onClick={() => void back()}
          disabled={leaving}
          aria-busy={leaving}
          title="Take your changes back to this project in Studio"
        >
          {leaving ? 'Going back…' : 'Back to Studio'}
        </button>
      </div>
    );
  }
  if (arriving) {
    return (
      <div className="bl-origin" data-studio-origin="arriving" role="status">
        <span className="bl-origin-from">Opening the project from Studio…</span>
      </div>
    );
  }
  if (problem) {
    return (
      <div className="bl-origin" data-studio-origin="problem" role="alert">
        <span className="bl-origin-from bl-origin-problem">{problem}</span>
        <a className="bl-btn bl-btn-sm" href={STUDIO_URL}>
          Back to Studio
        </a>
        <button type="button" className="bl-mini" aria-label="Dismiss" onClick={() => useStudioVisitStore.setState({ problem: null })}>
          ×
        </button>
      </div>
    );
  }
  return null;
}
