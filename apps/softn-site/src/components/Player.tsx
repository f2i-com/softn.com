import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Code } from '../lib/highlight';
import { runtimeUrlFor } from '../lib/appUrls';
import { DEFAULT_DEMO_ID, formatBytes, loadDemoIndex, loadDemoSource, type Demo, type DemoSource } from '../lib/demos';

/**
 * The player is the page's one claim, made literally: the file on the left is
 * read out of the same `.softn` bundle the runtime on the right is executing.
 * Neither side is a picture of the product.
 */
export function Player(): React.ReactElement {
  const [demos, setDemos] = useState<Demo[] | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [source, setSource] = useState<DemoSource | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [frameLive, setFrameLive] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const runtimeOrigin = useMemo(() => {
    if (typeof window === 'undefined' || !selectedId || !demos) return null;
    const selectedDemo = demos.find((demo) => demo.id === selectedId);
    if (!selectedDemo) return null;
    try {
      return new URL(runtimeUrlFor(selectedDemo.file, { embed: true }), window.location.href).origin;
    } catch {
      return null;
    }
  }, [demos, selectedId]);

  // The runtime posts this once the bundle has parsed and the app has replaced
  // its own spinner. The iframe's load event fires seconds earlier, so lighting
  // the badge on that instead would claim "live" over a loading screen.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // `postMessage` is global to the page. An extension, another iframe or a
      // runtime that navigated away must not be able to make this player claim
      // the selected demo is live.
      if (!runtimeOrigin || event.origin !== runtimeOrigin) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: string } | null;
      if (data && typeof data === 'object' && data.type === 'softn:app-ready') setFrameLive(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [runtimeOrigin]);

  useEffect(() => {
    const ac = new AbortController();
    loadDemoIndex(ac.signal)
      .then((list) => {
        if (ac.signal.aborted) return;
        setDemos(list);
        const first = list.find((d) => d.id === DEFAULT_DEMO_ID) ?? list[0];
        setSelectedId(first ? first.id : null);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setIndexError(err instanceof Error ? err.message : String(err));
      });
    return () => ac.abort();
  }, []);

  const selected = useMemo(() => demos?.find((d) => d.id === selectedId) ?? null, [demos, selectedId]);

  useEffect(() => {
    if (!selected) return;
    const ac = new AbortController();
    setSource(null);
    setSourceError(null);
    setFrameLive(false);
    loadDemoSource(selected.file, ac.signal)
      .then((s) => {
        if (!ac.signal.aborted) setSource(s);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setSourceError(err instanceof Error ? err.message : String(err));
      });
    return () => ac.abort();
  }, [selected]);

  return (
    <>
      <div className="player">
        <div className="panel">
          <div className="panel-bar">
            <span className="panel-bar-name">{source ? source.path : selected ? 'reading the bundle…' : '—'}</span>
            <span className="panel-bar-tag">source</span>
          </div>
          {/* The scroller here is the div, not the <pre> inside it, so the
              region and the tab stop belong on the div — and only while there
              is source in it to scroll. */}
          <div
            className="panel-source"
            role="region"
            aria-label="Demo source"
            tabIndex={source ? 0 : -1}
          >
            {source ? (
              <Code source={source.source} />
            ) : (
              <SourcePlaceholder error={sourceError} pending={Boolean(selected)} />
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-bar">
            <span className="live" data-on={frameLive}>
              <span className="live-dot" aria-hidden="true" />
              {frameLive ? 'live' : 'starting'}
            </span>
            <span className="panel-bar-name" style={{ color: 'var(--dimmer)' }}>
              {selected?.name ?? ''}
            </span>
            {selected && (
              <a
                className="panel-bar-tag"
                href={runtimeUrlFor(selected.file)}
                target="_blank"
                rel="noreferrer"
                style={{ textDecoration: 'underline', textUnderlineOffset: '3px' }}
              >
                open full size
              </a>
            )}
          </div>
          <div className="panel-stage">
            {selected ? (
              <iframe
                ref={frameRef}
                key={selected.file}
                src={runtimeUrlFor(selected.file, { embed: true })}
                title={`${selected.name} running in the SoftN web runtime`}
                allow="camera; microphone; fullscreen; clipboard-write; xr-spatial-tracking"
              />
            ) : (
              <StagePlaceholder error={indexError} />
            )}
          </div>
        </div>
      </div>

      <section className="shelf" id="demos">
        <div className="shelf-label">
          <span className="eyebrow">Demo bundles</span>
          <span className="shelf-note">
            {demos ? `${demos.length} apps, each a single .softn file. Pick one — it runs above.` : ''}
          </span>
        </div>
        <div className="shelf-row" role="group" aria-label="Demo bundles">
          {demos
            ? demos.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className="chip"
                  aria-pressed={d.id === selectedId}
                  onClick={() => setSelectedId(d.id)}
                >
                  <span className="chip-name">{d.name}</span>
                  <span className="chip-meta">{formatBytes(d.size)}</span>
                </button>
              ))
            : !indexError &&
              Array.from({ length: 6 }, (_, i) => <div key={i} className="shelf-skeleton" aria-hidden="true" />)}
        </div>
      </section>
    </>
  );
}

function SourcePlaceholder({ error, pending }: { error: string | null; pending: boolean }): React.ReactElement {
  if (error) {
    return (
      <span style={{ color: 'var(--dimmer)' }}>
        {'// '}
        {error}
      </span>
    );
  }
  return <span style={{ color: 'var(--dimmer)' }}>{pending ? '// unzipping…' : '// waiting for the runtime'}</span>;
}

function StagePlaceholder({ error }: { error: string | null }): React.ReactElement {
  if (!error) {
    return (
      <div className="stage-msg">
        <span>Starting the runtime…</span>
      </div>
    );
  }
  return (
    <div className="stage-msg">
      <span className="stage-msg-title">The web runtime isn&rsquo;t answering.</span>
      {import.meta.env.DEV ? (
        <span>
          Demos are served by the runtime. Start it with <code>npm run dev:web</code>, then reload — or point{' '}
          <code>VITE_WEB_URL</code> at wherever it is running.
        </span>
      ) : (
        <span>
          This build is missing <code>/demos</code>. Rebuild the site with <code>npm run build:site</code>.
        </span>
      )}
    </div>
  );
}
