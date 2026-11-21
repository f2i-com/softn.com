/**
 * AssetView - an asset of the project, open in the middle of the workspace.
 *
 * One row says what it is (its path, its kind and size, and a picture's size
 * in pixels) and holds what can be done with it; one line says how a page
 * asks for it; the rest of the room is the picture itself, at its own size
 * or fitted to the room when it is larger, or a text file's text.
 *
 * It was a card 900px wide at most, centred in the panel, with the picture
 * in a box of its own inside the card, and nothing could be done from it: a
 * newer picture under the same name meant deleting this one and adding it
 * again (utils/addAssets.ts, replaceAsset). Laid out in styles/builder.css,
 * under Assets, by the width the view itself is given.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { strToU8 } from 'fflate';
import { assetObjectUrl, classifyAsset } from '@softn/core';
import { toast } from '../../stores/notificationStore';
import { useFilesStore } from '../../stores/filesStore';
import type { AssetFile } from '../../types/builder';
import { PICTURE_PATTERN, assetKindWords, endingOf, replaceAsset, replacedWords, replacementAccept, sizeWords } from '../../utils/addAssets';
import { assetCall } from '../../utils/assetSource';
import { CodeEditor } from '../editor/CodeEditor';
import { codeLanguageFor } from '../editor/logicLanguage';

const AUDIO_PATTERN = /\.(?:mp3|wav|ogg|oga|flac|m4a|aac|opus)$/i;
const VIDEO_PATTERN = /\.(?:mp4|m4v|webm|ogv|mov)$/i;

/** As much of a text file as is shown: a megabyte of JSON in one element stalls the panel. */
const TEXT_SHOWN_BYTES = 100 * 1024;

/** The picture as the browser read it from the address it was given, or that it could not. */
type Drawn = { url: string; width: number; height: number; failed: boolean };

function OpenAsset({ id, asset, path }: { id: string; asset: AssetFile; path: string }) {
  const picture = PICTURE_PATTERN.test(path);
  const audio = AUDIO_PATTERN.test(path);
  const video = VIDEO_PATTERN.test(path);
  const [pictureUrl, setPictureUrl] = useState<string | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [editingText, setEditingText] = useState(false);
  const [drawn, setDrawn] = useState<Drawn | null>(null);

  useEffect(() => {
    if (!picture) {
      setPictureUrl(null);
      return;
    }
    // An SVG as a `data:` URL (core assetObjectUrl), which "Open image in new
    // tab" cannot open as a page of the Builder, the bundle's script in it.
    const url = assetObjectUrl(path, Uint8Array.from(asset.data));
    setPictureUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [asset, path, picture]);

  useEffect(() => {
    if (!audio && !video) {
      setMediaUrl(null);
      return;
    }
    const { mime } = classifyAsset(path);
    const url = URL.createObjectURL(new Blob([Uint8Array.from(asset.data)], { type: mime }));
    setMediaUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [asset, path, audio, video]);

  // A text file's text, as far as it is shown.
  const text = useMemo(
    () => (picture || audio || video || classifyAsset(path).binary ? null : new TextDecoder().decode(Uint8Array.from(asset.data.slice(0, TEXT_SHOWN_BYTES)))),
    [asset, path, picture, audio, video]
  );
  const canEditText = text !== null && asset.data.byteLength <= TEXT_SHOWN_BYTES;

  // Another file in its place, under the same path. What is refused is said
  // here, where it was asked; what was done is said as a save is.
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const take = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      try {
        const result = await replaceAsset(id, file);
        setRefused(result.outcome === 'refused' ? result.reason : null);
        const said = replacedWords(result, file.name);
        if (said) (result.outcome === 'replaced' ? toast.success : toast.info)(said);
      } finally {
        setBusy(false);
      }
    },
    [id]
  );

  // The text a page writes to be given this file, onto the clipboard.
  const call = assetCall(path);
  const code = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(call);
      setCopied(true);
    } catch {
      // No clipboard for this page (it is not served over https, or was
      // refused it): the text is selected, to be copied by hand.
      const selection = window.getSelection();
      if (code.current && selection) {
        const range = document.createRange();
        range.selectNodeContents(code.current);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      toast.info('It could not be copied from here. The text is selected, so you can copy it yourself.');
    }
  }, [call]);
  useEffect(() => {
    if (!copied) return;
    const back = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(back);
  }, [copied]);

  const seen = drawn && drawn.url === pictureUrl ? drawn : null;
  // An SVG is a drawing, with no pixels of its own to count.
  const pixels = seen && !seen.failed && seen.width > 0 && endingOf(path) !== 'svg' ? `${seen.width} × ${seen.height} pixels` : null;
  const facts = [assetKindWords(path), sizeWords(asset.data.byteLength), pixels].filter((fact) => fact !== null);

  return (
    <div className="bl-asset" data-asset-view={picture ? 'picture' : audio ? 'audio' : video ? 'video' : text !== null ? 'text' : 'file'}>
      <div className="bl-asset-head">
        <h2 className="bl-asset-name">{path}</h2>
        <span className="bl-asset-facts" data-asset-facts="">
          {facts.join(' · ')}
        </span>
        <div className="bl-asset-actions">
          {canEditText && (
            <button
              type="button"
              className="bl-btn bl-btn-sm"
              data-action="edit-text-asset"
              onClick={() => setEditingText((v) => !v)}
            >
              {editingText ? 'View text' : 'Edit text'}
            </button>
          )}
          <button
            type="button"
            className="bl-btn bl-btn-sm"
            data-action="replace-asset"
            // Not `disabled` while a file is read and asked about: the question
            // hands the focus back to this button, and a disabled one cannot take it.
            aria-disabled={busy || undefined}
            title="Put another file in its place, under the same name"
            onClick={() => {
              if (!busy) input.current?.click();
            }}
          >
            Replace…
          </button>
          <input
            ref={input}
            type="file"
            hidden
            tabIndex={-1}
            aria-hidden="true"
            accept={replacementAccept(path)}
            data-replace-asset-input=""
            onChange={(e) => {
              const picked = e.target.files?.[0];
              // Emptied, so that the same file can be picked again.
              e.target.value = '';
              void take(picked);
            }}
          />
        </div>
      </div>

      {/* How a page asks for it: the Builder could list a picture and never said how one is shown. */}
      <div className="bl-asset-use" data-asset-use="">
        {picture ? 'To show it on a page, select an Image there and choose it under Asset. ' : ''}
        A page or the logic asks for it as{' '}
        <span className="bl-asset-call">
          <span>
            <code ref={code}>{call}</code>.
          </span>
          <button type="button" className="bl-mini" data-action="copy-asset-call" aria-label={copied ? 'Copied' : `Copy ${call}`} onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </div>

      {refused && (
        <div className="bl-notice bl-asset-said" data-tone="danger" role="alert">
          <span>{refused}</span>
          <button type="button" className="bl-asset-dismiss" onClick={() => setRefused(null)} aria-label="Dismiss message">
            ×
          </button>
        </div>
      )}

      {picture && pictureUrl && !seen?.failed && (
        <div className="bl-asset-stage">
          <img
            className="bl-asset-picture"
            src={pictureUrl}
            alt={path}
            onLoad={(e) => setDrawn({ url: pictureUrl, width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight, failed: false })}
            onError={() => setDrawn({ url: pictureUrl, width: 0, height: 0, failed: true })}
          />
        </div>
      )}
      {picture && seen?.failed && (
        <div className="bl-asset-note" data-asset-note="">
          This picture could not be drawn. The file may be damaged, or not the kind its name says. Replace it with one that opens on your computer.
        </div>
      )}
      {audio && mediaUrl && (
        <div className="bl-asset-stage" style={{ padding: 24 }}>
          <audio controls preload="metadata" src={mediaUrl} style={{ width: 'min(100%, 420px)' }}>
            Your browser cannot play this audio format inline.
          </audio>
        </div>
      )}
      {video && mediaUrl && (
        <div className="bl-asset-stage" style={{ padding: 24 }}>
          <video controls preload="metadata" src={mediaUrl} style={{ maxWidth: '100%', maxHeight: '60vh', borderRadius: 8, background: '#000' }}>
            Your browser cannot play this video format inline.
          </video>
        </div>
      )}
      {text !== null && editingText && (
        <div style={{ flex: 1, minHeight: 280, border: '1px solid var(--line-soft)', borderRadius: 8, overflow: 'hidden' }}>
          <CodeEditor
            value={text}
            onChange={(next) => useFilesStore.getState().replaceAssetFile(id, strToU8(next))}
            language={codeLanguageFor(path)}
            height="100%"
          />
        </div>
      )}
      {text !== null && !editingText && (
        <>
          <pre className="bl-asset-text" tabIndex={0} aria-label={`The text of ${path}`}>
            {text}
          </pre>
          {asset.data.byteLength > TEXT_SHOWN_BYTES && (
            <div className="bl-asset-more">The first {sizeWords(TEXT_SHOWN_BYTES)} of it is shown. The app carries all of it.</div>
          )}
        </>
      )}
      {!picture && !audio && !video && text === null && (
        <div className="bl-asset-note" data-asset-note="">
          Files of this kind are not shown here. Pictures (PNG, JPEG, GIF, WebP, SVG and BMP) and text files are. The app carries it as it is.
        </div>
      )}
    </div>
  );
}

export function AssetView() {
  const id = useFilesStore((state) => state.activeFileId);
  const asset = useFilesStore((state) => (state.activeFileId ? state.assetFiles.get(state.activeFileId) : undefined));
  const path = useFilesStore((state) => (state.activeFileId ? state.nodes.get(state.activeFileId)?.path : undefined));

  if (!id || !asset) {
    return (
      <div className="bl-asset-none">
        <div>
          <div className="bl-asset-none-title">File not found</div>
          <div>It is no longer in the project. Choose another file in the Files panel.</div>
        </div>
      </div>
    );
  }

  // Keyed by the file: what was said of one asset is not said of the next.
  return <OpenAsset key={id} id={id} asset={asset} path={path ?? asset.name} />;
}
