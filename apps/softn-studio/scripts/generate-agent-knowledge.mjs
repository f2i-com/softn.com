#!/usr/bin/env node
/**
 * The agent's reference material, generated from the two sources of truth:
 *
 *   packages/@softn/components/component-manifest.json — every component, its
 *     props with their types, and which are registered as tags (and, from each
 *     component's source, the named types its props take, whole and with
 *     each field's comment: BarChart's BarChartSeries, and what an object,
 *     a light, a hit and the effects of a Scene3D are, from whichever file
 *     of the package declares them — without them a model can only guess);
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
 * carries a description for a handful of components of a hundred. The generator
 * refuses a component without one, so a new component cannot reach the
 * prompt undescribed.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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
  AvatarGroup: 'Avatars overlapping in a row, with +N for the rest; put Avatar tags (or an #each of them) inside.',
  Badge: 'A small count or status label.',
  BarChart: 'Vertical or horizontal bar chart; grouped or stacked series.',
  Box: 'A plain box with padding, background, border, radius and shadow props.',
  Breadcrumb: 'The path to the current page, as links.',
  Button: 'A clickable button: variants, sizes, loading and disabled states.',
  ButtonGroup: 'Buttons that belong together, joined edge to edge; put Button tags inside. For one choice of a few, use SegmentedControl.',
  Camera: 'Live camera view that can capture a photo or video (needs the camera permission).',
  Card: 'A bordered or elevated panel, with an optional title and subtitle.',
  Center: 'Centres its children horizontally and vertically.',
  // `:checked` is not a binding: like any `:` property but `:bind`, it only shows the value
  // (the renderer writes back for `:bind` alone). Said here as one, it was what a model wrote,
  // and the box it made could not be ticked.
  Checkbox: 'A checkbox with a label; :bind={name} holds true or false. checked={x} only shows x.',
  CodeEditor: 'An editor for source code with syntax highlighting.',
  Collapse: 'Shows or hides its children with an animation.',
  ColorPicker: 'Choose a colour, with optional presets.',
  Confirm: 'Asks "are you sure?" before something is done: open={asking}, @confirm and @cancel. The app closes it by setting open.',
  Container: 'Centres content at a maximum width (sm to xl).',
  Controls: 'What the player holds, as one record: :bind={pad} with keys={{ left: "ArrowLeft a", fire: "Space" }} gives pad.left and pad.presses.fire. Keeps those keys from the browser, reads a gamepad, draws nothing.',
  Content: 'The main content region of a Layout, optionally per route.',
  DataGrid: 'A large, virtualised data table with sorting and selection.',
  DatePicker: 'Choose a date.',
  DescriptionList: 'The facts about one record as labels and values: items={[{ label, value }]} or a record whose keys are the labels.',
  Divider: 'A horizontal or vertical rule, optionally labelled.',
  DPad: 'An on-screen directional pad for games: press and release per direction, or :bind={pad} to the record a Controls keeps.',
  Draggable: 'Makes its children draggable within bounds.',
  Drawer: 'A panel that slides in from an edge.',
  EmptyFolder: 'Preset empty state for an empty folder (helper; not a registered tag).',
  EmptyList: 'Preset empty state for an empty list (helper; not a registered tag).',
  EmptySearch: 'Preset empty state for no search results (helper; not a registered tag).',
  EmptyState: 'What to show when there is nothing yet: icon, title, description, action.',
  Field: 'A label, hint and error around any control that has none of its own (Slider, Rating, SegmentedControl, a group of checkboxes).',
  CopyButton: 'A button that copies its value to the clipboard and says "Copied" for a moment; use it instead of a logic function and a state variable for the label.',
  FileChooser: 'Pick files from the device, as a button or a drop zone.',
  Form: 'Groups inputs and submits them together.',
  GaugeChart: 'A single value on a dial, with thresholds.',
  Grid: 'CSS grid layout: columns, rows and gaps.',
  Header: 'A top bar with a title; can stick to the top.',
  Heading: 'A heading, h1 to h6 (level).',
  Icon: 'A named icon from the built-in set, or an SVG.',
  Image: 'An image with fit, position and radius.',
  Input: 'A single-line text field: text, email, password, number and more.',
  Kbd: 'A keyboard key or shortcut, such as Ctrl+K.',
  Layout: 'Page layout frame that holds Header, Sidebar and Content.',
  LineChart: 'Line chart for one or more series.',
  List: 'A vertical list of ListItem rows.',
  ListItem: 'One row of a List, with leading and trailing content.',
  Loop: 'A game or animation clock: calls @tick with the seconds since the last call while running. With frame, once a screen frame and not while hidden; else every interval ms.',
  MarkdownEditor: 'Edit Markdown with a live preview.',
  Marquee: 'Scrolls its children continuously.',
  Menu: 'A dropdown menu of items from a trigger.',
  Microphone: 'Records clips or streams microphone input (needs the mic permission).',
  Modal: 'A dialog over the page; open with open/isOpen, close with @close.',
  NavItem: 'A navigation link or button, marked active for the current page.',
  NumberInput: 'A number to type or step with + and −; @change and :bind give a number, or null when empty.',
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
  Rating: 'A score out of a few stars, to read (readOnly) or to set; @change and :bind give the number.',
  RichTextEditor: 'Formatted text editing with a toolbar.',
  Scene3D: 'A Three.js 3D scene from a list of objects, lights and a camera.',
  SceneAnchor: 'Page content pinned to an object or a place in a Scene3D (a name tag, a health bar, a card); written inside the Scene3D, it follows the object as it moves.',
  Section: 'A titled section of a page, with an optional action.',
  SegmentedControl: 'Choose one of a few options shown side by side; @change and :bind give the value.',
  Select: 'A dropdown to choose one option.',
  Sidebar: 'A side column, collapsible.',
  Skeleton: 'A loading placeholder shaped like the content to come; shows its children once loading is false.',
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
  Sprite: 'Draws and animates the frames of a sprite sheet at x, y: game characters. frames, loop and @end play a run once.',
  Stack: 'Lays children out in a row or column with a gap: the everyday layout.',
  Stat: 'One figure with its label and how it moved: a dashboard tile fed from state.',
  Steps: 'Where someone is in a sequence: done, current and upcoming steps; with @change the steps are buttons.',
  Switch: 'An on/off toggle with a label; :bind={name} holds true or false.',
  Table: 'A table from columns [{ key, header }] and data rows.',
  Tabs: 'Tabs from [{ key, label }]; @change receives the key.',
  Tag: 'A small label, optionally removable.',
  TagGroup: 'A row of Tag tags that wraps.',
  Text: 'A run of text: size, weight, colour, alignment, truncation.',
  TextArea: 'A multi-line text field.',
  TileMap: 'Draws a tile map from a tileset: game levels.',
  Timeline: 'Things that happened, in order, from a list in state: [{ title, description?, time?, variant? }].',
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

/** A shape no longer than this is written on one line, as it always was; a longer one a field to a line. */
const ONE_LINE_SHAPE = 400;
/** How far from a prop a type is followed: the prop's own type, what that names, and what those name. */
const TYPE_DEPTH = 3;
/** The most types one component's reference spells out. */
const MAX_TYPES = 40;

/** Text with its comments taken out and its white space closed up: a type's shape on one line. */
function onOneLine(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // Markup cannot go inside a {…} value, so to the model a React node is a string.
  return clean.replace(/\s*\n\s*/g, ' ').replace(/;\s*}/g, ' }').replace(/\s+/g, ' ').replace(/\b(?:React\.)?ReactNode\b/g, 'string').trim();
}

/** A declaration's or a member's doc comment as one line, or ''. */
function docText(node) {
  const docs = node.jsDoc;
  if (!docs || docs.length === 0) return '';
  const text = ts.getTextOfJSDocComment(docs[docs.length - 1].comment);
  return text ? text.replace(/\s+/g, ' ').trim() : '';
}

/**
 * What a source file says of types: the ones it declares, each with its
 * shape on one line, its own comment and its fields with theirs, and the
 * ones it only brings in or hands on by name (`import { type X } from`,
 * `export type { X } from`, `export * from`), with where each is from.
 */
function typesOf(sourceText, path) {
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const declared = new Map();
  const from = new Map();
  const stars = [];
  const fieldsOf = (members) => {
    const fields = [];
    for (const member of members) {
      if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) continue;
      const name = member.name.getText(source);
      const written = onOneLine(member.getText(source)).replace(/[;,]\s*$/, '');
      fields.push({ name, written, doc: docText(member) });
    }
    return fields;
  };
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement)) {
      const open = statement.members.pos - 1;
      const shape = onOneLine(sourceText.slice(sourceText.lastIndexOf('{', open), statement.end));
      declared.set(statement.name.text, { shape, doc: docText(statement), fields: fieldsOf(statement.members) });
    } else if (ts.isTypeAliasDeclaration(statement)) {
      const shape = onOneLine(statement.type.getText(source));
      const fields = ts.isTypeLiteralNode(statement.type) ? fieldsOf(statement.type.members) : null;
      declared.set(statement.name.text, { shape, doc: docText(statement), fields });
    } else if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const module = statement.moduleSpecifier.text;
      if (!module.startsWith('.')) continue;
      const named = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : statement.exportClause;
      if (named && (ts.isNamedImports(named) || ts.isNamedExports(named))) {
        for (const element of named.elements) from.set(element.name.text, { module, name: (element.propertyName ?? element.name).text });
      } else if (ts.isExportDeclaration(statement) && !statement.exportClause) {
        stars.push(module);
      }
    }
  }
  return { declared, from, stars };
}

/**
 * Finds a type by the name a file knows it under: declared there, or in the
 * file it was brought in from, however many files on. `read` reads a file
 * of the components package by its path from the package.
 */
function typeFinder(read) {
  const files = new Map();
  const load = (path) => {
    if (!files.has(path)) {
      const text = read(path);
      files.set(path, text === null ? null : typesOf(text, path));
    }
    return files.get(path);
  };
  /** `module` as written in the file at `path`, as a file of the package: null when there is none. */
  const resolve = (path, module) => {
    const base = posix.normalize(posix.join(posix.dirname(path), module));
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (load(candidate)) return candidate;
    return null;
  };
  const find = (path, name, hops = 0) => {
    const file = load(path);
    if (!file || hops > 6) return null;
    const own = file.declared.get(name);
    if (own) return own;
    const brought = file.from.get(name);
    if (brought) {
      const other = resolve(path, brought.module);
      return other ? find(other, brought.name, hops + 1) : null;
    }
    for (const module of file.stars) {
      const other = resolve(path, module);
      const found = other ? find(other, name, hops + 1) : null;
      if (found) return found;
    }
    return null;
  };
  return find;
}

/** A type as the reference spells it out: `- Name = shape`, and what its comments say. */
function typeLines(name, type) {
  const said = (type.fields ?? []).filter((field) => field.doc);
  if (type.shape.length <= ONE_LINE_SHAPE || !type.fields) {
    const lines = [`- ${name} = ${type.shape}`];
    if (type.doc) lines.push(`  ${type.doc}`);
    for (const field of said) lines.push(`  - ${field.name}: ${field.doc}`);
    return lines;
  }
  // Too long to read on one line: a field to a line, each with its comment.
  const lines = [`- ${name} = {`];
  if (type.doc) lines.push(`    // ${type.doc}`);
  for (const field of type.fields) lines.push(`    ${field.written}${field.doc ? ` — ${field.doc}` : ''}`);
  lines.push('  }');
  return lines;
}

/**
 * The named types a component's props refer to, and the ones those refer
 * to, spelled out with their comments: a model given `objects?: Scene3DObject[]`
 * and nothing of what an object is can only guess. Every type a prop names
 * is written in full, whatever its length, from the component's own source
 * file or the file it brings the type in from; the types those name are
 * followed {@link TYPE_DEPTH} deep.
 */
function propTypeLines(component, members, find) {
  if (!component.source) return [];
  const propsInterface = component.props?.interface;
  const names = (text) => [...text.matchAll(/\b([A-Z]\w*)\b/g)].map((m) => m[1]);
  const queue = [];
  for (const m of members) for (const name of names(typeText(m.type))) queue.push([name, 1]);
  // And what its events hand over: the manifest says only that `onClick` is
  // a function, and the source says it is given a Scene3DHit.
  for (const field of (propsInterface ? find(component.source, propsInterface) : null)?.fields ?? []) {
    for (const name of names(field.written)) queue.push([name, 1]);
  }
  const seen = new Set();
  const lines = [];
  let count = 0;
  while (queue.length > 0 && count < MAX_TYPES) {
    const [name, depth] = queue.shift();
    if (seen.has(name) || name === propsInterface) continue;
    seen.add(name);
    const type = find(component.source, name);
    if (!type) continue;
    count++;
    lines.push(...typeLines(name, type));
    if (depth < TYPE_DEPTH) for (const next of names(type.shape)) queue.push([next, depth + 1]);
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
  const findType = typeFinder(readSource);
  for (const component of [...manifest.components].sort((a, b) => a.name.localeCompare(b.name))) {
    const registered = category[component.name] !== undefined;
    index.push({ name: component.name, category: category[component.name] ?? 'helper', purpose: PURPOSES[component.name], registered });
    const members = component.props?.members ?? [];
    // An event is a prop that is named for one and takes a function. The name
    // alone is not enough: Switch's onColor is the colour it has when on, and
    // was listed for the model as an event called @color.
    const isEvent = (m) => eventName(m.name) !== null && m.type?.kind === 'function';
    const props = members.filter((m) => !COMMON_PROPS.has(m.name) && !isEvent(m));
    const events = members.filter(isEvent);
    const acceptsChildren = members.some((m) => m.name === 'children');
    const lines = [];
    lines.push(`## ${component.name} — ${PURPOSES[component.name]}`);
    lines.push(registered ? `Tag: <${component.name}> (group: ${category[component.name]})` : 'Not registered as a tag: it cannot be used in markup.');
    if (component.doc) lines.push(component.doc);
    if (props.length > 0) {
      lines.push('Props (? = optional):');
      for (const m of props) lines.push(`- ${m.name}${m.optional ? '?' : ''}: ${typeText(m.type)}${m.doc ? ` — ${m.doc}` : ''}`);
      const types = propTypeLines(component, props, findType);
      if (types.length > 0) lines.push('Types the props use:', ...types);
    } else {
      lines.push('Props: none of its own.');
    }
    if (events.length > 0) {
      lines.push('Events (write @name={…}; the prop is onName):');
      // What each hands its handler, as the component's source declares it.
      const own = component.source && component.props?.interface ? findType(component.source, component.props.interface) : null;
      // A browser's event reaches a handler as plain data, so its React type is left unsaid.
      const given = new Map(
        (own?.fields ?? []).map((field) => [field.name, (/^[^:]+:\s*(\([^]*\))\s*=>/.exec(field.written)?.[1] ?? '').replace(/:\s*React\.\w*Event(?:<[^>]*>)?/g, '')])
      );
      for (const m of events) {
        const handed = given.get(m.name) ?? '';
        lines.push(`- @${eventName(m.name)}${handed && handed !== '()' ? handed : ''}${m.doc ? ` — ${m.doc}` : ''}`);
      }
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
