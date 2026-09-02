import React, { useEffect, useMemo, useState } from 'react';
import { getSource, type SourceFile } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { Code } from '../../lib/highlight';

/**
 * Every file in the bundle, readable in place. This is the promise the
 * directory makes: what you run is what you can read, and what you can read
 * is what you can take to Studio or Builder and change.
 */
export function SourceViewer({ slug, version, main }: { slug: string; version?: number; main?: string | null }): React.ReactElement {
  const [files, setFiles] = useState<SourceFile[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setFiles(null);
    getSource(slug, version, ac.signal)
      .then((r) => {
        setFiles(r.files);
        setTruncated(r.truncated);
        const first = r.files.find((f) => f.path === main) ?? r.files.find((f) => /\.ui$/i.test(f.path)) ?? r.files.find((f) => f.text !== null) ?? r.files[0];
        setSelected(first?.path ?? null);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, [slug, version, main]);

  const current = useMemo(() => files?.find((f) => f.path === selected) ?? null, [files, selected]);
  const grouped = useMemo(() => {
    const groups = new Map<string, SourceFile[]>();
    for (const f of files ?? []) {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir)!.push(f);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [files]);

  if (error) return <p className="form-error">Could not read the source: {error}</p>;
  if (!files) return <p className="muted">Reading the bundle…</p>;

  const isMarkup = current ? /\.(ui|html|svg|xml)$/i.test(current.path) : false;
  const isCode = current ? /\.(logic|js|ts|json|css)$/i.test(current.path) : false;

  return (
    <div className="source">
      <nav className="source-tree" aria-label="Files in the bundle">
        {grouped.map(([dir, list]) => (
          <div key={dir || '/'} className="source-dir">
            {dir && <div className="source-dir-name">{dir}/</div>}
            {list.map((f) => (
              <button
                key={f.path}
                type="button"
                className={`source-file ${f.path === selected ? 'on' : ''} ${f.text === null ? 'binary' : ''}`}
                onClick={() => setSelected(f.path)}
                title={`${f.path} · ${formatBytes(f.size)}`}
              >
                <span className="source-file-name">{f.path.slice(dir ? dir.length + 1 : 0)}</span>
                <span className="source-file-size">{formatBytes(f.size)}</span>
              </button>
            ))}
          </div>
        ))}
        {truncated && <p className="source-note">Some large files are listed without their contents.</p>}
      </nav>
      <div className="source-pane">
        {current === null ? (
          <p className="muted">Pick a file.</p>
        ) : current.text === null ? (
          <p className="muted">
            {current.path} is a binary file of {formatBytes(current.size)}; download the bundle to get it.
          </p>
        ) : isMarkup ? (
          <Code source={current.text} className="source-code" />
        ) : (
          <pre className={`source-code source-plain ${isCode ? 'source-logic' : ''}`}>
            <code>{current.text}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
