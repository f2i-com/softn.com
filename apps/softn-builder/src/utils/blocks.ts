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
import { PAGE_TYPE, TEXT_NODE_TYPE } from '../types/builder';
import { getComponentMeta, paletteComponents } from './componentRegistry';

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
 * The words an element holds as its text, or null. Words are kept this way
 * only while they are all the element holds (see `wordsBecomeElement` in
 * the canvas store).
 */
export function wordsOf(element: CanvasElement): string | null {
  const words = element.props.children;
  return typeof words === 'string' && words !== '' ? words : null;
}

/**
 * Whether the element can hold children on the canvas, which is also
 * whether it is drawn with a place for them: a block always can, a
 * component if its registry entry says so, and any element that already
 * holds some. A `<Text>` with a `<Kbd>` among its words has children
 * whatever its entry says, and they have to be seen to be edited.
 *
 * A component whose content is its words, edited in the panel's Text
 * field, is complete as it stands. A Button with its label was drawn with a
 * dashed box under it asking for children, and took whatever was let go
 * over its middle; emptied of its words it is a container again.
 */
export function acceptsChildren(element: CanvasElement): boolean {
  if (element.block) return true;
  if (isTextNode(element)) return false;
  if (element.children.length > 0) return true;
  if (wordsOf(element) !== null && hasTextField(element.componentType)) return false;
  return getComponentMeta(element.componentType)?.allowChildren ?? false;
}

/**
 * Whether the panel has a Text field for the words of an element of this
 * type. Where it has, words that are all the element holds are its text;
 * where it has none (a block, the page, a Card) they are an element in
 * their place, or there would be nowhere to see them or change them.
 */
export function hasTextField(componentType: string): boolean {
  return getComponentMeta(componentType)?.propSchema.some((prop) => prop.name === 'children') ?? false;
}

/** Whether `componentType` is a control-flow block: `#if`, `#each` or one of their branches. */
function isBlockType(componentType: string): boolean {
  return defaultBlock(componentType) !== undefined;
}

/**
 * The elements that are a button themselves. What may draw a button of its
 * own (a Tag that can be removed does) is not put in one: a button inside a
 * button is not a thing a browser draws.
 */
const BUTTON_HOSTS: ReadonlySet<string> = new Set(['Button', 'CopyButton', 'button']);
const MAY_DRAW_A_BUTTON: ReadonlySet<string> = new Set(['Tag']);

/** The component that is a run of words inside a line of them (see canDropInto). */
const RUN_OF_WORDS = 'Text';

/**
 * Whether `target`, an element whose content is its words, takes
 * `draggedType` beside them: `<Button><Icon name="plus" /> Add</Button>`.
 *
 * Such an element draws no place for children and takes nothing else (see
 * acceptsChildren), which left the commonest pattern there is to be typed
 * in Code. What it takes is what stands in a line of words, and the
 * registry says which components do (componentRegistry.ts, INLINE_KINDS).
 * Not its own kind: a Badge in a Badge is a mistake of the hand.
 */
export function takesInline(target: CanvasElement, draggedType: string | null): boolean {
  if (target.block || isTextNode(target) || target.children.length > 0) return false;
  return standsInItsWords(target, draggedType);
}

/**
 * Whether `draggedType` is something that may stand among the words of
 * `target`, whatever it holds now. An element with nothing in it has to be
 * one whose words the panel edits; one that already holds a line of words
 * need not be.
 */
function standsInItsWords(target: CanvasElement, draggedType: string | null, needsTextField = true): boolean {
  if (!draggedType || (needsTextField && !hasTextField(target.componentType))) return false;
  if (!getComponentMeta(draggedType)?.inline || draggedType === target.componentType) return false;
  return !(BUTTON_HOSTS.has(target.componentType) && MAY_DRAW_A_BUTTON.has(draggedType));
}

/** What `canDropInto` may be told about the canvas the drop is made on. */
export interface DropContext {
  elements: Map<string, CanvasElement>;
  /** The element being moved, when the drag is a move and not a new element. */
  draggedId?: string | null;
}

/** The component a block stands in: its rules are the rules of the block's branch. */
function componentAround(block: CanvasElement, elements: Map<string, CanvasElement>): CanvasElement | undefined {
  let current: CanvasElement | undefined = block;
  while (current?.block) current = current.parentId ? elements.get(current.parentId) : undefined;
  return current;
}

/**
 * Whether `draggedType` may be dropped into `target`. A continuation is
 * never dropped anywhere (see isContinuationType), nor is the page; a
 * component takes what its registry entry allows, and as many as it draws;
 * a block takes what the component around it takes, since what is in its
 * branch is drawn there.
 */
export function canDropInto(target: CanvasElement, draggedType: string | null, context?: DropContext): boolean {
  if (draggedType && isContinuationType(draggedType)) return false;
  if (draggedType === PAGE_TYPE) return false;
  if (isTextNode(target)) return false;

  if (target.block) {
    const around = context ? componentAround(target, context.elements) : undefined;
    const kinds = around ? getComponentMeta(around.componentType)?.childTypes : undefined;
    return !kinds?.length || !draggedType || isBlockType(draggedType) || kinds.includes(draggedType);
  }

  // Complete as it stands, it still takes what stands in a line of words.
  if (!acceptsChildren(target)) return takesInline(target, draggedType);
  const meta = getComponentMeta(target.componentType);
  if (!meta?.allowChildren) {
    // It holds elements whatever its entry says. One that is no component
    // the registry knows (a page's own) takes more of any kind. A leaf the
    // registry does know holds them as a line of words (a Text with a key
    // among its words, a key holding its letter): it takes what stands in
    // one, words, and a block, and a Card goes beside it as it would have
    // before there was anything in it.
    if (!meta) return true;
    // One of its own, changing places, is in the line already: a span the
    // author put there can be put in another place in it.
    if (context?.draggedId && target.children.includes(context.draggedId)) return true;
    // A Text in a line is a run of its words, set apart to be styled: the
    // apps the directory ships do it 79 times in their 78 pages. Into a
    // line that is already made of parts, and one the panel edits the
    // words of; onto a Text that is only its words, another Text is the
    // next paragraph, and goes beside it.
    if (draggedType === RUN_OF_WORDS && hasTextField(target.componentType)) return true;
    return !draggedType || draggedType === TEXT_NODE_TYPE || isBlockType(draggedType) || standsInItsWords(target, draggedType, false);
  }
  // A block is not one of the kinds, and is how they are usually made:
  // an AvatarGroup holds an `#each` around an Avatar. A block by name, not
  // anything that begins `#`: words are `#text`, and went in the same way.
  if (meta.childTypes && meta.childTypes.length > 0 && draggedType && !isBlockType(draggedType)) {
    if (!meta.childTypes.includes(draggedType)) return false;
  }
  if (meta.maxChildren !== undefined && context) {
    // One of its own, changing places, is not one more.
    const own = context.draggedId ? target.children.includes(context.draggedId) : false;
    const held = target.children.filter((id) => {
      const child = context.elements.get(id);
      return child !== undefined && !isTextNode(child);
    }).length;
    if (!own && held >= meta.maxChildren) return false;
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

/** Whether `type` is something the palette offers: a component it lists, or one of the two blocks. */
export function isPaletteType(type: string): boolean {
  return blockPalette.some((entry) => entry.name === type) || paletteComponents.some((entry) => entry.name === type);
}

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
