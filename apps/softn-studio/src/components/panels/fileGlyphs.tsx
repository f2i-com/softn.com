import React from 'react';
import { classifyAsset } from '@softn/core';
import { isLogicPath, isPagePath } from '../../lib/sourceKinds';

/**
 * The small drawings of the Files panel: one for each kind of file, so a row
 * says what it is before its name is read, and one for each thing a menu does.
 *
 * Every file in the tree had the same sheet of paper beside it. These are
 * drawn as lines on a 16-pixel grid, the size a row shows them at, where the
 * filled icons the rail uses (common/Icon.tsx, drawn for 24) blur into blots.
 */

export type GlyphName =
  // Kinds of file
  | 'folder' | 'folder-open' | 'page' | 'logic' | 'data' | 'settings' | 'style' | 'picture' | 'sound' | 'video' | 'font' | 'text' | 'document' | 'file'
  // Things to do
  | 'more' | 'new-file' | 'new-folder' | 'add' | 'open' | 'rename' | 'duplicate' | 'copy' | 'cut' | 'paste' | 'download' | 'path' | 'delete' | 'undo' | 'close' | 'chevron';

const SHAPES: Record<GlyphName, React.ReactNode> = {
  folder: <path d="M1.75 4.25c0-.55.45-1 1-1h3.1l1.4 1.5h6c.55 0 1 .45 1 1v6.5c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z" />,
  'folder-open': (
    <>
      <path d="M1.75 11.75v-7.5c0-.55.45-1 1-1h3.1l1.4 1.5h5c.55 0 1 .45 1 1v1" />
      <path d="M1.9 12.6 3.6 7.5c.1-.4.5-.75.95-.75h9.2c.65 0 1.1.65.9 1.25l-1.4 4.55c-.13.42-.5.7-.95.7H2.75c-.6 0-1-.3-.85-.65z" />
    </>
  ),
  page: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25" />
      <path d="M1.75 5.75h12.5M4 4.3h.01M6 4.3h.01" />
    </>
  ),
  logic: <path d="M5.75 4.5 2.25 8l3.5 3.5M10.25 4.5 13.75 8l-3.5 3.5" />,
  data: (
    <>
      <ellipse cx="8" cy="4.25" rx="5" ry="2" />
      <path d="M3 4.25v7.5c0 1.1 2.24 2 5 2s5-.9 5-2v-7.5M3 8c0 1.1 2.24 2 5 2s5-.9 5-2" />
    </>
  ),
  settings: (
    <path d="M6 2.5c-1.4 0-1.9.6-1.9 1.9v1.7c0 .9-.5 1.6-1.6 1.9 1.1.3 1.6 1 1.6 1.9v1.7c0 1.3.5 1.9 1.9 1.9M10 2.5c1.4 0 1.9.6 1.9 1.9v1.7c0 .9.5 1.6 1.6 1.9-1.1.3-1.6 1-1.6 1.9v1.7c0 1.3-.5 1.9-1.9 1.9" />
  ),
  style: <path d="M6.25 2.5 5 13.5M11 2.5 9.75 13.5M3 5.75h10.5M2.5 10.25H13" />,
  picture: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25" />
      <circle cx="5.4" cy="6.2" r="1.1" />
      <path d="m2 11.6 3.4-3.1 2.4 2.1 2.3-2.4 3.9 3.6" />
    </>
  ),
  sound: (
    <>
      <path d="M6 11.25V3.6l6.25-1.35v7.75" />
      <circle cx="4.25" cy="11.25" r="1.75" />
      <circle cx="10.5" cy="10" r="1.75" />
    </>
  ),
  video: (
    <>
      <rect x="1.75" y="3.5" width="8.75" height="9" rx="1.25" />
      <path d="m10.5 7 3.75-2v6l-3.75-2" />
    </>
  ),
  font: <path d="M3.25 13 8 2.75 12.75 13M5 9.5h6" />,
  text: (
    <>
      <path d="M4 1.75h5.25L12.5 5v8.25c0 .55-.45 1-1 1H4c-.55 0-1-.45-1-1v-10.5c0-.55.45-1 1-1z" />
      <path d="M9 1.75V5h3.5M5.5 8h5M5.5 10.75h5" />
    </>
  ),
  document: (
    <>
      <path d="M4 1.75h5.25L12.5 5v8.25c0 .55-.45 1-1 1H4c-.55 0-1-.45-1-1v-10.5c0-.55.45-1 1-1z" />
      <path d="M9 1.75V5h3.5M5.5 8.25h5M5.5 10.5h3" />
    </>
  ),
  file: (
    <>
      <path d="M4 1.75h5.25L12.5 5v8.25c0 .55-.45 1-1 1H4c-.55 0-1-.45-1-1v-10.5c0-.55.45-1 1-1z" />
      <path d="M9 1.75V5h3.5" />
    </>
  ),
  more: <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.25" />,
  'new-file': (
    <>
      <path d="M12.5 7V5L9.25 1.75H4c-.55 0-1 .45-1 1v10.5c0 .55.45 1 1 1h3.5" />
      <path d="M9 1.75V5h3.5M11.75 9.5v4.5M9.5 11.75H14" />
    </>
  ),
  'new-folder': (
    <>
      <path d="M14.25 8V5.75c0-.55-.45-1-1-1h-6l-1.4-1.5h-3.1c-.55 0-1 .45-1 1v8c0 .55.45 1 1 1H8" />
      <path d="M11.75 9.75v4.5M9.5 12H14" />
    </>
  ),
  add: <path d="M8 10.5V2.5M4.75 5.5 8 2.25l3.25 3.25M2.5 10.25v2c0 .7.55 1.25 1.25 1.25h8.5c.7 0 1.25-.55 1.25-1.25v-2" />,
  open: (
    <>
      <path d="M1.5 8s2.4-4.25 6.5-4.25S14.5 8 14.5 8 12.1 12.25 8 12.25 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </>
  ),
  rename: <path d="M2.5 13.5h2.6l7.6-7.6a1.3 1.3 0 0 0 0-1.85l-.75-.75a1.3 1.3 0 0 0-1.85 0L2.5 10.9zM9 4.4l2.6 2.6" />,
  duplicate: (
    <>
      <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.25" />
      <path d="M10.75 5.25v-2c0-.55-.45-1-1-1h-6.5c-.55 0-1 .45-1 1v6.5c0 .55.45 1 1 1h2M9.5 7.5v4M7.5 9.5h4" />
    </>
  ),
  copy: (
    <>
      <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.25" />
      <path d="M10.75 5.25v-2c0-.55-.45-1-1-1h-6.5c-.55 0-1 .45-1 1v6.5c0 .55.45 1 1 1h2" />
    </>
  ),
  cut: (
    <>
      <circle cx="4" cy="11.75" r="1.9" />
      <circle cx="12" cy="11.75" r="1.9" />
      <path d="M5.2 10.3 12.5 2M10.8 10.3 3.5 2" />
    </>
  ),
  paste: (
    <>
      <path d="M5.5 3.25h-1.25c-.55 0-1 .45-1 1v9c0 .55.45 1 1 1h7.5c.55 0 1-.45 1-1v-9c0-.55-.45-1-1-1H10.5" />
      <rect x="5.5" y="1.75" width="5" height="3" rx=".9" />
    </>
  ),
  download: <path d="M8 2.25v8M4.75 7.25 8 10.5l3.25-3.25M2.5 10.25v2c0 .7.55 1.25 1.25 1.25h8.5c.7 0 1.25-.55 1.25-1.25v-2" />,
  path: <path d="M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2.25-2.25a2.75 2.75 0 0 0-3.9-3.9l-.75.75M9.25 6.75a2.75 2.75 0 0 0-3.9 0L3.1 9a2.75 2.75 0 0 0 3.9 3.9l.75-.75" />,
  delete: <path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.25 4.25l.6 8.6c.04.52.47.9 1 .9h4.3c.53 0 .96-.38 1-.9l.6-8.6M6.75 7v4M9.25 7v4" />,
  undo: <path d="M5.5 3 2.5 6l3 3M2.75 6H9.5a4 4 0 0 1 0 8H6.5" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  chevron: <path d="m6 3.75 4.25 4.25L6 12.25" />,
};

export const Glyph: React.FC<{ name: GlyphName; size?: number; className?: string }> = ({ name, size = 16, className }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.35"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
    aria-hidden="true"
    focusable="false"
  >
    {SHAPES[name]}
  </svg>
);

/** What a file is, in a word, and the drawing that goes with it: from its name, as the runtime reads it. */
export function fileKind(path: string): { glyph: GlyphName; word: string; language: boolean } {
  if (isPagePath(path)) return { glyph: 'page', word: 'page', language: true };
  if (isLogicPath(path)) return { glyph: 'logic', word: 'logic', language: true };
  if (/\.xdb$/i.test(path)) return { glyph: 'data', word: 'data', language: true };
  if (/\.json$/i.test(path)) return { glyph: 'settings', word: path === 'manifest.json' || path === 'permission.json' ? 'settings' : 'JSON', language: false };
  if (/\.css$/i.test(path)) return { glyph: 'style', word: 'styles', language: false };
  if (/\.(md|txt|csv|sql|ya?ml|toml)$/i.test(path)) return { glyph: 'text', word: 'text', language: false };
  if (/\.pdf$/i.test(path)) return { glyph: 'document', word: 'PDF', language: false };
  const { kind } = classifyAsset(path);
  if (kind === 'image') return { glyph: 'picture', word: 'picture', language: false };
  if (kind === 'audio') return { glyph: 'sound', word: 'sound', language: false };
  if (kind === 'video') return { glyph: 'video', word: 'video', language: false };
  if (kind === 'font') return { glyph: 'font', word: 'font', language: false };
  return { glyph: 'file', word: 'file', language: false };
}
