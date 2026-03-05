import React from 'react';

export type FileGlyphKind = 'folder-open' | 'folder' | 'ui' | 'logic' | 'file';

interface FileGlyphProps {
  kind: FileGlyphKind;
  size?: number;
  color?: string;
}

export function FileGlyph({ kind, size = 14, color = '#475569' }: FileGlyphProps) {
  const common: React.CSSProperties = {
    width: size,
    height: size,
    color,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };

  if (kind === 'folder' || kind === 'folder-open') {
    return (
      <span style={common} aria-hidden="true">
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <path
            d="M1.5 4.5C1.5 3.67 2.17 3 3 3h2.5l1.2 1.4H13c.83 0 1.5.67 1.5 1.5v6.6c0 .83-.67 1.5-1.5 1.5H3c-.83 0-1.5-.67-1.5-1.5V4.5Z"
            stroke={color}
            strokeWidth="1.2"
            fill={kind === 'folder-open' ? '#eff6ff' : 'transparent'}
          />
          {kind === 'folder-open' && (
            <path d="M2.3 6.5h11.4" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
          )}
        </svg>
      </span>
    );
  }

  if (kind === 'ui') {
    return (
      <span style={common} aria-hidden="true">
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <rect x="2" y="2.5" width="12" height="11" rx="1.6" stroke={color} strokeWidth="1.2" />
          <path d="M2.5 5.2h11" stroke={color} strokeWidth="1.2" />
          <circle cx="4.2" cy="3.9" r="0.7" fill={color} />
          <circle cx="6" cy="3.9" r="0.7" fill={color} />
        </svg>
      </span>
    );
  }

  if (kind === 'logic') {
    return (
      <span style={common} aria-hidden="true">
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <path
            d="M8.8 1.8 4.4 8h3l-.3 6.2L11.6 8H8.6l.2-6.2Z"
            fill="#dbeafe"
            stroke={color}
            strokeWidth="1.1"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  return (
    <span style={common} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        <path d="M4 1.8h5.1l3 3v9.4H4V1.8Z" stroke={color} strokeWidth="1.2" />
        <path d="M9.1 1.9V5h3.1" stroke={color} strokeWidth="1.2" />
      </svg>
    </span>
  );
}
