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

export function LiveAppPreview() {
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loaded, setLoaded] = useState(false);
  const [started, setStarted] = useState(() => !prefersManualStart());
  const [pageLoaded, setPageLoaded] = useState(() => typeof document === 'undefined' || document.readyState === 'complete');
  const mounted = started && pageLoaded;
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
      <span className="workspace-live-status" role="status"><span aria-hidden="true" />{state === 'ready' ? 'Live · try it here' : state === 'error' ? 'Preview unavailable' : !started ? 'Paused to save data' : 'Loading app…'}</span>
      {!started && <button type="button" className="workspace-live-start" onClick={() => setStarted(true)}>Start live preview</button>}
      <a className="workspace-live-action" href={FIELDNOTES_RUNTIME} aria-label="Open live Fieldnotes app in the runtime">Open in runtime <span aria-hidden="true">↗</span></a>
    </div>
  </>;
}
