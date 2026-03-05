import React, { useCallback } from 'react';

export interface TabInfo {
  id: string;
  name: string;
  icon?: string;
}

interface TabBarProps {
  tabs: TabInfo[];
  activeTabId: string | null; // null = Home
  onSelectTab: (id: string | null) => void;
  onCloseTab: (id: string) => void;
  onAddTab: () => void;
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
`;

export function TabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onAddTab,
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

        {/* Add tab button */}
        <button className="softn-tab-add" onClick={onAddTab} title="Open .softn file">
          +
        </button>
      </div>
    </>
  );
}
