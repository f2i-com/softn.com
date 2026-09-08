/**
 * Which tags a document renders before anything has happened — what the
 * renderer preloads. The rule under test is the negative one: a component
 * behind a condition is a later route and must not be named, however
 * plainly static analysis can see it.
 */

import { describe, it, expect } from 'vitest';
import { parse } from '../src/parser';
import { collectAllComponentTags, collectFirstScreenTags } from '../src/renderer/document-tags';
import { createDocument, type SoftNDocument } from '../src/parser/ast';

const tags = (source: string): Set<string> => collectFirstScreenTags(parse(source));

const loc = { line: 1, column: 0, start: 0, end: 0 };

describe('collectFirstScreenTags', () => {
  it('collects nested unconditional elements, HTML tags included', () => {
    const found = tags('<Stack><Heading>t</Heading><div><Scene3D /></div></Stack>');
    expect([...found].sort()).toEqual(['Heading', 'Scene3D', 'Stack', 'div']);
  });

  it('skips every branch of an #if, else and elseif alike', () => {
    const found = tags(
      [
        "#if (page === 'game')",
        '<Scene3D />',
        "#elseif (page === 'chart')",
        '<LineChart />',
        '#else',
        '<Text>x</Text>',
        '#end',
        '<Button>go</Button>',
      ].join('\n')
    );
    expect([...found]).toEqual(['Button']);
  });

  it('counts an #each body and its #empty fallback', () => {
    const found = tags('#each (item in items)\n<Card>{item}</Card>\n#empty\n<EmptyState />\n#end');
    expect([...found].sort()).toEqual(['Card', 'EmptyState']);
  });

  it('skips an element with an inline if and everything under it', () => {
    const found = tags('<Box if={open}><Scene3D /></Box><Text>y</Text>');
    expect([...found]).toEqual(['Text']);
  });

  it('counts an element with an inline each', () => {
    const found = tags('<Card each={items} as="item"><Badge /></Card>');
    expect([...found].sort()).toEqual(['Badge', 'Card']);
  });

  it('counts slot fallbacks and template slot children', () => {
    const doc: SoftNDocument = createDocument({
      loc,
      template: [
        {
          type: 'Slot',
          name: 'default',
          loc,
          fallback: [
            {
              type: 'Element',
              tag: 'Spinner',
              props: [],
              events: [],
              bindings: [],
              children: [],
              selfClosing: true,
              loc,
            },
          ],
        },
        {
          type: 'TemplateSlot',
          name: 'header',
          loc,
          children: [
            {
              type: 'Element',
              tag: 'Heading',
              props: [],
              events: [],
              bindings: [],
              children: [],
              selfClosing: true,
              loc,
            },
          ],
        },
        { type: 'Text', content: 'plain', loc },
      ],
    });
    expect([...collectFirstScreenTags(doc)].sort()).toEqual(['Heading', 'Spinner']);
  });

  it('is empty for a document with no template', () => {
    expect(tags('').size).toBe(0);
  });
});

/**
 * The other walk: what an offline install must fetch. The rule under test is
 * the positive one — every branch counts, because a route the user has not
 * visited is exactly what has to be there when the network is not.
 */
const allTags = (source: string): string[] => [...collectAllComponentTags(parse(source))].sort();

describe('collectAllComponentTags', () => {
  it('collects every arm of an #if chain, elseif and else alike', () => {
    expect(
      allTags(
        [
          "#if (page === 'game')",
          '<Scene3D />',
          "#elseif (page === 'chart')",
          '<LineChart />',
          '#else',
          '<Text>x</Text>',
          '#end',
          '<Button>go</Button>',
        ].join('\n')
      )
    ).toEqual(['Button', 'LineChart', 'Scene3D', 'Text']);
  });

  it('enters an element with an inline if, and what is nested under it', () => {
    expect(allTags('<Box if={open}><Card><Scene3D /></Card></Box><Text>y</Text>')).toEqual([
      'Box',
      'Card',
      'Scene3D',
      'Text',
    ]);
  });

  it('counts an #each body and its #empty fallback, and an #if nested in each', () => {
    expect(
      allTags(
        [
          '#each (item in items)',
          '<Card>',
          '#if (item.chart)',
          '<BarChart />',
          '#end',
          '</Card>',
          '#empty',
          '<EmptyState />',
          '#end',
        ].join('\n')
      )
    ).toEqual(['BarChart', 'Card', 'EmptyState']);
  });

  it('is a superset of the first screen, and the first screen still excludes branches', () => {
    const source = "<Stack><Heading>t</Heading></Stack>\n#if (page === 'game')\n<Scene3D />\n#end";
    const doc = parse(source);
    const first = collectFirstScreenTags(doc);
    const all = collectAllComponentTags(doc);
    expect([...first].sort()).toEqual(['Heading', 'Stack']);
    expect([...all].sort()).toEqual(['Heading', 'Scene3D', 'Stack']);
    for (const tag of first) expect(all.has(tag)).toBe(true);
  });

  it('counts slot fallbacks and template slot children', () => {
    const doc: SoftNDocument = createDocument({
      loc,
      template: [
        {
          type: 'Slot',
          name: 'default',
          loc,
          fallback: [
            { type: 'Element', tag: 'Spinner', props: [], events: [], bindings: [], children: [], selfClosing: true, loc },
          ],
        },
        {
          type: 'TemplateSlot',
          name: 'header',
          loc,
          children: [
            { type: 'Element', tag: 'Heading', props: [], events: [], bindings: [], children: [], selfClosing: true, loc },
          ],
        },
      ],
    });
    expect([...collectAllComponentTags(doc)].sort()).toEqual(['Heading', 'Spinner']);
  });

  it('is empty for a document with no template', () => {
    expect(allTags('')).toEqual([]);
  });
});
