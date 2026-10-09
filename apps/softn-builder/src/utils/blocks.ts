/**
 * Control-flow blocks on the canvas.
 *
 * A block (`#if`, `#elseif`, `#else`, `#each`, `#empty`) is an element of
 * the visual model whose branch is its children (types/builder.ts,
 * CanvasBlock). The parser and generator have held them that way since
 * BLD-03, but the canvas still asked the component registry whether an
 * element could hold children, and the registry has no entry for a block:
 * a block rendered as a notice ("edit the branch in Source"), its branch
 * was neither shown nor droppable, and nothing could make one. What is
 * here is the part of the block model the editing surfaces share — which
 * types are blocks, which are continuations of another block, what a new
 * block's header is, and what may be dropped where.
 */

import type { CanvasBlock, CanvasElement, ComponentMeta } from '../types/builder';
import { TEXT_NODE_TYPE } from '../types/builder';
import { getComponentMeta } from './componentRegistry';

/** Whether the element is words that stand beside elements (see TEXT_NODE_TYPE). */
export function isTextNode(element: CanvasElement): boolean {
  return element.componentType === TEXT_NODE_TYPE;
}

/** What the property panel offers for words: the words themselves. */
export const textNodeMeta: ComponentMeta = {
  name: 'Text',
  category: 'Display',
  icon: 'type',
  description: 'Words that stand beside the elements around them. Write {name} to show a value.',
  defaultProps: {},
  propSchema: [{ name: 'children', type: 'string' }],
  allowChildren: false,
};

/** What an element is called where there is room for a word or two. */
export function elementLabel(element: CanvasElement): string {
  if (!isTextNode(element)) return element.componentType;
  const words = String(element.props.children ?? '').trim();
  return words.length > 28 ? `“${words.slice(0, 27)}…”` : `“${words}”`;
}

/**
 * Whether `componentType` continues another block — `#elseif` and `#else`
 * belong to an `#if`, `#empty` to an `#each` — and so has no meaning on its
 * own: it is made by adding a branch to its block, never dropped in freely.
 */
export function isContinuationType(componentType: string): boolean {
  return componentType === '#elseif' || componentType === '#else' || componentType === '#empty';
}

/** Whether the element is a block that opens a chain: an `#if` or an `#each`. */
export function isBlockHead(element: CanvasElement): boolean {
  return element.block !== undefined && (element.block.kind === 'if' || element.block.kind === 'each');
}

/** The header of a block made on the canvas. The text is a placeholder to edit, not a guess. */
export function defaultBlock(componentType: string): CanvasBlock | undefined {
  switch (componentType) {
    case '#if':
      return { kind: 'if', condition: 'true' };
    case '#elseif':
      return { kind: 'elseif', condition: 'true' };
    case '#else':
      return { kind: 'else' };
    case '#each':
      return { kind: 'each', iterable: 'items', itemName: 'item' };
    case '#empty':
      return { kind: 'empty' };
    default:
      return undefined;
  }
}

/**
 * Whether the element can hold children on the canvas: a block always can,
 * a component if its registry entry says so, and any element that already
 * holds some. A `<Text>` with a `<Kbd>` among its words has children
 * whatever its entry says, and they have to be seen to be edited.
 */
export function acceptsChildren(element: CanvasElement): boolean {
  if (element.block) return true;
  if (isTextNode(element)) return false;
  if (element.children.length > 0) return true;
  return getComponentMeta(element.componentType)?.allowChildren ?? false;
}

/**
 * Whether `draggedType` may be dropped into `target`. A continuation is
 * never dropped anywhere (see isContinuationType); a block takes any
 * component or block; a component takes what its registry entry allows.
 */
export function canDropInto(target: CanvasElement, draggedType: string | null): boolean {
  if (draggedType && isContinuationType(draggedType)) return false;
  if (target.block) return true;
  if (isTextNode(target)) return false;
  const meta = getComponentMeta(target.componentType);
  if (!meta?.allowChildren) return target.children.length > 0;
  if (meta.childTypes && meta.childTypes.length > 0 && draggedType) {
    return meta.childTypes.includes(draggedType);
  }
  return true;
}

/**
 * Where the branch of a block ends among its children: at its first
 * `#elseif`, `#else` or `#empty`, or after its last child when it has none.
 * In the source whatever follows one of those is inside it, so an element
 * of the block itself goes no later than this.
 */
export function branchEnd(parent: CanvasElement, elements: Map<string, CanvasElement>): number {
  const at = parent.children.findIndex((id) => {
    const child = elements.get(id);
    return child !== undefined && isContinuationType(child.componentType);
  });
  return at === -1 ? parent.children.length : at;
}

/** What the palette shows for the two blocks a creator can start with. */
export const blockPalette: ComponentMeta[] = [
  {
    name: '#if',
    category: 'Utility',
    icon: 'branch',
    description: 'Show its branch only while a condition holds; add #elseif and #else branches from its properties',
    defaultProps: {},
    propSchema: [],
    allowChildren: true,
  },
  {
    name: '#each',
    category: 'Utility',
    icon: 'repeat',
    description: 'Repeat its branch for every item of a list; add an #empty branch for when the list has none',
    defaultProps: {},
    propSchema: [],
    allowChildren: true,
  },
];

/** A short description of what a block does, for the canvas and the property panel. */
export function blockDescription(block: CanvasBlock): string {
  switch (block.kind) {
    case 'if':
      return 'Shown while the condition holds';
    case 'elseif':
      return 'Shown when the branches above did not apply and this condition holds';
    case 'else':
      return 'Shown when no branch above applied';
    case 'each':
      return 'Repeated for every item of the list';
    case 'empty':
      return 'Shown when the list has no items';
  }
}
