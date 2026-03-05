/**
 * FileChooser Component
 *
 * File selection component with button and dropzone variants.
 * Supports single/multiple file selection, directory selection,
 * and drag-and-drop. Stores File objects in a global registry
 * with UUID references for later retrieval.
 */

import React, { useRef, useState, useCallback } from 'react';
import { registerFileRef } from '@softn/core';

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
  /** Called when files are selected */
  onSelect?: (files: FileInfo[]) => void;
  /** Inline styles */
  style?: React.CSSProperties;
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
  style,
}: FileChooserProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedFiles, setSelectedFiles] = useState<FileInfo[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);

  const processFiles = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      const infos: FileInfo[] = fileArray.map((file) => {
        const ref = registerFileRef(file);
        return {
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
          ref,
        };
      });
      setSelectedFiles(infos);
      onSelect?.(infos);
    },
    [onSelect]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        processFiles(e.target.files);
      }
      // Reset input value so the same file can be re-selected
      e.target.value = '';
    },
    [processFiles]
  );

  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const files = multiple
          ? Array.from(e.dataTransfer.files)
          : [e.dataTransfer.files[0]];
        processFiles(files);
      }
    },
    [multiple, processFiles]
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
      onChange={handleChange}
      style={{ display: 'none' }}
      {...directoryAttrs}
    />
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
      cursor: 'pointer',
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
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
        {fileInput}
        <button type="button" style={buttonStyle} onClick={handleClick}>
          {/* Upload icon */}
          <svg
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
        {selectedFiles.length > 0 && (
          <span style={fileNameStyle}>
            {selectedFiles.length === 1
              ? selectedFiles[0].name
              : `${selectedFiles.length} files selected`}
          </span>
        )}
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
    cursor: 'pointer',
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
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    fontSize: '0.8125rem',
    color: 'var(--color-text, #e4e4e7)',
  };

  return (
    <div>
      {fileInput}
      <div
        style={dropzoneStyle}
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Cloud upload icon */}
        <svg
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

        <div style={textStyle}>
          {isDragOver ? 'Drop files here' : label}
        </div>
        <div style={subtextStyle}>
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

        {/* Selected files list */}
        {selectedFiles.length > 0 && (
          <div style={fileListStyle} onClick={(e) => e.stopPropagation()}>
            {selectedFiles.map((file) => (
              <div key={file.ref} style={fileItemStyle}>
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
                <span style={{ color: 'var(--color-text-muted, #a1a1aa)', fontSize: '0.75rem', flexShrink: 0 }}>
                  {formatFileSize(file.size)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default FileChooser;
