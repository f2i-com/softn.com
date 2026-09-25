/**
 * The functions a handler field offers, and the handler it inserts.
 *
 * A Python function bound by name is called with the event, so `def save():`
 * bound as `@click={save}` raises a TypeError on the first click; a function
 * without parameters is offered as `() => save()` instead.
 */

import { describe, expect, it } from 'vitest';
import { callableNames, handlerFor, handlerTarget, logicFunctions } from './logicFunctions';

describe('the functions of a JavaScript logic file', () => {
  const js = [
    'let count = 0',
    'function increment() {',
    '  function inner() {}',
    '  count++',
    '}',
    'async function load(id, force) {}',
    'const save = (item) => {}',
    'export const drop = item => {}',
    'let reset = async function () {}',
    'const total = 3',
  ].join('\n');

  it('are the top-level ones, in file order, with their parameters', () => {
    expect(logicFunctions(js, 'javascript')).toEqual([
      { name: 'increment', params: '' },
      { name: 'load', params: 'id, force' },
      { name: 'save', params: 'item' },
      { name: 'drop', params: 'item' },
      { name: 'reset', params: '' },
    ]);
  });

  it('are inserted by name: an extra argument is ignored', () => {
    expect(handlerFor({ name: 'increment', params: '' }, 'javascript')).toBe('increment');
  });
});

describe('the functions of a Python module', () => {
  const py = [
    'count = 0',
    '',
    'def increment():',
    '    global count',
    '    def helper(x):',
    '        return x',
    '    count = count + 1',
    '',
    'async def fetch_rows(page, size=10):',
    '    pass',
    '',
    'class Thing:',
    '    def method(self):',
    '        pass',
  ].join('\n');

  it('are the top-level defs, with their parameters', () => {
    expect(logicFunctions(py, 'python')).toEqual([
      { name: 'increment', params: '' },
      { name: 'fetch_rows', params: 'page, size=10' },
    ]);
  });

  it('are inserted through an arrow when they take no parameters, so the event is not passed', () => {
    expect(handlerFor({ name: 'increment', params: '' }, 'python')).toBe('() => increment()');
    expect(handlerFor({ name: 'fetch_rows', params: 'page, size=10' }, 'python')).toBe('fetch_rows');
  });

  it('can call what the module imports by name', () => {
    const names = callableNames(['from helpers import double, triple as thrice\nfrom x import (a)\n'], 'python');
    expect([...names]).toEqual(expect.arrayContaining(['double', 'thrice', 'a']));
    expect(names.has('triple')).toBe(false);
  });
});

describe('the function a handler calls', () => {
  it('is read from a name, a call or an arrow calling one', () => {
    expect(handlerTarget('save')).toBe('save');
    expect(handlerTarget('save()')).toBe('save');
    expect(handlerTarget('save(item, 2)')).toBe('save');
    expect(handlerTarget('() => save()')).toBe('save');
    expect(handlerTarget('(e) => save(e)')).toBe('save');
    expect(handlerTarget('e => save(e)')).toBe('save');
    expect(handlerTarget('{save}')).toBe('save');
  });

  it('is not guessed from anything else', () => {
    expect(handlerTarget('count++')).toBeNull();
    expect(handlerTarget('count = count + 1')).toBeNull();
    expect(handlerTarget('nav.go("home")')).toBeNull();
    expect(handlerTarget('save(a) || other()')).toBeNull();
    expect(handlerTarget('')).toBeNull();
  });
});
