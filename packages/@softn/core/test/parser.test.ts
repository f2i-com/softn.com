/**
 * SoftN Parser Tests
 *
 * Tests for parsing .softn files into AST.
 */

import { describe, it, expect } from 'vitest';
import { parse, Lexer, TokenType } from '../src/parser';

describe('Lexer', () => {
  it('should tokenize simple tags', () => {
    const lexer = new Lexer('<Button>Click me</Button>');
    const tokens: { type: TokenType; literal: string }[] = [];

    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push({ type: token.type, literal: token.literal });
      token = lexer.nextToken();
    }

    expect(tokens[0].type).toBe(TokenType.TAG_OPEN);
    expect(tokens[1].type).toBe(TokenType.IDENTIFIER);
    expect(tokens[1].literal).toBe('Button');
    expect(tokens[2].type).toBe(TokenType.TAG_CLOSE);
    expect(tokens[3].type).toBe(TokenType.TEXT);
    expect(tokens[3].literal).toBe('Click me');
  });

  it('should tokenize attributes', () => {
    const lexer = new Lexer('<Button variant="primary" size="lg">');
    const tokens: { type: TokenType; literal: string }[] = [];

    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push({ type: token.type, literal: token.literal });
      token = lexer.nextToken();
    }

    expect(tokens.some((t) => t.type === TokenType.IDENTIFIER && t.literal === 'variant')).toBe(
      true
    );
    expect(tokens.some((t) => t.type === TokenType.STRING && t.literal === 'primary')).toBe(true);
  });

  it('should tokenize expressions', () => {
    const lexer = new Lexer('<Text>{count}</Text>');
    const tokens: { type: TokenType; literal: string }[] = [];

    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push({ type: token.type, literal: token.literal });
      token = lexer.nextToken();
    }

    expect(tokens.some((t) => t.type === TokenType.EXPR_START)).toBe(true);
    expect(tokens.some((t) => t.type === TokenType.IDENTIFIER && t.literal === 'count')).toBe(true);
    expect(tokens.some((t) => t.type === TokenType.EXPR_END)).toBe(true);
  });

  it('should tokenize event handlers', () => {
    const lexer = new Lexer('<Button @click={handleClick}>');
    const tokens: { type: TokenType; literal: string }[] = [];

    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push({ type: token.type, literal: token.literal });
      token = lexer.nextToken();
    }

    expect(tokens.some((t) => t.type === TokenType.AT)).toBe(true);
    expect(tokens.some((t) => t.type === TokenType.IDENTIFIER && t.literal === 'click')).toBe(true);
  });

  it('should tokenize control flow keywords', () => {
    const lexer = new Lexer('#if (condition) #else #end');
    const tokens: { type: TokenType; literal: string }[] = [];

    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push({ type: token.type, literal: token.literal });
      token = lexer.nextToken();
    }

    expect(tokens.some((t) => t.type === TokenType.HASH)).toBe(true);
    expect(tokens.some((t) => t.type === TokenType.IF)).toBe(true);
    expect(tokens.some((t) => t.type === TokenType.ELSE)).toBe(true);
    expect(tokens.some((t) => t.type === TokenType.END)).toBe(true);
  });
});

describe('Parser', () => {
  it('should parse a simple element', () => {
    const source = '<Button>Click me</Button>';
    const doc = parse(source);

    expect(doc.template).toHaveLength(1);
    expect(doc.template[0].type).toBe('Element');

    const element = doc.template[0] as any;
    expect(element.tag).toBe('Button');
    expect(element.children).toHaveLength(1);
    expect(element.children[0].type).toBe('Text');
    expect(element.children[0].content).toBe('Click me');
  });

  it('should parse nested elements', () => {
    const source = `
      <Stack>
        <Text>Hello</Text>
        <Button>Click</Button>
      </Stack>
    `;
    const doc = parse(source);

    expect(doc.template).toHaveLength(1);
    const stack = doc.template[0] as any;
    expect(stack.tag).toBe('Stack');
    expect(stack.children.filter((c: any) => c.type === 'Element')).toHaveLength(2);
  });

  it('should parse element with props', () => {
    const source = '<Button variant="primary" size="lg">Submit</Button>';
    const doc = parse(source);

    const button = doc.template[0] as any;
    expect(button.props).toHaveLength(2);
    expect(button.props[0].name).toBe('variant');
    expect(button.props[1].name).toBe('size');
  });

  it('should parse expression props', () => {
    const source = '<Button disabled={isLoading}>Submit</Button>';
    const doc = parse(source);

    const button = doc.template[0] as any;
    expect(button.props).toHaveLength(1);
    expect(button.props[0].name).toBe('disabled');
    expect(button.props[0].value.type).toBe('expression');
    expect(button.props[0].value.value.type).toBe('Identifier');
    expect(button.props[0].value.value.name).toBe('isLoading');
  });

  it('should parse event handlers', () => {
    const source = '<Button @click={handleClick}>Click</Button>';
    const doc = parse(source);

    const button = doc.template[0] as any;
    expect(button.events).toHaveLength(1);
    expect(button.events[0].name).toBe('click');
    expect(button.events[0].handler.type).toBe('Identifier');
  });

  it('should parse expression interpolation', () => {
    const source = '<Text>Count: {count}</Text>';
    const doc = parse(source);

    const text = doc.template[0] as any;
    expect(text.children).toHaveLength(2);
    expect(text.children[0].type).toBe('Text');
    expect(text.children[1].type).toBe('Expression');
  });

  it('should parse if blocks', () => {
    const source = `
      #if (isLoggedIn)
        <Text>Welcome!</Text>
      #else
        <Text>Please log in</Text>
      #end
    `;
    const doc = parse(source);

    const ifBlock = doc.template.find((n: any) => n.type === 'IfBlock') as any;
    expect(ifBlock).toBeDefined();
    expect(ifBlock.condition).toBeDefined();
    expect(ifBlock.consequent).toHaveLength(1);
    expect(ifBlock.alternate).toHaveLength(1);
  });

  it('should parse each blocks', () => {
    const source = `
      #each (item in items)
        <Text>{item.name}</Text>
      #end
    `;
    const doc = parse(source);

    const eachBlock = doc.template.find((n: any) => n.type === 'EachBlock') as any;
    expect(eachBlock).toBeDefined();
    expect(eachBlock.itemName).toBe('item');
    expect(eachBlock.iterable.name).toBe('items');
    expect(eachBlock.body).toHaveLength(1);
  });

  it('should parse each with index', () => {
    const source = `
      #each (item, index in items)
        <Text>{index}: {item}</Text>
      #end
    `;
    const doc = parse(source);

    const eachBlock = doc.template.find((n: any) => n.type === 'EachBlock') as any;
    expect(eachBlock.itemName).toBe('item');
    expect(eachBlock.indexName).toBe('index');
  });

  it('should parse self-closing tags', () => {
    const source = '<Divider />';
    const doc = parse(source);

    expect(doc.template).toHaveLength(1);
    const divider = doc.template[0] as any;
    expect(divider.tag).toBe('Divider');
    expect(divider.children).toHaveLength(0);
  });

  it('should parse script blocks', () => {
    const source = `
      <script>
        let count = 0;
        function increment() {
          count = count + 1;
        }
      </script>
      <Button @click={increment}>{count}</Button>
    `;
    const doc = parse(source);

    expect(doc.script).toBeDefined();
    expect(doc.script?.code).toContain('let count = 0');
  });

  it('should parse style blocks', () => {
    const source = `
      <Text>Hello</Text>
      <style>
        .text { color: blue; }
      </style>
    `;
    const doc = parse(source);

    expect(doc.style).toBeDefined();
    expect(doc.style?.content).toContain('.text { color: blue; }');
  });

  it('should parse complex expressions', () => {
    const source = '<Text>{user.name + " - " + user.email}</Text>';
    const doc = parse(source);

    const text = doc.template[0] as any;
    const exprNode = text.children.find((c: any) => c.type === 'Expression');
    expect(exprNode).toBeDefined();
    expect(exprNode.expression.type).toBe('BinaryExpression');
  });

  it('should parse member expressions in props', () => {
    const source = '<Avatar src={user.avatar} name={user.name} />';
    const doc = parse(source);

    const avatar = doc.template[0] as any;
    expect(avatar.props[0].value.type).toBe('expression');
    expect(avatar.props[0].value.value.type).toBe('MemberExpression');
    expect(avatar.props[0].value.value.object.name).toBe('user');
    expect(avatar.props[0].value.value.property.name).toBe('avatar');
  });
});

describe('Full .softn Document', () => {
  it('should parse a complete component', () => {
    const source = `
      <script>
        let tasks = [];
        let newTask = "";

        async function addTask() {
          if (newTask.trim() !== "") {
            tasks = [...tasks, { id: Date.now(), title: newTask }];
            newTask = "";
          }
        }
      </script>

      <Stack direction="vertical" gap="md">
        <Heading level={1}>Task Manager</Heading>

        <Stack direction="horizontal" gap="sm">
          <Input :bind={newTask} placeholder="New task..." />
          <Button @click={addTask} variant="primary">Add</Button>
        </Stack>

        #each (task in tasks)
          <Card>
            <Text>{task.title}</Text>
          </Card>
        #empty
          <Text>No tasks yet</Text>
        #end
      </Stack>

      <style>
        Stack { padding: 1rem; }
      </style>
    `;

    const doc = parse(source);

    // Check script
    expect(doc.script).toBeDefined();
    expect(doc.script?.code).toContain('let tasks = []');

    // Check template structure
    expect(doc.template.filter((n: any) => n.type === 'Element')).toHaveLength(1);

    // Check style
    expect(doc.style).toBeDefined();
    expect(doc.style?.content).toContain('padding: 1rem');
  });
});

describe('Edge Cases', () => {
  it('should parse ternary expressions', () => {
    const source = '<Text color={isActive ? "blue" : "gray"}>Content</Text>';
    const doc = parse(source);

    const text = doc.template[0] as any;
    const colorProp = text.props.find((p: any) => p.name === 'color');
    expect(colorProp.value.value.type).toBe('ConditionalExpression');
  });

  it('should parse array expressions', () => {
    const source = '<Select options={["one", "two", "three"]} />';
    const doc = parse(source);

    const select = doc.template[0] as any;
    const optionsProp = select.props.find((p: any) => p.name === 'options');
    expect(optionsProp.value.value.type).toBe('ArrayExpression');
    expect(optionsProp.value.value.elements).toHaveLength(3);
  });

  it('should parse function calls with multiple arguments', () => {
    const source = '<Button @click={handleAction("save", id, true)}>Save</Button>';
    const doc = parse(source);

    const button = doc.template[0] as any;
    expect(button.events[0].handler.type).toBe('CallExpression');
    expect(button.events[0].handler.arguments).toHaveLength(3);
  });

  it('should parse bindings', () => {
    const source = '<Input :value={name} :bind={email} />';
    const doc = parse(source);

    const input = doc.template[0] as any;
    expect(input.bindings).toHaveLength(2);
    expect(input.bindings[0].name).toBe('value');
    expect(input.bindings[1].name).toBe('bind');
  });

  it('should parse numeric props', () => {
    const source = '<Grid columns={3} gap={16} />';
    const doc = parse(source);

    const grid = doc.template[0] as any;
    const columnsProp = grid.props.find((p: any) => p.name === 'columns');
    expect(columnsProp.value.value.type).toBe('Literal');
    expect(columnsProp.value.value.value).toBe(3);
  });

  it('should parse boolean props', () => {
    const source = '<Button disabled={true} loading={false} />';
    const doc = parse(source);

    const button = doc.template[0] as any;
    const disabledProp = button.props.find((p: any) => p.name === 'disabled');
    expect(disabledProp.value.value.type).toBe('Literal');
    expect(disabledProp.value.value.value).toBe(true);
  });

  it('should parse unary expressions', () => {
    const source = '<Text visible={!isHidden}>Content</Text>';
    const doc = parse(source);

    const text = doc.template[0] as any;
    const visibleProp = text.props.find((p: any) => p.name === 'visible');
    expect(visibleProp.value.value.type).toBe('UnaryExpression');
    expect(visibleProp.value.value.operator).toBe('!');
  });

  it('should parse empty element children', () => {
    const source = '<Stack></Stack>';
    const doc = parse(source);

    const stack = doc.template[0] as any;
    expect(stack.children).toHaveLength(0);
  });

  it('should parse multiple sibling elements', () => {
    const source = '<Text>One</Text><Text>Two</Text><Text>Three</Text>';
    const doc = parse(source);

    const textElements = doc.template.filter((n: any) => n.type === 'Element');
    expect(textElements).toHaveLength(3);
  });

  it('should parse each with empty fallback', () => {
    const source = `
      #each (item in items)
        <Text>{item}</Text>
      #empty
        <Text>No items</Text>
      #end
    `;
    const doc = parse(source);

    const eachBlock = doc.template.find((n: any) => n.type === 'EachBlock') as any;
    expect(eachBlock.emptyFallback).toBeDefined();
    expect(eachBlock.emptyFallback).toHaveLength(1);
  });
});
