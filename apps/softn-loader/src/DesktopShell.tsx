import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Mark, ThemeToggle } from '@softn/brand';
import './desktop.css';

export function DesktopShell({ children, chrome, appName, onHome, onOpen, canOpen, contentRef, themeBox }: {
  children: ReactNode;
  /** The element the app renders in; focusable, so focus can be put back into the app. */
  contentRef?: RefObject<HTMLElement>;
  /**
   * The name the app's ThemeProvider knows that element by. An app whose
   * project declares the other side from this shell's has its tokens, and a
   * ground from them, written on the element so named.
   */
  themeBox?: string;
  /**
   * Runtime chrome drawn under the header and above the app — the permission
   * bar. Measured with the header, since an app root is sized under both.
   */
  chrome?: ReactNode;
  appName?: string;
  onHome: () => void;
  onOpen: () => void;
  canOpen: boolean;
}) {
  const header = useRef<HTMLDivElement>(null);
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
    <div className="desktop-chrome" ref={header}>
      <header className="desktop-header">
        <button className="desktop-brand" onClick={onHome} aria-label="Runtime home"><Mark size={24} /> softn</button>
        <span className="desktop-title">{appName || 'Desktop runtime'}</span>
        <span className="desktop-header-actions">
          {canOpen && <button className="desktop-button" onClick={onOpen}>Open app</button>}
          <ThemeToggle />
        </span>
      </header>
      {chrome}
    </div>
    {/* The app is drawn in a box that keeps its paint: a `position: fixed`
        element of the app's stops at the box and cannot cover the permission
        bar above it. The box does not scroll, so such an element stays where
        the app put it while the app scrolls. */}
    <main className="desktop-content" ref={contentRef} tabIndex={-1} data-softn-theme-box={themeBox}><div className="desktop-scroll">{children}</div></main>
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
        <p>{canOpen ? 'Choose a file or drop it into this window.' : 'Open this workspace in the SoftN desktop app to choose a local file.'}</p>
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
