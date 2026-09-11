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

import { BLOCK_COMPONENT_TYPES, type CanvasBlock, type CanvasElement, type ComponentMeta } from '../types/builder';
import { getComponentMeta } from './componentRegistry';

/** Whether `componentType` is a control-flow block rather than a component. */
export function isBlockType(componentType: string): boolean {
  return (BLOCK_COMPONENT_TYPES as readonly string[]).includes(componentType);
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

/** Whether the element can hold children on the canvas: a block always can, a component if its registry entry says so. */
export function acceptsChildren(element: CanvasElement): boolean {
  if (element.block) return true;
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
  const meta = getComponentMeta(target.componentType);
  if (!meta?.allowChildren) return false;
  if (meta.childTypes && meta.childTypes.length > 0 && draggedType) {
    return meta.childTypes.includes(draggedType);
  }
  return true;
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
