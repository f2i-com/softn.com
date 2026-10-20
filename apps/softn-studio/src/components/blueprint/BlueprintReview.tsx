import React, { useEffect, useMemo, useState } from 'react';
import { useVFSStore, useWorkspaceStore } from '../../stores';
import { generateBlueprintFromBrief, generateTaskGraph, pageFileCandidates, pageSlugs, scaffoldProjectFiles } from '../../lib/studioProject';
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

/** Words that say "a page" rather than name one: "add another page", "add a new page". */
const UNNAMED = /^(?:a|an|another|one|one more|more|new|extra|second|third|other)$/i;

/**
 * The page a note asks to add, or null when it asks for something else: "Add a settings page"
 * is Settings, "add a page called Team stats" is Team Stats, and "add another page", which names
 * none, is the next numbered page. `count` is how many pages the plan has.
 */
function requestedPageName(note: string, count: number): string | null {
  const text = note.trim().replace(/[.!]+$/, '');
  const titled = (raw: string): string | null => {
    const name = raw.replace(/^["'“‘]|["'”’]$/g, '').replace(/[^\p{L}\p{N}\s&'-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name || UNNAMED.test(name)) return null;
    return name.split(' ').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  };
  // "add a page called X", "add a screen named X", "add a page for X"
  const called = /^(?:please\s+)?(?:add|include|create|make)\s+(?:a|an|another|one more|a new)?\s*(?:page|screen|view)\s+(?:called|named|for|titled)\s+(.+)$/i.exec(text);
  if (called) return titled(called[1]) ?? `Page ${count + 1}`;
  // "add a settings page", "add another page", "add an about screen"
  const before = /^(?:please\s+)?(?:add|include|create|make)\s+(?:(?:a|an|another|one more|a new|new)\s+)?(.*?)\s*(?:page|screen|view)$/i.exec(text);
  if (before) return titled(before[1]) ?? `Page ${count + 1}`;
  return null;
}

/**
 * Where the keyboard goes when the plan is approved: to the AI's message box, where the run the
 * approval started is followed and the next request is typed, or else to the editor's main area
 * (App.tsx's `#studio-main`). Only when the focus is nowhere: the brief, sent back for revision,
 * takes it itself.
 */
function focusEditorIfLost(): void {
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  const composer = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message to AI"]');
  if (composer && !composer.disabled && composer.getClientRects().length > 0) {
    composer.focus();
    return;
  }
  document.getElementById('studio-main')?.focus();
}

export const BlueprintReview: React.FC<BlueprintReviewProps> = ({ onApprove, onReviseBrief }) => {
  const {
    blueprint,
    brief,
    taskGraph,
    setBrief,
    setBlueprint,
    setTaskGraph,
    setBlueprintApproved,
    addConsoleOutput,
  } = useWorkspaceStore();
  const [revisionInput, setRevisionInput] = useState('');
  // With the AI ready, approving hands the plan to the agent to build.
  const aiReady = useAIReadiness().state === 'ready';
  // A modal over the editor: keyboard stays inside; Escape is "Revise brief"
  // where that is offered (the only way out that is not approval).
  // It opens on its title. The first control is the note field at the foot of the plan, and
  // the focus went there: on a phone the dialog opened scrolled to its end with the keyboard
  // up, and the plan it was showing out of sight above.
  const dialogRef = useModalFocus(true, onReviseBrief ?? noop, '#blueprint-review-title');
  // The dialog gives the focus back to what opened it, and what opened it is the wizard's
  // Generate, which has gone by then: the focus fell to the page. Once the dialog has gone, a
  // focus that is nowhere goes to the editor (the hook is shared with Builder, so this is said here).
  useEffect(() => () => {
    setTimeout(focusEditorIfLost, 0);
  }, []);

  const summaryStats = useMemo(() => {
    if (!blueprint) return [];
    return [
      { label: 'Pages', value: blueprint.pages.length },
      { label: 'Collections', value: blueprint.collections.length },
      { label: 'Tasks', value: taskGraph.length },
    ];
  }, [blueprint, taskGraph.length]);

  if (!blueprint || !brief) return null;

  const pageFiles = pageSlugs(blueprint.pages).map((slug) => pageFileCandidates(slug)[0]);

  /**
   * A note that asks for a page ("Add a settings page", "add another page") adds it: to the
   * plan, to the brief the build is asked for, and, while the project is still the scaffold
   * Generate wrote, to the files as well. It was filed under Risks as "User requested
   * revision", and the plan still said one page. Any other note is kept with the assumptions,
   * for the build to read.
   */
  const applyRevisionHint = () => {
    const text = revisionInput.trim();
    if (!text) return;

    const existing = blueprint.pages.map((page) => page.name);
    const requested = requestedPageName(text, existing.length);
    if (requested && existing.some((name) => name.toLowerCase() === requested.toLowerCase())) {
      addConsoleOutput(`[Architect] The plan already has a page called ${requested}.`);
      setRevisionInput('');
      return;
    }
    if (requested) {
      const nextBrief = { ...brief, pages: [...existing, requested] };
      const planned = generateBlueprintFromBrief(nextBrief);
      const next = { ...blueprint, pages: planned.pages, navigation: planned.navigation };
      const vfs = useVFSStore.getState();
      // Written again only while every file is the one Generate wrote (builder/ holds Studio's
      // notes, which change with each note): anything else is the person's or the AI's work.
      const scaffold = scaffoldProjectFiles(brief, blueprint).filter((file) => !file.path.startsWith('builder/'));
      const current = [...vfs.files.keys()].filter((path) => !path.startsWith('builder/'));
      const pristine = scaffold.length === current.length && scaffold.every((file) => vfs.readFile(file.path) === file.content);
      setBrief(nextBrief);
      setBlueprint(next);
      setTaskGraph(generateTaskGraph(next));
      if (pristine) {
        vfs.reset();
        vfs.hydrateFiles(scaffoldProjectFiles(nextBrief, next));
      }
      addConsoleOutput(`[Architect] Blueprint revised: added the page ${requested}.`);
      setRevisionInput('');
      return;
    }

    const next = { ...blueprint };
    if (/auth/i.test(text)) {
      next.assumptions = [...next.assumptions, 'Review authentication flow requirements before export.'];
    }
    next.assumptions = [...next.assumptions, `Revision note: ${text}`];

    setBlueprint(next);
    addConsoleOutput(`[Architect] Blueprint revised: ${text}`);
    setRevisionInput('');
  };

  const rule = (isLast: boolean): React.CSSProperties =>
    (isLast ? { borderBottom: 'none', paddingBottom: 0 } : {});

  return (
    <div style={styles.overlay}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="blueprint-review-title" tabIndex={-1} style={styles.modal}>
        {/* The plan scrolls; the two actions under it do not. The sheet used to scroll whole with
            Approve as its last line, a screen and a half down on a phone. */}
        <div style={styles.body}>
        <div style={styles.header}>
          <div>
            <span style={styles.eyebrow}>Review the plan</span>
            {/* Where the dialog opens, and not one of its controls: stepping back from it goes to
                the last control, as it does from the first, where the browser would have gone
                out to the page behind the dialog. */}
            <h2
              id="blueprint-review-title"
              tabIndex={-1}
              style={{ ...styles.title, outline: 'none' }}
              onKeyDown={(event) => {
                if (event.key !== 'Tab' || !event.shiftKey) return;
                const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]');
                const last = controls?.[controls.length - 1];
                if (!last) return;
                event.preventDefault();
                last.focus();
              }}
            >
              {blueprint.appName}
            </h2>
            {/* Whose plan it is. It was "the AI plan", of pages Studio lays out from the brief
                before any AI has run. */}
            <p style={styles.subtitle}>
              Studio laid out from your brief what the app will hold. {aiReady ? 'Approve it and the AI builds it' : 'Approve it to open the editor'}, or change it first.
            </p>
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
                  {/* The file the page is written to and how it is laid out. This read "/ / responsive-shell":
                      the first page's route, then the layout's identifier, with a slash between that looked
                      like a third path. */}
                  <div style={styles.rowSub}>{pageFiles[index]} · {page.layout.replace(/[-_]+/g, ' ')} layout</div>
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
              // Not the Enter that confirms an input method's candidate: that added the half-typed note.
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) applyRevisionHint(); }}
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
    // Above the product bar (z-index 50), as the AI setup's scrim is. Below it, the bar covered
    // whatever part of the plan reached the top of the window: on a phone, where the plan is
    // taller than the screen, that was its heading.
    zIndex: 100,
  },
  // Same sheet the wizard hands off from: elevated ground, hairline, one radius.
  modal: {
    width: 'min(1100px, 100%)',
    maxHeight: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: 14,
    background: 'var(--studio-bg-elevated)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    // The old value read `0 40px 80px var(--studio-shadow)`, but the token
    // already carries its own offsets, so the declaration was invalid and the
    // modal had no shadow at all.
    boxShadow: 'var(--studio-shadow)',
  },
  /** The plan itself: the only part of the sheet that scrolls. */
  body: {
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    padding: '28px 28px 20px',
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
    // Three counts side by side at any width: at 140 each they stacked on a phone and took
    // half the screen before the plan began.
    gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))',
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
  /** Under the plan, always in the window: what the dialog is for. */
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 10,
    flexShrink: 0,
    padding: '14px 28px',
    borderTop: '1px solid var(--studio-border)',
    background: 'var(--studio-bg-elevated)',
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
