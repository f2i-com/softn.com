/**
 * Props as a page writes them, where the components took them only as their
 * types say. An audit drew every component about 74,000 times with wrong and
 * edge values, through the page's own parser and renderer; each case below
 * is one it found, and each threw, looped, froze the page or drew the wrong
 * thing. (Numbers written as text and numbers as yes-or-no are held by
 * declared-prop-kinds.test.tsx.)
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComponentRegistry, parse, renderDocument, type SoftNRenderContext } from '@softn/core';
import { mount, click, type Mounted } from './dom';
import { registerBuiltinComponents } from '../src/registry';

const registry = new ComponentRegistry();
registerBuiltinComponents(registry);

function page(source: string, state: Record<string, unknown> = {}): React.ReactElement {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const context = { state, setState: () => {}, data: {}, props: {}, computed: {}, functions: {}, asyncFunctions: {} } as unknown as SoftNRenderContext;
  return <>{renderDocument(doc, context, registry)}</>;
}
const drawn = (source: string, state?: Record<string, unknown>): string => renderToStaticMarkup(page(source, state));

const mounted: Mounted[] = [];
afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount();
  vi.restoreAllMocks();
});
function mounts(source: string, state?: Record<string, unknown>): Mounted {
  const view = mount(page(source, state));
  mounted.push(view);
  return view;
}
/** What the renderer's error boundary or React said, while drawing `source` mounted. */
function failures(source: string, state?: Record<string, unknown>): string[] {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => errors.push(args.map(String).join(' ')));
  mounts(source, state);
  return errors.filter((e) => /Error in <|Too many re-renders|is not a function|Cannot read/.test(e));
}

describe('what froze or crashed the page', () => {
  it('RadarChart draws at most 20 rings, whatever levels says', () => {
    const series = '[{name:"s", data:[{axis:"a",value:1},{axis:"b",value:2},{axis:"c",value:3}]}]';
    const rings = (levels: string) => (drawn(`<RadarChart axes={["a","b","c"]} series={${series}} levels={${levels}} />`).match(/stroke-dasharray="4,4"/g) ?? []).length;
    expect(rings('1e9')).toBe(20);
    expect(rings('Infinity')).toBe(5);
    expect(rings('3')).toBe(3);
  });

  it.each([
    ['<CodeEditor value={x} />', Number.NaN],
    ['<MarkdownEditor viewMode={x} />', Number.NaN],
    ['<DataGrid data={[{id:1,name:"A"}]} sortKey={x} />', Number.NaN],
    ['<Table columns={[{key:"name",header:"Name"}]} data={[{name:"A"}]} sortColumn={x} />', Number.NaN],
    ['<SmartForm data={x} />', Number.NaN],
    ['<CodeEditor value={x} />', () => 'a function'],
  ])('%s with a value that is never equal to itself draws once', (source, x) => {
    expect(failures(source, { x })).toEqual([]);
  });

  it('takes a list where a Set goes, as a page can only write a list', () => {
    expect(failures('<DataGrid data={[{id:1,name:"A"},{id:2,name:"B"}]} selectionMode="multiple" selectedKeys={[1]} />')).toEqual([]);
    const tree = mounts('<TreeView nodes={[{id:"1",label:"One",children:[{id:"2",label:"Two"}]}]} expandedIds={["1"]} />');
    expect(tree.container.textContent).toContain('Two');
  });

  it('takes a list or text where names go, and matches whole names', () => {
    expect(failures('<SmartView data={{name:"Ann", age:3, city:"X"}} fields={["name","age"]} />')).toEqual([]);
    const grid = drawn('<SmartGrid data={[{name:"A", nameLong:"B", e:"C"}]} hideColumns="nameLong" />');
    expect(grid).toContain('>Name<');
    expect(grid).not.toContain('Name Long');
    expect(failures('<SmartGrid data={[{a:1}]} hideColumns={1} />')).toEqual([]);
  });

  it('draws a callback prop written as text as if it were not given', () => {
    expect(failures('<Progress value={40} showLabel formatLabel="{value}%" />')).toEqual([]);
    expect(failures('<Slider value={30} ariaLabel="v" formatTooltip="x" showTooltip />')).toEqual([]);
    expect(failures('<SmartCards data={[{id:1,name:"A"}]} renderCard="card" />')).toEqual([]);
  });

  it('QRCode says when its text is too long for any code, and fits what it can at a lower level', () => {
    const long = 'x'.repeat(3000);
    expect(failures('<QRCode value={v} />', { v: long })).toEqual([]);
    expect(drawn('<QRCode value={v} />', { v: long })).toContain('Too long for a QR code');
    expect(drawn('<QRCode value={v} errorCorrection="H" />', { v: 'x'.repeat(2000) })).toContain('<canvas');
  });
});

describe('what was drawn wrong', () => {
  it.each(['LineChart', 'AreaChart', 'BarChart'])('%s at width="100%" draws, at its own size', (chart) => {
    const out = drawn(`<${chart} width="100%" series={[{name:"s", data:[{x:1,y:2},{x:2,y:3}]}]} data={[{label:"a",value:1}]} />`);
    expect(out).not.toContain('NaN');
  });

  it('PieChart, GaugeChart and RadarChart at width="100%" draw without NaN', () => {
    expect(drawn('<PieChart width="100%" data={[{label:"a",value:3},{label:"b",value:5}]} />')).not.toContain('NaN');
    expect(drawn('<GaugeChart width="100%" value={60} />')).not.toContain('NaN');
    expect(drawn('<RadarChart width="100%" axes={["a","b","c"]} series={[{name:"s",data:[{axis:"a",value:1}]}]} />')).not.toContain('NaN');
  });

  it('GaugeChart draws a shape it does not know as a semicircle', () => {
    expect(drawn('<GaugeChart value={60} variant="half" />')).toBe(drawn('<GaugeChart value={60} variant="semicircle" />'));
  });

  it('Accordion and Tabs key items without keys by their place', () => {
    const accordion = mounts('<Accordion items={[{header:"A",content:"Alpha"},{header:"B",content:"Beta"}]} />');
    click(accordion.container.querySelectorAll('button')[1]);
    expect([...accordion.container.querySelectorAll('button')].map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
    const tabs = drawn('<Tabs tabs={[{label:"A",content:"Alpha"},{label:"B",content:"Beta"}]} />');
    expect(tabs.match(/aria-selected="true"/g)).toHaveLength(1);
  });

  it('Accordion reads open keys written as text as whole keys, and a heading level it can draw', () => {
    const open = drawn('<Accordion items={[{key:"a",header:"A",content:"x"},{key:"b",header:"B",content:"y"},{key:"ab",header:"AB",content:"z"}]} defaultOpenKeys="ab" />');
    expect(open.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(drawn('<Accordion headingLevel={7} items={[{key:"a",header:"A",content:"x"}]} />')).toContain('<h3');
  });

  it('Slider draws marks written as numbers, and passes over a hole', () => {
    const out = drawn('<Slider value={30} marks={[0, null, 50, 100]} ariaLabel="v" />');
    expect(out).not.toContain('NaN');
    expect(out).toContain('left:50%');
  });

  it('a number written as text where a number or CSS text goes', () => {
    expect(drawn('<Grid columns="3"><div>a</div></Grid>')).toContain('repeat(3, 1fr)');
    expect(drawn('<Image src="a.png" alt="A" width="300" height="200" />')).toContain('width:300px;height:200px');
    expect(drawn('<Avatar name="Ada" size="64" />')).toContain('64px');
    expect(drawn('<Badge content="12" max={9} />')).toContain('9+');
    expect(drawn('<Stat label="Sales" value="10" change="5" />')).toContain('5%');
  });

  it('the small ones', () => {
    expect(drawn('<Kbd keys={["Ctrl", null, "C"]} />')).not.toContain('null');
    expect(drawn('<SortableList items={[{id:1,name:"Ann"}, null]} />')).not.toMatch(/null|undefined|object Object/);
    expect(failures('<EmptyState title="x" size="small" />')).toEqual([]);
    expect(drawn('<Skeleton speed="medium" />')).not.toContain('undefined');
    const radios = mounts('<Radio options={[{label:"Yes"},{label:"No"}]} />');
    const inputs = radios.container.querySelectorAll('input');
    expect([...inputs].map((input) => input.value)).toEqual(['Yes', 'No']);
    expect(failures('<Pagination currentPage={2} totalPages={5} />')).toEqual([]);
  });
});
