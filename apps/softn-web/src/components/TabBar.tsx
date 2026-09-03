import React, { useCallback, useEffect, useRef, useState } from 'react';

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

const tabBarStyles = `
  @keyframes softn-tab-slide-in {
    from { opacity: 0; transform: translateX(-8px); }
    to { opacity: 1; transform: translateX(0); }
  }
  @keyframes softn-tab-indicator-grow {
    from { transform: scaleX(0); }
    to { transform: scaleX(1); }
  }
  .softn-tab-hide {
    flex: 0 0 auto;
    width: 30px;
    height: 100%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #8b8b96;
    background: transparent;
    border: 0;
    cursor: pointer;
    transition: color 160ms ease;
  }
  .softn-tab-hide:hover { color: #fff; }
  .softn-tab-bar {
    height: 38px;
    background: #0c0c0e;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    display: flex;
    align-items: stretch;
    overflow: hidden;
    flex-shrink: 0;
    user-select: none;
  }
  .softn-tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: #5a5a66;
    font-size: 0.8rem;
    font-weight: 400;
    cursor: pointer;
    transition: all 200ms cubic-bezier(0.16, 1, 0.3, 1);
    flex-shrink: 0;
    white-space: nowrap;
    letter-spacing: -0.01em;
    position: relative;
  }
  .softn-tab:hover {
    color: #8b8b96;
    background: rgba(255, 255, 255, 0.025);
  }
  .softn-tab.active {
    border-bottom-color: #3b82f6;
    color: #ececf0;
    font-weight: 500;
    background: rgba(59, 130, 246, 0.04);
  }
  .softn-tab.active:hover { color: #ececf0; }
  .softn-tab-home { padding: 0 14px; }
  .softn-tab-app {
    max-width: 180px;
    min-width: 0;
    flex-shrink: 1;
    padding: 0 8px 0 10px;
    animation: softn-tab-slide-in 250ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .softn-tab-icon {
    width: 18px; height: 18px;
    border-radius: 5px;
    flex-shrink: 0;
    overflow: hidden;
    /* The letter fallback inherits the bar's line-height, which is taller than
       the box, so without this the glyph is clipped at every window size. */
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
    background: linear-gradient(135deg, #60a5fa 0%, #2563eb 100%);
    border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
    font-size: 0.6rem; color: white; font-weight: bold;
    flex-shrink: 0;
    box-shadow: 0 1px 3px rgba(59, 130, 246, 0.15);
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
    transition: all 150ms cubic-bezier(0.16, 1, 0.3, 1);
    cursor: pointer;
  }
  .softn-tab:hover .softn-tab-close { color: #5a5a66; }
  .softn-tab-close:hover {
    color: #ef4444 !important;
    background: rgba(239, 68, 68, 0.1);
    transform: scale(1.1);
  }
  .softn-tab-close:active {
    transform: scale(0.9);
  }
  .softn-tab-add {
    width: 32px;
    display: flex; align-items: center; justify-content: center;
    background: transparent;
    border: none;
    color: #3a3a44;
    font-size: 1.1rem;
    cursor: pointer;
    flex-shrink: 0;
    transition: all 180ms cubic-bezier(0.16, 1, 0.3, 1);
    border-radius: 6px;
    margin: 4px 2px;
  }
  .softn-tab-add:hover {
    color: #8b8b96;
    background: rgba(255, 255, 255, 0.04);
  }
  .softn-tab-add:active {
    transform: scale(0.9);
    color: #3b82f6;
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
    .softn-tab-icon { width: 16px; height: 16px; font-size: 0.6rem; }
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
    /* The Home tab drops its label on a narrow screen, leaving only the icon —
       tall enough after the rule above, but still too narrow to aim at. */
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
    display: flex; align-items: center; justify-content: center;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: #5a5a66;
    font-size: 1.05rem;
    letter-spacing: 0.08em;
    cursor: pointer;
    transition: all 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .softn-tab-menu-btn:hover,
  .softn-tab-menu-btn[aria-expanded="true"] {
    color: #ececf0;
    background: rgba(255, 255, 255, 0.05);
  }
  .softn-tab-menu-list {
    position: absolute;
    top: calc(100% + 2px);
    right: 0;
    min-width: 230px;
    max-width: min(320px, calc(100vw - 16px));
    background: #16161a;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    padding: 4px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    z-index: 60;
    display: flex;
    flex-direction: column;
    animation: softn-tab-slide-in 160ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .softn-tab-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 10px;
    border-radius: 6px;
    color: #d4d4dc;
    font-size: 0.8rem;
    text-align: left;
    background: transparent;
    border: none;
    cursor: pointer;
    text-decoration: none;
    white-space: normal;
    line-height: 1.35;
  }
  .softn-tab-menu-item:hover { background: rgba(255, 255, 255, 0.06); color: #fff; }
  .softn-tab-menu-note { color: #8b8b96; font-size: 0.75rem; padding: 6px 10px 8px; line-height: 1.4; }
  .softn-tab-menu-note a { color: #93c5fd; }
  .softn-tab-menu-sep { height: 1px; background: rgba(255, 255, 255, 0.06); margin: 4px 6px; }
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
            <svg width="18" height="18" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="softn-tab-logo" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#60a5fa"/>
                  <stop offset="100%" stopColor="#2563eb"/>
                </linearGradient>
              </defs>
              <rect width="32" height="32" rx="8" fill="url(#softn-tab-logo)"/>
              <path d="M10.5 9C20 9 21 16 16 16S12 23 21.5 23" fill="none" stroke="#fff" strokeWidth="2.8" strokeLinecap="round"/>
              <circle cx="10.5" cy="9" r="2.5" fill="#fff"/>
              <circle cx="21.5" cy="23" r="2.5" fill="#fff"/>
            </svg>
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
        <button className="softn-tab-add" onClick={onAddTab} title="Open .softn file">
          +
        </button>
        {onHide && (
          <button className="softn-tab-hide" onClick={onHide} title="Hide the tab bar (the corner tab brings it back)" aria-label="Hide the tab bar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
        )}
      </div>
    </>
  );
}
