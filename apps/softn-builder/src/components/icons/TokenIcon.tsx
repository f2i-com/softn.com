/**
 * The small glyph beside a component in the palette and on its canvas card,
 * chosen by the icon token its registry entry names (componentRegistry.ts,
 * the third argument of each entry; blocks.ts for #if and #each).
 *
 * Every token an entry names has a glyph of its own here. A token this file
 * does not know is drawn as a dashed square, and tokenIcon.test.ts
 * fails for any entry that would be: 68 rows of the palette once showed the
 * same clock, the fallback, for a token nobody had drawn.
 */

import type { ReactNode, SVGProps } from 'react';

type Stroke = Pick<SVGProps<SVGElement>, 'stroke' | 'strokeWidth' | 'strokeLinecap' | 'strokeLinejoin'>;

/** One glyph on a 16-unit square: lines drawn with `s`, solid parts filled with `color`. */
type Glyph = (s: Stroke, color: string) => ReactNode;

const GLYPHS: Record<string, Glyph> = {
  // Layout
  layout: (s) => (
    <>
      <rect x="2" y="2" width="12" height="12" rx="2" {...s} />
      <path d="M2 6h12M6 6v8" {...s} />
    </>
  ),
  layers: (s) => <path d="M8 2 2 5l6 3 6-3-6-3ZM2 8l6 3 6-3M2 11l6 3 6-3" {...s} />,
  square: (s) => <rect x="2.5" y="2.5" width="11" height="11" rx="2" {...s} />,
  'credit-card': (s) => (
    <>
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.6" {...s} />
      <path d="M1.5 6.5h13M4 10h3" {...s} />
    </>
  ),
  grid: (s) => (
    <>
      <rect x="2" y="2" width="12" height="12" rx="1.5" {...s} />
      <path d="M6 2v12M10 2v12M2 6h12M2 10h12" {...s} />
    </>
  ),
  maximize: (s) => <path d="M10 2h4v4M6 14H2v-4M14 2 9.3 6.7M2 14l4.7-4.7" {...s} />,
  'align-center': (s) => <path d="M2.5 4h11M5 8h6M3.5 12h9" {...s} />,
  'align-left': (s) => <path d="M2.5 4h11M2.5 8h7M2.5 12h9" {...s} />,
  minus: (s) => <path d="M2.5 8h11" {...s} />,
  move: (s) => <path d="M8 1.8v12.4M1.8 8h12.4M6 3.8l2-2 2 2M6 12.2l2 2 2-2M3.8 6l-2 2 2 2M12.2 6l2 2-2 2" {...s} />,
  columns: (s) => (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" {...s} />
      <path d="M8 2.5v11" {...s} />
    </>
  ),
  sidebar: (s) => (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" {...s} />
      <path d="M6 2.5v11" {...s} />
    </>
  ),
  'arrow-up': (s) => <path d="M8 13V3M4 7l4-4 4 4" {...s} />,
  'file-text': (s) => (
    <path
      d="M9.5 1.8h-5a1.2 1.2 0 0 0-1.2 1.2v10a1.2 1.2 0 0 0 1.2 1.2h7a1.2 1.2 0 0 0 1.2-1.2V5ZM9.5 1.8V5h3.2M5.5 8.5h5M5.5 11h5"
      {...s}
    />
  ),

  // Form
  'mouse-pointer': (s) => <path d="M3 3l3.6 9.5 1.5-4 4-1.5ZM8.6 8.6l4 4" {...s} />,
  type: (s) => <path d="M3 4.2V2.8h10v1.4M8 2.8v10.4M6 13.2h4" {...s} />,
  'check-square': (s) => (
    <>
      <rect x="2" y="2" width="12" height="12" rx="2" {...s} />
      <path d="M5 8.2l2 2 4-4.4" {...s} />
    </>
  ),
  circle: (s, color) => (
    <>
      <circle cx="8" cy="8" r="5.8" {...s} />
      <circle cx="8" cy="8" r="2.2" fill={color} />
    </>
  ),
  'toggle-left': (s) => (
    <>
      <rect x="1.5" y="4.5" width="13" height="7" rx="3.5" {...s} />
      <circle cx="5" cy="8" r="1.8" {...s} />
    </>
  ),
  toggle: (s, color) => (
    <>
      <rect x="1.5" y="4.5" width="13" height="7" rx="3.5" {...s} />
      <circle cx="11" cy="8" r="1.8" fill={color} />
    </>
  ),
  sliders: (s) => (
    <>
      <path d="M2.5 4.5h2M8.3 4.5h5.2M2.5 11.5h6.4M12.5 11.5h1" {...s} />
      <circle cx="6.4" cy="4.5" r="1.8" {...s} />
      <circle cx="10.7" cy="11.5" r="1.8" {...s} />
    </>
  ),
  calendar: (s) => (
    <>
      <rect x="2" y="3" width="12" height="11" rx="1.5" {...s} />
      <path d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4" {...s} />
    </>
  ),
  droplet: (s) => <path d="M8 1.8c2.6 3 4.2 5.2 4.2 7.4a4.2 4.2 0 0 1-8.4 0C3.8 7 5.4 4.8 8 1.8Z" {...s} />,
  upload: (s) => <path d="M8 10.5v-8M4.8 5.5 8 2.3l3.2 3.2M2.5 10.5v2A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5v-2" {...s} />,
  input: (s) => (
    <>
      <rect x="1.5" y="4.5" width="13" height="7" rx="1.5" {...s} />
      <path d="M4.5 6.5v3" {...s} />
    </>
  ),
  form: (s) => (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" {...s} />
      <path d="M4.5 6h7M4.5 10h4.5" {...s} />
    </>
  ),
  copy: (s) => (
    <>
      <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5" {...s} />
      <path d="M3.5 10.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5" {...s} />
    </>
  ),
  button: (s) => (
    <>
      <rect x="1.5" y="4.5" width="13" height="7" rx="3.5" {...s} />
      <path d="M5.5 8h5" {...s} />
    </>
  ),

  // Display
  star: (s) => <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6Z" {...s} />,
  tag: (s, color) => (
    <>
      <path d="M2.2 3.2v4.1c0 .3.1.5.3.7l5.8 5.8a1 1 0 0 0 1.4 0l4-4a1 1 0 0 0 0-1.4L7.9 2.6a1 1 0 0 0-.7-.4H3.2a1 1 0 0 0-1 1Z" {...s} />
      <circle cx="5" cy="5" r="0.9" fill={color} />
    </>
  ),
  user: (s) => (
    <>
      <circle cx="8" cy="5.5" r="2.7" {...s} />
      <path d="M2.8 14c.6-2.7 2.7-4.3 5.2-4.3s4.6 1.6 5.2 4.3" {...s} />
    </>
  ),
  hash: (s) => <path d="M3 6h10.5M2.5 10h10.5M6.5 2.5l-1 11M10.5 2.5l-1 11" {...s} />,
  image: (s) => (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" {...s} />
      <circle cx="5.8" cy="6" r="1.2" {...s} />
      <path d="M14 10.5l-3.3-3.2L4 13.5" {...s} />
    </>
  ),
  text: (s) => <path d="M3 4h10M3 8h10M3 12h6" {...s} />,
  badge: (s) => (
    <>
      <circle cx="8" cy="6.3" r="4" {...s} />
      <path d="M5.8 9.6 5 14.2l3-1.6 3 1.6-.8-4.6" {...s} />
    </>
  ),
  keyboard: (s) => (
    <>
      <rect x="1.5" y="4" width="13" height="8.5" rx="1.5" {...s} />
      <path d="M4.2 6.9h.01M6.7 6.9h.01M9.3 6.9h.01M11.8 6.9h.01M5 9.8h6" {...s} />
    </>
  ),
  'qr-code': (s) => (
    <>
      <rect x="2" y="2" width="4.5" height="4.5" rx="0.8" {...s} />
      <rect x="9.5" y="2" width="4.5" height="4.5" rx="0.8" {...s} />
      <rect x="2" y="9.5" width="4.5" height="4.5" rx="0.8" {...s} />
      <path d="M10 10h.01M13.5 10h.01M10 13.5h.01M13.5 13.5h.01M11.75 11.75h.01" {...s} />
    </>
  ),

  // Feedback
  'alert-circle': (s) => (
    <>
      <circle cx="8" cy="8" r="5.8" {...s} />
      <path d="M8 5v3.4M8 11h.01" {...s} />
    </>
  ),
  bell: (s) => <path d="M4 6.5a4 4 0 0 1 8 0c0 4 1.8 5.2 1.8 5.2H2.2S4 10.5 4 6.5ZM6.8 13.8a1.4 1.4 0 0 0 2.4 0" {...s} />,
  info: (s) => (
    <>
      <circle cx="8" cy="8" r="5.8" {...s} />
      <path d="M8 7.3V11M8 5h.01" {...s} />
    </>
  ),
  'message-square': (s) => <path d="M14 10a1.3 1.3 0 0 1-1.3 1.3H5l-3 2.7V3.3A1.3 1.3 0 0 1 3.3 2h9.4A1.3 1.3 0 0 1 14 3.3Z" {...s} />,
  inbox: (s) => (
    <path
      d="M14 8.5h-3.5l-1.2 2H6.7l-1.2-2H2M4.3 3.5 2 8.5v4a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-4l-2.3-5a1 1 0 0 0-.9-.5H5.2a1 1 0 0 0-.9.5Z"
      {...s}
    />
  ),
  loader: (s) => <path d="M8 1.8v2.4M8 11.8v2.4M3.6 3.6l1.7 1.7M10.7 10.7l1.7 1.7M1.8 8h2.4M11.8 8h2.4M3.6 12.4l1.7-1.7M10.7 5.3l1.7-1.7" {...s} />,

  // Navigation
  'chevron-down': (s) => <path d="M4 6l4 4 4-4" {...s} />,
  'chevrons-right': (s) => <path d="M3.5 4l4 4-4 4M8.5 4l4 4-4 4" {...s} />,
  breadcrumb: (s) => (
    <>
      <circle cx="3" cy="8" r="1.6" {...s} />
      <circle cx="8" cy="8" r="1.6" {...s} />
      <circle cx="13" cy="8" r="1.6" {...s} />
      <path d="M4.6 8h1.8M9.6 8h1.8" {...s} />
    </>
  ),
  folder: (s) => <path d="M2 4.3A1.3 1.3 0 0 1 3.3 3h3l1.4 1.8h5A1.3 1.3 0 0 1 14 6.1v6.6a1.3 1.3 0 0 1-1.3 1.3H3.3A1.3 1.3 0 0 1 2 12.7Z" {...s} />,
  link: (s) => (
    <path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.8.8M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.8-.8" {...s} />
  ),
  menu: (s) => <path d="M2.5 4h11M2.5 8h11M2.5 12h11" {...s} />,
  'more-horizontal': (_s, color) => (
    <>
      <circle cx="3.5" cy="8" r="1.1" fill={color} />
      <circle cx="8" cy="8" r="1.1" fill={color} />
      <circle cx="12.5" cy="8" r="1.1" fill={color} />
    </>
  ),

  // Data
  list: (s) => <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.6 4h.01M2.6 8h.01M2.6 12h.01" {...s} />,
  'list-ordered': (s) => (
    <path d="M6.5 4h7M6.5 8h7M6.5 12h7M2.4 2.9l1-.4v3.2M2.2 9.4c0-.6.5-1 1.1-1s1 .4 1 .9c0 .9-2.1 1.4-2.1 2.6h2.1" {...s} />
  ),
  table: (s) => (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" {...s} />
      <path d="M2 6h12M2 9.7h12M6.5 6v7.5" {...s} />
    </>
  ),
  'git-branch': (s) => (
    <>
      <path d="M4 2.2v8.1M12 5.7c0 3.4-2.6 6.3-6.3 6.3" {...s} />
      <circle cx="4" cy="12" r="1.7" {...s} />
      <circle cx="12" cy="4" r="1.7" {...s} />
    </>
  ),

  // Charts
  'trending-up': (s) => <path d="M1.8 11.5 6 7.3l3 3 5.2-5.2M10.5 5h3.7v3.7" {...s} />,
  'bar-chart': (s, color) => (
    <>
      <path d="M2.5 13.5h11" {...s} />
      <rect x="4" y="8" width="2" height="4.5" rx="0.6" fill={color} opacity="0.8" />
      <rect x="7" y="6" width="2" height="6.5" rx="0.6" fill={color} opacity="0.8" />
      <rect x="10" y="4.5" width="2" height="8" rx="0.6" fill={color} opacity="0.8" />
    </>
  ),
  'bar-chart-2': (s) => <path d="M12 13.5v-7M8 13.5v-11M4 13.5v-4" {...s} />,
  'area-chart': (s, color) => (
    <>
      <path d="M2 13.5h12" {...s} />
      <path d="M2.5 12V9l3-3 3 2.5 5-5V12Z" fill={color} fillOpacity="0.35" {...s} />
    </>
  ),
  'pie-chart': (s) => <path d="M14.1 10.6A6.7 6.7 0 1 1 5.3 1.9M14.7 8A6.7 6.7 0 0 0 8 1.3V8Z" {...s} />,
  radar: (s, color) => (
    <>
      <path d="M8 1.8l6 4.4-2.3 7H4.3L2 6.2Z" {...s} />
      <path d="M8 5l3 2.4-1.6 3.6H6.2L5 7.4Z" fill={color} fillOpacity="0.4" {...s} />
    </>
  ),
  gauge: (s, color) => (
    <>
      <path d="M2.5 11.5a5.5 5.5 0 0 1 11 0M8 11.5l2.8-3.7" {...s} />
      <circle cx="8" cy="11.5" r="1" fill={color} />
    </>
  ),

  // Editors
  code: (s) => <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" {...s} />,
  'edit-3': (s) => <path d="M8 13.5h5.5M10.8 2.7a1.6 1.6 0 0 1 2.3 2.3l-7.6 7.6-3 .8.8-3Z" {...s} />,

  // Smart
  eye: (s) => (
    <>
      <path d="M1.5 8S3.8 3.5 8 3.5 14.5 8 14.5 8 12.2 12.5 8 12.5 1.5 8 1.5 8Z" {...s} />
      <circle cx="8" cy="8" r="2" {...s} />
    </>
  ),
  clock: (s) => (
    <>
      <circle cx="8" cy="8" r="5.8" {...s} />
      <path d="M8 4.7v3.6l2.3 2.1" {...s} />
    </>
  ),

  // Utility, animation, media and games; `branch` and `repeat` are the #if and #each blocks too
  branch: (s) => <path d="M8 2v4.5M8 6.5 4 10.5V14M8 6.5l4 4V14" {...s} />,
  sparkles:(s) => (
    <path d="M7 2l1.2 3.3 3.3 1.2-3.3 1.2L7 11 5.8 7.7 2.5 6.5l3.3-1.2ZM12.5 9.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5Z" {...s} />
  ),
  'move-horizontal': (s) => <path d="M1.8 8h12.4M4 5.8 1.8 8 4 10.2M12 5.8 14.2 8 12 10.2" {...s} />,
  repeat: (s) => (
    <path d="M11.3 1.3l2 2-2 2M2.7 7.3v-.7a2.7 2.7 0 0 1 2.7-2.7h8M4.7 14.7l-2-2 2-2M13.3 8.7v.7a2.7 2.7 0 0 1-2.7 2.7h-8" {...s} />
  ),
  film: (s) => (
    <>
      <rect x="2" y="2" width="12" height="12" rx="1.5" {...s} />
      <path d="M5.3 2v12M10.7 2v12M2 8h12M2 5h3.3M2 11h3.3M10.7 5H14M10.7 11H14" {...s} />
    </>
  ),
  gamepad: (s) => (
    <path
      d="M4.5 4.5h7a3 3 0 0 1 3 3v1.8a2.2 2.2 0 0 1-4 1.3l-.6-.9H6.1l-.6.9a2.2 2.2 0 0 1-4-1.3V7.5a3 3 0 0 1 3-3ZM5 6.5v2.4M3.8 7.7h2.4M10.6 7.2h.01M12 8.4h.01"
      {...s}
    />
  ),
  map: (s) => <path d="M1.8 4.2l4-1.7 4.4 1.8 4-1.8v9.3l-4 1.7-4.4-1.8-4 1.8ZM5.8 2.5v9.3M10.2 4.3v9.2" {...s} />,
  monitor: (s) => (
    <>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.4" {...s} />
      <path d="M5.5 14h5M8 11.5V14" {...s} />
    </>
  ),
  cube: (s) => <path d="M8 1.8l5.5 3.2v6L8 14.2 2.5 11V5ZM2.5 5 8 8.2 13.5 5M8 8.2v6" {...s} />,
  camera: (s) => (
    <>
      <path d="M2 5.6a1.3 1.3 0 0 1 1.3-1.3h1.6L6 2.6h4l1.1 1.7h1.6A1.3 1.3 0 0 1 14 5.6v6.1a1.3 1.3 0 0 1-1.3 1.3H3.3A1.3 1.3 0 0 1 2 11.7Z" {...s} />
      <circle cx="8" cy="8.4" r="2.3" {...s} />
    </>
  ),
  mic: (s) => (
    <>
      <rect x="6" y="1.8" width="4" height="7.4" rx="2" {...s} />
      <path d="M3.8 7.5a4.2 4.2 0 0 0 8.4 0M8 11.7v2.5" {...s} />
    </>
  ),
  'audio-lines': (s) => <path d="M2.5 6.5v3M5.2 4v8M8 2v12M10.8 5v6M13.5 7v2" {...s} />,
  scan: (s) => (
    <path
      d="M2 5V3.3A1.3 1.3 0 0 1 3.3 2H5M11 2h1.7A1.3 1.3 0 0 1 14 3.3V5M14 11v1.7a1.3 1.3 0 0 1-1.3 1.3H11M5 14H3.3A1.3 1.3 0 0 1 2 12.7V11M4.5 8h7"
      {...s}
    />
  ),
};

function glyphFor(token?: string): Glyph | undefined {
  return GLYPHS[(token || '').toLowerCase()];
}

/** Whether `token` has a glyph of its own, rather than the dashed square any other token gets. */
export function hasTokenGlyph(token?: string): boolean {
  return glyphFor(token) !== undefined;
}

interface TokenIconProps {
  token?: string;
  size?: number;
  color?: string;
}

export function TokenIcon({ token, size = 14, color = 'var(--paper)' }: TokenIconProps) {
  const stroke: Stroke = { stroke: color, strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' };
  const glyph = glyphFor(token);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {glyph ? glyph(stroke, color) : <rect x="2.5" y="2.5" width="11" height="11" rx="2" strokeDasharray="2 2" {...stroke} />}
    </svg>
  );
}
