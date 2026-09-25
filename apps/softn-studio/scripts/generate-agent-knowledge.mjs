#!/usr/bin/env node
/**
 * The agent's reference material, generated from the two sources of truth:
 *
 *   packages/@softn/components/component-manifest.json — every component, its
 *     props with their types, and which are registered as tags (and, from each
 *     component's own source file, the shape of a named type a prop takes,
 *     such as BarChart's BarChartSeries — without it a model can only guess);
 *   docs/content/softn-docs.json — the published guides.
 *
 * It writes three modules under src/lib/agent/knowledge/:
 *
 *   index.generated.ts      — the compact component and docs index that goes
 *                             into every system prompt (small, imported
 *                             statically);
 *   components.generated.ts — the full per-component reference that
 *                             lookup_components answers from;
 *   docs.generated.ts       — the guides as plain text, which read_docs
 *                             answers from.
 *
 * The last two are imported lazily, so they are their own chunks and cost the
 * editor nothing until the agent asks. Studio is an offline PWA, so nothing
 * here is fetched at run time.
 *
 * test/agentKnowledge.test.ts regenerates in memory and fails when the
 * checked-in modules are stale. Regenerate with
 *   npm run generate:knowledge -w @softn/studio
 *
 * The one-line purposes below are the only hand-written part: the manifest
 * carries a description for six components of a hundred. The generator
 * refuses a component without one, so a new component cannot reach the
 * prompt undescribed.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, '../../..');
export const MANIFEST_PATH = join(REPO, 'packages/@softn/components/component-manifest.json');
export const DOCS_PATH = join(REPO, 'docs/content/softn-docs.json');
export const OUT_DIR = resolve(here, '../src/lib/agent/knowledge');

export const PURPOSES = {
  Accordion: 'Collapsible sections from an items list; one or many open.',
  Alert: 'An inline message box: info, success, warning or error, optionally dismissible.',
  AnimatedBox: 'Wraps children in an entrance or attention animation.',
  AnimatedNumber: 'A number that counts up or down to its value.',
  App: 'The root of a page: theme and base layout. Every page\'s template starts with <App>.',
  AreaChart: 'Filled line chart for one or more series.',
  AudioStream: 'Plays audio samples the logic produces, in real time.',
  Avatar: 'A person\'s picture, or their initials when there is none.',
  AvatarGroup: 'Stacked avatars (a helper inside Avatar; not a registered tag).',
  Badge: 'A small count or status label.',
  BarChart: 'Vertical or horizontal bar chart; grouped or stacked series.',
  Box: 'A plain box with padding, background, border, radius and shadow props.',
  Breadcrumb: 'The path to the current page, as links.',
  Button: 'A clickable button: variants, sizes, loading and disabled states.',
  Camera: 'Live camera view that can capture a photo or video (needs the camera permission).',
  Card: 'A bordered or elevated panel, with an optional title and subtitle.',
  Center: 'Centres its children horizontally and vertically.',
  Checkbox: 'A checkbox with a label; bind with :bind or :checked.',
  CodeEditor: 'An editor for source code with syntax highlighting.',
  Collapse: 'Shows or hides its children with an animation.',
  ColorPicker: 'Choose a colour, with optional presets.',
  Container: 'Centres content at a maximum width (sm to xl).',
  Content: 'The main content region of a Layout, optionally per route.',
  DataGrid: 'A large, virtualised data table with sorting and selection.',
  DatePicker: 'Choose a date.',
  Divider: 'A horizontal or vertical rule, optionally labelled.',
  DPad: 'An on-screen directional pad for games: press and release per direction.',
  Draggable: 'Makes its children draggable within bounds.',
  Drawer: 'A panel that slides in from an edge.',
  EmptyFolder: 'Preset empty state for an empty folder (helper; not a registered tag).',
  EmptyList: 'Preset empty state for an empty list (helper; not a registered tag).',
  EmptySearch: 'Preset empty state for no search results (helper; not a registered tag).',
  EmptyState: 'What to show when there is nothing yet: icon, title, description, action.',
  FileChooser: 'Pick files from the device, as a button or a drop zone.',
  Form: 'Groups inputs and submits them together.',
  GaugeChart: 'A single value on a dial, with thresholds.',
  Grid: 'CSS grid layout: columns, rows and gaps.',
  Header: 'A top bar with a title; can stick to the top.',
  Heading: 'A heading, h1 to h6 (level).',
  Icon: 'A named icon from the built-in set, or an SVG.',
  Image: 'An image with fit, position and radius.',
  Input: 'A single-line text field: text, email, password, number and more.',
  Layout: 'Page layout frame that holds Header, Sidebar and Content.',
  LineChart: 'Line chart for one or more series.',
  List: 'A vertical list of ListItem rows.',
  ListItem: 'One row of a List, with leading and trailing content.',
  Loop: 'Calls @tick on an interval while running: a game or animation clock.',
  MarkdownEditor: 'Edit Markdown with a live preview.',
  Marquee: 'Scrolls its children continuously.',
  Menu: 'A dropdown menu of items from a trigger.',
  Microphone: 'Records clips or streams microphone input (needs the mic permission).',
  Modal: 'A dialog over the page; open with open/isOpen, close with @close.',
  NavItem: 'A navigation link or button, marked active for the current page.',
  Pagination: 'Page controls for a long list or table.',
  PanView: 'A draggable, zoomable viewport over large content.',
  PieChart: 'Pie or donut chart.',
  PixelCanvas: 'A pixel framebuffer drawn from the logic: emulators, retro games.',
  PixelGrid: 'A grid of cells for board and tile games.',
  Popover: 'Floating content anchored to a trigger, on click or hover.',
  Progress: 'A progress bar.',
  QRCode: 'Draws a QR code for a value.',
  QRReader: 'Scans QR codes with the camera (needs the camera permission).',
  RadarChart: 'Radar (spider) chart across several axes.',
  Radio: 'Choose one of several options.',
  RichTextEditor: 'Formatted text editing with a toolbar.',
  Scene3D: 'A Three.js 3D scene from a list of objects, lights and a camera.',
  Section: 'A titled section of a page, with an optional action.',
  Select: 'A dropdown to choose one option.',
  Sidebar: 'A side column, collapsible.',
  Skeleton: 'Loading placeholder shapes (helper; not a registered tag).',
  SkeletonCard: 'Loading placeholder for a card (helper; not a registered tag).',
  SkeletonCircle: 'Loading placeholder for an avatar (helper; not a registered tag).',
  SkeletonText: 'Loading placeholder for lines of text (helper; not a registered tag).',
  Slider: 'Choose a number in a range by dragging.',
  SmartCards: 'Cards generated from records, mapping fields to title, image, badges.',
  SmartForm: 'A form generated from field definitions.',
  SmartGrid: 'A searchable, sortable table generated from records.',
  SmartList: 'A list generated from records, mapping fields to lines.',
  SmartStats: 'Stat tiles with trends.',
  SmartTimeline: 'A timeline of records.',
  SmartView: 'Shows one record\'s fields as a card, list or grid.',
  SortableList: 'A list the person can reorder by dragging.',
  Spacer: 'Empty space, fixed or flexible.',
  Spinner: 'A loading indicator.',
  Split: 'Two panes with a draggable divider.',
  Sprite: 'Draws one frame of a sprite sheet: game characters.',
  Stack: 'Lays children out in a row or column with a gap: the everyday layout.',
  Switch: 'An on/off toggle with a label.',
  Table: 'A table from columns [{ key, header }] and data rows.',
  Tabs: 'Tabs from [{ key, label }]; @change receives the key.',
  Tag: 'A small label, optionally removable.',
  TagGroup: 'Lays out several Tags (helper; not a registered tag).',
  Text: 'A run of text: size, weight, colour, alignment, truncation.',
  TextArea: 'A multi-line text field.',
  TileMap: 'Draws a tile map from a tileset: game levels.',
  Toast: 'A transient notification.',
  Tooltip: 'A hint shown on hover or focus.',
  TooltipTrigger: 'Wraps an element with a tooltip (helper; not a registered tag).',
  TreeView: 'A tree of expandable nodes.',
  Typewriter: 'Types its text out character by character.',
};

const COMMON_PROPS = new Set(['className', 'style', 'id']);
const COMPONENTS_DIR = join(REPO, 'packages/@softn/components');

/** A component's source file, or null when it cannot be read. */
export function readComponentSource(source) {
  try {
    return readFileSync(join(COMPONENTS_DIR, source), 'utf8');
  } catch {
    return null;
  }
}

/** Every `export interface` / `export type` in a source file, as one-line text. */
function declaredTypes(sourceText) {
  const types = new Map();
  const clean = sourceText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const re = /export\s+(interface|type)\s+([A-Z]\w*)(?:<[^>{=]*>)?\s*(?:extends\s+[^{]+)?(=)?\s*/g;
  let match;
  while ((match = re.exec(clean)) !== null) {
    let at = re.lastIndex;
    let body = '';
    if (match[1] === 'interface' || clean[at] === '{') {
      if (clean[at] !== '{') continue;
      let depth = 0;
      let end = at;
      for (; end < clean.length; end++) {
        if (clean[end] === '{') depth++;
        else if (clean[end] === '}' && --depth === 0) break;
      }
      body = clean.slice(at, end + 1);
    } else {
      const end = clean.indexOf(';', at);
      body = clean.slice(at, end < 0 ? undefined : end);
    }
    // Markup cannot go inside a {…} value, so to the model a React node is a string.
    const oneLine = body.replace(/\s*\n\s*/g, ' ').replace(/;\s*}/g, ' }').replace(/\s+/g, ' ').replace(/\b(?:React\.)?ReactNode\b/g, 'string').trim();
    if (oneLine && oneLine.length <= 400) types.set(match[2], oneLine);
  }
  return types;
}

/**
 * The named types a component's props refer to, and the ones those refer
 * to, as `- Name = shape` lines; only types its own source file declares.
 */
function propTypeLines(component, members, readSource) {
  const source = component.source ? readSource(component.source) : null;
  if (!source) return [];
  const declared = declaredTypes(source);
  const propsInterface = component.props?.interface;
  const queue = [];
  const names = (text) => [...text.matchAll(/\b([A-Z]\w*)\b/g)].map((m) => m[1]);
  for (const m of members) queue.push(...names(typeText(m.type)));
  const seen = new Set();
  const lines = [];
  while (queue.length > 0 && lines.length < 6) {
    const name = queue.shift();
    if (seen.has(name) || name === propsInterface || !declared.has(name)) continue;
    seen.add(name);
    const shape = declared.get(name);
    lines.push(`- ${name} = ${shape}`);
    queue.push(...names(shape));
  }
  return lines;
}

function typeText(type) {
  switch (type.kind) {
    case 'enum':
      return type.options.map((o) => JSON.stringify(o)).join(' | ');
    case 'array':
    case 'other':
      return type.text ?? type.kind;
    default:
      return type.kind;
  }
}

function eventName(prop) {
  return /^on[A-Z]/.test(prop) ? prop.charAt(2).toLowerCase() + prop.slice(3) : null;
}

function sampleValue(member) {
  const t = member.type;
  if (t.kind === 'enum') return JSON.stringify(t.options[0]);
  if (t.kind === 'string') return `"${member.name}"`;
  if (t.kind === 'number') return '{1}';
  if (t.kind === 'boolean') return '{true}';
  if (t.kind === 'array') return '{[]}';
  return `{${member.name}}`;
}

function blockText(block) {
  switch (block.type) {
    case 'paragraph':
      return block.text;
    case 'callout':
      return `${block.tone === 'warning' ? 'Warning' : 'Note'}${block.title ? ` — ${block.title}` : ''}: ${block.text}`;
    case 'code':
      return `\`\`\`${block.language ?? ''}\n${block.code}\n\`\`\`${block.caption ? `\n(${block.caption})` : ''}`;
    case 'table':
      return [block.columns.join(' | '), ...block.rows.map((r) => r.join(' | '))].join('\n');
    case 'list':
      return block.items.map((item, i) => `${block.ordered ? `${i + 1}.` : '-'} ${item}`).join('\n');
    case 'steps':
      return block.items.map((item, i) => `${i + 1}. ${item.title}: ${item.text}`).join('\n');
    case 'definitions':
      return block.items.map((item) => `- ${item.term}: ${item.description}`).join('\n');
    case 'links':
      return block.items.map((item) => `- ${item.label}${item.description ? `: ${item.description}` : ''}`).join('\n');
    case 'cards':
      return block.pageIds?.length ? `See: ${block.pageIds.join(', ')}` : '';
    default:
      return '';
  }
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Build every generated module's text from the two sources' text (and the components' own sources, for prop types). */
export function buildKnowledge(manifestText, docsText, readSource = readComponentSource) {
  const manifest = JSON.parse(manifestText);
  const docs = JSON.parse(docsText);
  const category = {};
  for (const [group, names] of Object.entries(manifest.registered)) for (const name of names) category[name] = group;

  const missing = manifest.components.map((c) => c.name).filter((n) => !PURPOSES[n]);
  if (missing.length > 0) throw new Error(`No purpose line for component(s): ${missing.join(', ')}. Add them to PURPOSES in scripts/generate-agent-knowledge.mjs.`);

  // Code examples from the docs, for the components they show.
  const docExamples = [];
  for (const page of docs.pages) for (const section of page.sections) for (const block of section.blocks) {
    if (block.type === 'code' && (block.language === 'softn' || block.language === 'xml' || block.language === 'ui')) docExamples.push({ page: page.id, code: block.code });
  }

  const index = [];
  const reference = {};
  for (const component of [...manifest.components].sort((a, b) => a.name.localeCompare(b.name))) {
    const registered = category[component.name] !== undefined;
    index.push({ name: component.name, category: category[component.name] ?? 'helper', purpose: PURPOSES[component.name], registered });
    const members = component.props?.members ?? [];
    const props = members.filter((m) => !COMMON_PROPS.has(m.name) && !eventName(m.name));
    const events = members.filter((m) => eventName(m.name));
    const acceptsChildren = members.some((m) => m.name === 'children');
    const lines = [];
    lines.push(`## ${component.name} — ${PURPOSES[component.name]}`);
    lines.push(registered ? `Tag: <${component.name}> (group: ${category[component.name]})` : 'Not registered as a tag: it cannot be used in markup.');
    if (component.doc) lines.push(component.doc);
    if (props.length > 0) {
      lines.push('Props (? = optional):');
      for (const m of props) lines.push(`- ${m.name}${m.optional ? '?' : ''}: ${typeText(m.type)}${m.doc ? ` — ${m.doc}` : ''}`);
      const types = propTypeLines(component, props, readSource);
      if (types.length > 0) lines.push('Types the props use:', ...types);
    } else {
      lines.push('Props: none of its own.');
    }
    if (events.length > 0) {
      lines.push('Events (write @name={…}; the prop is onName):');
      for (const m of events) lines.push(`- @${eventName(m.name)}${m.doc ? ` — ${m.doc}` : ''}`);
    }
    lines.push(acceptsChildren ? 'Children: accepts child content.' : 'Children: none (configure it with props).');
    lines.push('Every component also takes style and className.');
    if (registered) {
      const required = props.filter((m) => !m.optional && m.name !== 'children');
      const attrs = required.map((m) => ` ${m.name}=${sampleValue(m)}`).join('');
      lines.push(`Minimal usage: <${component.name}${attrs}${acceptsChildren ? `>…</${component.name}>` : ' />'}`);
      const example = docExamples
        .filter((e) => new RegExp(`<${component.name}[\\s/>]`).test(e.code))
        .sort((a, b) => a.code.length - b.code.length)[0];
      if (example) lines.push(`From the docs (${example.page}):\n\`\`\`xml\n${example.code}\n\`\`\``);
    }
    reference[component.name] = lines.join('\n');
  }

  const docPages = docs.pages.map((page) => ({
    slug: page.id,
    title: page.title,
    summary: page.summary,
    sections: page.sections.map((section) => ({
      id: section.id,
      title: section.title,
      text: section.blocks.map(blockText).filter(Boolean).join('\n\n'),
    })),
  }));
  const docIndex = docPages.map((p) => ({ slug: p.slug, title: p.title, summary: p.summary, sections: p.sections.map((s) => s.id) }));

  const header = (what) =>
    `/* Generated by scripts/generate-agent-knowledge.mjs from ${what}; do not edit.\n   Regenerate with: npm run generate:knowledge -w @softn/studio */\n`;
  const sources = { manifest: hash(manifestText), docs: hash(docsText) };

  return {
    'index.generated.ts':
      header('component-manifest.json and softn-docs.json') +
      `\nexport const KNOWLEDGE_SOURCES = ${JSON.stringify(sources)} as const;\n\n` +
      `export interface ComponentIndexEntry { name: string; category: string; purpose: string; registered: boolean }\n` +
      `export const COMPONENT_INDEX: ComponentIndexEntry[] = ${JSON.stringify(index, null, 1)};\n\n` +
      `export interface DocIndexEntry { slug: string; title: string; summary: string; sections: string[] }\n` +
      `export const DOC_INDEX: DocIndexEntry[] = ${JSON.stringify(docIndex, null, 1)};\n`,
    'components.generated.ts':
      header('packages/@softn/components/component-manifest.json') +
      `\nexport const COMPONENT_REFERENCE: Record<string, string> = ${JSON.stringify(reference, null, 1)};\n`,
    'docs.generated.ts':
      header('docs/content/softn-docs.json') +
      `\nexport interface DocPage { slug: string; title: string; summary: string; sections: Array<{ id: string; title: string; text: string }> }\n` +
      `export const DOC_PAGES: DocPage[] = ${JSON.stringify(docPages, null, 1)};\n`,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = buildKnowledge(readFileSync(MANIFEST_PATH, 'utf8'), readFileSync(DOCS_PATH, 'utf8'));
  for (const [name, text] of Object.entries(out)) {
    writeFileSync(join(OUT_DIR, name), text);
    console.log(`wrote ${name} (${(text.length / 1024).toFixed(1)} KB)`);
  }
}
