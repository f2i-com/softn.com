import { useEffect, useRef, useState } from 'react';
import { WEB_HREF } from '../lib/appUrls';
import { FIELDNOTES_BUNDLE } from './ExampleWalkthrough';

const WIDTH = 1200;
const HEIGHT = 960;
const frameUrl = `${WEB_HREF}?preview=fieldnotes`;
export const FIELDNOTES_RUNTIME = `${WEB_HREF}?open=${encodeURIComponent(FIELDNOTES_BUNDLE)}&back=${encodeURIComponent('/#top')}`;

/**
 * The preview is the real runtime — its engine alone is several megabytes of
 * WebAssembly — so a visitor who has asked to save data, or whose connection
 * reports itself as slow, starts it with a button instead of paying for it on
 * arrival. Everyone else gets it once the page itself has finished loading,
 * so the runtime never competes with the site's own first paint.
 */
export function prefersManualStart(nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  const connection = (nav as (Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }) | undefined)?.connection;
  return Boolean(connection && (connection.saveData || ['slow-2g', '2g', '3g'].includes(connection.effectiveType ?? '')));
}

/**
 * A phone, for this purpose: the site's narrow layout, where the hero stacks
 * and the preview card is a phone's width. There the runtime is a lot to load
 * for a card most visitors scroll past, so it waits to be asked for. Without
 * `matchMedia` (an old browser, a test) nothing is a phone.
 */
export const PHONE_QUERY = '(max-width: 720px)';

export function isPhone(): boolean {
  return typeof matchMedia === 'function' && matchMedia(PHONE_QUERY).matches;
}

/** Why the preview waits for its button, if it does. */
type Held = 'save-data' | 'phone' | null;

function heldBack(): Held {
  if (prefersManualStart()) return 'save-data';
  if (isPhone()) return 'phone';
  return null;
}

export function LiveAppPreview() {
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loaded, setLoaded] = useState(false);
  const [held] = useState<Held>(heldBack);
  const [started, setStarted] = useState(() => held === null);
  const [pageLoaded, setPageLoaded] = useState(() => typeof document === 'undefined' || document.readyState === 'complete');
  // Whether the stage has come near the screen. Below the fold (the hero
  // stacks on a tablet) the runtime waits until it is scrolled to; without
  // IntersectionObserver there is no telling, so it counts as seen.
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  const mounted = started && pageLoaded && seen;
  // Let the app use its phone layout in narrow cards instead of shrinking
  // desktop controls to a size that is difficult to tap.
  const compact = width > 0 && width < 420;
  const viewportWidth = compact ? Math.max(360, Math.ceil(width / 0.9)) : WIDTH;
  const viewportHeight = compact ? 640 : HEIGHT;

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth > 0) setWidth(element.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (pageLoaded) return;
    const done = () => setPageLoaded(true);
    window.addEventListener('load', done, { once: true });
    return () => window.removeEventListener('load', done);
  }, [pageLoaded]);

  // Watched only once it would otherwise start: a held-back preview loads on
  // its button, which is beside it, and needs no watching.
  useEffect(() => {
    const element = stage.current;
    if (seen || !started || !element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: '200px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen, started]);

  const start = () => {
    setStarted(true);
    // Pressed beside the card, so the card is on screen.
    setSeen(true);
  };

  useEffect(() => {
    const origin = new URL(frameUrl, window.location.href).origin;
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow || event.data?.app !== 'Fieldnotes') return;
      if (event.data.type === 'softn:app-ready') setState('ready');
      else if (event.data.type === 'softn:app-error') setState('error');
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => {
    if (!loaded || state !== 'loading') return;
    const timer = window.setTimeout(() => setState('error'), 30_000);
    return () => window.clearTimeout(timer);
  }, [loaded, state]);

  return <>
    <div ref={stage} className="workspace-live-stage" data-state={state} style={{ aspectRatio: `${viewportWidth} / ${viewportHeight}` }}>
      <div className="workspace-live-canvas" {...(state !== 'ready' ? { inert: '', 'aria-hidden': true as const } : {})}>
        {mounted && <iframe ref={frame} title="Live Fieldnotes sample app" src={frameUrl} loading="lazy"
          style={{ width: viewportWidth, height: viewportHeight, transform: `scale(${width / viewportWidth})` }}
          onLoad={() => setLoaded(true)} onError={() => setState('error')} />}
      </div>
      {state !== 'ready' && <div className="workspace-live-placeholder" aria-hidden="true">
        <span className="workspace-live-monogram">f</span><strong>Fieldnotes</strong>
        <span>{state === 'error' ? 'Open the app to explore your workspace.' : !started ? 'Start the preview to try it here.' : 'Preparing your sample workspace…'}</span>
      </div>}
    </div>
    <div className="workspace-live-footer" data-state={state}>
      <span className="workspace-live-status" role="status"><span aria-hidden="true" />{state === 'ready' ? 'Live · try it here' : state === 'error' ? 'Preview unavailable' : !started ? (held === 'phone' ? 'Loads when you start it' : 'Paused to save data') : 'Loading app…'}</span>
      {!started && <button type="button" className="workspace-live-start" onClick={start}>Start live preview</button>}
      <a className="workspace-live-action" href={FIELDNOTES_RUNTIME} aria-label="Open live Fieldnotes app in the runtime">Open in runtime <span aria-hidden="true">↗</span></a>
    </div>
  </>;
}
