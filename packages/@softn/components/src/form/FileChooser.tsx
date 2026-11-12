/**
 * FileChooser Component
 *
 * File selection component with button and dropzone variants.
 * Supports single/multiple file selection, directory selection,
 * and drag-and-drop. Stores File objects in a global registry
 * with UUID references for later retrieval.
 */

import React, { useRef, useState, useCallback, useId, useMemo } from 'react';
import { registerFileRef, useAppScope } from '@softn/core';
import { TOUCH_MEDIA } from '../utils/media';

// ---- Types ----

export interface FileInfo {
  name: string;
  size: number;
  type: string;
  ref: string;
}

export interface FileChooserProps {
  /** Accepted file types (e.g. "image/*,.pdf") */
  accept?: string;
  /** Allow multiple file selection */
  multiple?: boolean;
  /** Allow directory selection */
  directory?: boolean;
  /** Button label (default "Choose File") */
  label?: string;
  /** Display variant (default 'button') */
  variant?: 'button' | 'dropzone';
  /** Called when files are selected, and with what is left when one is removed */
  onSelect?: (files: FileInfo[]) => void;
  /**
   * The files shown as chosen, when the page keeps them: what `onSelect`
   * handed it, and `[]` once they have been sent, which shows none. Left
   * out, the chooser shows what was last chosen until it is removed.
   */
  value?: FileInfo[] | null;
  /** Whether the chooser is turned off: nothing can be chosen, dropped or removed */
  disabled?: boolean;
  /** Additional CSS class, on the component's root */
  className?: string;
  /** Inline styles, on the button or the drop zone (as before `className` existed) */
  style?: React.CSSProperties;
}

/**
 * Whether `file` is one `accept` admits. A drop is not held to `accept` by
 * the browser, so a zone that said "Accepted: image/*" took a PDF; and the
 * picker only starts on it: its "All files" choice hands over anything, and
 * a picked PDF went to the page as a dropped one no longer did.
 */
function fileMatchesAccept(file: { name: string; type: string }, accept: string | undefined): boolean {
  if (!accept || !accept.trim()) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();
  return accept
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .some((token) => {
      if (token.startsWith('.')) return name.endsWith(token);
      if (token.endsWith('/*')) return type.startsWith(token.slice(0, -1));
      return type === token;
    });
}

/**
 * The same for a file the picker handed over. A file whose type the browser
 * does not know (it has none) is taken where `accept` names types: the
 * picker offered it, and there is nothing to hold it to.
 */
function pickedFileMatchesAccept(file: { name: string; type: string }, accept: string | undefined): boolean {
  if (fileMatchesAccept(file, accept)) return true;
  return !file.type && (accept ?? '').split(',').some((token) => token.includes('/'));
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function FileChooser({
  accept,
  multiple = false,
  directory = false,
  label = 'Choose File',
  variant = 'button',
  onSelect,
  value,
  disabled = false,
  className,
  style,
}: FileChooserProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [ownFiles, setOwnFiles] = useState<FileInfo[]>([]);
  // What is shown as chosen is the page's to say when it gives `value`: the
  // name of a file stayed on show after it had been sent, with no way for
  // the page to take it down. (`null`, as an unset variable arrives, is none.)
  const selectedFiles = useMemo(
    () => (value === undefined ? ownFiles : Array.isArray(value) ? value.filter((info) => info && typeof info === 'object') : []),
    [value, ownFiles]
  );
  const [isDragOver, setIsDragOver] = useState(false);
  const [rejected, setRejected] = useState(0);
  const hintId = useId();

  // Held for the app, not for this chooser: the app's logic may read a ref
  // after the chooser has gone, and the app's closing lets them go.
  const { filesOwner } = useAppScope();

  const processFiles = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      const infos: FileInfo[] = fileArray.map((file) => {
        const ref = registerFileRef(file, filesOwner);
        return {
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
          ref,
        };
      });
      setOwnFiles(infos);
      setRejected(0);
      onSelect?.(infos);
    },
    [onSelect, filesOwner]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        // Held to `accept`, as a drop is (see pickedFileMatchesAccept).
        const picked = Array.from(e.target.files);
        const accepted = picked.filter((file) => pickedFileMatchesAccept(file, accept));
        if (accepted.length > 0) processFiles(accepted);
        setRejected(picked.length - accepted.length);
      }
      // Reset input value so the same file can be re-selected
      e.target.value = '';
    },
    [processFiles, accept]
  );

  const handleClick = useCallback(() => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  /** Take a chosen file back: the page is handed what is left. */
  const removeFile = useCallback(
    (ref: string | null) => {
      const left = ref === null ? [] : selectedFiles.filter((info) => info.ref !== ref);
      setOwnFiles(left);
      setRejected(0);
      onSelect?.(left);
    },
    [selectedFiles, onSelect]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) setIsDragOver(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Crossing from the zone onto the icon or the text inside it is a
    // dragleave too; only leaving the zone itself ends the hover.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (disabled) return;

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const dropped = Array.from(e.dataTransfer.files);
        const accepted = dropped.filter((file) => fileMatchesAccept(file, accept));
        const files = multiple ? accepted : accepted.slice(0, 1);
        if (files.length > 0) processFiles(files);
        setRejected(dropped.length - accepted.length);
      }
    },
    [accept, multiple, processFiles, disabled]
  );

  // Additional input attributes for directory mode
  const directoryAttrs: Record<string, string> = directory
    ? { webkitdirectory: '', directory: '' }
    : {};

  // Shared input element
  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept={accept}
      multiple={multiple}
      disabled={disabled}
      onChange={handleChange}
      style={{ display: 'none' }}
      {...directoryAttrs}
    />
  );

  const rejectedNote =
    rejected > 0 ? `${rejected} ${rejected === 1 ? 'file was' : 'files were'} not an accepted type` : '';

  const removeButtonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    width: '1.5rem',
    height: '1.5rem',
    padding: 0,
    border: 'none',
    borderRadius: '0.25rem',
    background: 'none',
    color: 'var(--color-text-muted, inherit)',
    cursor: 'pointer',
  };
  const removeButton = (label: string, ref: string | null) => (
    <button
      type="button"
      className="softn-file-remove"
      style={removeButtonStyle}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        removeFile(ref);
      }}
    >
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 4l6 6M10 4l-6 6" strokeLinecap="round" />
      </svg>
    </button>
  );
  // Under a finger the button is 44 pixels tall and a remove button takes a press 44 across.
  const touchRules = (
    <style>{`${TOUCH_MEDIA} {
      .softn-file-button { min-height: 44px; }
      .softn-file-remove { width: 44px !important; height: 44px !important; margin: -10px; }
    }`}</style>
  );

  // ---- Button variant ----
  if (variant === 'button') {
    const buttonStyle: React.CSSProperties = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.5rem',
      padding: '0.5rem 1rem',
      border: '1px solid var(--color-border, rgba(255, 255, 255, 0.12))',
      borderRadius: '0.375rem',
      backgroundColor: 'var(--color-surface, #1e1e2e)',
      color: 'var(--color-text, #e4e4e7)',
      fontSize: '0.875rem',
      fontWeight: 500,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.6 : 1,
      transition: 'background-color 0.15s, border-color 0.15s',
      ...style,
    };

    const fileNameStyle: React.CSSProperties = {
      fontSize: '0.8125rem',
      color: 'var(--color-text-muted, #a1a1aa)',
      marginLeft: '0.25rem',
      maxWidth: 200,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    };

    return (
      <div className={className} style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', maxWidth: '100%' }}>
        {fileInput}
        <button type="button" className="softn-file-button" style={buttonStyle} onClick={handleClick} disabled={disabled}>
          {/* Upload icon */}
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{ flexShrink: 0 }}
          >
            <path
              d="M8 1v10M4 5l4-4 4 4M2 12v1.5A1.5 1.5 0 003.5 15h9a1.5 1.5 0 001.5-1.5V12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {label}
        </button>
        <span style={fileNameStyle} aria-live="polite">
          {selectedFiles.length === 0
            ? ''
            : selectedFiles.length === 1
              ? selectedFiles[0].name
              : `${selectedFiles.length} files selected`}
        </span>
        {selectedFiles.length > 0 &&
          !disabled &&
          removeButton(selectedFiles.length === 1 ? `Remove ${selectedFiles[0].name}` : `Remove ${selectedFiles.length} files`, null)}
        <span role="status" style={{ fontSize: '0.75rem', color: 'var(--color-error-500, currentColor)' }}>
          {rejectedNote}
        </span>
        {touchRules}
      </div>
    );
  }

  // ---- Dropzone variant ----
  const dropzoneStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    padding: '2rem 1.5rem',
    border: `2px dashed ${isDragOver ? 'var(--color-primary, #6366f1)' : 'var(--color-border, rgba(255, 255, 255, 0.12))'}`,
    borderRadius: '0.5rem',
    backgroundColor: isDragOver
      ? 'rgba(99, 102, 241, 0.06)'
      : 'var(--color-surface, #1e1e2e)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    transition: 'border-color 0.15s, background-color 0.15s',
    textAlign: 'center',
    ...style,
  };

  const iconStyle: React.CSSProperties = {
    color: isDragOver ? 'var(--color-primary, #6366f1)' : 'var(--color-text-muted, #a1a1aa)',
    transition: 'color 0.15s',
  };

  const textStyle: React.CSSProperties = {
    fontSize: '0.875rem',
    color: 'var(--color-text, #e4e4e7)',
    fontWeight: 500,
  };

  const subtextStyle: React.CSSProperties = {
    fontSize: '0.75rem',
    color: 'var(--color-text-muted, #a1a1aa)',
  };

  const fileListStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    width: '100%',
    marginTop: '0.5rem',
  };

  const fileItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.375rem 0.625rem',
    borderRadius: '0.25rem',
    backgroundColor: 'var(--color-surface-hover, rgba(255, 255, 255, 0.04))',
    fontSize: '0.8125rem',
    color: 'var(--color-text, #e4e4e7)',
  };

  // The zone takes a click anywhere for the mouse; the label inside it is a
  // real button, so the keyboard reaches it and a screen reader hears what
  // it does. (The zone itself was a <div onClick>: no tab stop, no Enter.)
  const labelButtonStyle: React.CSSProperties = {
    ...textStyle,
    padding: 0,
    border: 'none',
    background: 'none',
    font: 'inherit',
    fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    borderRadius: '0.25rem',
  };

  return (
    <div className={className}>
      {fileInput}
      <div
        style={dropzoneStyle}
        onClick={handleClick}
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Cloud upload icon */}
        <svg
          aria-hidden="true"
          width="40"
          height="40"
          viewBox="0 0 40 40"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={iconStyle}
        >
          <path
            d="M20 26V14M16 18l4-4 4 4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M28 26h1a5 5 0 001.7-9.7A7 7 0 0017 13a7 7 0 00-6.7 5A5 5 0 0011 28h1"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>

        <button
          type="button"
          style={labelButtonStyle}
          aria-describedby={hintId}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            handleClick();
          }}
        >
          {isDragOver ? 'Drop files here' : label}
        </button>
        <div id={hintId} style={subtextStyle}>
          {directory
            ? 'Select a folder or drag and drop'
            : multiple
              ? 'Drag and drop files, or click to browse'
              : 'Drag and drop a file, or click to browse'}
        </div>

        {accept && (
          <div style={{ ...subtextStyle, marginTop: '0.25rem' }}>
            Accepted: {accept}
          </div>
        )}

        <div role="status" style={{ ...subtextStyle, color: 'var(--color-error-500, currentColor)' }}>
          {rejectedNote}
        </div>

        {/* Selected files list */}
        {selectedFiles.length > 0 && (
          <div style={fileListStyle} onClick={(e) => e.stopPropagation()}>
            {selectedFiles.map((file, index) => (
              <div key={file.ref ?? index} style={fileItemStyle}>
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '70%',
                  }}
                >
                  {file.name}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                  <span style={{ color: 'var(--color-text-muted, #a1a1aa)', fontSize: '0.75rem' }}>
                    {formatFileSize(Number(file.size) || 0)}
                  </span>
                  {!disabled && removeButton(`Remove ${file.name}`, file.ref)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {touchRules}
    </div>
  );
}

export default FileChooser;
