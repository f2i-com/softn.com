import React from 'react';
import { useWorkspaceStore } from '../../stores';
import { Icon } from '../common/Icon';
import type { LeftPanel } from '../../types/studio';

type RailItem = { id: LeftPanel; icon: Parameters<typeof Icon>[0]['name']; label: string };

const topPanels: RailItem[] = [
  { id: 'ai', icon: 'ai', label: 'AI' },
  { id: 'files', icon: 'folder', label: 'Files' },
  { id: 'pages', icon: 'pages', label: 'Pages' },
  { id: 'settings', icon: 'settings', label: 'Settings' },
];

const historyPanel: RailItem = { id: 'history', icon: 'clock', label: 'History' };

const allPanels = [...topPanels, historyPanel];

/**
 * The rail of panels down the left edge and the one panel that is open.
 *
 * Each button says whether its panel is open (aria-pressed) and the open one
 * is joined to the panel by a bar on the rail's edge, so the pairing reads
 * without colour. The panel's header is its name and a close button: the
 * "Studio panel" eyebrow and the upper-case copy of the name beside it said
 * the same word three times.
 */
export const LeftRail: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const { leftPanel, leftPanelExpanded, setLeftPanel } = useWorkspaceStore();

  const toggle = (id: LeftPanel) =>
    setLeftPanel(leftPanel === id && leftPanelExpanded ? null : id);

  const renderBtn = (p: RailItem) => (
    <button
      key={p.id}
      type="button"
      onClick={() => toggle(p.id)}
      className="st-rail-btn"
      aria-pressed={leftPanel === p.id && leftPanelExpanded}
      title={p.label}
    >
      <Icon name={p.icon} size={18} />
      <span>{p.label}</span>
    </button>
  );

  const open = allPanels.find((p) => p.id === leftPanel);

  return (
    <div className="st-rail-wrap">
      <nav className="st-rail" aria-label="Panels">
        {topPanels.map(renderBtn)}
        <div className="st-rail-spacer" />
        {renderBtn(historyPanel)}
      </nav>

      {leftPanel && leftPanelExpanded && (
        <section className="st-panel" data-panel={leftPanel} aria-label={open?.label}>
          <div className="st-panel-head">
            <h2 className="st-panel-title">{open?.label}</h2>
            <button type="button" onClick={() => setLeftPanel(null)} className="st-icon-btn" title="Close panel" aria-label="Close panel">
              <Icon name="x" size={16} />
            </button>
          </div>
          <div className="st-panel-body">
            {children}
          </div>
        </section>
      )}
    </div>
  );
};
