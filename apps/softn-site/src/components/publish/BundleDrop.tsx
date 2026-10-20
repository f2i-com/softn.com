import React, { useRef, useState } from 'react';
import { formatBytes } from '../../lib/format';
import { droppedFiles } from '../../lib/dropped';
import type { SelectionItem } from '../../lib/selection';

/**
 * A drop target for one .softn or several, or a folder of them, showing the
 * chosen item as far as its inspection has got.
 */
export function BundleDrop({ item, onFiles }: { item: SelectionItem | null; onFiles: (files: File[]) => void }): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const file = item?.file ?? null;
  const info = item?.info ?? null;
  return (
    <div
      className={`dropzone ${dragging ? 'over' : ''} ${file ? 'has-file' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        // The page-wide drop must not take these too.
        e.stopPropagation();
        setDragging(false);
        // A folder is opened for the bundles in it; its entries are taken
        // now, while the drop is being handled.
        void droppedFiles(e.dataTransfer).then((files) => {
          if (files.length > 0) onFiles(files);
        });
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".softn,application/zip,application/octet-stream"
        multiple
        hidden
        aria-label="Bundle files"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onFiles(files);
        }}
      />
      {file && item ? (
        <div className="dropzone-file">
          {info?.iconDataUrl && <img className="dropzone-icon" src={info.iconDataUrl} alt="" />}
          <div>
            <strong>{file.name}</strong> · {formatBytes(file.size)}
            {item.status === 'inspecting' && (
              <div className="muted" role="status">
                Reading…
              </div>
            )}
            {item.status === 'ready' && info && (
              <div className="muted">
                {info.name} v{info.version} · {info.files} files · entry {info.main}
                {info.execution === 'worker' && ' · off-main-thread'}
              </div>
            )}
            {item.status === 'rejected' && (
              <div className="form-error" role="alert">
                {item.error}
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          <svg className="dropzone-glyph" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 16V4m0 0-4 4m4-4 4 4" />
            <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
          </svg>
          <strong>Drop .softn files here</strong> or click to choose — one, several, or a whole folder dropped at once
        </>
      )}
    </div>
  );
}
