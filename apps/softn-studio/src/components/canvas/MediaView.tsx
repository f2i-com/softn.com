import React, { useEffect, useMemo, useState } from 'react';
import { classifyAsset } from '@softn/core';
import { Icon } from '../common/Icon';
import '../../styles/code.css';

export type MediaKind = 'image' | 'audio' | 'video' | 'font' | 'pdf';

/** Image formats a browser draws in an <img>; the rest of core's image list (tiff, hdr, exr) it does not. */
const BROWSER_IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'bmp']);
/** Font formats FontFace loads; .eot is Internet Explorer's. */
const BROWSER_FONTS = new Set(['woff', 'woff2', 'ttf', 'otf']);

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
}

/** Which viewer shows a file, from core's classification of its name; null for none. */
export function mediaKindFor(path: string): MediaKind | null {
  const ext = extension(path);
  const { kind } = classifyAsset(path);
  if (kind === 'image') return BROWSER_IMAGES.has(ext) ? 'image' : null;
  if (kind === 'audio') return 'audio';
  if (kind === 'video') return 'video';
  if (kind === 'font') return BROWSER_FONTS.has(ext) ? 'font' : null;
  if (ext === 'pdf') return 'pdf';
  return null;
}

const KIND_LABEL: Record<MediaKind, string> = { image: 'Image', audio: 'Audio', video: 'Video', font: 'Font', pdf: 'PDF document' };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * An object URL for the file's bytes, typed with core's MIME for its name,
 * created in an effect and revoked when the file changes or the view goes —
 * never in render, where an abandoned render would leak it. Text content (an
 * SVG kept as text) becomes a Blob too, so it is shown through <img> and never
 * put into this document.
 */
function useObjectUrl(content: string | Uint8Array, mime: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const part: BlobPart = typeof content === 'string'
      ? content
      : content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
    const next = URL.createObjectURL(new Blob([part], { type: mime }));
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(null);
    };
  }, [content, mime]);
  return url;
}

let fontCounter = 0;

function FontSpecimen({ url, name }: { url: string; name: string }): React.ReactElement {
  const [family, setFamily] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (typeof FontFace === 'undefined' || !document.fonts) {
      setFailed(true);
      return;
    }
    const familyName = `studio-specimen-${++fontCounter}`;
    const face = new FontFace(familyName, `url(${url})`);
    let active = true;
    setFailed(false);
    setFamily(null);
    face.load().then(
      (loaded) => {
        if (!active) return;
        document.fonts.add(loaded);
        setFamily(familyName);
      },
      () => { if (active) setFailed(true); },
    );
    return () => {
      active = false;
      document.fonts.delete(face);
    };
  }, [url]);

  if (failed) {
    return (
      <div className="st-media-empty" role="status">
        <strong>This font could not be loaded</strong>
        The browser did not accept {name} as a font. It may be damaged, or in a format this browser does not read.
      </div>
    );
  }
  if (!family) return <div className="st-loading" role="status">Loading font…</div>;
  return (
    <div className="st-media-font" style={{ fontFamily: `"${family}", var(--studio-body)` }}>
      <span className="st-media-font-lg">The quick brown fox jumps over the lazy dog</span>
      <span className="st-media-font-md">ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789</span>
      <span className="st-media-font-sm">Sphinx of black quartz, judge my vow. !?&amp;@#%(){}[]</span>
    </div>
  );
}

interface MediaViewProps {
  path: string;
  content: string | Uint8Array;
}

/**
 * A project file the browser can show as itself: an image, audio or video
 * with the native controls, a font as a specimen, a PDF in the browser's own
 * viewer. Anything else gets its name, type and size and a way to download
 * it, instead of a screen of decoded bytes.
 */
export function MediaView({ path, content }: MediaViewProps): React.ReactElement {
  const kind = mediaKindFor(path);
  const { mime } = classifyAsset(path);
  const url = useObjectUrl(content, mime);
  const name = path.split('/').pop() ?? path;
  const size = useMemo(
    () => (typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength),
    [content],
  );
  const [dimensions, setDimensions] = useState<string | null>(null);
  useEffect(() => setDimensions(null), [url]);

  let stage: React.ReactNode;
  if (!url) {
    stage = null;
  } else if (kind === 'image') {
    stage = (
      <img
        src={url}
        alt={name}
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget;
          if (naturalWidth && naturalHeight) setDimensions(`${naturalWidth} × ${naturalHeight}`);
        }}
      />
    );
  } else if (kind === 'audio') {
    stage = (
      <div className="st-media-audio">
        <span className="st-media-audio-title">{name}</span>
        <audio controls src={url} aria-label={`Play ${name}`} preload="metadata" />
      </div>
    );
  } else if (kind === 'video') {
    stage = <video controls src={url} aria-label={`Play ${name}`} preload="metadata" />;
  } else if (kind === 'font') {
    stage = <FontSpecimen url={url} name={name} />;
  } else if (kind === 'pdf') {
    stage = (
      <object data={url} type="application/pdf" className="st-media-pdf" aria-label={name}>
        <div className="st-media-empty">
          <strong>This browser does not show PDFs inline</strong>
          Use Open in a new tab below to read it.
        </div>
      </object>
    );
  } else {
    stage = (
      <div className="st-media-empty" role="status">
        <Icon name="file" size={28} />
        <strong>No preview for this file type</strong>
        Studio can show images, audio, video, fonts, PDFs and text. This file is kept in the bundle as it is; download it to open it elsewhere.
      </div>
    );
  }

  const typeLabel = kind ? KIND_LABEL[kind] : 'File';
  return (
    <div className="st-media" data-media-kind={kind ?? 'other'}>
      <div className="st-media-stage" data-kind={kind ?? 'other'}>{stage}</div>
      <div className="st-media-info">
        <span className="st-media-name">{name}</span>
        <span>{typeLabel}, <span className="num">{mime}</span></span>
        <span className="num">{formatBytes(size)}</span>
        {dimensions && <span className="num">{dimensions}</span>}
        {url && (kind === 'pdf' ? (
          <a href={url} target="_blank" rel="noopener noreferrer">Open in a new tab</a>
        ) : (
          <a href={url} download={name}>Download</a>
        ))}
      </div>
    </div>
  );
}
