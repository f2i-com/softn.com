/**
 * What the app's logic reported while it ran in Preview, shown above it.
 *
 * See utils/previewProblems.ts for where the sentences come from. This is a
 * component of its own, beside the app and not around it, so that keeping a
 * sentence redraws this strip and nothing else: a function the page calls
 * as it is drawn reports its failure during the drawing, and a strip that
 * redrew the app for each report would have it report again, without end.
 * For the same reason a sentence already kept changes nothing, and the list
 * stops growing when it is full.
 */

import React, { useEffect, useState } from 'react';
import { stoppedSentence, watchRuntimeProblems, withProblem, type PreviewProblem } from '../../utils/previewProblems';

interface PreviewProblemsProps {
  /** Which start of the app this is: a restart begins with nothing reported. */
  run: number;
  /** Start the app again, with a new engine and the records it began with. */
  onRestart: () => void;
  /** Told when the logic stops, and when a restart has it running again. */
  onStopped?: (stopped: boolean) => void;
}

const styles: Record<string, React.CSSProperties> = {
  strip: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  words: {
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  list: {
    margin: '4px 0 0',
    paddingLeft: 18,
    fontFamily: 'var(--mono)',
    fontSize: 11.5,
  },
  actions: {
    display: 'flex',
    gap: 6,
    flexShrink: 0,
  },
};

export function PreviewProblems({ run, onRestart, onStopped }: PreviewProblemsProps): React.ReactElement | null {
  const [problems, setProblems] = useState<readonly PreviewProblem[]>([]);

  useEffect(() => {
    setProblems((kept) => (kept.length === 0 ? kept : []));
    let listening = true;
    const stop = watchRuntimeProblems(console, (said) => {
      // After the drawing that reported it: a report can come in the middle of one.
      queueMicrotask(() => {
        if (listening) setProblems((kept) => withProblem(kept, said));
      });
    });
    return () => {
      listening = false;
      stop();
    };
  }, [run]);

  const stopped = problems.some((problem) => problem.stopped);
  useEffect(() => {
    onStopped?.(stopped);
    // Told of the change, not of every drawing: the one who listens redraws the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopped]);

  if (problems.length === 0) return null;
  const [first, ...others] = problems;

  return (
    <div
      className="bl-notice"
      data-tone={stopped ? 'danger' : undefined}
      data-preview-problems={stopped ? 'stopped' : 'reported'}
      role={stopped ? 'alert' : 'status'}
      style={styles.strip}
    >
      <div style={styles.words}>
        {stopped ? (
          <>
            <strong>The app’s logic has stopped.</strong> {stoppedSentence(problems)}
          </>
        ) : (
          <>
            <strong>The app’s logic reported a problem.</strong> {first.text}
          </>
        )}
        {(stopped || others.length > 0) && (
          <details>
            <summary style={{ cursor: 'pointer' }}>
              {stopped ? `What the logic reported (${problems.length})` : `${others.length} more`}
            </summary>
            <ul style={styles.list}>
              {(stopped ? problems : others).map((problem) => (
                <li key={problem.text}>{problem.text}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div style={styles.actions}>
        <button type="button" className={`bl-btn bl-btn-sm${stopped ? ' bl-btn-primary' : ''}`} data-action="restart-preview" onClick={onRestart}>
          Restart preview
        </button>
        {!stopped && (
          <button type="button" className="bl-btn bl-btn-sm" data-action="dismiss-preview-problems" onClick={() => setProblems([])}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
