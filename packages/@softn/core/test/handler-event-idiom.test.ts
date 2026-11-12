/**
 * `@input={(e) => q = e.target.value}`: the way other frameworks write it.
 *
 * A handler written in braces for `@input` or `@change` is handed the
 * field's new value, not the event (a logic function is handed plain data,
 * and so is the arrow, as documented). So `e` is the text typed, `e.target`
 * is nothing, and the assignment clears the variable, with nothing to say
 * why: the field empties itself at every keystroke.
 *
 * The page still runs as written. The parser says what the handler is
 * handed, once for the handler, as a warning.
 */
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser';

const warnings = (source: string) =>
  (parse(source).diagnostics ?? []).map((diagnostic) => `${diagnostic.severity}: ${diagnostic.message}`);

describe('an arrow on @input or @change that reads its parameter as an event', () => {
  it('is told that it is handed the value itself', () => {
    const said = warnings('<input @input={(e) => q = e.target.value} />');
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^warning: /);
    expect(said[0]).toContain('@input={(e) => …}');
    expect(said[0]).toContain('e.target.value');
    expect(said[0]).toContain('is handed the new value itself, not the event');
    expect(said[0]).toContain('@input={(value) => …}');
    expect(said[0]).toContain(':bind');
  });

  it('is told so for a checkbox’s checked, with the ways that work', () => {
    const said = warnings('<input type="checkbox" @change={(event) => done = event.target.checked} />');
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('event.target.checked');
    expect(said[0]).toContain(':bind');
    expect(said[0]).toContain('@change="…"');
  });

  it.each([
    ['in a call', '<input @input={(e) => search(e.target.value)} />'],
    ['in a block', '<input @change={(e) => { q = e.target.value; search() }} />'],
    ['through currentTarget', '<select @change={(e) => pick(e.currentTarget.value)}></select>'],
    ['with ?.', '<input @input={(e) => q = e?.target?.value} />'],
    ['in an arrow inside it', '<input @input={(e) => later(() => save(e.target.value))} />'],
    ['on a component', '<Input @change={(e) => q = e.target.value} />'],
    ['written as an HTML attribute in braces', '<input oninput={(e) => q = e.target.value} />'],
    ['written as React writes it, on an HTML field', '<input onChange={(e) => setQ(e.target.value)} />'],
    ['with a modifier', '<input @input.stop={(e) => q = e.target.value} />'],
    ['taking the event apart', '<input @input={({ target }) => q = target.value} />'],
  ])('is told so %s', (_where, source) => {
    const said = warnings(source);
    expect(said, source).toHaveLength(1);
    expect(said[0]).toContain('is handed the new value itself, not the event');
  });

  it('is told once, however many times the handler reads it', () => {
    expect(warnings('<input @input={(e) => { q = e.target.value; n = e.target.value.length; load(e.target.value) }} />')).toHaveLength(1);
  });

  it('is told for each handler that does it, at the handler’s own place', () => {
    const doc = parse('<div>\n<input @input={(e) => a = e.target.value} />\n<input @change={(e) => b = e.target.value} />\n</div>');
    expect((doc.diagnostics ?? []).map((diagnostic) => diagnostic.loc.line)).toEqual([2, 3]);
  });

  it('leaves the page as it was read', () => {
    const doc = parse('<input @input={(e) => q = e.target.value} />');
    const input = doc.template[0];
    if (input.type !== 'Element') throw new Error('expected an element');
    expect(input.events).toHaveLength(1);
    expect(input.events[0].name).toBe('input');
    expect(input.events[0].handler.type).toBe('ArrowFunctionExpression');
  });
});

describe('a handler that is handed what it reads', () => {
  it.each([
    ['uses its parameter as the value', '<input @input={(value) => q = value} />'],
    ['is named e and uses it as the value', '<input @input={(e) => q = e} />'],
    ['reads a field of the value a component hands over', '<Picker @change={(e) => q = e.value} />'],
    ['is written in quotes, and is handed the event', '<input @input="q = event.target.value" />'],
    ['is an HTML attribute in quotes', '<input oninput="search(event.target.value)" />'],
    ['is for another event, which is handed the event', '<input @keydown={(e) => q = e.target.value} @blur={(e) => save(e.target.value)} @click={(e) => e.target.checked} />'],
    ['is a prop of a component, which decides what it hands over', '<Input onChange={(e) => q = e.target.value} />'],
    ['names something else e inside', '<input @input={(e) => rows.map((e) => e.target.value)} />'],
    ['reads a target of its own', '<input @input={(e) => q = state.target.value} />'],
    ['is a function by name', '<input @input={search} />'],
    ['is a call', '<input @change={load(e.target.value)} />'],
  ])('is told nothing when it %s', (_what, source) => {
    expect(warnings(source), source).toEqual([]);
  });
});
