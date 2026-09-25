import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceStore, useAIStore, useVFSStore } from '../../stores';
import { Icon } from '../common/Icon';
import type { ValidationError } from '../../types/studio';

const LEVEL_ORDER: Record<ValidationError['level'], number> = { error: 0, warning: 1, info: 2 };

const AGENT_LABEL: Record<string, string> = {
  idle: 'AI idle',
  error: 'AI stopped with an error',
};

/**
 * The strip along the bottom: what the AI is doing, whether the project has
 * problems, and a few facts about the bundle.
 *
 * The validator's findings used to reach the screen only as a count — "1
 * warning" — with nothing to press and nowhere to read what it was. The
 * count is now a button that opens the list: each finding with its file,
 * its message and the suggested fix, errors first. Escape or a second press
 * closes it and gives focus back to the count.
 */
export const StatusBar: React.FC = () => {
  const { mode, errors, blueprint } = useWorkspaceStore();
  const { agentState } = useAIStore();
  const { files } = useVFSStore();
  const [issuesOpen, setIssuesOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const target = blueprint?.target ?? 'web';
  const errorCount = errors.filter((e) => e.level === 'error').length;
  const warnCount = errors.filter((e) => e.level === 'warning').length;
  const sorted = useMemo(
    () => [...errors].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.file.localeCompare(b.file)),
    [errors],
  );

  // Estimate bundle size (memoized — TextEncoder is expensive per-render)
  const sizeLabel = useMemo(() => {
    let bundleSize = 0;
    for (const f of files.values()) {
      if (typeof f.content === 'string') {
        bundleSize += new TextEncoder().encode(f.content).length;
      } else {
        bundleSize += f.content.length;
      }
    }
    return bundleSize < 1024
      ? `${bundleSize} B`
      : bundleSize < 1024 * 1024
      ? `${(bundleSize / 1024).toFixed(1)} KB`
      : `${(bundleSize / (1024 * 1024)).toFixed(1)} MB`;
  }, [files]);

  useEffect(() => {
    if (!issuesOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIssuesOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const node = event.target as Node;
      if (panelRef.current?.contains(node) || toggleRef.current?.contains(node)) return;
      setIssuesOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [issuesOpen]);

  // A list that empties while open has nothing left to show.
  useEffect(() => {
    if (errors.length === 0) setIssuesOpen(false);
  }, [errors.length]);

  const agentLive = agentState !== 'idle' && agentState !== 'error';
  const issueLabel =
    errorCount > 0
      ? `${errorCount} error${errorCount > 1 ? 's' : ''}${warnCount > 0 ? `, ${warnCount} warning${warnCount > 1 ? 's' : ''}` : ''}`
      : warnCount > 0
        ? `${warnCount} warning${warnCount > 1 ? 's' : ''}`
        : errors.length > 0
          ? `${errors.length} note${errors.length > 1 ? 's' : ''}`
          : 'No problems';

  return (
    <div className="st-statusbar">
      <div className="st-status-group">
        <span className="st-status-item">
          <span className="st-status-dot" data-state={agentLive ? 'live' : agentState === 'error' ? 'error' : 'idle'} />
          {AGENT_LABEL[agentState] ?? `AI ${agentState}`}
        </span>

        {errors.length > 0 ? (
          <button
            ref={toggleRef}
            type="button"
            className="st-status-item"
            data-level={errorCount > 0 ? 'error' : warnCount > 0 ? 'warning' : undefined}
            aria-expanded={issuesOpen}
            aria-controls="studio-issues"
            onClick={() => setIssuesOpen((open) => !open)}
          >
            <Icon name={errorCount > 0 ? 'alert-circle' : warnCount > 0 ? 'warning' : 'info'} size={13} />
            {issueLabel}
          </button>
        ) : (
          <span className="st-status-item">
            <Icon name="check" size={13} />
            {issueLabel}
          </span>
        )}
      </div>

      <div className="st-status-group">
        <span className="st-status-item">
          <span className="num">{files.size}</span> file{files.size === 1 ? '' : 's'}
        </span>
        <span className="st-status-item">
          Bundle <span className="num">{sizeLabel}</span>
        </span>
        <span className="st-status-item st-status-hide-narrow">
          {target.charAt(0).toUpperCase() + target.slice(1)} target
        </span>
        <span className="st-status-item st-status-hide-narrow">
          {mode.charAt(0).toUpperCase() + mode.slice(1)} mode
        </span>
      </div>

      {issuesOpen && (
        <div ref={panelRef} id="studio-issues" className="st-issues" role="region" aria-labelledby="studio-issues-title">
          <div className="st-issues-head">
            <h2 id="studio-issues-title" className="st-issues-title">Problems in this project</h2>
            <button
              type="button"
              className="st-icon-btn"
              aria-label="Close the problem list"
              onClick={() => {
                setIssuesOpen(false);
                toggleRef.current?.focus();
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
          <ul className="st-issues-list">
            {sorted.map((issue, i) => (
              <li key={`${issue.file}:${issue.line ?? ''}:${i}`} className="st-issue" data-level={issue.level}>
                <span className="st-issue-icon">
                  <Icon name={issue.level === 'error' ? 'alert-circle' : issue.level === 'warning' ? 'warning' : 'info'} size={14} />
                </span>
                <span className="st-issue-where">
                  {issue.file}
                  {issue.line ? `:${issue.line}` : ''}
                </span>
                <span>{issue.message}</span>
                {issue.suggestion && <span className="st-issue-fix">{issue.suggestion}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
