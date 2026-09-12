import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getSource, type SourceFile } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { Code } from '../../lib/highlight';
import { copyText } from '../../lib/share';

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
  const [attempt, setAttempt] = useState(0);
  const [wrap, setWrap] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    setFiles(null);
    setError(null);
    getSource(slug, version, ac.signal)
      .then((r) => {
        if (ac.signal.aborted) return;
        setFiles(r.files);
        setTruncated(r.truncated);
        const first = r.files.find((f) => f.path === main) ?? r.files.find((f) => /\.ui$/i.test(f.path)) ?? r.files.find((f) => f.text !== null) ?? r.files[0];
        setSelected(first?.path ?? null);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, [slug, version, main, attempt]);

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

  if (error) return <div className="notice" role="alert"><p>Could not read the source: {error}</p><button className="cta cta-small" type="button" onClick={() => setAttempt((n) => n + 1)}>Retry source</button></div>;
  if (!files) return <p className="muted" role="status">Reading the bundle…</p>;
  if (files.length === 0) return <p className="notice" role="status">This bundle has no files to preview.</p>;

  return (
    <div className="source">
      <label className="source-mobile-picker">
        <span>File to read</span>
        <select aria-label="File to read" value={selected ?? ''} onChange={(e) => setSelected(e.target.value)}>
          {files.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}
        </select>
      </label>
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
                aria-pressed={f.path === selected}
              >
                <span className="source-file-name">{f.path.slice(dir ? dir.length + 1 : 0)}</span>
                <span className="source-file-size">{formatBytes(f.size)}</span>
              </button>
            ))}
          </div>
        ))}
        {truncated && <p className="source-note">Some large files are listed without their contents.</p>}
      </nav>
      <div className="source-reading">
        {current === null ? (
          <p className="muted">Pick a file.</p>
        ) : (
          <SourceContent key={`${slug}:${version}:${current.path}`} file={current} wrap={wrap} onWrap={setWrap} />
        )}
      </div>
    </div>
  );
}

function SourceContent({ file, wrap, onWrap }: { file: SourceFile; wrap: boolean; onWrap: (value: boolean) => void }): React.ReactElement {
  const [copyStatus, setCopyStatus] = useState('');
  const active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const isMarkup = /\.(ui|html|svg|xml)$/i.test(file.path);
  return <>
    <div className="source-toolbar">
      <div className="source-current"><strong>{file.path}</strong><span>{formatBytes(file.size)}</span></div>
      {file.text !== null && <div className="source-actions">
        <button type="button" className="cta cta-small" aria-pressed={wrap} onClick={() => onWrap(!wrap)}>Wrap lines</button>
        <button type="button" className="cta cta-small" onClick={async () => {
          const copied = await copyText(file.text!);
          if (active.current) setCopyStatus(copied ? 'Source copied.' : 'Copy unavailable. Select and copy the source below.');
        }}>Copy source</button>
      </div>}
    </div>
    {copyStatus && <p className="source-copy-status" role="status">{copyStatus}</p>}
    <div className={`source-pane ${wrap ? 'source-wrap' : ''}`} tabIndex={0} role="region" aria-label={`Source of ${file.path}`}>
      {file.text === null ? <p className="source-message">Preview unavailable for this file. It may be binary or too large to display; download the bundle to read it.</p>
        : file.text.length === 0 ? <p className="source-message">This file is empty.</p>
        : isMarkup ? <Code source={file.text} className="source-code" />
        : <pre className="source-code source-plain"><code>{file.text}</code></pre>}
    </div>
  </>;
}
