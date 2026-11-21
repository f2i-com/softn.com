import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getSource, type SourceFile, type SourceFileKind } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { Code, languageOf } from '../../lib/highlight';
import { copyText } from '../../lib/share';

function inferFileKind(file: SourceFile): SourceFileKind {
  if (file.kind) return file.kind;
  const lower = file.path.toLowerCase();
  if (/\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif)$/.test(lower)) return 'image';
  if (/\.(?:mp3|wav|ogg|oga|flac|m4a|aac|opus)$/.test(lower)) return 'audio';
  if (/\.(?:mp4|m4v|webm|ogv|mov)$/.test(lower)) return 'video';
  if (file.text !== null) return 'text';
  return 'binary';
}

function fileBadgeLabel(file: SourceFile, kind: SourceFileKind): string | null {
  if (kind === 'image') return 'IMG';
  if (kind === 'audio') return 'AUDIO';
  if (kind === 'video') return 'VIDEO';
  const ext = file.path.split('.').pop()?.toLowerCase() ?? '';
  if (['php', 'phtml', 'rs', 'py', 'sql', 'ts', 'tsx', 'js', 'jsx', 'toml', 'yaml', 'yml', 'go', 'sh'].includes(ext)) {
    return ext.toUpperCase();
  }
  return null;
}

function buildSourceFileUrl(slug: string, filePath: string, version?: number, download = false): string {
  const qs = new URLSearchParams({ path: filePath });
  if (version) qs.set('v', String(version));
  if (download) qs.set('download', '1');
  return `/api/apps/${encodeURIComponent(slug)}/source/file?${qs}`;
}

/**
 * Every file in the bundle, readable or playable in place. This is the promise
 * the directory makes: what you run is what you can inspect — frontend pages,
 * PHP/Rust/Python/SQL backend code, and bundled images, audio, and video.
 */
export function SourceViewer({ slug, version, main }: { slug: string; version?: number; main?: string | null }): React.ReactElement {
  const [files, setFiles] = useState<SourceFile[] | null>(null);
  const [resolvedVersion, setResolvedVersion] = useState<number | undefined>(version);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [wrap, setWrap] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    setFiles(null);
    setError(null);
    setFilter('');
    getSource(slug, version, ac.signal)
      .then((r) => {
        if (ac.signal.aborted) return;
        setFiles(r.files);
        setResolvedVersion(r.version ?? version);
        setTruncated(r.truncated);
        const first =
          r.files.find((f) => f.path === main) ??
          r.files.find((f) => /^(?:[^/]+\/)?index\.html?$/i.test(f.path)) ??
          r.files.find((f) => /\.(?:html?|ui)$/i.test(f.path)) ??
          r.files.find((f) => f.text !== null) ??
          r.files[0];
        setSelected(first?.path ?? null);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, [slug, version, main, attempt]);

  const current = useMemo(() => files?.find((f) => f.path === selected) ?? null, [files, selected]);
  const filteredFiles = useMemo(() => {
    const list = files ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((f) => f.path.toLowerCase().includes(q));
  }, [files, filter]);

  const grouped = useMemo(() => {
    const groups = new Map<string, SourceFile[]>();
    for (const f of filteredFiles) {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir)!.push(f);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredFiles]);

  if (error) {
    return (
      <div className="notice" role="alert">
        <p>Could not read the source: {error}</p>
        <button className="cta cta-small" type="button" onClick={() => setAttempt((n) => n + 1)}>
          Retry source
        </button>
      </div>
    );
  }
  if (!files) return <p className="muted" role="status">Reading the bundle…</p>;
  if (files.length === 0) return <p className="notice" role="status">This bundle has no files to preview.</p>;

  return (
    <div className="source">
      <label className="source-mobile-picker">
        <span>File to read</span>
        <select aria-label="File to read" value={selected ?? ''} onChange={(e) => setSelected(e.target.value)}>
          {files.map((file) => (
            <option key={file.path} value={file.path}>
              {file.path}
            </option>
          ))}
        </select>
      </label>
      <nav className="source-tree" aria-label="Files in the bundle">
        {files.length > 6 && (
          <div className="source-filter">
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${files.length} files…`}
              aria-label="Filter bundle files"
            />
          </div>
        )}
        {grouped.length === 0 ? (
          <p className="source-note">No files match &ldquo;{filter}&rdquo;.</p>
        ) : (
          grouped.map(([dir, list]) => (
            <div key={dir || '/'} className="source-dir">
              {dir && <div className="source-dir-name">{dir}/</div>}
              {list.map((f) => {
                const kind = inferFileKind(f);
                const badge = fileBadgeLabel(f, kind);
                const isOpaque = kind === 'binary' && f.text === null;
                return (
                  <button
                    key={f.path}
                    type="button"
                    className={`source-file ${f.path === selected ? 'on' : ''} ${isOpaque ? 'binary' : ''}`}
                    onClick={() => setSelected(f.path)}
                    title={`${f.path} · ${formatBytes(f.size)}`}
                    aria-pressed={f.path === selected}
                  >
                    <span className="source-file-name">{f.path.slice(dir ? dir.length + 1 : 0)}</span>
                    <span className="source-file-right">
                      {badge && <span className={`source-file-kind is-${kind}`}>{badge}</span>}
                      <span className="source-file-size">{formatBytes(f.size)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
        {truncated && <p className="source-note">Large text files load on demand when selected.</p>}
      </nav>
      <div className="source-reading">
        {current === null ? (
          <p className="muted">Pick a file.</p>
        ) : (
          <SourceContent
            key={`${slug}:${resolvedVersion}:${current.path}`}
            slug={slug}
            version={resolvedVersion}
            file={current}
            wrap={wrap}
            onWrap={setWrap}
          />
        )}
      </div>
    </div>
  );
}

function SourceContent({
  slug,
  version,
  file,
  wrap,
  onWrap,
}: {
  slug: string;
  version?: number;
  file: SourceFile;
  wrap: boolean;
  onWrap: (value: boolean) => void;
}): React.ReactElement {
  const [copyStatus, setCopyStatus] = useState('');
  const [svgMode, setSvgMode] = useState<'preview' | 'code'>('preview');
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null);
  const [mediaError, setMediaError] = useState(false);
  const [loadedText, setLoadedText] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [loadFullError, setLoadFullError] = useState<string | null>(null);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const kind = inferFileKind(file);
  const isSvg = /\.svg$/i.test(file.path);
  const textContent = file.text ?? loadedText;
  const mediaUrl = buildSourceFileUrl(slug, file.path, version, false);
  const downloadUrl = buildSourceFileUrl(slug, file.path, version, true);

  const isPlainLogic = /\.logic$/i.test(file.path);
  const lang = languageOf(file.path);
  const useHighlighter =
    !isPlainLogic &&
    (/\.(?:ui|html?|svg|xml|py|php|phtml|rs|sql|css|scss|less|json|xdb|toml|ya?ml|ini|conf|cfg|sh|bash|zsh|ts|tsx|mts|js|jsx|mjs|cjs|go|c|cpp|h|hpp)$/i.test(
      file.path,
    ) ||
      /(?:^|\/)(?:\.htaccess|Dockerfile|Makefile)$/i.test(file.path));

  const showingCode = textContent !== null && (kind === 'text' || (isSvg && svgMode === 'code'));
  const showingImage = kind === 'image' && (!isSvg || svgMode === 'preview');

  const fetchFullText = async () => {
    if (loadingFull) return;
    setLoadingFull(true);
    setLoadFullError(null);
    try {
      const res = await fetch(mediaUrl, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Could not load file (${res.status}).`);
      const txt = await res.text();
      if (active.current) setLoadedText(txt);
    } catch (e) {
      if (active.current) setLoadFullError(e instanceof Error ? e.message : String(e));
    } finally {
      if (active.current) setLoadingFull(false);
    }
  };

  return (
    <>
      <div className="source-toolbar">
        <div className="source-current">
          <strong>{file.path}</strong>
          <span>
            {formatBytes(file.size)}
            {file.mime && kind !== 'text' ? ` · ${file.mime}` : ''}
            {imgDims && !isSvg ? ` · ${imgDims.w} × ${imgDims.h}px` : ''}
          </span>
        </div>
        <div className="source-actions">
          {isSvg && textContent !== null && (
            <button
              type="button"
              className="cta cta-small"
              aria-pressed={svgMode === 'code'}
              onClick={() => setSvgMode((m) => (m === 'preview' ? 'code' : 'preview'))}
            >
              {svgMode === 'preview' ? 'View SVG code' : 'Preview SVG'}
            </button>
          )}
          {showingCode && (
            <>
              <button type="button" className="cta cta-small" aria-pressed={wrap} onClick={() => onWrap(!wrap)}>
                Wrap lines
              </button>
              <button
                type="button"
                className="cta cta-small"
                onClick={async () => {
                  const copied = await copyText(textContent);
                  if (active.current) setCopyStatus(copied ? 'Source copied.' : 'Copy unavailable. Select and copy the source below.');
                }}
              >
                Copy source
              </button>
            </>
          )}
          {(kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'binary') && (
            <a className="cta cta-small" href={downloadUrl} download>
              Download
            </a>
          )}
        </div>
      </div>
      {copyStatus && (
        <p className="source-copy-status" role="status">
          {copyStatus}
        </p>
      )}
      <div className={`source-pane ${wrap ? 'source-wrap' : ''}`} tabIndex={0} role="region" aria-label={`Source of ${file.path}`}>
        {showingImage ? (
          <div className="source-media source-media-image">
            {mediaError ? (
              <p className="source-message">Could not render this image preview. Use Download to inspect the file.</p>
            ) : (
              <img
                src={mediaUrl}
                alt={file.path}
                onLoad={(e) => setImgDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                onError={() => setMediaError(true)}
              />
            )}
          </div>
        ) : kind === 'audio' ? (
          <div className="source-media source-media-audio">
            <div className="source-audio-card">
              <div className="source-audio-title">{file.path.split('/').pop()}</div>
              <div className="muted">
                {file.mime ?? 'Audio file'} · {formatBytes(file.size)}
              </div>
              {mediaError ? (
                <p className="source-message">This browser cannot play this audio format inline. Download it to listen locally.</p>
              ) : (
                <audio controls preload="metadata" src={mediaUrl} onError={() => setMediaError(true)}>
                  Your browser does not support inline audio playback.
                </audio>
              )}
            </div>
          </div>
        ) : kind === 'video' ? (
          <div className="source-media source-media-video">
            {mediaError ? (
              <p className="source-message">This browser cannot play this video format inline. Download it to watch locally.</p>
            ) : (
              <video controls preload="metadata" src={mediaUrl} onError={() => setMediaError(true)}>
                Your browser does not support inline video playback.
              </video>
            )}
          </div>
        ) : textContent === null ? (
          <div className="source-message">
            <p>
              Preview unavailable for this file. It may be binary or too large to display; download the bundle to read it.
            </p>
            {kind === 'text' && (
              <p style={{ marginTop: '0.65rem' }}>
                <button type="button" className="cta cta-small" disabled={loadingFull} onClick={() => void fetchFullText()}>
                  {loadingFull ? 'Loading file…' : 'Load full text'}
                </button>
                {loadFullError && <span className="form-error"> {loadFullError}</span>}
              </p>
            )}
          </div>
        ) : textContent.length === 0 ? (
          <p className="source-message">This file is empty.</p>
        ) : useHighlighter ? (
          <Code source={textContent} className="source-code" language={lang} />
        ) : (
          <pre className="source-code source-plain">
            <code>{textContent}</code>
          </pre>
        )}
      </div>
    </>
  );
}
