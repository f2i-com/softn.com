import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../common/Icon';
import { HandoffReady } from '../common/HandoffReady';
import { ProjectActionError } from '../common/ProjectActionError';
import { SaveStatusIndicator } from '../common/SaveStatus';
import { useProjectActions } from '../common/ProjectActions';

/**
 * The project's actions on a phone.
 *
 * The mobile editor draws its own header and never rendered the desktop
 * TopBar, so on a phone there was no Run, no Publish and — the one that
 * matters when storage fails — no Export. The bundle could be built and
 * previewed and could not leave the device. This is the same three actions
 * from the same hook the desktop bar uses, folded into one button, with
 * the save status and a file/problem count in the same place, so the
 * person can see the state of the project before choosing.
 *
 * It is a menu in the ARIA sense: the trigger says it opens one, the items
 * are `menuitem`s, arrow keys move between them, Escape closes and puts
 * focus back on the trigger, and a tap outside closes. Run and Publish are
 * marked `aria-disabled` rather than `disabled` while the validator holds a
 * refusal, so they stay in the tab order and can say why. Export is never
 * disabled while there are files: it is the way out.
 */
export function MobileProjectMenu(): React.ReactElement {
  const actions = useProjectActions();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Focus the first item once the menu is up, so a keyboard or screen-reader
  // user is inside it after opening.
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next].focus();
  };

  const item = (label: string, icon: 'play' | 'upload' | 'export', enabled: boolean, title: string, onSelect: () => void) => (
    <button
      type="button"
      role="menuitem"
      aria-disabled={enabled ? undefined : true}
      title={title}
      onClick={() => {
        if (!enabled) return;
        close(true);
        onSelect();
      }}
      style={{ ...styles.item, opacity: enabled ? 1 : 0.45, cursor: enabled ? 'pointer' : 'not-allowed' }}
    >
      <Icon name={icon} size={16} />
      <span style={styles.itemLabel}>{label}</span>
      <span style={styles.itemHint}>{enabled ? '' : title}</span>
    </button>
  );

  return (
    <div style={styles.wrap}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Project actions"
        title="Project actions: Run, Publish, Export bundle"
        onClick={() => (open ? close(false) : setOpen(true))}
        style={styles.trigger}
      >
        <Icon name="menu" size={18} />
      </button>
      {open && (
        <div ref={menuRef} id={menuId} role="menu" aria-label="Project actions" onKeyDown={onMenuKeyDown} style={styles.menu}>
          <div style={styles.summary}>
            <SaveStatusIndicator compact />
            <span style={styles.counts}>
              {actions.fileCount} file{actions.fileCount === 1 ? '' : 's'} · {actions.problemCount} problem{actions.problemCount === 1 ? '' : 's'}
            </span>
          </div>
          {item('Run', 'play', actions.canRun, actions.describe('runtime', 'Stage the bundle for the SoftN runtime'), actions.run)}
          {item('Publish', 'upload', actions.canPublish, actions.describe('publish', 'Stage the bundle for the directory’s publish page'), actions.publish)}
          {item('Export bundle', 'export', actions.canExport, actions.canExport ? 'Download the project as a .softn file' : 'No files to export', actions.exportBundle)}
        </div>
      )}
      {(actions.ready || actions.error) && (
        <div style={styles.readyDock}>
          {actions.error ? <ProjectActionError message={actions.error} onDismiss={actions.dismissError} />
            : actions.ready && <HandoffReady ready={actions.ready} onDone={actions.dismissReady} compact />}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
  },
  trigger: {
    width: 36,
    height: 36,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid var(--studio-border)',
    background: 'var(--studio-panel)',
    color: 'var(--studio-text)',
    borderRadius: 10,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  menu: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: 6,
    zIndex: 30,
    minWidth: 240,
    maxWidth: 'calc(100vw - 24px)',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: 8,
    borderRadius: 12,
    border: '1px solid var(--studio-border)',
    background: 'var(--studio-panel-strong)',
    boxShadow: 'var(--studio-shadow)',
  },
  summary: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '4px 6px 8px',
    borderBottom: '1px solid var(--studio-border-subtle)',
    marginBottom: 4,
  },
  counts: {
    fontFamily: 'var(--studio-mono)',
    fontSize: 11,
    color: 'var(--studio-text-muted)',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    minHeight: 44,
    padding: '8px 10px',
    borderRadius: 8,
    border: 'none',
    background: 'transparent',
    color: 'var(--studio-text)',
    fontSize: 14,
    fontWeight: 600,
    fontFamily: 'inherit',
    textAlign: 'left',
  },
  itemLabel: {
    flexShrink: 0,
  },
  itemHint: {
    fontSize: 11,
    fontWeight: 400,
    color: 'var(--studio-text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  readyDock: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: 6,
    zIndex: 25,
    width: 'calc(100vw - 24px)',
    maxWidth: 420,
  },
};
