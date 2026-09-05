import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mark } from '@softn/brand';

export interface TabInfo {
  id: string;
  name: string;
  icon?: string;
  /** The app's slug in the site's directory, when it was opened from there. */
  directorySlug?: string;
}

interface TabBarProps {
  tabs: TabInfo[];
  activeTabId: string | null; // null = Home
  onSelectTab: (id: string | null) => void;
  onCloseTab: (id: string) => void;
  onAddTab: () => void;
  /** Hands the running app's bundle back as a file. */
  onDownloadTab?: (id: string) => void;
  /** Folds the bar away so the app has the whole viewport. */
  onHide?: () => void;
}

/*
 * The tab strip, drawn from the shared tokens so it is the same chrome as the
 * product bar above it in both themes. A running app's tab is marked in mint
 * — the machine's colour, because behind that tab something is executing —
 * and nothing else in the strip is coloured.
 */
const tabBarStyles = `
  @keyframes softn-tab-slide-in {
    from { opacity: 0; transform: translateX(-8px); }
    to { opacity: 1; transform: translateX(0); }
  }
  .softn-tab-bar {
    height: 38px;
    background: var(--ink-2);
    border-bottom: 1px solid var(--line-soft);
    display: flex;
    align-items: stretch;
    overflow: hidden;
    flex-shrink: 0;
    user-select: none;
    font-family: var(--body);
  }
  .softn-tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--dim);
    font: inherit;
    font-size: 0.8125rem;
    cursor: pointer;
    transition: color 160ms var(--ease), background 160ms var(--ease);
    flex-shrink: 0;
    white-space: nowrap;
    letter-spacing: -0.01em;
    position: relative;
  }
  .softn-tab:hover {
    color: var(--paper);
    background: var(--inset);
  }
  .softn-tab.active {
    border-bottom-color: var(--mint);
    color: var(--paper);
    font-weight: 500;
  }
  .softn-tab-home.active { border-bottom-color: var(--paper); }
  .softn-tab:focus-visible { outline: 2px solid var(--mint); outline-offset: -3px; }
  .softn-tab-home { padding: 0 12px; }
  .softn-tab-app {
    max-width: 180px;
    min-width: 0;
    flex-shrink: 1;
    padding: 0 8px 0 10px;
    animation: softn-tab-slide-in 250ms var(--ease) both;
  }
  .softn-tab-icon {
    width: 18px; height: 18px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }
  .softn-tab-app-icon {
    width: 16px; height: 16px;
    border-radius: 4px;
    flex-shrink: 0;
  }
  .softn-tab-app-icon-letter {
    width: 16px; height: 16px;
    background: var(--ink-3);
    border: 1px solid var(--line);
    border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
    font-family: var(--display);
    font-size: 0.6rem; color: var(--paper); font-weight: 700;
    flex-shrink: 0;
  }
  .softn-tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .softn-tab-close {
    width: 16px; height: 16px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 4px;
    font-size: 0.85rem; line-height: 1;
    color: transparent;
    flex-shrink: 0;
    transition: color 150ms var(--ease), background 150ms var(--ease);
    cursor: pointer;
  }
  .softn-tab:hover .softn-tab-close,
  .softn-tab.active .softn-tab-close { color: var(--dimmer); }
  .softn-tab-close:hover {
    color: var(--paper) !important;
    background: var(--ink-3);
  }
  .softn-tab-add,
  .softn-tab-hide,
  .softn-tab-menu-btn {
    display: flex; align-items: center; justify-content: center;
    background: transparent;
    border: none;
    color: var(--dimmer);
    font: inherit;
    cursor: pointer;
    flex-shrink: 0;
    border-radius: 6px;
    margin: 4px 2px;
    transition: color 160ms var(--ease), background 160ms var(--ease);
  }
  .softn-tab-add { width: 32px; font-size: 1.1rem; }
  .softn-tab-hide { width: 30px; margin-right: 4px; }
  .softn-tab-add:hover, .softn-tab-hide:hover,
  .softn-tab-menu-btn:hover, .softn-tab-menu-btn[aria-expanded="true"] {
    color: var(--paper);
    background: var(--ink-3);
  }
  .softn-tab-add:focus-visible, .softn-tab-hide:focus-visible, .softn-tab-menu-btn:focus-visible {
    outline: 2px solid var(--mint); outline-offset: -2px;
  }
  .softn-tab-scroll {
    display: flex;
    align-items: stretch;
    overflow-x: auto;
    overflow-y: hidden;
    flex: 1;
    min-width: 0;
    scrollbar-width: none;
  }
  .softn-tab-scroll::-webkit-scrollbar { display: none; }
  .softn-home-label {}

  @media (max-width: 640px) {
    .softn-tab-bar { height: 34px; }
    .softn-tab { font-size: 0.75rem; gap: 4px; }
    .softn-tab-home { padding: 0 10px; }
    .softn-tab-app { max-width: 120px; padding: 0 6px; }
    .softn-tab-icon { width: 16px; height: 16px; }
    .softn-tab-close { width: 14px; height: 14px; font-size: 0.75rem; }
    .softn-tab-add { width: 28px; font-size: 1rem; }
    .softn-home-label { display: none; }
  }

  /*
   * A narrow window shrinks these to fit; a touch screen needs the opposite.
   * Keyed on pointer, so a small desktop window keeps the compact bar and a
   * phone gets targets a thumb can actually land on.
   */
  @media (pointer: coarse) {
    .softn-tab-bar { height: 44px; }
    .softn-tab { min-height: 44px; }
    .softn-tab-home { min-width: 44px; }
    .softn-tab-add { width: 44px; min-height: 44px; font-size: 1.15rem; }
    .softn-tab-close { width: 24px; height: 24px; font-size: 0.9rem; }
    .softn-tab-app { max-width: 150px; }
  }
  .softn-tab-menu {
    position: relative;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .softn-tab-menu-btn {
    width: 32px;
    height: calc(100% - 8px);
    margin: 4px 0;
    font-size: 1.05rem;
    letter-spacing: 0.08em;
  }
  .softn-tab-menu-list {
    position: absolute;
    top: calc(100% + 2px);
    right: 0;
    min-width: 230px;
    max-width: min(320px, calc(100vw - 16px));
    background: var(--ink-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 4px;
    box-shadow: var(--shadow);
    z-index: 60;
    display: flex;
    flex-direction: column;
    animation: softn-tab-slide-in 160ms var(--ease);
  }
  .softn-tab-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 10px;
    border-radius: 6px;
    color: var(--paper);
    font: inherit;
    font-size: 0.8rem;
    text-align: left;
    background: transparent;
    border: none;
    cursor: pointer;
    text-decoration: none;
    white-space: normal;
    line-height: 1.35;
  }
  .softn-tab-menu-item:hover { background: var(--ink-3); }
  .softn-tab-menu-note { color: var(--dim); font-size: 0.75rem; padding: 6px 10px 8px; line-height: 1.4; }
  .softn-tab-menu-note a { color: var(--paper); text-decoration: underline; text-underline-offset: 2px; }
  .softn-tab-menu-sep { height: 1px; background: var(--line-soft); margin: 4px 6px; }
  @media (pointer: coarse) {
    .softn-tab-menu-btn { width: 44px; }
    .softn-tab-menu-item { padding: 12px 12px; }
  }
`;

/**
 * What can be done with the app in the active tab, beyond running it: take
 * its bundle away as a file — the exact bytes that were opened — and, for an
 * app that came from the site's directory, go to its page, open it in Studio
 * or Builder, or copy the link that opens it anywhere.
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
    <div className="softn-tab-menu" ref={ref}>
      <button
        className="softn-tab-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${tab.name}`}
        title={`Actions for ${tab.name}`}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div className="softn-tab-menu-list" role="menu">
          {onDownload && (
            <button
              role="menuitem"
              className="softn-tab-menu-item"
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
              <div className="softn-tab-menu-sep" />
              <a role="menuitem" className="softn-tab-menu-item" href={`/app/${slug}`}>
                App page: comments, ratings, source
              </a>
              <a role="menuitem" className="softn-tab-menu-item" href={`/studio/?open=${encodeURIComponent(bundle!)}`}>
                Edit in Studio
              </a>
              <a role="menuitem" className="softn-tab-menu-item" href={`/builder/?open=${encodeURIComponent(bundle!)}`}>
                Edit in Builder
              </a>
              <a role="menuitem" className="softn-tab-menu-item" href={`/publish?remix=${slug}`}>
                Publish a remix
              </a>
              <button role="menuitem" className="softn-tab-menu-item" onClick={copy}>
                {copied ? 'Copied' : 'Copy share link'}
              </button>
            </>
          ) : (
            <div className="softn-tab-menu-note">
              This app was opened from a file. <a href="/publish">Publish it</a> to share it, remix it or edit it
              online.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onDownloadTab,
  onHide,
}: TabBarProps): React.ReactElement {
  const handleMiddleClick = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      if (e.button === 1) {
        e.preventDefault();
        onCloseTab(tabId);
      }
    },
    [onCloseTab]
  );

  const isHome = activeTabId === null;
  const activeTab = isHome ? null : tabs.find((t) => t.id === activeTabId) ?? null;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: tabBarStyles }} />
      <div className="softn-tab-bar">
        {/* Home tab */}
        <button
          className={`softn-tab softn-tab-home ${isHome ? 'active' : ''}`}
          onClick={() => onSelectTab(null)}
        >
          <span className="softn-tab-icon">
            <Mark size={18} radius={5} title="Home" />
          </span>
          <span className="softn-home-label">Home</span>
        </button>

        {/* App tabs - horizontally scrollable */}
        <div className="softn-tab-scroll">
          {tabs.map((tab) => {
            const isActive = activeTabId === tab.id;
            return (
              <button
                key={tab.id}
                className={`softn-tab softn-tab-app ${isActive ? 'active' : ''}`}
                onClick={() => onSelectTab(tab.id)}
                onMouseDown={(e) => handleMiddleClick(e, tab.id)}
              >
                {tab.icon ? (
                  <img src={tab.icon} alt="" className="softn-tab-app-icon" style={{ objectFit: 'cover' }} />
                ) : (
                  <span className="softn-tab-app-icon-letter">
                    {tab.name.charAt(0).toUpperCase()}
                  </span>
                )}
                <span className="softn-tab-label">{tab.name}</span>
                <span
                  className="softn-tab-close"
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${tab.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      onCloseTab(tab.id);
                    }
                  }}
                >
                  &times;
                </span>
              </button>
            );
          })}
        </div>

        {activeTab && <AppMenu tab={activeTab} onDownload={onDownloadTab} />}

        {/* Add tab button */}
        <button className="softn-tab-add" onClick={onAddTab} title="Open a .softn file" aria-label="Open a .softn file">
          +
        </button>
        {onHide && (
          <button className="softn-tab-hide" onClick={onHide} title="Hide the bars (the corner tab brings them back)" aria-label="Hide the bars">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
        )}
      </div>
    </>
  );
}
