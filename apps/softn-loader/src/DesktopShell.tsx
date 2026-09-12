import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Mark, ThemeToggle } from '@softn/brand';
import './desktop.css';

export function DesktopShell({ children, appName, onHome, onOpen, canOpen }: {
  children: ReactNode;
  appName?: string;
  onHome: () => void;
  onOpen: () => void;
  canOpen: boolean;
}) {
  const header = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(58);
  useEffect(() => {
    const element = header.current;
    if (!element) return;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div className="desktop-shell" style={{ '--softn-tab-bar-height': `${height}px` } as CSSProperties}>
    <header className="desktop-header" ref={header}>
      <button className="desktop-brand" onClick={onHome} aria-label="Runtime home"><Mark size={24} /> softn</button>
      <span className="desktop-title">{appName || 'Desktop runtime'}</span>
      <span className="desktop-header-actions">
        {canOpen && <button className="desktop-button" onClick={onOpen}>Open app</button>}
        <ThemeToggle />
      </span>
    </header>
    <main className="desktop-content">{children}</main>
  </div>;
}

export function DesktopWelcome({ onOpen, canOpen, dragging, error }: {
  onOpen: () => void;
  canOpen: boolean;
  dragging: boolean;
  error: Error | null;
}) {
  return <section className="desktop-welcome" data-dragging={dragging || undefined}>
    <div className="desktop-welcome-copy">
      <span className="desktop-eyebrow">Your apps, on your desktop</span>
      <h1>Open it.<br />Make yourself at home.</h1>
      <p>Run the same apps you create in Studio and Builder. Your interface, logic and starting data travel together in one <code>.softn</code> file.</p>
      <div className="desktop-drop-card">
        <Mark size={44} />
        <h2>{dragging ? 'Drop your app here' : 'Start with a .softn app'}</h2>
        <p>{canOpen ? 'Choose a file or drop it into this window.' : 'Open this workspace in the Softn desktop app to choose a local file.'}</p>
        {canOpen && <button className="desktop-button desktop-button-primary" onClick={onOpen}>Open a .softn file</button>}
        {error && <p className="desktop-error" role="alert">{error.message}</p>}
      </div>
    </div>
    <aside className="desktop-guide" aria-label="Move between your tools">
      <h2>One app. Three ways to work.</h2>
      <ol>
        <li><span>01</span><div><h3>Create in Studio</h3><p>Start from an idea or import an existing app, then export its editable bundle.</p></div></li>
        <li><span>02</span><div><h3>Refine in Builder</h3><p>Open the bundle to edit its screens, logic and collections. Export your changes.</p></div></li>
        <li><span>03</span><div><h3>Run it here</h3><p>Open that file on your desktop. Saved records stay with this app on this device.</p></div></li>
      </ol>
      <p className="desktop-note">Exporting a project carries its source and starting records. Each runtime keeps its own saved data.</p>
    </aside>
  </section>;
}
