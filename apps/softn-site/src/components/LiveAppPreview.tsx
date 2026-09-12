import { useEffect, useRef, useState } from 'react';
import { WEB_HREF } from '../lib/appUrls';
import { FIELDNOTES_BUNDLE } from './ExampleWalkthrough';

const WIDTH = 1200;
const HEIGHT = 960;
const frameUrl = `${WEB_HREF}?preview=fieldnotes`;
export const FIELDNOTES_RUNTIME = `${WEB_HREF}?open=${encodeURIComponent(FIELDNOTES_BUNDLE)}&back=${encodeURIComponent('/#top')}`;

export function LiveAppPreview() {
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loaded, setLoaded] = useState(false);
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
        <iframe ref={frame} title="Live Fieldnotes sample app" src={frameUrl} loading="lazy"
          style={{ width: viewportWidth, height: viewportHeight, transform: `scale(${width / viewportWidth})` }}
          onLoad={() => setLoaded(true)} onError={() => setState('error')} />
      </div>
      {state !== 'ready' && <div className="workspace-live-placeholder" aria-hidden="true">
        <span className="workspace-live-monogram">f</span><strong>Fieldnotes</strong>
        <span>{state === 'error' ? 'Open the app to explore your workspace.' : 'Preparing your sample workspace…'}</span>
      </div>}
    </div>
    <div className="workspace-live-footer" data-state={state}>
      <span className="workspace-live-status" role="status"><span aria-hidden="true" />{state === 'ready' ? 'Live · try it here' : state === 'error' ? 'Preview unavailable' : 'Loading app…'}</span>
      <a className="workspace-live-action" href={FIELDNOTES_RUNTIME} aria-label="Open live Fieldnotes app in the runtime">Open in runtime <span aria-hidden="true">↗</span></a>
    </div>
  </>;
}
