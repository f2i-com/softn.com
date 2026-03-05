/**
 * SoftN Abstract Syntax Tree Types
 *
 * Defines the structure of parsed .softn documents.
 */

import type { SourceLocation } from './token';

// ============================================================================
// Document Structure
// ============================================================================

/**
 * A diagnostic message from the parser (error or warning).
 * Used for fault-tolerant parsing — the parser collects errors and continues
 * rather than aborting on the first problem.
 */
export interface ParseDiagnostic {
  /** Error/warning message */
  message: string;
  /** Severity level */
  severity: 'error' | 'warning';
  /** Source location where the problem occurred */
  loc: SourceLocation;
}

/**
 * Root document representing a complete .softn file
 */
export interface SoftNDocument {
  type: 'Document';
  imports: ImportDeclaration[];
  component?: ComponentDeclaration;
  script?: ScriptBlock;
  logic?: LogicBlock;
  data?: DataBlock;
  template: TemplateNode[];
  style?: StyleBlock;
  loc: SourceLocation;
  /** Parse diagnostics (errors/warnings) — present when fault-tolerant parsing recovered from issues */
  diagnostics?: ParseDiagnostic[];
}

// ============================================================================
// Top-Level Blocks
// ============================================================================

/**
 * Import statement: <import Foo from "@/components/Foo.softn" />
 */
export interface ImportDeclaration {
  type: 'ImportDeclaration';
  defaultImport?: string; // import Foo
  namedImports?: string[]; // import { A, B }
  source: string; // "@/components/Foo.softn"
  loc: SourceLocation;
}

/**
 * Component declaration: <component name="MyComponent">...</component>
 */
export interface ComponentDeclaration {
  type: 'ComponentDeclaration';
  name: string;
  props: PropDeclaration[];
  slots: SlotDeclaration[];
  loc: SourceLocation;
}

/**
 * Prop declaration within component block
 */
export interface PropDeclaration {
  type: 'PropDeclaration';
  name: string;
  propType?: string; // "string", "number", "object", "array", "function"
  required?: boolean;
  defaultValue?: Expression;
  loc: SourceLocation;
}

/**
 * Slot declaration within component block
 */
export interface SlotDeclaration {
  type: 'SlotDeclaration';
  name: string; // "default" for unnamed slot
  loc: SourceLocation;
}

/**
 * Script block containing FormLogic code (legacy, use LogicBlock instead)
 */
export interface ScriptBlock {
  type: 'ScriptBlock';
  code: string; // Raw FormLogic code
  loc: SourceLocation;
}

/**
 * Logic block containing FormLogic code (preferred over ScriptBlock)
 * The <logic> tag is the new standard for SoftN files
 */
export interface LogicBlock {
  type: 'LogicBlock';
  code: string; // Raw FormLogic code
  loc: SourceLocation;
}

/**
 * Data block for XDB collection declarations
 */
export interface DataBlock {
  type: 'DataBlock';
  collections: CollectionDeclaration[];
  loc: SourceLocation;
}

/**
 * Collection declaration within data block
 *
 * Supports filtering, sorting, and limiting:
 * <collection name="tasks" as="tasks" filter={{ completed: false }} sort="createdAt:desc" limit={10} />
 */
export interface CollectionDeclaration {
  type: 'CollectionDeclaration';
  name: string; // Collection name in XDB
  as: string; // Variable name to bind to
  query?: Expression; // Optional query object
  /** Filter expression: filter={{ completed: false }} */
  filter?: Expression;
  /** Sort string: sort="createdAt:desc" or sort="name:asc" */
  sort?: string;
  /** Limit number: limit={10} */
  limit?: number;
  loc: SourceLocation;
}

/**
 * Style block containing scoped CSS
 */
export interface StyleBlock {
  type: 'StyleBlock';
  content: string; // Raw CSS
  loc: SourceLocation;
}

// ============================================================================
// Template Nodes
// ============================================================================

export type TemplateNode =
  | ElementNode
  | TextNode
  | ExpressionNode
  | IfBlock
  | EachBlock
  | SlotNode
  | TemplateSlotNode;

/**
 * Element node: <Component prop="value">...</Component>
 *
 * Supports inline conditionals and loops:
 * - <Component if={condition} /> - Only render if condition is truthy
 * - <Component each={items} as="item" /> - Render once per item
 */
export interface ElementNode {
  type: 'Element';
  tag: string;
  props: PropNode[];
  events: EventNode[];
  bindings: BindingNode[];
  children: TemplateNode[];
  selfClosing: boolean;
  /** Inline conditional: if={condition} */
  conditionalIf?: Expression;
  /** Inline loop configuration */
  inlineEach?: {
    iterable: Expression;
    itemName: string;
    indexName?: string;
  };
  loc: SourceLocation;
}

/**
 * Property on an element
 */
export interface PropNode {
  type: 'Prop';
  name: string;
  value: PropValue;
  loc: SourceLocation;
}

export type PropValue =
  | { type: 'static'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'expression'; value: Expression };

/**
 * Event handler: @click={handler}
 */
export interface EventNode {
  type: 'Event';
  name: string; // "click", "submit", etc.
  handler: Expression;
  loc: SourceLocation;
}

/**
 * Binding: :value={variable} or :bind={variable}
 */
export interface BindingNode {
  type: 'Binding';
  name: string; // "value", "checked", "bind"
  expression: Expression;
  loc: SourceLocation;
}

/**
 * Plain text content
 */
export interface TextNode {
  type: 'Text';
  content: string;
  loc: SourceLocation;
}

/**
 * Expression interpolation: {expression}
 */
export interface ExpressionNode {
  type: 'Expression';
  expression: Expression;
  loc: SourceLocation;
}

// ============================================================================
// Control Flow
// ============================================================================

/**
 * If block: #if (condition) ... #elseif ... #else ... #end
 */
export interface IfBlock {
  type: 'IfBlock';
  condition: Expression;
  consequent: TemplateNode[];
  alternate?: TemplateNode[] | IfBlock; // For #elseif chaining
  loc: SourceLocation;
}

/**
 * Each block: #each (item in items) ... #empty ... #end
 */
export interface EachBlock {
  type: 'EachBlock';
  iterable: Expression;
  itemName: string;
  indexName?: string;
  keyExpression?: Expression;
  body: TemplateNode[];
  emptyFallback?: TemplateNode[];
  loc: SourceLocation;
}

// ============================================================================
// Slots
// ============================================================================

/**
 * Slot outlet: <slot /> or <slot name="header" />
 */
export interface SlotNode {
  type: 'Slot';
  name: string; // "default" for unnamed
  fallback?: TemplateNode[];
  loc: SourceLocation;
}

/**
 * Template slot: <template slot="header">...</template>
 */
export interface TemplateSlotNode {
  type: 'TemplateSlot';
  name: string;
  children: TemplateNode[];
  loc: SourceLocation;
}

// ============================================================================
// Expressions
// ============================================================================

/**
 * Expression types for dynamic values
 */
export type Expression =
  | IdentifierExpression
  | LiteralExpression
  | BinaryExpression
  | UnaryExpression
  | MemberExpression
  | CallExpression
  | ConditionalExpression
  | ArrowFunctionExpression
  | ObjectExpression
  | ArrayExpression
  | SpreadElement
  | TemplateLiteral;

export interface IdentifierExpression {
  type: 'Identifier';
  name: string;
  loc: SourceLocation;
}

export interface LiteralExpression {
  type: 'Literal';
  value: string | number | boolean | null;
  raw: string;
  loc: SourceLocation;
}

export interface BinaryExpression {
  type: 'BinaryExpression';
  operator: string;
  left: Expression;
  right: Expression;
  loc: SourceLocation;
}

export interface UnaryExpression {
  type: 'UnaryExpression';
  operator: string;
  argument: Expression;
  prefix: boolean;
  loc: SourceLocation;
}

export interface MemberExpression {
  type: 'MemberExpression';
  object: Expression;
  property: Expression;
  computed: boolean; // obj[prop] vs obj.prop
  optional?: boolean; // obj?.prop (optional chaining)
  loc: SourceLocation;
}

export interface CallExpression {
  type: 'CallExpression';
  callee: Expression;
  arguments: Expression[];
  optional?: boolean; // fn?.() (optional chaining)
  loc: SourceLocation;
}

export interface ConditionalExpression {
  type: 'ConditionalExpression';
  test: Expression;
  consequent: Expression;
  alternate: Expression;
  loc: SourceLocation;
}

export interface ArrowFunctionExpression {
  type: 'ArrowFunctionExpression';
  params: string[];
  body: Expression | string; // Expression for concise, string for block body
  async: boolean;
  loc: SourceLocation;
}

export interface ObjectExpression {
  type: 'ObjectExpression';
  properties: ObjectProperty[];
  loc: SourceLocation;
}

export interface ObjectProperty {
  type: 'ObjectProperty';
  key: string;
  value: Expression;
  shorthand: boolean; // { foo } instead of { foo: foo }
  loc: SourceLocation;
}

export interface ArrayExpression {
  type: 'ArrayExpression';
  elements: Expression[];
  loc: SourceLocation;
}

export interface SpreadElement {
  type: 'SpreadElement';
  argument: Expression;
  loc: SourceLocation;
}

export interface TemplateLiteral {
  type: 'TemplateLiteral';
  quasis: TemplateElement[];
  expressions: Expression[];
  loc: SourceLocation;
}

export interface TemplateElement {
  type: 'TemplateElement';
  value: { raw: string; cooked: string };
  tail: boolean;
  loc: SourceLocation;
}

// ============================================================================
// Helpers
// ============================================================================

export function createDocument(
  partial: Partial<SoftNDocument> & Pick<SoftNDocument, 'loc'>
): SoftNDocument {
  return {
    type: 'Document',
    imports: [],
    template: [],
    ...partial,
  };
}

export function createElementNode(
  tag: string,
  loc: SourceLocation,
  options: Partial<Omit<ElementNode, 'type' | 'tag' | 'loc'>> = {}
): ElementNode {
  return {
    type: 'Element',
    tag,
    props: [],
    events: [],
    bindings: [],
    children: [],
    selfClosing: false,
    loc,
    ...options,
  };
}

/** Decode common HTML entities in text content */
const htmlEntities: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&nbsp;': '\u00A0', '&larr;': '\u2190', '&rarr;': '\u2192', '&uarr;': '\u2191', '&darr;': '\u2193',
  '&laquo;': '\u00AB', '&raquo;': '\u00BB', '&bull;': '\u2022', '&middot;': '\u00B7',
  '&mdash;': '\u2014', '&ndash;': '\u2013', '&hellip;': '\u2026', '&trade;': '\u2122',
  '&copy;': '\u00A9', '&reg;': '\u00AE', '&deg;': '\u00B0', '&plusmn;': '\u00B1',
  '&times;': '\u00D7', '&divide;': '\u00F7', '&lsquo;': '\u2018', '&rsquo;': '\u2019',
  '&ldquo;': '\u201C', '&rdquo;': '\u201D', '&check;': '\u2713', '&cross;': '\u2717',
  '&star;': '\u2605', '&hearts;': '\u2665', '&infin;': '\u221E',
};

function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));/g, (match, decimal, hex, named) => {
    if (decimal) return String.fromCodePoint(parseInt(decimal, 10));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (named) return htmlEntities[`&${named};`] ?? match;
    return match;
  });
}

export function createTextNode(content: string, loc: SourceLocation): TextNode {
  return { type: 'Text', content: decodeHtmlEntities(content), loc };
}

export function createIdentifier(name: string, loc: SourceLocation): IdentifierExpression {
  return { type: 'Identifier', name, loc };
}

export function createLiteral(
  value: string | number | boolean | null,
  raw: string,
  loc: SourceLocation
): LiteralExpression {
  return { type: 'Literal', value, raw, loc };
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Union type for all top-level parseable elements
 */
export type TopLevelElement =
  | ImportDeclaration
  | ComponentDeclaration
  | ScriptBlock
  | LogicBlock
  | DataBlock
  | StyleBlock
  | TemplateNode;

export function isImportDeclaration(node: TopLevelElement): node is ImportDeclaration {
  return node.type === 'ImportDeclaration';
}

export function isComponentDeclaration(node: TopLevelElement): node is ComponentDeclaration {
  return node.type === 'ComponentDeclaration';
}

export function isScriptBlock(node: TopLevelElement): node is ScriptBlock {
  return node.type === 'ScriptBlock';
}

export function isLogicBlock(node: TopLevelElement): node is LogicBlock {
  return node.type === 'LogicBlock';
}

export function isDataBlock(node: TopLevelElement): node is DataBlock {
  return node.type === 'DataBlock';
}

export function isStyleBlock(node: TopLevelElement): node is StyleBlock {
  return node.type === 'StyleBlock';
}

export function isElementNode(node: TemplateNode): node is ElementNode {
  return node.type === 'Element';
}

export function isTextNode(node: TemplateNode): node is TextNode {
  return node.type === 'Text';
}

export function isExpressionNode(node: TemplateNode): node is ExpressionNode {
  return node.type === 'Expression';
}

export function isIfBlock(node: TemplateNode): node is IfBlock {
  return node.type === 'IfBlock';
}

export function isEachBlock(node: TemplateNode): node is EachBlock {
  return node.type === 'EachBlock';
}

export function isTemplateNode(node: TopLevelElement): node is TemplateNode {
  return (
    node.type === 'Element' ||
    node.type === 'Text' ||
    node.type === 'Expression' ||
    node.type === 'IfBlock' ||
    node.type === 'EachBlock' ||
    node.type === 'Slot' ||
    node.type === 'TemplateSlot'
  );
}
