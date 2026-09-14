/**
 * Every rewrite propMigrations.ts makes, pinned: what an older Builder wrote,
 * what the components read, and the note the author sees.
 */

import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { CanvasElement } from '../types/builder';
import { PROP_MIGRATIONS, describeMigrations, migrateElementProps, migrateElements } from './propMigrations';
import { componentRegistry } from './componentRegistry';
import { loadBundle } from './bundleLoader';

function element(componentType: string, props: Record<string, unknown>, extra: Partial<CanvasElement> = {}): CanvasElement {
  return { id: 'e1', componentType, props: { ...props }, children: [], parentId: null, expressionProps: [], events: {}, ...extra };
}

describe('renamed props keep their value and their expression-ness', () => {
  it('Tag: colorScheme → variant with the colour mapped, variant → tagStyle, closable → removable', () => {
    const el = element('Tag', { variant: 'outline', colorScheme: 'green', closable: true, onClose: 'gone()' }, { events: { close: 'gone()' } });
    const notes = migrateElementProps(el);
    expect(el.props).toEqual({ tagStyle: 'outline', variant: 'success', removable: true, onRemove: 'gone()' });
    expect(el.events).toEqual({ remove: 'gone()' });
    expect(notes.join('\n')).toMatch(/colorScheme="green" became variant="success"/);
    expect(notes.join('\n')).toMatch(/variant="outline" became tagStyle="outline"/);
  });

  it('keeps an expression an expression', () => {
    const el = element('Tabs', { value: 'activeTab', defaultValue: 'tab1' }, { expressionProps: ['value'] });
    migrateElementProps(el);
    expect(el.props).toEqual({ activeKey: 'activeTab', defaultActiveKey: 'tab1' });
    expect(el.expressionProps).toEqual(['activeKey']);
  });

  it('does not overwrite a prop the element already has under the new name', () => {
    const el = element('Container', { maxWidth: 'sm', size: 'xl' });
    const notes = migrateElementProps(el);
    expect(el.props).toEqual({ size: 'xl' });
    expect(notes[0]).toMatch(/already has size/);
  });

  it('touches nothing on an element without legacy props', () => {
    const el = element('Tag', { variant: 'primary', tagStyle: 'solid' });
    expect(migrateElementProps(el)).toEqual([]);
    expect(el.props).toEqual({ variant: 'primary', tagStyle: 'solid' });
  });
});

describe('values the components fall back from become the ones they accept', () => {
  it.each([
    ['Tabs', 'variant', 'line', 'underline'],
    ['Tabs', 'variant', 'enclosed', 'default'],
    ['Toast', 'position', 'top', 'top-center'],
    ['Toast', 'position', 'bottom', 'bottom-center'],
    ['SmartView', 'layout', 'vertical', 'list'],
    ['SmartView', 'layout', 'horizontal', 'inline'],
    ['CodeEditor', 'language', 'rust', 'plain'],
    ['Progress', 'colorScheme', 'purple', 'info'],
  ])('%s %s=%s → %s', (type, prop, from, to) => {
    const el = element(type, { [prop]: from });
    migrateElementProps(el);
    const target = type === 'Progress' ? 'variant' : prop;
    expect(el.props[target]).toBe(to);
  });

  it('leaves a value it does not know alone', () => {
    const el = element('Tabs', { variant: 'pills' });
    expect(migrateElementProps(el)).toEqual([]);
    expect(el.props.variant).toBe('pills');
  });
});

describe('props nothing reads are dropped with a reason', () => {
  it('Heading size and weight', () => {
    const el = element('Heading', { level: 2, size: 'xl', weight: 'bold' });
    const notes = migrateElementProps(el);
    expect(el.props).toEqual({ level: 2 });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/size was dropped: a heading takes its size from level/);
  });

  it('says nothing about an empty value', () => {
    const el = element('Draggable', { axis: 'x', handle: '' });
    expect(migrateElementProps(el)).toEqual([]);
    expect(el.props).toEqual({ axis: 'x' });
  });
});

describe('the rewrites the table cannot say', () => {
  it('Card shadow becomes the elevated variant', () => {
    const el = element('Card', { shadow: 'lg' });
    migrateElementProps(el);
    expect(el.props).toEqual({ variant: 'elevated' });
    expect(migrateElementProps(element('Card', { shadow: 'none' })).length).toBe(1);
  });

  it('Split ratio and gap become the first pane size and the gutter', () => {
    const el = element('Split', { ratio: '1:2', gap: 'lg' });
    migrateElementProps(el);
    expect(el.props).toEqual({ initialSize: '33.33%', gutterSize: 12 });
  });

  it('Sidebar width in pixels becomes a CSS length', () => {
    const el = element('Sidebar', { width: 250 });
    migrateElementProps(el);
    expect(el.props.width).toBe('250px');
  });

  it('DatePicker format is lower-cased, or dropped when unknown; minDate/maxDate become min/max', () => {
    const el = element('DatePicker', { format: 'YYYY-MM-DD', minDate: '2026-01-01' });
    migrateElementProps(el);
    expect(el.props).toEqual({ format: 'yyyy-mm-dd', min: '2026-01-01' });
    const odd = element('DatePicker', { format: 'D MMM' });
    migrateElementProps(odd);
    expect(odd.props).toEqual({});
  });

  it("Alert's style select becomes alertStyle; a real style is left alone", () => {
    const el = element('Alert', { style: 'outline', closable: true });
    migrateElementProps(el);
    expect(el.props).toEqual({ alertStyle: 'outline', dismissible: true });
    const css = element('Alert', { style: { color: 'red' } });
    migrateElementProps(css);
    expect(css.props).toEqual({ style: { color: 'red' } });
  });

  it('Popover trigger mode moves to triggerMode; focus becomes hover', () => {
    const el = element('Popover', { trigger: 'focus', position: 'left', title: 'Hi' });
    const notes = migrateElementProps(el);
    expect(el.props).toEqual({ placement: 'left', triggerMode: 'hover' });
    expect(notes.join('\n')).toMatch(/title was dropped/);
    const node = element('Popover', { trigger: 'openButton' }, { expressionProps: ['trigger'] });
    migrateElementProps(node);
    expect(node.props).toEqual({ trigger: 'openButton' });
  });

  it('Collapse open/defaultOpen become isOpen; title and toggle go', () => {
    const el = element('Collapse', { title: 'More', defaultOpen: true, onToggle: 'flip()' }, { events: { toggle: 'flip()' } });
    migrateElementProps(el);
    expect(el.props).toEqual({ isOpen: true });
    expect(el.events).toEqual({});
    const bound = element('Collapse', { open: 'showMore' }, { expressionProps: ['open'] });
    migrateElementProps(bound);
    expect(bound.props).toEqual({ isOpen: 'showMore' });
    expect(bound.expressionProps).toEqual(['isOpen']);
  });

  it('List ordered/unordered variants become the ordered flag', () => {
    const ordered = element('List', { variant: 'ordered' });
    migrateElementProps(ordered);
    expect(ordered.props).toEqual({ ordered: true });
    const unordered = element('List', { variant: 'unordered' });
    migrateElementProps(unordered);
    expect(unordered.props).toEqual({});
  });

  it('Table striped/bordered become a variant; sortable and selectable go', () => {
    const el = element('Table', { striped: true, bordered: true, sortable: true, selectable: false });
    const notes = migrateElementProps(el);
    expect(el.props).toEqual({ variant: 'striped' });
    expect(notes.join('\n')).toMatch(/sortable was dropped/);
    const bordered = element('Table', { bordered: true });
    migrateElementProps(bordered);
    expect(bordered.props).toEqual({ variant: 'bordered' });
  });

  it('Pagination gets the props it needs: currentPage, totalItems, totalPages', () => {
    const el = element('Pagination', { total: 95, pageSize: 10, defaultCurrent: 1, onChange: 'go()', showSizeChanger: true }, { events: { change: 'go()' } });
    migrateElementProps(el);
    expect(el.props).toEqual({ totalItems: 95, pageSize: 10, currentPage: 1, onPageChange: 'go()', showPageSize: true, totalPages: 10 });
    expect(el.events).toEqual({ pageChange: 'go()' });
    const bound = element('Pagination', { total: 'count', current: 'page' }, { expressionProps: ['total', 'current'] });
    migrateElementProps(bound);
    expect(bound.props.totalPages).toBe('Math.max(1, Math.ceil((count) / (10)))');
    expect(bound.expressionProps).toEqual(expect.arrayContaining(['totalItems', 'currentPage', 'totalPages']));
  });

  it('DataGrid selectable becomes a selection mode', () => {
    const el = element('DataGrid', { selectable: true, pageSize: 20 });
    migrateElementProps(el);
    expect(el.props).toEqual({ selectionMode: 'multiple' });
  });

  it('LineChart data/xKey/yKey become a series expression', () => {
    const el = element('LineChart', { data: 'points', xKey: 'day', yKey: 'total', curved: true }, { expressionProps: ['data'] });
    migrateElementProps(el);
    expect(el.props).toEqual({ series: '[{ name: "total", data: (points).map((d) => ({ x: d["day"], y: d["total"] })) }]' });
    expect(el.expressionProps).toEqual(['series']);
    const literal = element('AreaChart', { data: '[]', xKey: 'name', yKey: 'value', color: '#fff' });
    migrateElementProps(literal);
    expect(literal.props.series).toBe('[{ name: "value", data: ([]).map((d) => ({ x: d["name"], y: d["value"] })) }]');
  });

  it('BarChart horizontal becomes orientation, the data a label/value series', () => {
    const el = element('BarChart', { data: 'rows', xKey: 'x', yKey: 'y', horizontal: true }, { expressionProps: ['data'] });
    migrateElementProps(el);
    expect(el.props).toEqual({ orientation: 'horizontal', series: '[{ name: "y", data: (rows).map((d) => ({ label: d["x"], value: d["y"] })) }]' });
  });

  it('PieChart keys map the data to label/value; donut becomes innerRadius', () => {
    const el = element('PieChart', { data: 'slices', nameKey: 'kind', dataKey: 'n', donut: true }, { expressionProps: ['data'] });
    migrateElementProps(el);
    expect(el.props).toEqual({ innerRadius: 60, data: '(slices).map((d) => ({ label: d["kind"], value: d["n"] }))' });
  });

  it('RadarChart gets axes and series from data and its keys', () => {
    const el = element('RadarChart', { data: 'stats', dataKey: 'score' }, { expressionProps: ['data'] });
    migrateElementProps(el);
    expect(el.props.axes).toBe('(stats).map((d) => d["name"])');
    expect(el.props.series).toBe('[{ name: "score", data: (stats).map((d) => ({ axis: d["name"], value: d["score"] })) }]');
  });

  it('editor heights become min/max CSS lengths', () => {
    const el = element('CodeEditor', { height: 300, showLineNumbers: false, theme: 'dark' });
    migrateElementProps(el);
    expect(el.props).toEqual({ minHeight: '300px', maxHeight: '300px', lineNumbers: false });
    const md = element('MarkdownEditor', { height: '40vh', preview: 'edit' });
    migrateElementProps(md);
    expect(md.props).toEqual({ minHeight: '40vh', maxHeight: '40vh', viewMode: 'edit' });
  });

  it('SmartStats data becomes stats', () => {
    const el = element('SmartStats', { data: 'metrics' }, { expressionProps: ['data'] });
    migrateElementProps(el);
    expect(el.props).toEqual({ stats: 'metrics' });
    expect(el.expressionProps).toEqual(['stats']);
  });

  it('a Loop repeater becomes a Box repeated per item; a timer Loop is left alone', () => {
    const el = element('Loop', { each: 'items', as: 'item', indexAs: 'i' }, { expressionProps: ['each'] });
    const notes = migrateElementProps(el);
    expect(el.componentType).toBe('Box');
    expect(el.loopEach).toBe('items');
    expect(el.loopAs).toBe('item, i');
    expect(el.props).toEqual({});
    expect(notes[0]).toMatch(/repeated per item/);
    const timer = element('Loop', { interval: 500, running: true });
    expect(migrateElementProps(timer)).toEqual([]);
    expect(timer.componentType).toBe('Loop');
  });
});

describe('the rules only name props the registry no longer offers', () => {
  const offered = new Map(componentRegistry.map((c) => [c.name, new Set(c.propSchema.map((p) => p.name))]));

  it('every migrated component is in the palette', () => {
    for (const name of Object.keys(PROP_MIGRATIONS)) expect(offered.has(name), name).toBe(true);
  });

  it('no renamed or dropped prop is still offered by the panel', () => {
    for (const [name, rule] of Object.entries(PROP_MIGRATIONS)) {
      const props = offered.get(name)!;
      for (const old of [...Object.keys(rule.rename ?? {}), ...Object.keys(rule.drop ?? {})]) {
        expect(props.has(old), `${name}.${old}`).toBe(false);
      }
    }
  });
});

describe('opening a bundle', () => {
  const bundle = (ui: string) =>
    zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'Legacy', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] } })),
      'ui/main.ui': strToU8(ui),
    });

  it('rewrites legacy attributes and lists each rewrite in the warnings', async () => {
    const loaded = await loadBundle(bundle('<App><Tag colorScheme="red" closable>Old</Tag><Table striped /></App>\n'));
    const tag = [...loaded.uiFiles.values()][0].elements;
    const props = [...tag.values()].map((e) => [e.componentType, e.props] as const);
    expect(props).toContainEqual(['Tag', expect.objectContaining({ variant: 'danger', removable: true })]);
    expect(props).toContainEqual(['Table', { variant: 'striped' }]);
    expect(loaded.warnings).toContain('ui/main.ui: <Tag> colorScheme="red" became variant="danger"');
    expect(loaded.warnings).toContain('ui/main.ui: <Table> striped became variant="striped"');
  });

  it('warns about nothing when there is nothing to migrate', async () => {
    const loaded = await loadBundle(bundle('<App><Tag variant="danger">New</Tag></App>\n'));
    expect(loaded.warnings.filter((w) => w.includes('<Tag>'))).toEqual([]);
  });

  it('describes a migration with the file and the component', () => {
    expect(describeMigrations('ui/x.ui', migrateElements([element('Image', { fit: 'contain' })]))).toEqual(['ui/x.ui: <Image> fit is now objectFit']);
  });
});
