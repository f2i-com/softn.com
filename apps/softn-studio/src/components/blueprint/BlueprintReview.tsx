import React, { useEffect, useState } from 'react';
import { useVFSStore, useWorkspaceStore } from '../../stores';
import { REVISION_NOTE_PREFIX, generateBlueprintFromBrief, generateTaskGraph, isRevisionNote, pageFileCandidates, pageSlugs, revisionNotes, scaffoldProjectFiles } from '../../lib/studioProject';
import { planRequest } from '../../lib/planRequest';
import { restartPreview } from '../../lib/previewRestart';
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

/** A note about how people sign in: by its usual names, where it used to be the word "auth" alone. */
const ABOUT_SIGN_IN = /auth|sign[\s-]?(?:in|up)|log[\s-]?in|password/i;

/** The line a note about sign-in puts among the plan's assumptions, for as long as such a note is there. */
export const SIGN_IN_REVIEW_LINE = 'Review authentication flow requirements before export.';

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
    setBrief,
    setBlueprint,
    setTaskGraph,
    setBlueprintApproved,
    addConsoleOutput,
  } = useWorkspaceStore();
  const [revisionInput, setRevisionInput] = useState('');
  /** What the last line typed under "Revise the plan" did, said under the field. */
  const [said, setSaid] = useState<string | null>(null);
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

  if (!blueprint || !brief) return null;

  const pageFiles = pageSlugs(blueprint.pages).map((slug) => pageFileCandidates(slug)[0]);

  /** The plan with `pages` as its pages: in the brief the build is asked for, and, while the
      project is still the scaffold Generate wrote, in the files as well. */
  const planPages = (pages: string[]) => {
    const nextBrief = { ...brief, pages };
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
      // The app behind this dialog is running the scaffold that was just replaced, and keeps
      // its state across an edit: its nav went on listing the pages it started with.
      restartPreview();
    }
    // The page that was chosen may be one that has just gone.
    const ws = useWorkspaceStore.getState();
    if (!next.pages.some((page) => page.id === ws.activePageId)) ws.setActivePage(next.pages[0]?.id ?? null);
  };

  /**
   * A line that asks for pages ("Add a settings page", "add a page for plants and a page for
   * notes") adds them, and one that asks for pages to go ("Remove the watering page") removes
   * them: in the plan, in the brief the build is asked for, and, while the project is still the
   * scaffold Generate wrote, in the files as well (lib/planRequest.ts reads the line). The first
   * was filed under Risks once, and the second was kept as a note while the plan went on listing
   * the page. Any other line is kept with the assumptions, marked as the person's, and the agent
   * is sent it with the plan (revisionNotes in lib/studioProject.ts, read by agent/prompt.ts).
   * What happened is said under the field: it used to go to the log, which the dialog covers.
   */
  const applyRevisionHint = () => {
    const text = revisionInput.trim();
    if (!text) return;

    const existing = blueprint.pages.map((page) => page.name);
    const request = planRequest(text, existing);
    const all = (names: string[]) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
    const counted = (count: number) => `The plan has ${count} page${count === 1 ? '' : 's'}.`;

    if (request.kind === 'add') {
      const has = request.already.length > 0 ? `The plan already has ${request.already.length === 1 ? 'a page' : 'pages'} called ${all(request.already)}.` : '';
      if (request.names.length === 0) {
        addConsoleOutput(`[Architect] ${has}`);
        setSaid(has);
        setRevisionInput('');
        return;
      }
      planPages([...existing, ...request.names]);
      const added = request.names.length === 1 ? `Added the page ${request.names[0]}.` : `Added ${request.names.length} pages: ${all(request.names)}.`;
      addConsoleOutput(`[Architect] Blueprint revised: ${added}`);
      setSaid([added, has, counted(existing.length + request.names.length)].filter(Boolean).join(' '));
      setRevisionInput('');
      return;
    }

    if (request.kind === 'remove') {
      const left = existing.filter((name) => !request.names.includes(name));
      if (left.length === 0) {
        // The line stays in the field: nothing was done with it.
        setSaid(`A plan needs at least one page, so ${all(request.names)} ${request.names.length === 1 ? 'stays' : 'stay'}. Add the page you want first.`);
        return;
      }
      planPages(left);
      const removed = request.names.length === 1 ? `Removed the page ${request.names[0]}.` : `Removed ${request.names.length} pages: ${all(request.names)}.`;
      addConsoleOutput(`[Architect] Blueprint revised: ${removed}`);
      setSaid(`${removed} ${counted(left.length)}`);
      setRevisionInput('');
      return;
    }

    // Said once: a line is the key of its row, and the same note twice is one instruction.
    const lines = [...(ABOUT_SIGN_IN.test(text) ? [SIGN_IN_REVIEW_LINE] : []), `${REVISION_NOTE_PREFIX}${text}`];
    const next = { ...blueprint, assumptions: [...blueprint.assumptions, ...lines.filter((line) => !blueprint.assumptions.includes(line))] };

    setBlueprint(next);
    addConsoleOutput(`[Architect] Blueprint revised: ${text}`);
    // What a note is, said when one is made: it changes nothing above, and the AI reads it.
    setSaid('Kept as a note. The plan above is as it was: the AI reads your notes when it builds.');
    setRevisionInput('');
  };

  /** Take a note back: one typed wrong, or one the brief now says, stayed on the plan for good. */
  const removeNote = (note: string) => {
    const line = `${REVISION_NOTE_PREFIX}${note}`;
    // The line a note about sign-in brought with it goes when the last such note does. It
    // stayed: a note taken back left "Review authentication flow requirements" on a plan that
    // no longer said anything about signing in.
    const left = revisionNotes(blueprint).filter((other) => other !== note);
    const signInStillNoted = left.some((other) => ABOUT_SIGN_IN.test(other));
    setBlueprint({
      ...blueprint,
      assumptions: blueprint.assumptions.filter((assumption) => assumption !== line && (signInStillNoted || assumption !== SIGN_IN_REVIEW_LINE)),
    });
    addConsoleOutput(`[Architect] Blueprint revised: removed the note “${note}”.`);
    setSaid(null);
    // The button pressed goes with its row, and the focus would fall to the page behind the
    // dialog. It goes to the button beside the field: not the field, which on a phone would
    // bring the keyboard up over the plan.
    document.getElementById('blueprint-revision-apply')?.focus();
  };

  // The person's notes are shown as theirs, where they are typed, and not among the plan's own
  // assumptions, where each read "Revision note: …".
  const notes = revisionNotes(blueprint);
  const assumptions = blueprint.assumptions.filter((line) => !isRevisionNote(line));

  const rule = (isLast: boolean): React.CSSProperties =>
    (isLast ? { borderBottom: 'none', paddingBottom: 0 } : {});

  return (
    <div className="st-plan-overlay" style={styles.overlay}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="blueprint-review-title" tabIndex={-1} style={styles.modal}>
        {/* The plan scrolls; the two actions under it do not. The sheet used to scroll whole with
            Approve as its last line, a screen and a half down on a phone. */}
        <div className="st-plan-body" style={styles.body}>
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

        {/* The plan starts with its pages. Three tiles stood above it, each a count the section
            under it shows by itself (and "Tasks", a count of Studio's own steps, which is nothing
            the person asked for): on a phone they took the first screen. Each section's count is
            beside its name now. The grid is in styles/studio.css (.st-plan-grid). */}
        <div className="st-plan-grid">
          <section style={styles.sectionCard}>
            <div style={styles.sectionHead}>
              <span style={styles.sectionKicker}>Pages</span>
              <strong style={styles.sectionCount}>{blueprint.pages.length}</strong>
            </div>
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
            <div style={styles.sectionHead}>
              <span style={styles.sectionKicker}>Data model</span>
              <strong style={styles.sectionCount}>{blueprint.collections.length}</strong>
            </div>
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
            <div style={styles.sectionHead}>
              <span style={styles.sectionKicker}>Risks</span>
            </div>
            {blueprint.risks.map((risk, index) => (
              <div key={risk} style={{ ...styles.noteRow, ...rule(index === blueprint.risks.length - 1) }}>{risk}</div>
            ))}
          </section>

          <section style={styles.sectionCard}>
            <div style={styles.sectionHead}>
              <span style={styles.sectionKicker}>Assumptions</span>
            </div>
            {assumptions.map((assumption, index) => (
              <div key={assumption} style={{ ...styles.noteRow, ...rule(index === assumptions.length - 1) }}>{assumption}</div>
            ))}
          </section>
        </div>

        <div style={styles.revisionCard}>
          <div style={styles.revisionHeader}>
            <Icon name="edit" size={14} color="var(--studio-accent)" />
            <span id="blueprint-revision-title" style={styles.revisionTitle}>Revise the plan</span>
          </div>
          {/* What a line here does, and what it does not. The field said "note a revision for the
              next pass", and nothing said where a note went; then it said a note was kept, and
              not that a note changes nothing in the plan above it. */}
          <p id="blueprint-revision-hint" style={styles.revisionHint}>
            Ask to add or remove pages and the plan changes at once. Anything else you write is kept as a note: it changes nothing above, and the AI is given your notes with the plan when it builds.
          </p>
          <div style={styles.revisionRow}>
            <input
              id="blueprint-revision-note"
              value={revisionInput}
              onChange={(event) => setRevisionInput(event.target.value)}
              // Not the Enter that confirms an input method's candidate: that added the half-typed note.
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) applyRevisionHint(); }}
              // Short enough to be read whole in a phone's field (about 33 characters at 390px).
              placeholder="Add or remove a page, or a note"
              aria-labelledby="blueprint-revision-title"
              aria-describedby="blueprint-revision-hint"
              style={styles.revisionInput}
            />
            {/* "Apply note" of a line that may add or remove a page instead. */}
            <button
              id="blueprint-revision-apply"
              onClick={applyRevisionHint}
              className="st-plan-tap"
              style={styles.secondaryButton}
              {...hover('var(--studio-bg-muted)', 'var(--studio-surface-hover)')}
            >
              Apply
            </button>
          </div>
          {/* Always in the page, so what it comes to hold is read out. */}
          <p id="blueprint-revision-said" role="status" aria-live="polite" style={said ? styles.revisionSaid : styles.revisionSaidEmpty}>{said}</p>
          {notes.length > 0 && (
            <ul aria-label="Your notes" style={styles.noteList}>
              {notes.map((note) => (
                <li key={note} style={styles.noteItem}>
                  <span style={styles.noteText}>{note}</span>
                  <button
                    type="button"
                    onClick={() => removeNote(note)}
                    aria-label={`Remove the note: ${note}`}
                    className="st-plan-tap"
                    style={styles.noteRemove}
                    {...hover('transparent', 'var(--studio-surface-hover)')}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
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
            className="st-plan-tap"
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
            className="st-plan-tap"
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
    // (Its padding is in styles/studio.css, .st-plan-overlay: less of it on a phone.)
    // Above the product bar (z-index 50), as the AI setup's scrim is. Below it, the bar covered
    // whatever part of the plan reached the top of the window: on a phone, where the plan is
    // taller than the screen, that was its heading.
    zIndex: 100,
  },
  // Same sheet the wizard hands off from: elevated ground, hairline, one radius.
  modal: {
    width: 'min(1240px, 100%)',
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
    // (Its padding is in styles/studio.css, .st-plan-body.)
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
    marginBottom: 14,
  },
  eyebrow: {
    ...eyebrow,
    display: 'block',
    color: 'var(--studio-text-dim)',
    marginBottom: 2,
  },
  // The app's name, at the size of a heading in the editor behind it: it was 32px.
  title: {
    margin: 0,
    fontFamily: 'var(--studio-display)',
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: '-0.03em',
    lineHeight: 1.15,
    color: 'var(--studio-text)',
  },
  subtitle: {
    margin: '6px 0 0',
    color: 'var(--studio-text-muted)',
    fontSize: 13,
    lineHeight: 1.5,
  },
  sectionCard: {
    minWidth: 0,
    padding: '12px 14px 4px',
    borderRadius: 12,
    background: 'var(--studio-bg-muted)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
  },
  // Four coral kickers turned the panel into a stripe of accent; section names
  // are not SoftN, so they get the eyebrow treatment in dim instead.
  sectionHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    paddingBottom: 8,
    marginBottom: 2,
    borderBottom: '1px solid var(--studio-border)',
  },
  sectionKicker: {
    ...eyebrow,
    color: 'var(--studio-text-dim)',
  },
  /** How many pages, how many collections: beside the section's name. */
  sectionCount: {
    ...eyebrow,
    fontFamily: 'var(--studio-mono)',
    fontSize: 12,
    color: 'var(--studio-text)',
  },
  listRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingTop: 8,
    paddingBottom: 8,
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
    lineHeight: 1.5,
    paddingTop: 8,
    paddingBottom: 8,
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
  revisionHint: {
    margin: '0 0 12px',
    color: 'var(--studio-text-muted)',
    fontSize: 13,
    lineHeight: 1.5,
  },
  // The button goes under the field where the two do not fit side by side: on a phone the field
  // was left about 140px, and showed "Add another page," of what it asks for.
  revisionRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
  },
  /** What the last line did: the text's own colour, one step quieter than the plan. */
  revisionSaid: {
    margin: '10px 0 0',
    color: 'var(--studio-text)',
    fontSize: 13,
    lineHeight: 1.5,
  },
  revisionSaidEmpty: {
    margin: 0,
  },
  noteList: {
    listStyle: 'none',
    margin: '12px 0 0',
    padding: 0,
  },
  noteItem: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    padding: '9px 0',
    borderTop: '1px solid var(--studio-border-subtle)',
  },
  noteText: {
    minWidth: 0,
    color: 'var(--studio-text)',
    fontSize: 13,
    lineHeight: 1.6,
    overflowWrap: 'anywhere',
  },
  noteRemove: {
    flexShrink: 0,
    padding: '3px 10px',
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    background: 'transparent',
    color: 'var(--studio-text-muted)',
    fontSize: 12,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  revisionInput: {
    flex: '1 1 220px',
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
    padding: '12px 22px',
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
