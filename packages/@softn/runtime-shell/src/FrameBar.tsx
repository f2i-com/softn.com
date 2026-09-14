import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mark } from '@softn/brand';

export interface TabInfo {
  id: string;
  name: string;
  icon?: string;
  /** The app's slug in the site's directory, when it was opened from there. */
  directorySlug?: string;
}

interface FrameBarProps {
  tab: TabInfo;
  /** Back to the runtime's home. The app keeps running behind it. */
  onHome: () => void;
  /** Stop the app and go home. */
  onClose: () => void;
  /** Fold the bar away so the app has the whole viewport. */
  onHide: () => void;
  /** The element to put into fullscreen: the shell, bar and app together. */
  fullscreenTarget: React.RefObject<HTMLElement>;
  /** Hands the running app's bundle back as a file. */
  onDownload?: (id: string) => void;
  /**
   * What Home is called and does. The runtime's bar goes back to the runtime
   * with the app still running; the site's play page has no runtime behind
   * it, so its Home is the directory and Close leaves for the app's page.
   */
  homeLabel?: string;
  homeTitle?: string;
  closeTitle?: string;
}

/*
 * The slim bar over a running app — the same one the site draws over an app
 * playing from its directory page, so an app looks the same wherever it was
 * opened from. It names the app, offers the way home and the way out, and
 * folds to a corner tab when the app wants every pixel. Drawn from the shared
 * tokens; nothing in it is coloured except the one button that stops the app.
 */
const frameBarStyles = `
  .softn-frame-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    /* The product bar's height and inset, so the mark stays where it was
       when the app opened: same size, same spot, only the bar around it
       changes. */
    min-height: 3rem;
    padding: 0.35rem var(--gutter);
    background: var(--ink-2);
    border-bottom: 1px solid var(--line-soft);
    font-family: var(--body);
    font-size: 0.8rem;
    color: var(--dim);
    user-select: none;
  }
  .softn-frame-home {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem 0.25rem 0.3rem;
    margin-left: -0.3rem;
    border: none;
    border-radius: 7px;
    flex-shrink: 0;
    background: transparent;
    color: var(--paper);
    font: inherit;
    font-weight: 500;
    cursor: pointer;
    min-width: 0;
    transition: background 160ms var(--ease);
  }
  .softn-frame-home svg { flex-shrink: 0; }
  .softn-frame-home:hover { background: var(--ink-3); }
  .softn-frame-home:focus-visible { outline: 2px solid var(--mint); outline-offset: 2px; }
  .softn-frame-home small {
    font-family: var(--mono);
    font-size: 0.7rem;
    color: var(--dimmer);
    font-weight: 400;
  }
  .softn-frame-name {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    color: var(--paper);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .softn-frame-name-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .softn-frame-icon {
    width: 18px; height: 18px;
    border-radius: 5px;
    flex-shrink: 0;
    object-fit: cover;
  }
  .softn-frame-icon-letter {
    width: 18px; height: 18px;
    border-radius: 5px;
    background: var(--ink-3);
    border: 1px solid var(--line);
    display: inline-flex; align-items: center; justify-content: center;
    font-family: var(--display);
    font-size: 0.65rem; font-weight: 700; color: var(--paper);
    flex-shrink: 0;
  }
  .softn-frame-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .softn-frame-sep { color: var(--line-strong); }
  .softn-frame-actions {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex-shrink: 0;
  }
  .softn-frame-btn {
    font-family: var(--mono);
    font-size: 0.72rem;
    color: var(--dim);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 0.35rem 0.65rem;
    cursor: pointer;
    white-space: nowrap;
    transition: color 160ms var(--ease), border-color 160ms var(--ease);
  }
  .softn-frame-btn:hover { color: var(--paper); border-color: var(--dimmer); }
  .softn-frame-btn:focus-visible { outline: 2px solid var(--mint); outline-offset: 2px; }
  .softn-frame-close { border-color: var(--coral); color: var(--coral); }
  .softn-frame-close:hover { color: var(--paper); border-color: var(--coral); background: var(--coral-glow); }
  .softn-frame-menu { position: relative; display: flex; align-items: center; }
  .softn-frame-menu-btn {
    width: 32px; height: 30px;
    display: flex; align-items: center; justify-content: center;
    background: transparent; border: 1px solid var(--line); border-radius: 7px;
    color: var(--dim); font: inherit; font-size: 1rem; letter-spacing: 0.08em; cursor: pointer;
  }
  .softn-frame-menu-btn:hover, .softn-frame-menu-btn[aria-expanded="true"] { color: var(--paper); border-color: var(--dimmer); }
  .softn-frame-menu-btn:focus-visible, .softn-frame-menu-item:focus-visible { outline: 2px solid var(--mint); outline-offset: -2px; }
  .softn-frame-menu-list {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 240px;
    max-width: min(320px, calc(100vw - 16px));
    background: var(--ink-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 4px;
    box-shadow: var(--shadow);
    z-index: 60;
    display: flex;
    flex-direction: column;
  }
  .softn-frame-menu-item {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 10px; border-radius: 6px;
    color: var(--paper); font: inherit; font-size: 0.8rem; text-align: left;
    background: transparent; border: none; cursor: pointer; text-decoration: none;
    white-space: normal; line-height: 1.35;
  }
  .softn-frame-menu-item:hover { background: var(--ink-3); }
  .softn-frame-menu-note { color: var(--dim); font-size: 0.75rem; padding: 6px 10px 8px; line-height: 1.4; }
  .softn-frame-menu-note a { color: var(--paper); text-decoration: underline; text-underline-offset: 2px; }
  .softn-frame-menu-note input { width: 100%; margin-top: 6px; padding: 6px; border: 1px solid var(--line); border-radius: 5px; color: var(--paper); background: var(--ink); font: inherit; }
  .softn-frame-menu-sep { height: 1px; background: var(--line-soft); margin: 4px 6px; }
  .softn-frame-mobile-icon { display: none; }

  @media (max-width: 640px) {
    .softn-frame-bar { padding: 0.3rem var(--gutter); gap: 0.4rem; }
    .softn-frame-btn { padding: 0.35rem 0.5rem; }
    .softn-frame-hide-label, .softn-frame-home small { display: none; }
  }
  @media (pointer: coarse) {
    .softn-frame-btn, .softn-frame-menu-btn, .softn-frame-home { min-height: 40px; min-width: 40px; }
    .softn-frame-menu-item { min-height: 44px; }
  }
  @media (max-width: 480px) {
    .softn-frame-bar { padding: 0.2rem 0.65rem; }
    .softn-frame-btn { min-width: 36px; min-height: 36px; display: inline-flex; align-items: center; justify-content: center; }
    .softn-frame-mobile-label { display: none; }
    .softn-frame-mobile-icon { display: inline-flex; }
    .softn-frame-actions { gap: 0.25rem; }
  }
`;

/**
 * What can be done with the running app beyond running it: take its bundle
 * away as a file — the exact bytes that were opened — and, for an app that
 * came from the site's directory, go to its page, open it in Studio or
 * Builder, or copy the link that opens it anywhere.
 */
function AppMenu({ tab, onDownload }: { tab: TabInfo; onDownload?: (id: string) => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyAttempt = useRef(0);

  useEffect(() => () => {
    copyAttempt.current++;
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  useEffect(() => {
    if (!open) {
      copyAttempt.current++;
      if (copyTimer.current) clearTimeout(copyTimer.current);
      setCopied(false);
      setCopyFailed(false);
      return undefined;
    }
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDoc = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('focusin', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('focusin', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const slug = tab.directorySlug ? encodeURIComponent(tab.directorySlug) : null;
  const bundle = slug ? `/api/apps/${slug}/bundle.softn` : null;
  const share = slug ? `${window.location.origin}/app/${slug}` : null;

  const copy = async () => {
    if (!share) return;
    const attempt = ++copyAttempt.current;
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(share);
      if (attempt !== copyAttempt.current) return;
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => {
        setCopied(false);
        setOpen(false);
        triggerRef.current?.focus();
      }, 900);
    } catch {
      if (attempt === copyAttempt.current) setCopyFailed(true);
    }
  };

  const navigateMenu = (event: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
    items[next].focus();
  };

  return (
    <div className="softn-frame-menu" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="softn-frame-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More for ${tab.name}`}
        title={`More for ${tab.name}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        ⋯
      </button>
      {open && (
        <div className="softn-frame-menu-list" role="menu" aria-label={`Actions for ${tab.name}`} onKeyDown={navigateMenu}>
          {onDownload && (
            <button
              role="menuitem"
              className="softn-frame-menu-item"
              onClick={() => {
                onDownload(tab.id);
                setOpen(false);
              }}
            >
              Download {tab.directorySlug || tab.name}.softn
            </button>
          )}
          {slug ? (
            <>
              <div className="softn-frame-menu-sep" />
              <a role="menuitem" className="softn-frame-menu-item" href={`/app/${slug}`}>
                App page: comments, ratings, source
              </a>
              <a role="menuitem" className="softn-frame-menu-item" href={`/studio/?open=${encodeURIComponent(bundle!)}`}>
                Edit in Studio
              </a>
              <a role="menuitem" className="softn-frame-menu-item" href={`/builder/?open=${encodeURIComponent(bundle!)}`}>
                Edit in Builder
              </a>
              <a role="menuitem" className="softn-frame-menu-item" href={`/publish?remix=${slug}`}>
                Publish a remix
              </a>
              <button role="menuitem" className="softn-frame-menu-item" onClick={copy}>
                {copied ? 'Copied' : 'Copy share link'}
              </button>
              {copyFailed && <div className="softn-frame-menu-note" role="status">Could not copy automatically. Select and copy this link:
                <input aria-label="Share link" readOnly value={share ?? ''} onFocus={(event) => event.currentTarget.select()} />
              </div>}
            </>
          ) : (
            <div className="softn-frame-menu-note">
              This app was opened from a file. <a href="/publish" role="menuitem">Publish it</a> to share it, remix it or edit it
              online.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FrameBar({
  tab,
  onHome,
  onClose,
  onHide,
  fullscreenTarget,
  onDownload,
  homeLabel = 'runtime',
  homeTitle = 'Back to the runtime. The app keeps running.',
  closeTitle = 'Stop the app and go back to the runtime',
}: FrameBarProps): React.ReactElement {
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === fullscreenTarget.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, [fullscreenTarget]);

  const toggleFullscreen = useCallback(async () => {
    const el = fullscreenTarget.current;
    if (!el) return;
    setFullscreenError(null);
    try {
      if (document.fullscreenElement !== el) {
        if (!el.requestFullscreen) throw new Error('Fullscreen is unavailable');
        await el.requestFullscreen();
      } else await document.exitFullscreen?.();
    } catch {
      setFullscreenError('Fullscreen is unavailable. Hide the bar for more room.');
    }
  }, [fullscreenTarget]);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: frameBarStyles }} />
      <div className="softn-frame-bar">
        <div className="softn-frame-left">
          <button type="button" className="softn-frame-home" onClick={onHome} title={homeTitle} aria-label={homeTitle}>
            <Mark size={22} radius={6} title="SoftN" />
            <small>{homeLabel}</small>
          </button>
          <span className="softn-frame-sep" aria-hidden="true">/</span>
          <span className="softn-frame-name">
            {tab.icon ? (
              <img src={tab.icon} alt="" className="softn-frame-icon" />
            ) : (
              <span className="softn-frame-icon-letter" aria-hidden="true">{tab.name.charAt(0).toUpperCase()}</span>
            )}
            <span className="softn-frame-name-label" title={tab.name}>{tab.name}</span>
          </span>
        </div>
        <span className="softn-frame-actions">
          <AppMenu key={tab.id} tab={tab} onDownload={onDownload} />
          <button type="button" className="softn-frame-btn" onClick={onHide} aria-label="Hide the app bar" title="Hide this bar and give the app the whole screen">
            <span className="softn-frame-mobile-label">Hide <span className="softn-frame-hide-label">bar</span></span><span className="softn-frame-mobile-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m6 15 6-6 6 6" /></svg></span>
          </button>
          <button type="button" className="softn-frame-btn" onClick={() => { void toggleFullscreen(); }} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
            <span className="softn-frame-mobile-label">{fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</span><span className="softn-frame-mobile-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d={fullscreen ? 'M9 3v6H3m12-6v6h6M3 15h6v6m12-6h-6v6' : 'M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6'} /></svg></span>
          </button>
          <button type="button" className="softn-frame-btn softn-frame-close" onClick={onClose} aria-label={closeTitle} title={closeTitle}>
            <span className="softn-frame-mobile-label">Close</span><span className="softn-frame-mobile-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m6 6 12 12M6 18 18 6" /></svg></span>
          </button>
        </span>
      </div>
      {fullscreenError && <div className="softn-frame-menu-note" role="status" style={{ position: 'absolute', top: '3rem', right: '0.75rem', maxWidth: 'min(320px, calc(100vw - 24px))', zIndex: 60, background: 'var(--ink-2)', border: '1px solid var(--line)', borderRadius: '8px' }}>
        {fullscreenError} <button type="button" className="softn-frame-btn" onClick={() => setFullscreenError(null)} aria-label="Dismiss fullscreen message">×</button>
      </div>}
    </>
  );
}
