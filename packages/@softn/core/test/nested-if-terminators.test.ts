import { describe, it, expect } from 'vitest';
import { parse } from '../src/parser';

describe('nested conditional terminators', () => {
  it.each(['#if (inner)<Text>A</Text>#end', '#if (inner)<Text>A</Text>#elseif (other)<Text>B</Text>#end'])
  ('keeps following panels outside their preceding conditional: %s', (nested) => {
    const doc = parse(`<Box>#if (page === "chat")${nested}#end#if (page === "settings")<Text>Settings</Text>#end<Text>Footer</Text></Box>`);
    const box = doc.template[0] as any;
    expect(box.children.map((n: any) => n.type)).toEqual(['IfBlock', 'IfBlock', 'Element']);
    expect(box.children[0].consequent).toHaveLength(1);
    expect(box.children[1].condition.right.value).toBe('settings');
  });
});
