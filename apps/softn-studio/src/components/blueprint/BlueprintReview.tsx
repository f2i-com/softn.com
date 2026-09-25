import React, { useMemo, useState } from 'react';
import { useWorkspaceStore } from '../../stores';
import { Icon } from '../common/Icon';
import { useModalFocus } from '@softn/editor-shared/useModalFocus';
import { useAIReadiness } from '../ai/AIStatusPill';

interface BlueprintReviewProps {
  onApprove: () => void;
  onReviseBrief?: () => void;
}

// Focus is drawn by the one rule in styles/studio.css, the same ring as the
// rest of Studio and the product bar; nothing here paints it.

const hover = (rest: string, over: string) => ({
  onMouseEnter: (event: React.MouseEvent<HTMLElement>) => { event.currentTarget.style.background = over; },
  onMouseLeave: (event: React.MouseEvent<HTMLElement>) => { event.currentTarget.style.background = rest; },
});

const noop = () => {};

export const BlueprintReview: React.FC<BlueprintReviewProps> = ({ onApprove, onReviseBrief }) => {
  const {
    blueprint,
    brief,
    taskGraph,
    setBlueprint,
    setBlueprintApproved,
    addConsoleOutput,
  } = useWorkspaceStore();
  const [revisionInput, setRevisionInput] = useState('');
  // With the AI ready, approving hands the plan to the agent to build.
  const aiReady = useAIReadiness().state === 'ready';
  // A modal over the editor: keyboard stays inside; Escape is "Revise brief"
  // where that is offered (the only way out that is not approval).
  const dialogRef = useModalFocus(true, onReviseBrief ?? noop);

  const summaryStats = useMemo(() => {
    if (!blueprint) return [];
    return [
      { label: 'Pages', value: blueprint.pages.length },
      { label: 'Collections', value: blueprint.collections.length },
      { label: 'Tasks', value: taskGraph.length },
    ];
  }, [blueprint, taskGraph.length]);

  if (!blueprint || !brief) return null;

  const applyRevisionHint = () => {
    const text = revisionInput.trim();
    if (!text) return;

    const next = { ...blueprint };
    if (/auth/i.test(text)) {
      next.assumptions = [...next.assumptions, 'Review authentication flow requirements before export.'];
    }
    if (/page|screen|view/i.test(text)) {
      next.risks = [...next.risks, `User requested revision: ${text}`];
    } else {
      next.assumptions = [...next.assumptions, `Revision note: ${text}`];
    }

    setBlueprint(next);
    addConsoleOutput(`[Architect] Blueprint revised: ${text}`);
    setRevisionInput('');
  };

  const rule = (isLast: boolean): React.CSSProperties =>
    (isLast ? { borderBottom: 'none', paddingBottom: 0 } : {});

  return (
    <div style={styles.overlay}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="blueprint-review-title" tabIndex={-1} style={styles.modal}>
        <div style={styles.header}>
          <div>
            <span style={styles.eyebrow}>Review the plan</span>
            <h2 id="blueprint-review-title" style={styles.title}>{blueprint.appName}</h2>
            <p style={styles.subtitle}>Approve the AI plan before you continue deeper into the editor.</p>
          </div>
        </div>

        <div style={styles.statGrid}>
          {summaryStats.map((stat) => (
            <div key={stat.label} style={styles.statCard}>
              <span style={styles.statLabel}>{stat.label}</span>
              <strong style={styles.statValue}>{stat.value}</strong>
            </div>
          ))}
        </div>

        <div style={styles.contentGrid}>
          <section style={styles.sectionCard}>
            <span style={styles.sectionKicker}>Pages</span>
            {blueprint.pages.map((page, index) => (
              <div key={page.id} style={{ ...styles.listRow, ...rule(index === blueprint.pages.length - 1) }}>
                <div style={{ minWidth: 0 }}>
                  <div style={styles.rowTitle}>{page.name}</div>
                  <div style={styles.rowSub}>{page.route || 'No route'} / {page.layout}</div>
                </div>
                <span style={styles.rowBadge}>{page.components.length} component{page.components.length === 1 ? '' : 's'}</span>
              </div>
            ))}
          </section>

          <section style={styles.sectionCard}>
            <span style={styles.sectionKicker}>Data model</span>
            {blueprint.collections.length > 0 ? blueprint.collections.map((collection, index) => (
              <div key={collection.id} style={{ ...styles.listRow, ...rule(index === blueprint.collections.length - 1) }}>
                <div style={{ minWidth: 0 }}>
                  <div style={styles.rowTitle}>{collection.name}</div>
                  <div style={styles.rowSub}>{collection.fields.map((field) => field.name).join(', ') || 'No fields yet'}</div>
                </div>
                <span style={styles.rowBadge}>{collection.fields.length} fields</span>
              </div>
            )) : (
              <div style={styles.emptyCard}>No collections requested yet.</div>
            )}
          </section>

          <section style={styles.sectionCard}>
            <span style={styles.sectionKicker}>Risks</span>
            {blueprint.risks.map((risk, index) => (
              <div key={risk} style={{ ...styles.noteRow, ...rule(index === blueprint.risks.length - 1) }}>{risk}</div>
            ))}
          </section>

          <section style={styles.sectionCard}>
            <span style={styles.sectionKicker}>Assumptions</span>
            {blueprint.assumptions.map((assumption, index) => (
              <div key={assumption} style={{ ...styles.noteRow, ...rule(index === blueprint.assumptions.length - 1) }}>{assumption}</div>
            ))}
          </section>
        </div>

        <div style={styles.revisionCard}>
          <div style={styles.revisionHeader}>
            <Icon name="edit" size={14} color="var(--studio-accent)" />
            <span id="blueprint-revision-title" style={styles.revisionTitle}>Revise the plan</span>
          </div>
          <div style={styles.revisionRow}>
            <input
              id="blueprint-revision-note"
              value={revisionInput}
              onChange={(event) => setRevisionInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') applyRevisionHint(); }}
              placeholder="Add another page, tighten auth, or note a revision for the next pass..."
              aria-labelledby="blueprint-revision-title"
              style={styles.revisionInput}
            />
            <button
              onClick={applyRevisionHint}
              style={styles.secondaryButton}
              {...hover('var(--studio-bg-muted)', 'var(--studio-surface-hover)')}
            >
              Apply note
            </button>
          </div>
        </div>

        <div style={styles.actions}>
          <button
            onClick={() => {
              if (onReviseBrief) {
                addConsoleOutput('[Architect] Blueprint sent back for revision.');
                onReviseBrief();
              } else {
                // Fallback: approve and let user revise via AI chat
                setBlueprintApproved(true);
                addConsoleOutput('[Architect] Blueprint approved — use AI chat to revise the plan.');
                onApprove();
              }
            }}
            style={styles.secondaryButton}
            {...hover('var(--studio-bg-muted)', 'var(--studio-surface-hover)')}
          >
            Revise brief
          </button>
          <button
            onClick={() => {
              setBlueprintApproved(true);
              addConsoleOutput('[Architect] Blueprint approved.');
              onApprove();
            }}
            style={styles.primaryButton}
          >
            {aiReady ? 'Approve and build' : 'Approve blueprint'}
          </button>
        </div>
      </div>
    </div>
  );
};

// Shared with the brief wizard: labels in the sans, sentence case. The
// tracked capitals every kicker, stat label and count used to wear made the
// sheet shout each heading at the same volume as its title.
const eyebrow: React.CSSProperties = {
  fontFamily: 'var(--studio-body)',
  fontSize: 13,
  fontWeight: 500,
  letterSpacing: 0,
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'var(--studio-overlay)',
    backdropFilter: 'blur(12px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    zIndex: 30,
  },
  // Same sheet the wizard hands off from: elevated ground, hairline, one radius.
  modal: {
    width: 'min(1100px, 100%)',
    maxHeight: '100%',
    overflow: 'auto',
    borderRadius: 14,
    background: 'var(--studio-bg-elevated)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    // The old value read `0 40px 80px var(--studio-shadow)`, but the token
    // already carries its own offsets, so the declaration was invalid and the
    // modal had no shadow at all.
    boxShadow: 'var(--studio-shadow)',
    padding: 28,
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
    marginBottom: 22,
  },
  eyebrow: {
    ...eyebrow,
    display: 'block',
    color: 'var(--studio-text-dim)',
    marginBottom: 8,
  },
  title: {
    margin: 0,
    fontFamily: 'var(--studio-display)',
    fontSize: 32,
    fontWeight: 700,
    letterSpacing: '-0.035em',
    lineHeight: 1.05,
    color: 'var(--studio-text)',
  },
  subtitle: {
    margin: '10px 0 0',
    color: 'var(--studio-text-muted)',
    fontSize: 14,
    lineHeight: 1.5,
  },
  statGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: 12,
    marginBottom: 14,
  },
  statCard: {
    padding: '14px 16px',
    borderRadius: 12,
    background: 'var(--studio-bg-muted)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
  },
  statLabel: {
    ...eyebrow,
    display: 'block',
    color: 'var(--studio-text-dim)',
    marginBottom: 8,
  },
  // Counts get size and the display face rather than colour.
  statValue: {
    display: 'block',
    fontFamily: 'var(--studio-display)',
    color: 'var(--studio-text)',
    fontSize: 30,
    fontWeight: 700,
    letterSpacing: '-0.04em',
    lineHeight: 1,
  },
  contentGrid: {
    display: 'grid',
    // auto-fit, so the pair becomes a stack on a phone rather than two columns
    // roughly 130px wide. Every other grid in this sheet already does this.
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: 12,
  },
  sectionCard: {
    padding: '14px 16px 4px',
    borderRadius: 12,
    background: 'var(--studio-bg-muted)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
  },
  // Four coral kickers turned the panel into a stripe of accent; section names
  // are not SoftN, so they get the eyebrow treatment in dim instead.
  sectionKicker: {
    ...eyebrow,
    display: 'block',
    color: 'var(--studio-text-dim)',
    paddingBottom: 10,
    marginBottom: 2,
    borderBottom: '1px solid var(--studio-border)',
  },
  listRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingTop: 11,
    paddingBottom: 11,
    borderBottom: '1px solid var(--studio-border-subtle)',
  },
  rowTitle: {
    color: 'var(--studio-text)',
    fontSize: 14,
    fontWeight: 600,
  },
  rowSub: {
    fontFamily: 'var(--studio-mono)',
    color: 'var(--studio-text-muted)',
    fontSize: 11,
    marginTop: 4,
    lineHeight: 1.4,
    wordBreak: 'break-word',
  },
  rowBadge: {
    ...eyebrow,
    fontSize: 12,
    color: 'var(--studio-text-dim)',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  noteRow: {
    color: 'var(--studio-text)',
    fontSize: 13,
    lineHeight: 1.6,
    paddingTop: 10,
    paddingBottom: 10,
    borderBottom: '1px solid var(--studio-border-subtle)',
  },
  emptyCard: {
    color: 'var(--studio-text-dim)',
    fontSize: 13,
    padding: '10px 0 14px',
  },
  revisionCard: {
    marginTop: 12,
    padding: '14px 16px 16px',
    borderRadius: 12,
    background: 'var(--studio-bg-muted)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
  },
  revisionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  revisionTitle: {
    ...eyebrow,
    color: 'var(--studio-text-dim)',
  },
  revisionRow: {
    display: 'flex',
    gap: 10,
  },
  revisionInput: {
    flex: 1,
    minWidth: 0,
    padding: '11px 14px',
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    background: 'var(--studio-bg)',
    color: 'var(--studio-text)',
    fontSize: 13,
    outline: 'none',
    boxShadow: 'none',
    fontFamily: 'inherit',
    transition: 'border-color 0.12s, box-shadow 0.12s',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 20,
  },
  secondaryButton: {
    padding: '10px 16px',
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    background: 'var(--studio-bg-muted)',
    color: 'var(--studio-text-muted)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    outline: 'none',
    flexShrink: 0,
  },
  primaryButton: {
    padding: '10px 18px',
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-accent)',
    background: 'var(--studio-accent)',
    color: 'var(--studio-bg)',
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: '0.01em',
    cursor: 'pointer',
    fontFamily: 'inherit',
    outline: 'none',
  },
};
