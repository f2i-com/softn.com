/**
 * SoftN Renderer Tests
 *
 * Tests for rendering parsed .softn AST to React elements.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry, evaluateExpression } from '../src/renderer';
import type { SoftNRenderContext } from '../src/types';

// Mock components for testing
const MockButton: React.FC<{
  variant?: string;
  onClick?: () => void;
  children?: React.ReactNode;
}> = ({ variant, onClick, children }) => (
  <button data-variant={variant} onClick={onClick}>
    {children}
  </button>
);

const MockText: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <span>{children}</span>
);

const MockStack: React.FC<{ direction?: string; children?: React.ReactNode }> = ({
  direction,
  children,
}) => <div data-direction={direction}>{children}</div>;

const MockHeading: React.FC<{ level?: number; children?: React.ReactNode }> = ({
  level,
  children,
}) => {
  const Tag = `h${level || 1}` as keyof JSX.IntrinsicElements;
  return <Tag>{children}</Tag>;
};

// Create test registry
function createTestRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register('Button', MockButton);
  registry.register('Text', MockText);
  registry.register('Stack', MockStack);
  registry.register('Heading', MockHeading);
  return registry;
}

// Create test context
function createTestContext(overrides: Partial<SoftNRenderContext> = {}): SoftNRenderContext {
  return {
    state: {},
    setState: () => {},
    data: {},
    props: {},
    functions: {},
    asyncFunctions: {},
    computed: {},
    ...overrides,
  };
}

describe('evaluateExpression', () => {
  it('should evaluate identifiers from state', () => {
    const context = createTestContext({ state: { count: 42 } });
    const expr = {
      type: 'Identifier' as const,
      name: 'count',
      loc: { line: 1, column: 0, start: 0, end: 5 },
    };

    expect(evaluateExpression(expr, context)).toBe(42);
  });

  it('should evaluate string literals', () => {
    const context = createTestContext();
    const expr = {
      type: 'Literal' as const,
      value: 'hello',
      raw: '"hello"',
      loc: { line: 1, column: 0, start: 0, end: 7 },
    };

    expect(evaluateExpression(expr, context)).toBe('hello');
  });

  it('should evaluate number literals', () => {
    const context = createTestContext();
    const expr = {
      type: 'Literal' as const,
      value: 123,
      raw: '123',
      loc: { line: 1, column: 0, start: 0, end: 3 },
    };

    expect(evaluateExpression(expr, context)).toBe(123);
  });

  it('should evaluate boolean literals', () => {
    const context = createTestContext();
    const trueExpr = {
      type: 'Literal' as const,
      value: true,
      raw: 'true',
      loc: { line: 1, column: 0, start: 0, end: 4 },
    };
    const falseExpr = {
      type: 'Literal' as const,
      value: false,
      raw: 'false',
      loc: { line: 1, column: 0, start: 0, end: 5 },
    };

    expect(evaluateExpression(trueExpr, context)).toBe(true);
    expect(evaluateExpression(falseExpr, context)).toBe(false);
  });

  it('should evaluate member expressions', () => {
    const context = createTestContext({
      state: { user: { name: 'Alice', age: 30 } },
    });
    const expr = {
      type: 'MemberExpression' as const,
      object: {
        type: 'Identifier' as const,
        name: 'user',
        loc: { line: 1, column: 0, start: 0, end: 4 },
      },
      property: {
        type: 'Identifier' as const,
        name: 'name',
        loc: { line: 1, column: 5, start: 5, end: 9 },
      },
      computed: false,
      loc: { line: 1, column: 0, start: 0, end: 9 },
    };

    expect(evaluateExpression(expr, context)).toBe('Alice');
  });

  it('should evaluate binary expressions', () => {
    const context = createTestContext({ state: { a: 10, b: 5 } });

    const addExpr = {
      type: 'BinaryExpression' as const,
      operator: '+',
      left: {
        type: 'Identifier' as const,
        name: 'a',
        loc: { line: 1, column: 0, start: 0, end: 1 },
      },
      right: {
        type: 'Identifier' as const,
        name: 'b',
        loc: { line: 1, column: 4, start: 4, end: 5 },
      },
      loc: { line: 1, column: 0, start: 0, end: 5 },
    };

    expect(evaluateExpression(addExpr, context)).toBe(15);
  });

  it('should evaluate comparison expressions', () => {
    const context = createTestContext({ state: { count: 10 } });

    const gtExpr = {
      type: 'BinaryExpression' as const,
      operator: '>',
      left: {
        type: 'Identifier' as const,
        name: 'count',
        loc: { line: 1, column: 0, start: 0, end: 5 },
      },
      right: {
        type: 'Literal' as const,
        value: 5,
        raw: '5',
        loc: { line: 1, column: 8, start: 8, end: 9 },
      },
      loc: { line: 1, column: 0, start: 0, end: 9 },
    };

    expect(evaluateExpression(gtExpr, context)).toBe(true);
  });

  it('should evaluate function calls', () => {
    const mockFn = vi.fn().mockReturnValue('result');
    const context = createTestContext({
      functions: { myFunc: mockFn },
    });

    const callExpr = {
      type: 'CallExpression' as const,
      callee: {
        type: 'Identifier' as const,
        name: 'myFunc',
        loc: { line: 1, column: 0, start: 0, end: 6 },
      },
      arguments: [
        {
          type: 'Literal' as const,
          value: 'arg1',
          raw: '"arg1"',
          loc: { line: 1, column: 7, start: 7, end: 13 },
        },
      ],
      loc: { line: 1, column: 0, start: 0, end: 14 },
    };

    expect(evaluateExpression(callExpr, context)).toBe('result');
    expect(mockFn).toHaveBeenCalledWith('arg1');
  });
});

describe('renderDocument', () => {
  it('should render a simple element', () => {
    const source = '<Text>Hello World</Text>';
    const doc = parse(source);
    const registry = createTestRegistry();
    const context = createTestContext();

    const result = renderDocument(doc, context, registry);

    expect(result).toBeDefined();
  });

  it('should render nested elements', () => {
    const source = `
      <Stack direction="vertical">
        <Text>Item 1</Text>
        <Text>Item 2</Text>
      </Stack>
    `;
    const doc = parse(source);
    const registry = createTestRegistry();
    const context = createTestContext();

    const result = renderDocument(doc, context, registry);

    expect(result).toBeDefined();
  });

  it('should render with state interpolation', () => {
    const source = '<Text>Count: {count}</Text>';
    const doc = parse(source);
    const registry = createTestRegistry();
    const context = createTestContext({ state: { count: 42 } });

    const result = renderDocument(doc, context, registry);

    expect(result).toBeDefined();
  });

  it('should render with props from context', () => {
    const source = '<Button variant={buttonVariant}>Click</Button>';
    const doc = parse(source);
    const registry = createTestRegistry();
    const context = createTestContext({ state: { buttonVariant: 'primary' } });

    const result = renderDocument(doc, context, registry);

    expect(result).toBeDefined();
  });

  it('should render if blocks correctly', () => {
    const source = `
      #if (showMessage)
        <Text>Visible</Text>
      #else
        <Text>Hidden</Text>
      #end
    `;
    const doc = parse(source);
    const registry = createTestRegistry();

    // Test with showMessage = true
    const contextTrue = createTestContext({ state: { showMessage: true } });
    const resultTrue = renderDocument(doc, contextTrue, registry);
    expect(resultTrue).toBeDefined();

    // Test with showMessage = false
    const contextFalse = createTestContext({ state: { showMessage: false } });
    const resultFalse = renderDocument(doc, contextFalse, registry);
    expect(resultFalse).toBeDefined();
  });

  it('should render each blocks correctly', () => {
    const source = `
      #each (item in items)
        <Text>{item}</Text>
      #end
    `;
    const doc = parse(source);
    const registry = createTestRegistry();
    const context = createTestContext({
      state: { items: ['Apple', 'Banana', 'Cherry'] },
    });

    const result = renderDocument(doc, context, registry);

    expect(result).toBeDefined();
  });

  it('should render each blocks with empty fallback', () => {
    const source = `
      #each (item in items)
        <Text>{item}</Text>
      #empty
        <Text>No items</Text>
      #end
    `;
    const doc = parse(source);
    const registry = createTestRegistry();
    const context = createTestContext({ state: { items: [] } });

    const result = renderDocument(doc, context, registry);

    expect(result).toBeDefined();
  });

  it('should handle event handlers', () => {
    const handleClick = vi.fn();
    const source = '<Button @click={handleClick}>Click Me</Button>';
    const doc = parse(source);
    const registry = createTestRegistry();
    const context = createTestContext({
      functions: { handleClick },
    });

    const result = renderDocument(doc, context, registry);

    expect(result).toBeDefined();
  });
});

describe('ComponentRegistry', () => {
  it('should register and retrieve components', () => {
    const registry = new ComponentRegistry();
    registry.register('TestComponent', MockButton);

    expect(registry.get('TestComponent')).toBe(MockButton);
  });

  it('should return undefined for unregistered components', () => {
    const registry = new ComponentRegistry();

    expect(registry.get('UnknownComponent')).toBeUndefined();
  });

  it('should check if component is registered', () => {
    const registry = new ComponentRegistry();
    registry.register('TestComponent', MockButton);

    expect(registry.has('TestComponent')).toBe(true);
    expect(registry.has('Unknown')).toBe(false);
  });

  it('should register multiple components at once', () => {
    const registry = new ComponentRegistry();
    registry.registerAll({
      Button: MockButton,
      Text: MockText,
      Stack: MockStack,
    });

    expect(registry.has('Button')).toBe(true);
    expect(registry.has('Text')).toBe(true);
    expect(registry.has('Stack')).toBe(true);
  });
});
