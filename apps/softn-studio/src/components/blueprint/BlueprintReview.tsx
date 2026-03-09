import React, { useMemo, useState } from 'react';
import { useWorkspaceStore } from '../../stores';
import { Icon } from '../common/Icon';

interface BlueprintReviewProps {
  onApprove: () => void;
  onReviseBrief?: () => void;
}

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

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        <div style={styles.header}>
          <div>
            <span style={styles.eyebrow}>Blueprint Review</span>
            <h2 style={styles.title}>{blueprint.appName}</h2>
            <p style={styles.subtitle}>Approve the AI plan before you continue deeper into the editor.</p>
          </div>
          <div style={styles.badge}>AI</div>
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
            {blueprint.pages.map((page) => (
              <div key={page.id} style={styles.listRow}>
                <div>
                  <div style={styles.rowTitle}>{page.name}</div>
                  <div style={styles.rowSub}>{page.route || 'No route'} / {page.layout}</div>
                </div>
                <span style={styles.rowBadge}>{page.components.length} comps</span>
              </div>
            ))}
          </section>

          <section style={styles.sectionCard}>
            <span style={styles.sectionKicker}>Data model</span>
            {blueprint.collections.length > 0 ? blueprint.collections.map((collection) => (
              <div key={collection.id} style={styles.listRow}>
                <div>
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
            {blueprint.risks.map((risk) => <div key={risk} style={styles.noteRow}>{risk}</div>)}
          </section>

          <section style={styles.sectionCard}>
            <span style={styles.sectionKicker}>Assumptions</span>
            {blueprint.assumptions.map((assumption) => <div key={assumption} style={styles.noteRow}>{assumption}</div>)}
          </section>
        </div>

        <div style={styles.revisionCard}>
          <div style={styles.revisionHeader}>
            <Icon name="edit" size={15} color="var(--studio-accent)" />
            <span style={styles.revisionTitle}>Revise the plan</span>
          </div>
          <div style={styles.revisionRow}>
            <input
              value={revisionInput}
              onChange={(event) => setRevisionInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') applyRevisionHint(); }}
              placeholder="Add another page, tighten auth, or note a revision for the next pass..."
              style={styles.revisionInput}
            />
            <button onClick={applyRevisionHint} style={styles.secondaryButton}>Apply note</button>
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
            Approve blueprint
          </button>
        </div>
      </div>
    </div>
  );
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
  modal: {
    width: 'min(1100px, 100%)',
    maxHeight: '100%',
    overflow: 'auto',
    borderRadius: 28,
    background: 'var(--studio-bg-elevated)',
    border: '1px solid var(--studio-border)',
    boxShadow: '0 40px 80px var(--studio-shadow)',
    padding: 24,
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
    marginBottom: 18,
  },
  eyebrow: {
    display: 'block',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.14em',
    textTransform: 'uppercase' as const,
    color: 'var(--studio-accent)',
    marginBottom: 8,
  },
  title: {
    margin: 0,
    fontSize: 30,
    color: 'var(--studio-text)',
  },
  subtitle: {
    margin: '8px 0 0',
    color: 'var(--studio-text-muted)',
    fontSize: 14,
  },
  badge: {
    padding: '8px 12px',
    borderRadius: 999,
    background: 'var(--studio-accent-soft)',
    color: 'var(--studio-accent)',
    fontSize: 11,
    fontWeight: 700,
    whiteSpace: 'nowrap' as const,
  },
  statGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: 12,
    marginBottom: 18,
  },
  statCard: {
    padding: 16,
    borderRadius: 18,
    background: 'var(--studio-inset)',
    border: '1px solid var(--studio-border)',
  },
  statLabel: {
    display: 'block',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: 'var(--studio-text-muted)',
    marginBottom: 10,
  },
  statValue: {
    color: 'var(--studio-text)',
    fontSize: 28,
  },
  contentGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 14,
  },
  sectionCard: {
    padding: 16,
    borderRadius: 18,
    background: 'var(--studio-inset)',
    border: '1px solid var(--studio-border)',
  },
  sectionKicker: {
    display: 'block',
    fontSize: 10,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.1em',
    color: 'var(--studio-accent)',
    fontWeight: 700,
    marginBottom: 12,
  },
  listRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '10px 0',
    borderBottom: '1px solid var(--studio-border)',
  },
  rowTitle: {
    color: 'var(--studio-text)',
    fontSize: 14,
    fontWeight: 700,
  },
  rowSub: {
    color: 'var(--studio-text-muted)',
    fontSize: 12,
    marginTop: 4,
  },
  rowBadge: {
    padding: '5px 8px',
    borderRadius: 999,
    background: 'var(--studio-accent-soft)',
    color: 'var(--studio-accent)',
    fontSize: 10,
    fontWeight: 700,
  },
  noteRow: {
    color: 'var(--studio-text)',
    fontSize: 13,
    lineHeight: 1.6,
    padding: '8px 0',
    borderBottom: '1px solid var(--studio-border)',
  },
  emptyCard: {
    color: 'var(--studio-text-muted)',
    fontSize: 13,
    padding: '8px 0',
  },
  revisionCard: {
    marginTop: 16,
    padding: 16,
    borderRadius: 18,
    background: 'var(--studio-bg)',
    border: '1px solid var(--studio-border)',
  },
  revisionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  revisionTitle: {
    color: 'var(--studio-text)',
    fontSize: 13,
    fontWeight: 700,
  },
  revisionRow: {
    display: 'flex',
    gap: 10,
  },
  revisionInput: {
    flex: 1,
    padding: '12px 14px',
    borderRadius: 14,
    border: '1px solid var(--studio-border)',
    background: 'var(--studio-surface)',
    color: 'var(--studio-text)',
    fontSize: 13,
    outline: 'none',
    fontFamily: 'inherit',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 20,
  },
  secondaryButton: {
    padding: '10px 14px',
    borderRadius: 12,
    border: '1px solid var(--studio-border)',
    background: 'var(--studio-surface)',
    color: 'var(--studio-text-muted)',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  primaryButton: {
    padding: '10px 16px',
    borderRadius: 12,
    border: 'none',
    background: 'linear-gradient(135deg, #0ea5e9, #2563eb)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
