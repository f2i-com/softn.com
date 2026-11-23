import { useEffect, useRef, useState } from 'react';
import { CORE_APPS, VERTICAL_PACKS, type ModulaAppDef } from '../data/suiteCatalog';

interface CommandPaletteProps {
  open: boolean;
  mountedIds: string[];
  backendMode: 'zipp' | 'standalone';
  onClose: () => void;
  onOpenCoreApp: (app: ModulaAppDef) => void;
  onOpenPack: (packFile: string) => void;
  onToggleHome: () => void;
  onToggleBackendMode: () => void;
  onOpenAppStore: () => void;
}

export function CommandPalette({
  open,
  mountedIds,
  backendMode,
  onClose,
  onOpenCoreApp,
  onOpenPack,
  onToggleHome,
  onToggleBackendMode,
  onOpenAppStore,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const matchedApps = CORE_APPS.filter(
    (a) =>
      !q ||
      a.name.toLowerCase().includes(q) ||
      a.tagline.toLowerCase().includes(q) ||
      a.odooEquivalents.some((o) => o.toLowerCase().includes(q))
  );
  const matchedPacks = VERTICAL_PACKS.filter(
    (p) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q)
  );

  return (
    <div id="cmd-palette-backdrop" className="cmd-backdrop" onClick={onClose}>
      <div className="cmd-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cmd-head">
          <input
            ref={inputRef}
            id="cmd-palette-input"
            className="cmd-input"
            type="search"
            placeholder="Jump to any Modula app, Odoo module (MRP, eSign, POS, Payroll...), or action..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && matchedApps.length > 0) {
                onOpenCoreApp(matchedApps[0]);
                onClose();
              }
            }}
          />
          <kbd className="cmd-kbd">ESC</kbd>
        </div>

        <div className="cmd-list">
          {matchedApps.length > 0 && (
            <div className="cmd-group">
              <div className="cmd-group-label">Modula Core .softn Apps ({matchedApps.length})</div>
              {matchedApps.map((app) => {
                const running = mountedIds.includes(app.id);
                return (
                  <button
                    key={app.id}
                    type="button"
                    className="cmd-item"
                    data-cmd-app={app.slug}
                    onClick={() => {
                      onOpenCoreApp(app);
                      onClose();
                    }}
                  >
                    <span className="cmd-icon" style={{ background: app.color }}>{app.iconText}</span>
                    <div className="cmd-item-main">
                      <strong>{app.name}</strong>
                      <span>{app.odooEquivalents.join(' · ')}</span>
                    </div>
                    {running && <span className="ws-app-running-tag">Running</span>}
                  </button>
                );
              })}
            </div>
          )}

          {matchedPacks.length > 0 && (
            <div className="cmd-group">
              <div className="cmd-group-label">Turnkey Industry Packs</div>
              {matchedPacks.slice(0, 5).map((pack) => (
                <button
                  key={pack.slug}
                  type="button"
                  className="cmd-item"
                  onClick={() => {
                    onOpenPack(pack.file);
                    onClose();
                  }}
                >
                  <span className="cmd-icon" style={{ background: pack.color }}>{pack.name.slice(0, 2).toUpperCase()}</span>
                  <div className="cmd-item-main">
                    <strong>{pack.name}</strong>
                    <span>{pack.category} · {pack.description}</span>
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="cmd-group">
            <div className="cmd-group-label">Workspace Actions</div>
            <button type="button" className="cmd-item" onClick={() => { onToggleHome(); onClose(); }}>
              <span className="cmd-icon" style={{ background: '#334155' }}>⊞</span>
              <div className="cmd-item-main"><strong>Open Home App Grid</strong><span>Show all installed apps &amp; industry packs</span></div>
            </button>
            <button type="button" className="cmd-item" onClick={() => { onToggleBackendMode(); onClose(); }}>
              <span className="cmd-icon" style={{ background: '#059669' }}>⇄</span>
              <div className="cmd-item-main">
                <strong>Switch PHP Runtime Mode</strong>
                <span>Currently: {backendMode === 'zipp' ? 'In-Browser ZIPP PHP WASM + XDB' : 'Standalone Native PHP Host'}</span>
              </div>
            </button>
            <button type="button" className="cmd-item" onClick={() => { onOpenAppStore(); onClose(); }}>
              <span className="cmd-icon" style={{ background: '#5b21b6' }}>+</span>
              <div className="cmd-item-main"><strong>Open Modula App Store</strong><span>Install, remove, or sideload custom .softn bundles</span></div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
