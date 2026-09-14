/**
 * What an older Builder wrote that the components never read, and what it
 * means today.
 *
 * The property panel used to offer props the components do not declare
 * (`Tag colorScheme`, `LineChart data/xKey/yKey`, `Table striped`) and values
 * they fall back from (`Tabs variant="line"`, `Toast position="top"`). The
 * runtime passes attributes straight to the component, so every one of
 * those was written into the `.ui` file and then ignored: a chart with no
 * series, a tag in the default colour. The registry now offers only what
 * the components take (`componentRegistry.manifest.test.ts` holds it to
 * `component-manifest.json`), and this module carries the old spellings
 * forward when a file that has them is opened.
 *
 * Applied to the elements of a `.ui` file on open (`bundleLoader`) and to a
 * saved session (`openProject`), never on export: an export writes what the
 * canvas holds. The runtime is not changed — a bundle exported before this
 * renders exactly as it did; one re-exported from Builder renders the
 * migrated attributes, which for a prop the component ignored means the
 * same, and for a chart or a repeater means it starts working. Every
 * rewrite is reported in the open warnings so the author can see what
 * moved.
 */

import type { CanvasElement } from '../types/builder';

export interface PropMigrationNote {
  elementId: string;
  component: string;
  message: string;
}

type Note = (message: string) => void;

interface Rule {
  /** Old prop name → the name the component reads (value kept). */
  rename?: Record<string, string>;
  /** Prop (after renaming) → old value → the value the component accepts. */
  values?: Record<string, Record<string, string>>;
  /** Old prop name → why nothing takes its place. */
  drop?: Record<string, string>;
  /** Old `@event` → new `@event`, or null when nothing listens. */
  events?: Record<string, string | null>;
  /** What the table cannot say. Runs after the table. */
  custom?: (el: CanvasElement, note: Note) => void;
}

const has = (el: CanvasElement, name: string): boolean => Object.prototype.hasOwnProperty.call(el.props, name);
const isExpression = (el: CanvasElement, name: string): boolean => (el.expressionProps ?? []).includes(name);

/** Remove a prop and say whether it was an expression. */
function take(el: CanvasElement, name: string): { value: unknown; expression: boolean } | null {
  if (!has(el, name)) return null;
  const value = el.props[name];
  const expression = isExpression(el, name);
  delete el.props[name];
  if (expression) el.expressionProps = (el.expressionProps ?? []).filter((p) => p !== name);
  return { value, expression };
}

function put(el: CanvasElement, name: string, value: unknown, expression = false): void {
  el.props[name] = value;
  const set = new Set(el.expressionProps ?? []);
  if (expression) set.add(name);
  else set.delete(name);
  el.expressionProps = [...set];
}

/** The text of a prop as an expression: an expression as written, a literal quoted. */
function asExpression(taken: { value: unknown; expression: boolean }): string {
  if (taken.expression) return String(taken.value);
  if (typeof taken.value === 'string') {
    const text = taken.value.trim();
    // A literal array or object typed into an expression control.
    if (/^[[{]/.test(text)) return text;
    return JSON.stringify(taken.value);
  }
  return JSON.stringify(taken.value);
}

function stringValue(taken: { value: unknown; expression: boolean } | null, fallback: string): string {
  if (!taken || taken.expression || typeof taken.value !== 'string' || taken.value === '') return fallback;
  return taken.value;
}

const px = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}px`;
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) return `${value.trim()}px`;
  return null;
};

/** `height` on the editors → the min/max pair the components take. */
function heightToMinMax(el: CanvasElement, note: Note): void {
  const height = take(el, 'height');
  if (!height) return;
  const size = px(height.value) ?? (typeof height.value === 'string' ? height.value : null);
  if (!size || height.expression) {
    note('height was dropped: the editor takes minHeight and maxHeight as CSS lengths');
    return;
  }
  if (!has(el, 'minHeight')) put(el, 'minHeight', size);
  if (!has(el, 'maxHeight')) put(el, 'maxHeight', size);
  note(`height ${JSON.stringify(height.value)} became minHeight and maxHeight ${size}`);
}

/** `data` + key names on the line and area charts → `series`. */
function xySeries(el: CanvasElement, note: Note): void {
  const data = take(el, 'data');
  const xKey = stringValue(take(el, 'xKey'), 'x');
  const yKey = stringValue(take(el, 'yKey'), 'y');
  if (!data) return;
  if (has(el, 'series')) {
    note('data, xKey and yKey were dropped: the chart already has series');
    return;
  }
  const source = asExpression(data);
  put(
    el,
    'series',
    `[{ name: ${JSON.stringify(yKey)}, data: (${source}).map((d) => ({ x: d[${JSON.stringify(xKey)}], y: d[${JSON.stringify(yKey)}] })) }]`,
    true
  );
  note(`data, xKey and yKey became a series expression (x from ${JSON.stringify(xKey)}, y from ${JSON.stringify(yKey)}); the chart reads series only`);
}

export const PROP_MIGRATIONS: Record<string, Rule> = {
  // Layout
  Card: {
    custom(el, note) {
      const shadow = take(el, 'shadow');
      if (!shadow) return;
      if (shadow.value !== 'none' && !has(el, 'variant')) {
        put(el, 'variant', 'elevated');
        note(`shadow ${JSON.stringify(shadow.value)} became variant="elevated"; the card has no shadow prop`);
      } else {
        note('shadow was dropped: the card has no shadow prop (variant="elevated" is the shadowed card)');
      }
    },
  },
  Container: { rename: { maxWidth: 'size' } },
  Divider: { rename: { orientation: 'direction' } },
  Split: {
    custom(el, note) {
      const ratio = take(el, 'ratio');
      if (ratio && !ratio.expression) {
        const size = ({ '1:1': '50%', '1:2': '33.33%', '2:1': '66.67%', '1:3': '25%', '3:1': '75%' } as Record<string, string>)[String(ratio.value)];
        if (size && !has(el, 'initialSize')) {
          put(el, 'initialSize', size);
          note(`ratio ${JSON.stringify(ratio.value)} became initialSize="${size}" (the first pane's size)`);
        } else note('ratio was dropped: the split takes initialSize, the first pane’s size');
      } else if (ratio) note('ratio was dropped: the split takes initialSize, the first pane’s size');
      const gap = take(el, 'gap');
      if (gap && !gap.expression) {
        const gutter = ({ none: 0, xs: 2, sm: 4, md: 8, lg: 12, xl: 16 } as Record<string, number>)[String(gap.value)];
        if (gutter !== undefined && !has(el, 'gutterSize')) {
          put(el, 'gutterSize', gutter);
          note(`gap ${JSON.stringify(gap.value)} became gutterSize={${gutter}}`);
        } else note('gap was dropped: the split takes gutterSize in pixels');
      } else if (gap) note('gap was dropped: the split takes gutterSize in pixels');
    },
  },
  Sidebar: {
    custom(el, note) {
      if (!has(el, 'width') || isExpression(el, 'width')) return;
      const size = px(el.props.width);
      if (size && size !== el.props.width) {
        put(el, 'width', size);
        note(`width became "${size}": the sidebar takes a CSS length`);
      }
    },
  },

  // Form
  Slider: { rename: { showValue: 'showTooltip' } },
  DatePicker: {
    rename: { minDate: 'min', maxDate: 'max' },
    custom(el, note) {
      if (!has(el, 'format') || isExpression(el, 'format')) return;
      const wanted = String(el.props.format).toLowerCase();
      if (['yyyy-mm-dd', 'mm/dd/yyyy', 'dd/mm/yyyy'].includes(wanted)) {
        if (wanted !== el.props.format) {
          note(`format ${JSON.stringify(el.props.format)} became "${wanted}"`);
          put(el, 'format', wanted);
        }
      } else {
        note(`format ${JSON.stringify(el.props.format)} was dropped: the picker offers yyyy-mm-dd, mm/dd/yyyy or dd/mm/yyyy`);
        take(el, 'format');
      }
    },
  },
  ColorPicker: { drop: { format: 'the picker always works in hex' } },

  // Display
  Heading: {
    drop: {
      size: 'a heading takes its size from level',
      weight: 'a heading takes its weight from level; use className for another',
    },
  },
  Tag: {
    rename: { closable: 'removable', onClose: 'onRemove' },
    events: { close: 'remove' },
    // `variant` changed meaning: it used to be the style (solid, outline,
    // subtle) and is now the colour, so only the old values move.
    custom(el, note) {
      const variant = el.props.variant;
      if (typeof variant === 'string' && ['solid', 'outline', 'subtle'].includes(variant) && !isExpression(el, 'variant')) {
        take(el, 'variant');
        if (!has(el, 'tagStyle')) put(el, 'tagStyle', variant);
        note(`variant="${variant}" became tagStyle="${variant}"; variant is now the colour`);
      }
      const colour = take(el, 'colorScheme');
      if (!colour) return;
      if (has(el, 'variant')) {
        note('colorScheme was dropped: the element already has variant');
        return;
      }
      const map: Record<string, string> = { gray: 'default', blue: 'primary', green: 'success', red: 'danger', yellow: 'warning', purple: 'secondary' };
      const mapped = !colour.expression && typeof colour.value === 'string' ? map[colour.value] : undefined;
      put(el, 'variant', mapped ?? colour.value, colour.expression);
      note(mapped ? `colorScheme="${colour.value}" became variant="${mapped}"` : 'colorScheme is now variant');
    },
  },
  Progress: {
    rename: { colorScheme: 'variant', showValue: 'showLabel' },
    values: { variant: { blue: 'primary', green: 'success', red: 'danger', yellow: 'warning', purple: 'info' } },
  },
  Image: { rename: { fit: 'objectFit', fallback: 'fallbackSrc' } },

  // Feedback
  Alert: {
    rename: { closable: 'dismissible', onClose: 'onDismiss' },
    events: { close: 'dismiss' },
    custom(el, note) {
      const style = el.props.style;
      if (typeof style === 'string' && ['filled', 'light', 'outline', 'subtle'].includes(style) && !isExpression(el, 'style')) {
        take(el, 'style');
        if (!has(el, 'alertStyle')) put(el, 'alertStyle', style);
        note(`style="${style}" became alertStyle="${style}": style is the element's CSS`);
      }
    },
  },
  Modal: { rename: { closeOnOverlay: 'closeOnOverlayClick' } },
  Toast: { values: { position: { top: 'top-center', bottom: 'bottom-center' } } },
  Popover: {
    rename: { position: 'placement' },
    drop: { title: 'the popover shows its children; put a heading inside' },
    custom(el, note) {
      const trigger = el.props.trigger;
      if (typeof trigger !== 'string' || isExpression(el, 'trigger') || !['click', 'hover', 'focus'].includes(trigger)) return;
      take(el, 'trigger');
      const mode = trigger === 'focus' ? 'hover' : trigger;
      if (!has(el, 'triggerMode')) put(el, 'triggerMode', mode);
      note(trigger === 'focus' ? 'trigger="focus" became triggerMode="hover": the popover opens on click or hover' : `trigger="${trigger}" became triggerMode="${trigger}"; trigger is the element that opens it`);
    },
  },
  Tooltip: { rename: { position: 'placement', delay: 'showDelay' } },

  // Navigation
  Tabs: {
    rename: { defaultValue: 'defaultActiveKey', value: 'activeKey' },
    values: { variant: { line: 'underline', enclosed: 'default' } },
    drop: { orientation: 'tabs run horizontally' },
  },
  Menu: { drop: { orientation: 'the menu is a dropdown; give it items and a trigger' } },
  NavItem: { rename: { href: 'navigate' } },
  Accordion: {
    rename: { allowMultiple: 'multiple' },
    drop: { defaultIndex: 'the accordion opens items by key: defaultOpenKeys' },
  },
  Collapse: {
    drop: { title: 'the collapse shows or hides its children; put a heading before it', onToggle: 'the collapse is controlled by isOpen' },
    events: { toggle: null },
    custom(el, note) {
      const open = take(el, 'open');
      const defaultOpen = take(el, 'defaultOpen');
      if (has(el, 'isOpen')) return;
      if (open) {
        put(el, 'isOpen', open.value, open.expression);
        note('open became isOpen');
      } else if (defaultOpen) {
        put(el, 'isOpen', defaultOpen.value, defaultOpen.expression);
        note('defaultOpen became isOpen; the collapse is controlled');
      }
    },
  },

  // Data
  List: {
    custom(el, note) {
      const variant = el.props.variant;
      if (isExpression(el, 'variant')) return;
      if (variant === 'ordered') {
        take(el, 'variant');
        put(el, 'ordered', true);
        note('variant="ordered" became ordered; variant is now default, bordered or divided');
      } else if (variant === 'unordered') {
        take(el, 'variant');
        note('variant="unordered" was dropped: an unordered list is the default');
      }
    },
  },
  ListItem: { drop: { icon: 'a list item takes leading and trailing content, not an icon name' } },
  Table: {
    drop: { sortable: 'sorting is sortColumn, sortDirection and @sort', selectable: 'the table has no row selection' },
    custom(el, note) {
      const striped = take(el, 'striped');
      const bordered = take(el, 'bordered');
      if (has(el, 'variant') || isExpression(el, 'variant')) {
        if (striped || bordered) note('striped and bordered were dropped: the table already has variant');
        return;
      }
      if (striped?.value === true) {
        put(el, 'variant', 'striped');
        note(bordered?.value === true ? 'striped and bordered became variant="striped" (one variant at a time)' : 'striped became variant="striped"');
      } else if (bordered?.value === true) {
        put(el, 'variant', 'bordered');
        note('bordered became variant="bordered"');
      }
    },
  },
  TreeView: {
    rename: { data: 'nodes' },
    drop: {
      defaultExpandedKeys: 'the tree takes defaultExpandAll or a controlled expandedIds',
      selectable: 'selection is @select',
      checkable: 'the tree has no checkboxes',
    },
  },
  Pagination: {
    rename: { total: 'totalItems', current: 'currentPage', onChange: 'onPageChange', showSizeChanger: 'showPageSize' },
    events: { change: 'pageChange' },
    drop: { showQuickJumper: 'the pagination has no jumper' },
    custom(el, note) {
      const defaultCurrent = take(el, 'defaultCurrent');
      if (defaultCurrent && !has(el, 'currentPage')) {
        put(el, 'currentPage', defaultCurrent.value, defaultCurrent.expression);
        note('defaultCurrent became currentPage; the pagination is controlled');
      }
      if (has(el, 'totalPages') || !has(el, 'totalItems')) return;
      const total = el.props.totalItems;
      const size = has(el, 'pageSize') ? el.props.pageSize : 10;
      if (!isExpression(el, 'totalItems') && typeof total === 'number' && typeof size === 'number' && size > 0 && !isExpression(el, 'pageSize')) {
        put(el, 'totalPages', Math.max(1, Math.ceil(total / size)));
      } else {
        const totalText = isExpression(el, 'totalItems') ? String(total) : JSON.stringify(total);
        const sizeText = isExpression(el, 'pageSize') ? String(size) : JSON.stringify(size);
        put(el, 'totalPages', `Math.max(1, Math.ceil((${totalText}) / (${sizeText})))`, true);
      }
      note('totalPages was derived from totalItems and pageSize; the pagination needs it');
    },
  },
  DataGrid: {
    drop: {
      pageSize: 'the grid is virtualised, not paged',
      sortable: 'sorting is sortKey, sortDirection and @sort',
      filterable: 'filtering is filters and @filterChange',
    },
    custom(el, note) {
      const selectable = take(el, 'selectable');
      if (!selectable || selectable.expression) return;
      if (!has(el, 'selectionMode')) put(el, 'selectionMode', selectable.value === true ? 'multiple' : 'none');
      note(`selectable became selectionMode="${selectable.value === true ? 'multiple' : 'none'}"`);
    },
  },

  // Charts
  LineChart: {
    drop: { curved: 'a series is drawn straight; smoothing is per series' },
    custom: xySeries,
  },
  AreaChart: {
    drop: { color: 'colour is per series; the theme colours the rest' },
    custom: xySeries,
  },
  BarChart: {
    custom(el, note) {
      const horizontal = take(el, 'horizontal');
      if (horizontal && !horizontal.expression && !has(el, 'orientation')) {
        put(el, 'orientation', horizontal.value === true ? 'horizontal' : 'vertical');
        note(`horizontal became orientation="${horizontal.value === true ? 'horizontal' : 'vertical'}"`);
      } else if (horizontal) note('horizontal was dropped: the chart takes orientation');
      const data = take(el, 'data');
      const xKey = stringValue(take(el, 'xKey'), 'x');
      const yKey = stringValue(take(el, 'yKey'), 'y');
      if (!data) return;
      if (has(el, 'series')) {
        note('data, xKey and yKey were dropped: the chart already has series');
        return;
      }
      put(
        el,
        'series',
        `[{ name: ${JSON.stringify(yKey)}, data: (${asExpression(data)}).map((d) => ({ label: d[${JSON.stringify(xKey)}], value: d[${JSON.stringify(yKey)}] })) }]`,
        true
      );
      note(`data, xKey and yKey became a series expression (label from ${JSON.stringify(xKey)}, value from ${JSON.stringify(yKey)})`);
    },
  },
  PieChart: {
    custom(el, note) {
      const donut = take(el, 'donut');
      if (donut && !donut.expression) {
        if (donut.value === true && !has(el, 'innerRadius')) put(el, 'innerRadius', 60);
        note(donut.value === true ? 'donut became innerRadius={60}' : 'donut was dropped: innerRadius makes a donut');
      } else if (donut) note('donut was dropped: innerRadius makes a donut');
      const nameKey = take(el, 'nameKey');
      const dataKey = take(el, 'dataKey');
      if (!nameKey && !dataKey) return;
      const label = stringValue(nameKey, 'name');
      const value = stringValue(dataKey, 'value');
      if (!has(el, 'data')) return;
      const data = take(el, 'data')!;
      put(el, 'data', `(${asExpression(data)}).map((d) => ({ label: d[${JSON.stringify(label)}], value: d[${JSON.stringify(value)}] }))`, true);
      note(`nameKey and dataKey became a data expression (label from ${JSON.stringify(label)}, value from ${JSON.stringify(value)}); the chart reads label and value`);
    },
  },
  RadarChart: {
    custom(el, note) {
      const data = take(el, 'data');
      const nameKey = stringValue(take(el, 'nameKey'), 'name');
      const dataKey = stringValue(take(el, 'dataKey'), 'value');
      if (!data) return;
      if (has(el, 'series')) {
        note('data, nameKey and dataKey were dropped: the chart already has series');
        return;
      }
      const source = asExpression(data);
      if (!has(el, 'axes')) put(el, 'axes', `(${source}).map((d) => d[${JSON.stringify(nameKey)}])`, true);
      put(
        el,
        'series',
        `[{ name: ${JSON.stringify(dataKey)}, data: (${source}).map((d) => ({ axis: d[${JSON.stringify(nameKey)}], value: d[${JSON.stringify(dataKey)}] })) }]`,
        true
      );
      note(`data, nameKey and dataKey became axes and series expressions (axis from ${JSON.stringify(nameKey)}, value from ${JSON.stringify(dataKey)})`);
    },
  },

  // Editors
  CodeEditor: {
    rename: { showLineNumbers: 'lineNumbers' },
    values: { language: { rust: 'plain', go: 'plain' } },
    drop: { theme: 'the editor follows the app theme' },
    custom: heightToMinMax,
  },
  MarkdownEditor: { rename: { preview: 'viewMode' }, custom: heightToMinMax },
  RichTextEditor: { custom: heightToMinMax },

  // Smart
  SmartForm: { rename: { values: 'data', submitLabel: 'submitText' } },
  SmartView: { values: { layout: { vertical: 'list', horizontal: 'inline' } } },
  SmartStats: {
    custom(el, note) {
      const data = take(el, 'data');
      if (!data) return;
      if (has(el, 'stats')) {
        note('data was dropped: the stats already come from stats');
        return;
      }
      put(el, 'stats', data.value, data.expression);
      note('data became stats');
    },
  },
  SmartCards: {
    rename: { titleField: 'title', descriptionField: 'description', imageField: 'image', onClick: 'onSelect' },
    events: { click: 'select' },
  },
  SmartList: {
    rename: { titleField: 'primary', descriptionField: 'secondary', onClick: 'onSelect' },
    events: { click: 'select' },
    drop: { search: 'the list has no search box; filter data before it' },
  },
  SmartTimeline: { rename: { dateField: 'time', titleField: 'title', descriptionField: 'description' } },
  EmptyState: { drop: { actionLabel: 'the action is content: put a Button in action' } },

  // Utility
  Loop: {
    custom(el, note) {
      const each = take(el, 'each');
      const as = take(el, 'as');
      const indexAs = take(el, 'indexAs');
      if (!each && !as && !indexAs) return;
      // The palette's "Loop" repeated a timer that renders nothing, so the
      // children never appeared. A repeated Box is what was meant.
      el.componentType = 'Box';
      if (each && !el.loopEach) el.loopEach = each.expression ? String(each.value) : String(each.value);
      const alias = stringValue(as, 'item');
      const index = stringValue(indexAs, '');
      if (!el.loopAs) el.loopAs = index ? `${alias}, ${index}` : alias;
      note(`Loop with each/as became a Box repeated per item (each={${el.loopEach ?? ''}} as="${el.loopAs}"); Loop is the interval timer`);
    },
  },
  PixelGrid: { rename: { columns: 'cols', data: 'items' } },
  Draggable: { drop: { handle: 'the whole element is the handle' } },
  SortableList: { rename: { itemKey: 'renderKey' } },
};

/** Apply the rules for one element, in place. Returns what changed. */
export function migrateElementProps(el: CanvasElement): string[] {
  const rule = PROP_MIGRATIONS[el.componentType];
  if (!rule) return [];
  const notes: string[] = [];
  const note: Note = (message) => notes.push(message);

  if (rule.rename) {
    for (const [from, to] of Object.entries(rule.rename)) {
      const taken = has(el, from) ? take(el, from) : null;
      if (!taken) continue;
      if (has(el, to)) {
        note(`${from} was dropped: the element already has ${to}`);
        continue;
      }
      put(el, to, taken.value, taken.expression);
      note(`${from} is now ${to}`);
    }
  }
  if (rule.values) {
    for (const [prop, map] of Object.entries(rule.values)) {
      if (!has(el, prop) || isExpression(el, prop)) continue;
      const current = el.props[prop];
      if (typeof current !== 'string' || !(current in map)) continue;
      put(el, prop, map[current]);
      note(`${prop}="${current}" became "${map[current]}"`);
    }
  }
  if (rule.drop) {
    for (const [prop, why] of Object.entries(rule.drop)) {
      const taken = take(el, prop);
      if (!taken) continue;
      if (taken.value === '' || taken.value === undefined || taken.value === null) continue;
      note(`${prop} was dropped: ${why}`);
    }
  }
  if (rule.events && el.events) {
    for (const [from, to] of Object.entries(rule.events)) {
      if (!(from in el.events)) continue;
      const handler = el.events[from];
      delete el.events[from];
      if (to && handler) {
        if (!el.events[to]) el.events[to] = handler;
        note(`@${from} is now @${to}`);
      } else if (handler) {
        note(`@${from} was dropped: nothing listens for it`);
      }
    }
  }
  rule.custom?.(el, note);
  return notes;
}

/** Apply the rules to every element of a file. Returns one note per change. */
export function migrateElements(elements: Iterable<CanvasElement>): PropMigrationNote[] {
  const out: PropMigrationNote[] = [];
  for (const el of elements) {
    const component = el.componentType;
    for (const message of migrateElementProps(el)) out.push({ elementId: el.id, component, message });
  }
  return out;
}

/** The notes as the open-warnings list shows them. */
export function describeMigrations(file: string, notes: PropMigrationNote[]): string[] {
  return notes.map((n) => `${file}: <${n.component}> ${n.message}`);
}
