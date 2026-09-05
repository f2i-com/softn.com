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
  }
  .softn-frame-home svg {
    /* The mark is never the thing that gives way when the bar is crowded. */
    flex-shrink: 0;
    background: transparent;
    color: var(--paper);
    font: inherit;
    font-weight: 500;
    cursor: pointer;
    min-width: 0;
    transition: background 160ms var(--ease);
  }
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
  .softn-frame-menu-sep { height: 1px; background: var(--line-soft); margin: 4px 6px; }

  @media (max-width: 640px) {
    .softn-frame-bar { padding: 0.3rem var(--gutter); gap: 0.4rem; }
    .softn-frame-btn { padding: 0.35rem 0.5rem; }
    .softn-frame-hide-label, .softn-frame-home small { display: none; }
  }
  @media (pointer: coarse) {
    .softn-frame-btn, .softn-frame-menu-btn, .softn-frame-home { min-height: 36px; }
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const slug = tab.directorySlug ? encodeURIComponent(tab.directorySlug) : null;
  const bundle = slug ? `/api/apps/${slug}/bundle.softn` : null;
  const share = slug ? `${window.location.origin}/app/${slug}` : null;

  const copy = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        setOpen(false);
      }, 900);
    } catch {
      setOpen(false);
    }
  };

  return (
    <div className="softn-frame-menu" ref={ref}>
      <button
        className="softn-frame-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More for ${tab.name}`}
        title={`More for ${tab.name}`}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div className="softn-frame-menu-list" role="menu">
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
            </>
          ) : (
            <div className="softn-frame-menu-note">
              This app was opened from a file. <a href="/publish">Publish it</a> to share it, remix it or edit it
              online.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FrameBar({ tab, onHome, onClose, onHide, fullscreenTarget, onDownload }: FrameBarProps): React.ReactElement {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === fullscreenTarget.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, [fullscreenTarget]);

  const toggleFullscreen = useCallback(() => {
    const el = fullscreenTarget.current;
    if (!el) return;
    if (document.fullscreenElement !== el) void el.requestFullscreen?.();
    else void document.exitFullscreen?.();
  }, [fullscreenTarget]);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: frameBarStyles }} />
      <div className="softn-frame-bar">
        <div className="softn-frame-left">
          <button type="button" className="softn-frame-home" onClick={onHome} title="Back to the runtime. The app keeps running.">
            <Mark size={22} radius={6} title="SoftN" />
            <small>runtime</small>
          </button>
          <span className="softn-frame-sep" aria-hidden="true">/</span>
          <span className="softn-frame-name">
            {tab.icon ? (
              <img src={tab.icon} alt="" className="softn-frame-icon" />
            ) : (
              <span className="softn-frame-icon-letter" aria-hidden="true">{tab.name.charAt(0).toUpperCase()}</span>
            )}
            {tab.name}
          </span>
        </div>
        <span className="softn-frame-actions">
          <AppMenu tab={tab} onDownload={onDownload} />
          <button type="button" className="softn-frame-btn" onClick={onHide} title="Hide this bar and give the app the whole screen">
            Hide <span className="softn-frame-hide-label">bar</span>
          </button>
          <button type="button" className="softn-frame-btn" onClick={toggleFullscreen}>
            {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </button>
          <button type="button" className="softn-frame-btn softn-frame-close" onClick={onClose} aria-label="Stop the app and go back to the runtime">
            Close
          </button>
        </span>
      </div>
    </>
  );
}
