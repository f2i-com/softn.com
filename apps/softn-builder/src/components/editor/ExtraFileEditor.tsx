/**
 * ExtraFileEditor - Edit ANY backend or project file stored in `source.extraEntries`
 * (PHP, Rust, Python, SQL, Go, JS/TS, TOML, YAML, JSON, .htaccess, Markdown, etc.)
 * and preview/play bundled image, audio, and video files directly inside Builder.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { strToU8 } from 'fflate';
import { assetObjectUrl } from '@softn/core';
import { useProjectStore } from '../../stores/projectStore';
import { askConfirm } from '../../utils/confirm';
import { sizeWords } from '../../utils/addAssets';
import { startsWithByteOrderMark } from '../../utils/bundleExporter';
import { CodeEditor } from './CodeEditor';
import { EditorWayOut } from './EditorWayOut';
import { codeLanguageFor, codeLanguageLabelFor } from './logicLanguage';

const IMAGE_RE = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i;
const AUDIO_RE = /\.(?:mp3|wav|ogg|oga|flac|m4a|aac|opus)$/i;
const VIDEO_RE = /\.(?:mp4|m4v|webm|ogv|mov)$/i;
const BINARY_RE = /\.(?:woff2?|ttf|otf|eot|wasm|db|sqlite3?|zip|gz|tar|7z|rar|pdf|bin|dat|glb|exe|dll|so|dylib|pyc|o|a)$/i;

function isUtf8Text(bytes: Uint8Array): boolean {
  const sampleLen = Math.min(bytes.byteLength, 8192);
  for (let i = 0; i < sampleLen; i++) {
    if (bytes[i] === 0) return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function encodeWithOptionalBom(text: string, bom: boolean): Uint8Array {
  const body = strToU8(text);
  if (!bom) return body;
  const out = new Uint8Array(3 + body.length);
  out[0] = 0xef;
  out[1] = 0xbb;
  out[2] = 0xbf;
  out.set(body, 3);
  return out;
}

function mediaMimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    opus: 'audio/opus',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    ogv: 'video/ogg',
    mov: 'video/quicktime',
  };
  return map[ext] ?? 'application/octet-stream';
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--ink-2)',
  },
  header: {
    minHeight: 40,
    gap: 10,
    padding: '6px 16px',
    borderBottom: '1px solid var(--line-soft)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  path: {
    fontFamily: 'var(--mono)',
    fontSize: 12.5,
    fontWeight: 500,
    color: 'var(--paper)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    fontSize: 11.5,
    color: 'var(--dim)',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  editorWrapper: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  mediaStage: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 14,
  },
  image: {
    maxWidth: '100%',
    maxHeight: '65vh',
    objectFit: 'contain',
    borderRadius: 8,
    border: '1px solid var(--line-soft)',
  },
  audioCard: {
    width: 'min(100%, 420px)',
    padding: '18px 20px',
    borderRadius: 12,
    background: 'var(--ink)',
    border: '1px solid var(--line-soft)',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  video: {
    maxWidth: '100%',
    maxHeight: '65vh',
    borderRadius: 10,
    background: '#000',
  },
  empty: {
    padding: 24,
    color: 'var(--dim)',
    fontSize: 13,
    lineHeight: 1.55,
  },
};

export function ExtraFileEditor({ path }: { path: string }) {
  const bytes = useProjectStore((state) => state.source.extraEntries.get(path));
  const setExtraEntry = useProjectStore((state) => state.setExtraEntry);
  const deleteExtraEntry = useProjectStore((state) => state.deleteExtraEntry);
  const closeExtraFile = useProjectStore((state) => state.closeExtraFile);

  const isImage = IMAGE_RE.test(path);
  const isSvg = /\.svg$/i.test(path);
  const isAudio = AUDIO_RE.test(path);
  const isVideo = VIDEO_RE.test(path);
  const isSqlite = /\.(?:db|sqlite3?)$/i.test(path);
  const isBackend = /^(?:server|backend)\//i.test(path) || /\.(?:php|phtml|rs|sql)$/i.test(path);

  const [svgEdit, setSvgEdit] = useState(false);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);

  useEffect(() => {
    setSvgEdit(false);
  }, [path]);

  useEffect(() => {
    if (!bytes || (!isImage && !isAudio && !isVideo)) {
      setMediaUrl(null);
      return;
    }
    const url = isImage
      ? assetObjectUrl(path, Uint8Array.from(bytes))
      : URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: mediaMimeFor(path) }));
    setMediaUrl(url);
    return () => {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    };
  }, [bytes, path, isImage, isAudio, isVideo]);

  const decoded = useMemo(() => {
    if (!bytes) return null;
    if ((isImage && !isSvg) || isAudio || isVideo || BINARY_RE.test(path)) return null;
    if (!isUtf8Text(bytes)) return null;
    return {
      text: new TextDecoder().decode(bytes),
      bom: startsWithByteOrderMark(bytes),
    };
  }, [bytes, path, isImage, isSvg, isAudio, isVideo]);

  if (!bytes) {
    return (
      <div style={styles.container}>
        <div style={styles.empty}>
          File <code>{path}</code> is no longer in the project. Choose another file in the Files panel.
        </div>
      </div>
    );
  }

  const language = codeLanguageFor(path);
  const badgeLabel = isImage
    ? 'Image'
    : isAudio
      ? 'Audio'
      : isVideo
        ? 'Video'
        : decoded
          ? codeLanguageLabelFor(path)
          : 'Binary';

  const handleDownload = () => {
    const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() || 'file';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleDelete = async () => {
    const yes = await askConfirm(`Delete "${path}" from this project?`, {
      title: 'Delete file',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (yes) deleteExtraEntry(path);
  };

  const showingCode = decoded !== null && (!isImage || (isSvg && svgEdit));

  return (
    <div style={styles.container} data-extra-editor={path}>
      <div style={styles.header}>
        <span style={styles.titleRow}>
          {isBackend && (
            <span className="bl-badge" data-tone="warn">
              Backend
            </span>
          )}
          <span className="bl-badge" data-tone="code" data-extra-language={language}>
            {badgeLabel}
          </span>
          <span style={styles.path} title={path}>
            {path}
          </span>
          <span style={styles.meta}>{sizeWords(bytes.byteLength)}</span>
        </span>
        <div style={styles.actions}>
          {isSvg && decoded && (
            <button
              type="button"
              className="bl-btn bl-btn-sm"
              onClick={() => setSvgEdit((v) => !v)}
            >
              {svgEdit ? 'Preview SVG' : 'Edit SVG code'}
            </button>
          )}
          <button type="button" className="bl-btn bl-btn-sm" onClick={handleDownload}>
            Download
          </button>
          <button type="button" className="bl-btn bl-btn-sm" onClick={() => void handleDelete()}>
            Delete
          </button>
          <button
            type="button"
            className="bl-mini"
            onClick={() => closeExtraFile(path)}
            aria-label={`Close ${path}`}
            title="Close tab"
          >
            ×
          </button>
        </div>
      </div>

      {showingCode && (
        <>
          <EditorWayOut style={{ display: 'block', padding: '3px 16px', borderBottom: '1px solid var(--line-soft)' }} />
          <div style={styles.editorWrapper}>
            <CodeEditor
              value={decoded.text}
              onChange={(next) => setExtraEntry(path, encodeWithOptionalBom(next, decoded.bom))}
              language={language}
              height="100%"
            />
          </div>
        </>
      )}

      {!showingCode && isImage && mediaUrl && (
        <div style={styles.mediaStage}>
          <img src={mediaUrl} alt={path} style={styles.image} />
        </div>
      )}

      {!showingCode && isAudio && mediaUrl && (
        <div style={styles.mediaStage}>
          <div style={styles.audioCard}>
            <strong style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{path.split('/').pop()}</strong>
            <span style={styles.meta}>{sizeWords(bytes.byteLength)}</span>
            <audio controls preload="metadata" src={mediaUrl} style={{ width: '100%' }}>
              Your browser cannot play this audio format inline.
            </audio>
          </div>
        </div>
      )}

      {!showingCode && isVideo && mediaUrl && (
        <div style={styles.mediaStage}>
          <video controls preload="metadata" src={mediaUrl} style={styles.video}>
            Your browser cannot play this video format inline.
          </video>
        </div>
      )}

      {!showingCode && !isImage && !isAudio && !isVideo && (
        <div style={styles.empty}>
          <p>
            <strong>{path}</strong> is a binary file ({sizeWords(bytes.byteLength)}) and is preserved in your exported and published{' '}
            <code>.softn</code> bundle.
          </p>
          {isSqlite && (
            <p style={{ marginTop: 8 }}>
              Tip: open the <strong>Data</strong> tab in the top toolbar to browse tables, run queries, and edit SQLite schema &amp; rows visually.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
