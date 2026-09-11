/**
 * Assignment in a template expression, and the silence that used to follow.
 *
 * `<Button @click={() => count = count + 1}>` is the documented way to write
 * a one-line handler (softn-studio's system prompt shows exactly this and
 * `(e) => name = e.target.value`). The parser had no assignment expression,
 * so the arrow body stopped at `count`; back in the element's attribute loop
 * the `=` was skipped, `count` became a boolean attribute, and `+`, `1` and
 * the closing `}` were dropped one token at a time. The document carried no
 * diagnostic. An author got a button that did nothing and nothing that said
 * so; the Builder's source-fidelity check had to detect the truncation by
 * re-parsing every `{…}` on its own (apps/softn-builder/src/utils/sourceFidelity.ts).
 *
 * Two things are pinned here: the assignment forms parse as assignments, and
 * an attribute or interpolation expression the parser cannot read to its
 * closing `}` is reported rather than turned into stray attributes.
 */

import { describe, it, expect } from 'vitest';
import { parse } from '../src/parser';
import type {
  ElementNode,
  Expression,
  ParseDiagnostic,
  SoftNDocument,
  TemplateNode,
} from '../src/parser';

function firstElement(doc: SoftNDocument): ElementNode {
  const node = doc.template.find((n: TemplateNode) => n.type === 'Element');
  if (!node || node.type !== 'Element') throw new Error('no element parsed');
  return node;
}

function errors(doc: SoftNDocument): ParseDiagnostic[] {
  return (doc.diagnostics ?? []).filter((d) => d.severity === 'error');
}

/** The handler of the first element's first event. */
function handlerOf(source: string): { doc: SoftNDocument; element: ElementNode; handler: Expression } {
  const doc = parse(source);
  const element = firstElement(doc);
  const handler = element.events[0]?.handler;
  if (!handler) throw new Error('no event parsed');
  return { doc, element, handler };
}

function arrowBody(handler: Expression): Expression {
  if (handler.type !== 'ArrowFunctionExpression') throw new Error(`expected an arrow, got ${handler.type}`);
  if (typeof handler.body === 'string') throw new Error('expected a concise body');
  return handler.body;
}

describe('assignment in an arrow body', () => {
  it('parses `() => count = count + 1` as one assignment, with no stray attribute', () => {
    const { doc, element, handler } = handlerOf('<Button @click={() => count = count + 1}>Add</Button>');
    const body = arrowBody(handler);
    expect(body.type).toBe('AssignmentExpression');
    if (body.type !== 'AssignmentExpression') return;
    expect(body.operator).toBe('=');
    expect(body.left).toMatchObject({ type: 'Identifier', name: 'count' });
    expect(body.right).toMatchObject({
      type: 'BinaryExpression',
      operator: '+',
      left: { type: 'Identifier', name: 'count' },
      right: { type: 'Literal', value: 1 },
    });
    // The tail of the expression used to surface here as `count={true}`.
    expect(element.props).toEqual([]);
    expect(doc.diagnostics ?? []).toEqual([]);
    // The element itself is intact: the text child and the close tag were read.
    expect(element.children.some((c) => c.type === 'Text' && c.content === 'Add')).toBe(true);
  });

  it('parses the documented `(e) => name = e.target.value`', () => {
    const { doc, element, handler } = handlerOf('<Input @change={(e) => name = e.target.value} />');
    expect(handler.type).toBe('ArrowFunctionExpression');
    if (handler.type !== 'ArrowFunctionExpression') return;
    expect(handler.params).toEqual(['e']);
    const body = arrowBody(handler);
    expect(body).toMatchObject({
      type: 'AssignmentExpression',
      operator: '=',
      left: { type: 'Identifier', name: 'name' },
      right: {
        type: 'MemberExpression',
        object: { type: 'MemberExpression', object: { type: 'Identifier', name: 'e' } },
        property: { type: 'Identifier', name: 'value' },
      },
    });
    expect(element.selfClosing).toBe(true);
    expect(element.props).toEqual([]);
    expect(doc.diagnostics ?? []).toEqual([]);
  });

  it.each([
    ['+=', '<Button @click={() => count += 1} />'],
    ['-=', '<Button @click={() => count -= 1} />'],
    ['*=', '<Button @click={() => count *= 2} />'],
    ['/=', '<Button @click={() => count /= 2} />'],
    ['%=', '<Button @click={() => count %= 2} />'],
    ['??=', '<Button @click={() => count ??= 1} />'],
    ['||=', '<Button @click={() => count ||= 1} />'],
    ['&&=', '<Button @click={() => count &&= 1} />'],
  ])('parses the compound form %s', (operator, source) => {
    const { doc, element, handler } = handlerOf(source);
    const body = arrowBody(handler);
    expect(body).toMatchObject({
      type: 'AssignmentExpression',
      operator,
      left: { type: 'Identifier', name: 'count' },
      right: { type: 'Literal' },
    });
    expect(element.props).toEqual([]);
    expect(doc.diagnostics ?? []).toEqual([]);
  });

  it('chains to the right: `a = b = 1` is `a = (b = 1)`', () => {
    const { handler, doc } = handlerOf('<Button @click={() => a = b = 1} />');
    const body = arrowBody(handler);
    expect(body).toMatchObject({
      type: 'AssignmentExpression',
      operator: '=',
      left: { type: 'Identifier', name: 'a' },
      right: {
        type: 'AssignmentExpression',
        operator: '=',
        left: { type: 'Identifier', name: 'b' },
        right: { type: 'Literal', value: 1 },
      },
    });
    expect(doc.diagnostics ?? []).toEqual([]);
  });

  it('assigns to a member path: `(v) => form.name = v`', () => {
    const { handler, doc } = handlerOf('<Input @change={(v) => form.name = v} />');
    const body = arrowBody(handler);
    expect(body).toMatchObject({
      type: 'AssignmentExpression',
      left: {
        type: 'MemberExpression',
        object: { type: 'Identifier', name: 'form' },
        property: { type: 'Identifier', name: 'name' },
      },
      right: { type: 'Identifier', name: 'v' },
    });
    expect(doc.diagnostics ?? []).toEqual([]);
  });

  it('binds looser than the conditional: `() => x = a ? 1 : 2` assigns the whole conditional', () => {
    const { handler } = handlerOf('<Button @click={() => x = a ? 1 : 2} />');
    const body = arrowBody(handler);
    expect(body).toMatchObject({
      type: 'AssignmentExpression',
      left: { type: 'Identifier', name: 'x' },
      right: { type: 'ConditionalExpression' },
    });
  });

  it('rejects a target that cannot be assigned to, with a diagnostic', () => {
    const doc = parse('<Button @click={() => 1 = count} />');
    const errs = errors(doc);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].message).toMatch(/assign/i);
    // Recovery: the element itself still parses, with nothing stray on it.
    expect(firstElement(doc).props).toEqual([]);
  });

  it('leaves comparison alone: `a == b` and `a === b` are still binary expressions', () => {
    const doc = parse('<Text v={a == b} w={a === b} />');
    const [v, w] = firstElement(doc).props;
    expect(v.value).toMatchObject({ type: 'expression', value: { type: 'BinaryExpression', operator: '==' } });
    expect(w.value).toMatchObject({ type: 'expression', value: { type: 'BinaryExpression', operator: '===' } });
    expect(doc.diagnostics ?? []).toEqual([]);
  });
});

/**
 * Whatever the parser cannot read is reported. Before, `{a b}` on an
 * attribute yielded `v={a}` plus a boolean attribute `b`, and `{a b}` as an
 * interpolation yielded `{a}` followed by nothing at all — the `b` and the
 * `}` were skipped by the child loop's catch-all branch.
 */
describe('an expression the parser cannot read to its closing brace', () => {
  it('is reported on an attribute, and its tail does not become attributes', () => {
    const doc = parse('<Text v={a b} other="kept">x</Text>');
    const element = firstElement(doc);
    const errs = errors(doc);
    expect(errs.length).toBe(1);
    expect(errs[0].message).toMatch(/expression/i);
    expect(errs[0].loc.line).toBe(1);
    expect(element.props.map((p) => p.name)).toEqual(['v', 'other']);
    // The attribute keeps what was read, so a preview still has something
    // to show, but the author is told the rest was not.
    expect(element.props[0].value).toMatchObject({ type: 'expression', value: { type: 'Identifier', name: 'a' } });
    expect(element.props[1].value).toEqual({ type: 'static', value: 'kept' });
    expect(element.children.some((c) => c.type === 'Text' && c.content === 'x')).toBe(true);
  });

  it('is reported on an event handler', () => {
    const doc = parse('<Button @click={go() now} />');
    expect(errors(doc).length).toBe(1);
    expect(firstElement(doc).props).toEqual([]);
    expect(firstElement(doc).events[0].handler.type).toBe('CallExpression');
  });

  it('is reported on a binding', () => {
    const doc = parse('<Input :value={name extra} />');
    expect(errors(doc).length).toBe(1);
    expect(firstElement(doc).props).toEqual([]);
    expect(firstElement(doc).bindings[0].expression.type).toBe('Identifier');
  });

  it('is reported on an inline if= and each=', () => {
    const doc = parse('<Text if={a b} each={items c} as="item" />');
    expect(errors(doc).length).toBe(2);
    expect(firstElement(doc).props).toEqual([]);
  });

  it('is reported on an interpolation', () => {
    const doc = parse('<Text>{a b}</Text>');
    const element = firstElement(doc);
    const errs = errors(doc);
    expect(errs.length).toBe(1);
    expect(errs[0].message).toMatch(/expression/i);
    expect(element.children.filter((c) => c.type === 'Expression').length).toBe(1);
  });

  it('skips a nested brace inside the unread tail, and stops at the right one', () => {
    const doc = parse('<Text v={a {b: 1}} w={2} />');
    const element = firstElement(doc);
    expect(errors(doc).length).toBe(1);
    expect(element.props.map((p) => p.name)).toEqual(['v', 'w']);
    expect(element.props[1].value).toMatchObject({ type: 'expression', value: { type: 'Literal', value: 2 } });
  });

  it('says nothing about an expression that was read whole', () => {
    const doc = parse(
      '<Stack v={items.filter((i) => i.done).length} w={{ a: 1, b: [1, 2] }} @click={() => go(1, 2)}>{`x${y}`}</Stack>'
    );
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(firstElement(doc).props.map((p) => p.name)).toEqual(['v', 'w']);
  });
});
