/**
 * CanvasElement - Draggable wrapper for components on the canvas
 */

import React, { useCallback, useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { assetObjectUrl } from '@softn/core';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import { useProjectStore } from '../../stores/projectStore';
import { useCurrentAssets } from '../../utils/projectAssets';
import { assetCallPath, assetNamed } from '../../utils/assetSource';
import { isRemoteAddress, remoteShown, showRemotePicture, useShownPictures } from '../../utils/remotePictures';
import { useFilesStore } from '../../stores/filesStore';
import { DrawnComponent } from './DrawnComponent';
import { addDropped } from '../../utils/pageDrop';
import { SelectionBox } from './SelectionBox';
import { getComponentMeta } from '../../utils/componentRegistry';
import { blockHeaderText } from '../../utils/sourceGenerator';
import { acceptsChildren, blockDescription, branchEnd, canDropInto, elementLabel, hasTextField, isTextNode, takesInline } from '../../utils/blocks';
import { drawnHeld, type DrawnHeld } from '../../utils/drawnProps';
import { parseStringLiteralVariables } from '../../utils/logicStringLiterals';
import { dockLogicFile, entryFileId, logicLanguageOf } from '../../utils/logicFiles';
import { TokenIcon } from '../icons/TokenIcon';
import type { CanvasElement as CanvasElementType, DropIndicator } from '../../types/builder';

/**
 * The pointer events an element has already answered. An element inside
 * another is under the pointer together with it, and both hear the pointer
 * move: the inner one hears first and its answer is the one that counts.
 * The outer one used to hear last and overwrite it, so a drop over a Card
 * in a Stack always went to the Stack.
 */
const answered = new WeakSet<Event>();

/**
 * The drawn components that stay drawn when they hold something that is not
 * among their words: what they hold goes under their own content, which is
 * where the canvas draws an element's children.
 */
const DRAWN_OVER_ITS_CHILDREN: ReadonlySet<string> = new Set(['EmptyState']);

/** What is being dragged, as the type the drop rules ask about. */
function draggedTypeOf(state: { draggedType: string | null; draggedElementId: string | null; elements: Map<string, CanvasElementType> }): string | null {
  if (state.draggedType) return state.draggedType;
  return state.draggedElementId ? state.elements.get(state.draggedElementId)?.componentType ?? null : null;
}

/** The place an element's wrapper draws for its own children, or null when it draws none. */
function ownChildrenArea(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.querySelector<HTMLElement>(':scope > [data-canvas-treeitem] > [data-children-area]');
}

/** How far to either side of an element's words the pointer still counts as on them: a label is a small thing to aim at. */
const NEAR_WORDS = 16;

/**
 * Where the words of the element drawn in `item` are, as the browser laid
 * them out, or null where that is not known (nothing is drawn, or there is
 * no layout to ask).
 *
 * An element is drawn as a row of what holds it, and its words are often
 * the left end of that row: a Button's label, a short Text. Which side of
 * its words a drop goes was measured against the row, so every point on a
 * label was before it, and "after" began far to the right of it.
 */
function wordsBox(item: Element | null | undefined): DOMRect | null {
  const standIn = item?.querySelector(':scope > [aria-hidden="true"]')?.lastElementChild;
  // A component drawn as itself sits in a page of its own, as wide as the
  // row: what is measured is the component in it.
  const drawn = standIn?.matches('[data-softn-drawn]') ? standIn.querySelector('[data-softn-drawn-content]') ?? standIn : standIn;
  if (!drawn) return null;
  const range = document.createRange();
  range.selectNodeContents(drawn);
  // Not every DOM measures a range, and one that does not has no box to give.
  const box = range.getBoundingClientRect?.();
  return box && box.width > 0 ? box : null;
}

const sideBarStyle: React.CSSProperties = {
  position: 'absolute',
  top: 4,
  bottom: 4,
  width: 3,
  background: 'var(--coral)',
  borderRadius: 2,
  // Ringed in the colour of the page: the end of a Button's label is inside
  // the Button, and the bar on the Button's own colour could not be seen.
  boxShadow: '0 0 0 1.5px var(--ink-2)',
  pointerEvents: 'none',
  zIndex: 20,
};

/**
 * The bar that shows which side of an element's words a drop would go: at
 * that end of the words where they can be measured, and at that edge of the
 * element where they cannot.
 */
function WordsSideBar({ side }: { side: 'start' | 'end' }) {
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = bar.current;
    const item = node?.parentElement;
    const words = wordsBox(item);
    if (!node || !item || !words) return;
    const origin = item.getBoundingClientRect();
    node.style.right = 'auto';
    node.style.left = `${Math.round((side === 'start' ? words.left - 5 : words.right + 2) - origin.left)}px`;
  }, [side]);
  return <div ref={bar} data-drop-side={side} style={{ ...sideBarStyle, ...(side === 'start' ? { left: 2 } : { right: 2 }) }} />;
}

/** Where among the elements drawn in `area` the height `y` falls: before the first whose middle is below it. */
function placeAmong(area: HTMLElement, y: number): number {
  const drawn = [...area.children].filter((child) => child.querySelector(':scope > [data-canvas-treeitem]') !== null);
  const at = drawn.findIndex((child) => {
    const rect = child.getBoundingClientRect();
    return y < rect.top + rect.height / 2;
  });
  return at === -1 ? drawn.length : at;
}

// Check if an element is a descendant of another
function isDescendantOf(
  elements: Map<string, CanvasElementType>,
  childId: string,
  parentId: string
): boolean {
  let current = elements.get(childId);
  while (current && current.parentId) {
    if (current.parentId === parentId) return true;
    current = elements.get(current.parentId);
  }
  return false;
}

interface Props {
  elementId: string;
  depth?: number;
  focusedElementId?: string | null;
  onTreeFocusChange?: (elementId: string) => void;
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: 'relative' as const,
    minHeight: 24,
    margin: 2,
    borderRadius: 4,
    transition: 'all 0.15s ease',
  },
  container: {
    position: 'relative' as const,
    padding: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    cursor: 'pointer',
  },
  hovered: {
    borderColor: 'var(--dimmer)',
    background: 'var(--bl-hover)',
  },
  // Tints of the accent the page's side has, so they are there on a dark page too.
  selected: {
    borderColor: 'var(--coral)',
    background: 'color-mix(in srgb, var(--coral) 6%, transparent)',
  },
  dragging: {
    opacity: 0.5,
  },
  dragOver: {
    borderColor: 'var(--coral)',
    background: 'var(--coral-glow)',
  },
  label: {
    position: 'absolute' as const,
    top: -10,
    left: 8,
    fontSize: 10,
    fontWeight: 500,
    fontFamily: 'var(--mono)',
    color: 'var(--coral)',
    background: 'var(--ink-2)',
    padding: '0 4px',
    borderRadius: 2,
    zIndex: 10,
  },
  children: {
    minHeight: 40,
    padding: 4,
    borderRadius: 4,
    borderWidth: 1,
    borderStyle: 'dashed',
    // The outline of where an element's children go. Once it holds some,
    // the words "Drop children here" are gone and this line is all that
    // shows the place, so it is drawn to be seen: half the page's text
    // colour, which is 3:1 on a light page and more on a dark one. It was
    // a tenth of that, a line that was there if one looked for it.
    borderColor: 'var(--place-line, var(--line-strong))',
    marginTop: 8,
    transition: 'all 0.2s',
  },
  childrenEmpty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--dimmer)',
    fontSize: 11,
    padding: 16,
  },
  childrenDragOver: {
    borderColor: 'var(--coral)',
    background: 'color-mix(in srgb, var(--coral) 6%, transparent)',
  },
  notAllowed: {
    cursor: 'not-allowed',
  },
  content: {
    pointerEvents: 'none' as const,
  },
  comment: {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    color: 'var(--dim)',
    whiteSpace: 'pre-wrap' as const,
    overflowWrap: 'anywhere' as const,
    marginBottom: 4,
  },
  // What a container is, where its drawing is otherwise an empty bar.
  containerName: {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    color: 'var(--dim)',
  },
  // A block's header strip: the keyword and its expression, set in the
  // mono face so it reads as the source line it will be written as.
  blockHeader: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    padding: '6px 10px',
    borderRadius: 6,
    // A block is the language's own construct, so it takes the language's
    // colour; it was mint, which the brand keeps for something running.
    // The tint is the page side's (builder.css, --block-ground): the
    // brand's glow where the keyword reads on it, and fainter where not.
    background: 'var(--block-ground, var(--coral-glow))',
    border: '1px solid var(--line)',
    fontSize: 12,
  },
  blockKeyword: {
    fontFamily: 'var(--mono)',
    fontWeight: 600,
    color: 'var(--coral)',
    whiteSpace: 'nowrap' as const,
  },
  blockExpression: {
    fontFamily: 'var(--mono)',
    color: 'var(--paper)',
    overflowWrap: 'anywhere' as const,
  },
  blockHint: {
    marginLeft: 'auto',
    color: 'var(--dim)',
    fontSize: 11,
    whiteSpace: 'nowrap' as const,
  },
};

export const CanvasElement = React.memo(function CanvasElement({
  elementId,
  depth = 0,
  focusedElementId,
  onTreeFocusChange,
}: Props) {
  // Fine-grained store selectors — only re-renders when this element's own state changes.
  const element = useCanvasStore((s) => s.elements.get(elementId));
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(elementId));
  const isHovered = useCanvasStore((s) => s.hoveredId === elementId);
  const isDragging = useCanvasStore((s) => s.draggedElementId === elementId);
  const draggedType = useCanvasStore((s) => s.draggedType);
  const draggedElementId = useCanvasStore((s) => s.draggedElementId);
  const selectElement = useCanvasStore((s) => s.selectElement);
  const setHoveredId = useCanvasStore((s) => s.setHoveredId);
  const setDraggedElementId = useCanvasStore((s) => s.setDraggedElementId);

  // Whether this element has a children area: a registered container, or a
  // control-flow block, whose branch is its children. Blocks used to be
  // asked of the registry, which has no entry for them, so a block showed
  // a notice and its branch was neither drawn nor droppable.
  const allowsChildren = element ? acceptsChildren(element) : false;
  // What the element holds among its words, where it can be drawn inside
  // the element itself (utils/drawnProps.ts, drawnHeld). As text, so that
  // this element is drawn again when one of the things it holds changes,
  // and only then.
  const heldText = useCanvasStore((s) => {
    const own = s.elements.get(elementId);
    if (!own || own.children.length === 0 || own.block || !hasTextField(own.componentType)) return null;
    if (!getComponentMeta(own.componentType)?.drawn) return null;
    const held = drawnHeld(own, s.elements, getComponentMeta, (type) => s.imports.some((imp) => imp.name === type));
    return held ? JSON.stringify(held) : null;
  });
  const held = useMemo<DrawnHeld[] | null>(() => (heldText ? (JSON.parse(heldText) as DrawnHeld[]) : null), [heldText]);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  // The address of a picture that is not loaded until it is asked for, and how many have been.
  const [withheldPicture, setWithheldPicture] = useState<string | null>(null);
  const picturesShown = useShownPictures();
  const assets = useCurrentAssets();
  const retainedSource = useProjectStore((state) => state.source);

  // The logic the file on the canvas runs — the one it links, else the
  // entry's — read in its own language, so an image bound to a Python
  // module's name shows too. It used to fall back to the project's copy of
  // the logic, which is JavaScript whatever the project is.
  //
  // Only a picture reads it, for a `src` that names a string of the logic,
  // and only a picture is drawn again as the logic is typed. Every element
  // held every file of the project and read the whole logic again at each
  // key: sixty keys took nineteen seconds with 427 elements on the canvas.
  const pictured = element?.componentType === 'Image' || element?.componentType === 'Avatar';
  const linkedLogic = useFilesStore((state) =>
    pictured ? dockLogicFile(state.activeFileId, state.uiFiles, state.logicFiles, entryFileId(state.uiFiles, retainedSource)) : undefined
  );

  const resolvedLogicStrings = React.useMemo(
    () =>
      linkedLogic
        ? parseStringLiteralVariables(linkedLogic.content, logicLanguageOf(linkedLogic.path))
        : {},
    [linkedLogic]
  );
  const elementComponentType = element?.componentType;
  const elementParentId = element?.parentId;
  const imageSource = element?.props.src;
  const imageExpressionProps = element?.expressionProps;

  // Check if this element can accept the current drag (reads from store directly for fresh state)
  const canAcceptDrop = useCallback(() => {
    if (!allowsChildren || !elementComponentType) return false;

    const state = useCanvasStore.getState();
    const target = state.elements.get(elementId);
    if (!target) return false;

    // Check for palette component
    if (state.draggedType) {
      return canDropInto(target, state.draggedType, { elements: state.elements });
    }

    // Check for canvas element
    if (state.draggedElementId) {
      // Can't drop on self
      if (state.draggedElementId === elementId) return false;

      // Can't drop on descendants
      if (isDescendantOf(state.elements, elementId, state.draggedElementId)) return false;

      const draggedElement = state.elements.get(state.draggedElementId);
      if (draggedElement) {
        return canDropInto(target, draggedElement.componentType, { elements: state.elements, draggedId: state.draggedElementId });
      }
    }

    return false;
  }, [allowsChildren, elementComponentType, elementId]);

  // Ref for the wrapper div (used for drop position tracking)
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Track mouse position during drag to compute insertion position
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || !elementParentId) return;

    const handleMouseMove = (e: MouseEvent) => {
      const state = useCanvasStore.getState();
      if (!state.draggedType && !state.draggedElementId) return;

      if (answered.has(e)) return;

      // No place is shown on the element being dragged, nor on anything it
      // holds: it does not go into itself. Its own Text offered a line
      // inside it, where letting go moved nothing and still recorded a
      // step to undo; and the place shown before it came back over itself
      // stayed up, so putting it down where it was picked up moved it.
      const moved = state.draggedElementId;
      if (moved && (moved === elementId || isDescendantOf(state.elements, elementId, moved))) {
        answered.add(e);
        if (state.dropIndicator) state.setDropIndicator(null);
        return;
      }

      const rect = el.getBoundingClientRect();
      const relativeY = (e.clientY - rect.top) / rect.height;

      const parentElement = state.elements.get(elementParentId);
      if (!parentElement) return;
      const myIndex = parentElement.children.indexOf(elementId);
      if (myIndex === -1) return;

      let indicator: DropIndicator | null;

      // What may hold what decides where a drop is offered, not only the
      // cursor: a place that is shown is a place the drop is made.
      const dragged = draggedTypeOf(state);
      const self = state.elements.get(elementId);
      const context = { elements: state.elements, draggedId: state.draggedElementId };
      const takesIt = allowsChildren && self !== undefined && canDropInto(self, dragged, context);
      const beside = canDropInto(parentElement, dragged, context);
      const area = takesIt ? ownChildrenArea(el) : null;
      // An element whose content is its words draws no place for children
      // and takes what stands in a line of words, beside them.
      const inline = !takesIt && self !== undefined && takesInline(self, dragged);
      // On its words is into them, and the rest of the row it is drawn as
      // is beside it, as for anything else: let go beside a small Button,
      // an Icon went into the Button from anywhere but the top and bottom
      // few pixels of the row. Where the words cannot be measured, the
      // whole of the row is taken as them.
      const words = inline ? wordsBox(el.querySelector(':scope > [data-canvas-treeitem]')) : null;
      const onWords = inline && (!words || (e.clientX >= words.left - NEAR_WORDS && e.clientX <= words.right + NEAR_WORDS));

      if (area && e.target instanceof Node && area.contains(e.target)) {
        // In this element's own place for children, with none of them under
        // the pointer (one that was would have answered): the drop is into
        // it, where the pointer is among what it holds. How far down the
        // whole element that is says nothing: the place is its lower part,
        // so the bottom of "Drop children here" used to be a drop beside it.
        indicator = { parentId: elementId, index: Math.min(placeAmong(area, e.clientY), branchEnd(self!, state.elements)) };
      } else if (takesIt && (!beside || (relativeY >= 0.25 && relativeY <= 0.75))) {
        // Into this container: the middle half of it, or all of it when the
        // element may not go beside it. At the end of its own branch.
        indicator = { parentId: elementId, index: branchEnd(self, state.elements) };
      } else if (inline && (!beside || (onWords && relativeY >= 0.25 && relativeY <= 0.75))) {
        // Into its line of words: before them on the left half of the
        // words, after them on the right. Their upper and lower quarters
        // stay a drop beside it, as for a container.
        const middle = words ? words.left + words.width / 2 : rect.left + rect.width / 2;
        indicator = { parentId: elementId, index: 0, side: e.clientX < middle ? 'start' : 'end' };
      } else if (!beside) {
        indicator = null;
      } else if (relativeY < (takesIt || onWords ? 0.25 : 0.5)) {
        indicator = { parentId: elementParentId, index: myIndex };
      } else {
        indicator = { parentId: elementParentId, index: myIndex + 1 };
      }

      if (!indicator) {
        // Nowhere here for it, in this element or beside it. That is not
        // the answer: what holds this element is asked next, and may have a
        // place beside itself. A Card over a word in a line of words is
        // offered a place beside the line; with this taken as the answer it
        // was offered nothing, and landed at the end of the page.
        //
        // Only the last to be asked, an element of the page itself, takes
        // the place shown away: one further in that did would have it taken
        // away and put back on every move of the pointer.
        if (elementParentId === state.rootId && state.dropIndicator) state.setDropIndicator(null);
        return;
      }
      answered.add(e);

      // Only update if changed
      const current = state.dropIndicator;
      if (
        !current ||
        current.parentId !== indicator.parentId ||
        current.index !== indicator.index ||
        current.side !== indicator.side
      ) {
        state.setDropIndicator(indicator);
      }
    };

    const handleMouseLeave = () => {
      const state = useCanvasStore.getState();
      if (state.dropIndicator) {
        state.setDropIndicator(null);
      }
    };

    el.addEventListener('mousemove', handleMouseMove);
    el.addEventListener('mouseleave', handleMouseLeave);
    return () => {
      el.removeEventListener('mousemove', handleMouseMove);
      el.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [elementId, elementParentId, allowsChildren]);

  // Mouse-based drag start for moving existing elements
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Start drag only after small pointer movement threshold.
      if (e.button !== 0) return;

      const state = useCanvasStore.getState();
      if (state.draggedType || state.draggedElementId) return;

      // A press in the place this element draws for its own children picks
      // nothing up: that is where things are let go. It used to be any such
      // place around the press, and everything inside a container is inside
      // the container's: nothing that had been put in one could be dragged
      // again. A press on something this element holds never gets here, the
      // inner element having taken it.
      const target = e.target as Node;
      const ownArea = e.currentTarget.querySelector(':scope > [data-children-area]');
      if (ownArea?.contains(target)) return;

      e.stopPropagation();

      const startX = e.clientX;
      const startY = e.clientY;
      let dragActivated = false;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (dragActivated) return;
        const deltaX = Math.abs(moveEvent.clientX - startX);
        const deltaY = Math.abs(moveEvent.clientY - startY);
        if (deltaX + deltaY >= 5) {
          dragActivated = true;
          setDraggedElementId(elementId);
        }
      };

      const handleMouseUp = () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [elementId, setDraggedElementId]
  );

  // Handle mouse up for dropping onto this element (uses dropIndicator for position)
  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const state = useCanvasStore.getState();
      const indicator = state.dropIndicator;

      // Drop a new palette component
      if (state.draggedType && indicator) {
        e.stopPropagation();
        addDropped(state.draggedType, indicator.parentId, indicator.index, indicator.side, () => useHistoryStore.getState().push(state.elements, state.rootId));
        state.setDraggedType(null);
        state.setDropIndicator(null);
        return;
      }

      // Move an existing canvas element
      if (state.draggedElementId && state.draggedElementId !== elementId && indicator) {
        e.stopPropagation();
        const historyState = useHistoryStore.getState();
        historyState.push(state.elements, state.rootId);
        state.moveElement(state.draggedElementId, indicator.parentId, indicator.index, indicator.side);
        state.setDraggedElementId(null);
        state.setDropIndicator(null);
        return;
      }
    },
    [elementId]
  );

  // Track when drag enters/leaves this element
  const handleMouseEnter = useCallback(() => {
    setHoveredId(elementId);
  }, [elementId, setHoveredId]);

  const handleMouseLeave = useCallback(() => {
    setHoveredId(null);
  }, [setHoveredId]);

  useEffect(() => {
    // An Image, and an Avatar, whose picture the app shows and the canvas
    // showed initials for. An Avatar is given a picture of the project's
    // own (`src={asset("…")}`) and no other: see the address test below.
    setWithheldPicture(null);
    if (elementComponentType !== 'Image' && elementComponentType !== 'Avatar') {
      setImagePreviewUrl(null);
      return;
    }

    const src = String(imageSource || '').trim();
    if (!src) {
      setImagePreviewUrl(null);
      return;
    }

    // What the app would load: the file `asset("…")` names, an address, or
    // a name the logic gives a string. A path written on its own is none of
    // these (utils/assetSource.ts): the app does not load it, and the canvas
    // found the file by it and drew the picture all the same.
    const isExpressionSrc = imageExpressionProps?.includes('src') ?? false;
    const called = isExpressionSrc ? assetCallPath(src) : null;
    let resolvedSrc = called ?? src;
    if (isExpressionSrc && called === null && resolvedLogicStrings[src]) {
      resolvedSrc = resolvedLogicStrings[src];
    }

    if (/^(https?:|data:|blob:)/i.test(resolvedSrc) || isRemoteAddress(resolvedSrc)) {
      // A component drawn as itself is given nothing the browser would go
      // and fetch (utils/drawnProps.ts): an Avatar with an address keeps its
      // initials here. An Image at an address was fetched as its file was
      // opened, which told the host of every picture in somebody else's
      // project that it had been opened. It is drawn once it has been asked
      // for (utils/remotePictures.ts); a picture written into the page as
      // `data:` is a request to nobody, and is drawn as before.
      const remote = isRemoteAddress(resolvedSrc);
      const drawn = elementComponentType === 'Image' && (!remote || remoteShown(resolvedSrc));
      setImagePreviewUrl(drawn ? resolvedSrc : null);
      if (remote && !drawn && elementComponentType === 'Image') setWithheldPicture(resolvedSrc);
      return;
    }

    const matchedAsset = isExpressionSrc ? assetNamed(resolvedSrc, assets) : undefined;

    if (!matchedAsset) {
      setImagePreviewUrl(null);
      return;
    }

    // As the app will be handed it, by its name (core assetObjectUrl): an SVG
    // as a `data:` URL, which "Open image in new tab" cannot open as a page of
    // the Builder, the bundle's script in it.
    const objectUrl = assetObjectUrl(matchedAsset.name, Uint8Array.from(matchedAsset.data));
    setImagePreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [elementComponentType, imageSource, imageExpressionProps, assets, resolvedLogicStrings, picturesShown]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setDraggedElementId(null);
      onTreeFocusChange?.(elementId);
      selectElement(elementId, e.shiftKey);
    },
    [elementId, onTreeFocusChange, selectElement, setDraggedElementId]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        setDraggedElementId(null);
        selectElement(elementId, e.shiftKey);
        return;
      }

      if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      const current = e.currentTarget as HTMLElement;
      const tree = current.closest<HTMLElement>('[role="tree"]');
      if (!tree) return;
      const items = Array.from(tree.querySelectorAll<HTMLElement>('[data-canvas-treeitem="true"]'));
      const currentIndex = items.indexOf(current);
      let target: HTMLElement | undefined;

      if (e.key === 'ArrowDown' && currentIndex >= 0) target = items[currentIndex + 1];
      else if (e.key === 'ArrowUp' && currentIndex > 0) target = items[currentIndex - 1];
      else if (e.key === 'Home') target = items[0];
      else if (e.key === 'End') target = items.at(-1);
      else if (e.key === 'ArrowRight') {
        const childGroup = Array.from(current.children).find(
          (child) => child.getAttribute('role') === 'group'
        );
        target =
          childGroup?.querySelector<HTMLElement>('[data-canvas-treeitem="true"]') ?? undefined;
      } else if (e.key === 'ArrowLeft') {
        target =
          current.parentElement?.closest<HTMLElement>('[data-canvas-treeitem="true"]') ?? undefined;
      }

      if (!target || target === current) return;
      const targetId = target.dataset.canvasElementId;
      if (targetId) onTreeFocusChange?.(targetId);
      for (const item of items) item.tabIndex = item === target ? 0 : -1;
      target.focus();
    },
    [elementId, onTreeFocusChange, selectElement, setDraggedElementId]
  );

  const handleFocus = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      // React focus events bubble. A child tree item taking focus must not make
      // each ancestor claim the roving tab stop on the way up.
      if (event.target !== event.currentTarget) return;
      if (onTreeFocusChange) {
        const tree = event.currentTarget.closest('[role="tree"]');
        for (const item of tree?.querySelectorAll<HTMLElement>('[data-canvas-treeitem="true"]') ??
          []) {
          item.tabIndex = item === event.currentTarget ? 0 : -1;
        }
      }
      onTreeFocusChange?.(elementId);
    },
    [elementId, onTreeFocusChange]
  );

  // Drop indicator state
  const dropIndicator = useCanvasStore((s) => s.dropIndicator);
  const { showLineBefore, showLineAfter, showDropInto } = useMemo(() => {
    if (!element) return { showLineBefore: false, showLineAfter: false, showDropInto: false };
    const parent = element.parentId
      ? useCanvasStore.getState().elements.get(element.parentId)
      : null;
    const idx = parent?.children.indexOf(elementId) ?? -1;
    return {
      showLineBefore: dropIndicator?.parentId === element.parentId && dropIndicator?.index === idx,
      showLineAfter:
        dropIndicator?.parentId === element.parentId &&
        dropIndicator?.index === idx + 1 &&
        idx === (parent?.children.length ?? 0) - 1,
      showDropInto: dropIndicator?.parentId === elementId,
    };
  }, [dropIndicator, element, elementId]);

  // Determine if we should show that this element can receive drops
  if (!element) return null;

  const canDrop = canAcceptDrop();
  const isDragActive = !!(draggedType || draggedElementId);
  const showNotAllowed = isDragActive && isHovered && !canDrop && !isDragging;

  const containerStyle: React.CSSProperties = {
    ...styles.container,
    ...(isHovered && !isSelected ? styles.hovered : {}),
    ...(isSelected ? styles.selected : {}),
    ...(isDragging ? styles.dragging : {}),
    ...(showDropInto ? styles.dragOver : {}),
    ...(showNotAllowed ? styles.notAllowed : {}),
  };

  const childrenStyle: React.CSSProperties = {
    ...styles.children,
    ...(showDropInto ? styles.childrenDragOver : {}),
  };

  // The component itself, where the registry says the canvas draws it, and
  // what the canvas draws in its place otherwise.
  const renderComponentPreview = () => {
    const meta = element.block || isTextNode(element) ? undefined : getComponentMeta(element.componentType);
    // What an element holds is drawn below its own drawing, where it can be
    // picked up. A component that held anything was a card with its name
    // again, so a Badge turned grey when an Icon was put in it. It stays
    // itself where the drawing is still a true one: holding what stands
    // among its words, which is drawn inside it as well (`held`), and an
    // EmptyState, which lays what it holds out under its description, where
    // the canvas puts it too. What a Skeleton holds is shown in place of the
    // Skeleton, and any other container lays its children out itself: each
    // of those is drawn as before. And a name a page has imported over is
    // that page's component, not the library's.
    const itself =
      meta?.drawn === true &&
      (element.children.length === 0 || held !== null || DRAWN_OVER_ITS_CHILDREN.has(element.componentType)) &&
      !useCanvasStore.getState().getImportSource(element.componentType);
    if (itself) {
      return (
        <DrawnComponent
          element={element}
          meta={meta}
          fallback={renderStandIn()}
          held={held}
          picture={element.componentType === 'Avatar' ? imagePreviewUrl : null}
        />
      );
    }
    return renderStandIn();
  };

  // What the canvas draws for an element by hand: ten components as a
  // likeness, and any other as a card with its name.
  const renderStandIn = () => {
    const { componentType, props } = element;

    // A control-flow block: its header line, with the branch drawn below
    // as the children area, where elements can be dropped. The expression
    // is edited in the property panel.
    if (element.block) {
      const header = blockHeaderText(element) ?? componentType;
      const keywordEnd = header.indexOf(' ');
      const keyword = keywordEnd === -1 ? header : header.slice(0, keywordEnd);
      const expression = keywordEnd === -1 ? '' : header.slice(keywordEnd + 1);
      return (
        <div style={styles.blockHeader} data-block-header={element.block.kind}>
          <span style={styles.blockKeyword}>{keyword}</span>
          {expression && <span style={styles.blockExpression}>{expression}</span>}
          <span style={styles.blockHint}>{blockDescription(element.block)}</span>
        </div>
      );
    }

    // Words beside elements: drawn as the words, with their expressions as
    // written.
    if (isTextNode(element)) {
      return (
        <span data-canvas-text-node="true" style={{ fontSize: 14, color: 'var(--paper)', overflowWrap: 'anywhere' }}>
          {String(props.children ?? '')}
        </span>
      );
    }
    // A placeholder stands in for missing words only where there are none:
    // an element whose words are among its children shows them below.
    const placeholder = (word: string) => (element.children.length > 0 ? '' : word);

    switch (componentType) {
      case 'Button':
        return (
          <button
            tabIndex={-1}
            style={{
              padding: '8px 16px',
              borderRadius: 4,
              border: 'none',
              // The app's own button colours, where it was the editor's
              // accent: on the canvas a primary Button is the colour it is
              // when the app runs. Its box is what it was: where a drop
              // goes among its words is measured on it.
              // The primary's ground is the two-stop fall the library's
              // Button has, so the canvas and Preview show one Button.
              background:
                props.variant === 'secondary'
                  ? 'var(--btn-secondary-bg, var(--line-soft))'
                  : 'linear-gradient(to bottom, var(--color-primary-500, var(--coral)), var(--color-primary-600, var(--coral)))',
              color: props.variant === 'secondary' ? 'var(--btn-secondary-text, var(--paper))' : 'var(--color-primary-text, #fff)',
              boxShadow: props.variant === 'secondary' ? 'inset 0 0 0 1px var(--btn-secondary-border, var(--line))' : undefined,
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            {(props.children as string) || placeholder('Button')}
          </button>
        );

      case 'Input':
        return (
          <input
            tabIndex={-1}
            type="text"
            placeholder={(props.placeholder as string) || 'Input'}
            style={{
              padding: '8px 12px',
              borderRadius: 4,
              border: '1px solid var(--line-soft)',
              fontSize: 14,
              width: '100%',
            }}
            readOnly
          />
        );

      case 'TextArea':
        return (
          <textarea
            tabIndex={-1}
            placeholder={(props.placeholder as string) || 'TextArea'}
            style={{
              padding: '8px 12px',
              borderRadius: 4,
              border: '1px solid var(--line-soft)',
              fontSize: 14,
              width: '100%',
              minHeight: 80,
              resize: 'none',
            }}
            readOnly
          />
        );

      case 'Text':
        return (
          <span style={{ fontSize: 14, color: 'var(--paper)' }}>
            {(props.children as string) || placeholder('Text')}
          </span>
        );

      case 'Heading': {
        const HeadingTag = `h${props.level || 1}` as keyof JSX.IntrinsicElements;
        return (
          <HeadingTag style={{ margin: 0, fontSize: props.level === 1 ? 24 : 18 }}>
            {(props.children as string) || placeholder('Heading')}
          </HeadingTag>
        );
      }

      case 'Card':
        return (
          <div
            style={{
              padding: 16,
              borderRadius: 8,
              // The app's surface on the app's page: it was white whatever the page.
              background: 'var(--color-surface, var(--ink-2))',
              boxShadow: 'var(--shadow-md, 0 2px 8px rgba(0,0,0,0.1))',
              border: '1px solid var(--color-border, var(--line-soft))',
            }}
          >
            Card
          </div>
        );

      case 'Stack':
        return (
          <div
            style={{
              display: 'flex',
              flexDirection: props.direction === 'horizontal' ? 'row' : 'column',
              gap: 8,
              padding: 8,
              background: 'var(--ink)',
              borderRadius: 4,
              minHeight: 28,
            }}
          >
            {/* Its name, quietly: it was a bare grey bar, and a page is
                mostly Stacks. Its children are drawn below. */}
            <span style={styles.containerName} data-canvas-container-name="">
              {props.direction === 'horizontal' ? 'Stack · horizontal' : 'Stack'}
            </span>
          </div>
        );

      case 'Box':
        return (
          <div
            style={{
              padding: 8,
              background: 'var(--ink)',
              borderRadius: 4,
              minHeight: 28,
            }}
          >
            <span style={styles.containerName} data-canvas-container-name="">Box</span>
          </div>
        );

      case 'Image':
        return (
          <div
            style={{
              width: '100%',
              minHeight: 100,
              background: 'var(--ink)',
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--dim)',
              fontSize: 12,
              overflow: 'hidden',
              border: '1px solid var(--line-soft)',
            }}
          >
            {withheldPicture ? (
              <span data-remote-picture="" style={{ display: 'grid', gap: 6, justifyItems: 'center', padding: '10px 12px', textAlign: 'center', overflowWrap: 'anywhere' }}>
                <span style={{ fontFamily: 'var(--mono)' }}>{withheldPicture}</span>
                <span>Not loaded: the canvas asks nothing of another site until you say so.</span>
                {/* The canvas is one stop for Tab: the same is offered in Properties, where the keyboard reaches. */}
                <button
                  type="button"
                  className="bl-btn bl-btn-sm"
                  tabIndex={-1}
                  data-action="show-remote-picture"
                  // What the canvas draws for an element is a picture and takes no pointer; this is the one thing in it to press.
                  style={{ pointerEvents: 'auto' }}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    showRemotePicture(withheldPicture);
                  }}
                >
                  Show
                </button>
              </span>
            ) : imagePreviewUrl ? (
              <img
                src={imagePreviewUrl}
                alt={(props.alt as string) || 'Image'}
                style={{ maxWidth: '100%', maxHeight: 180, objectFit: 'contain' }}
              />
            ) : props.src && !(element.expressionProps ?? []).includes('src') && assetNamed(String(props.src), assets) ? (
              // The file is in the project and the page names it by its path,
              // which the app does not load: said here, where it was drawn.
              `${String(props.src)} is written as a path, which the app does not load. Choose the picture under Asset in Properties.`
            ) : props.src ? (
              `Missing image source: ${String(props.src)}`
            ) : (
              'No image'
            )}
          </div>
        );

      case 'Alert': {
        // The status colour, mixed into the page as the library's Alert mixes
        // it (feedback/Alert.tsx): a tint for the ground and a stronger one
        // for the line, which read on a light page and on a dark one. With
        // no variant written it is information, as the Alert itself is.
        const status = ['error', 'success', 'warning', 'info'].includes(String(props.variant)) ? String(props.variant) : 'info';
        const fallback = { error: '#ef4444', success: '#22c55e', warning: '#f59e0b', info: '#3b82f6' }[status];
        const statusColor = `var(--color-${status}-500, ${fallback})`;
        return (
          <div
            style={{
              padding: '12px 16px',
              borderRadius: 4,
              background: `color-mix(in srgb, ${statusColor} 12%, transparent)`,
              border: `1px solid color-mix(in srgb, ${statusColor} 35%, transparent)`,
              fontSize: 14,
            }}
          >
            {(props.children as string) || 'Alert message'}
          </div>
        );
      }

      default: {
        const componentMeta = getComponentMeta(componentType);
        // Check if this is an imported component
        const importSource = useCanvasStore.getState().getImportSource(componentType);
        if (importSource) {
          // Render as imported component placeholder
          return (
            <div
              style={{
                padding: 12,
                // The app's own accent, faintly: it was a fixed light purple,
                // which a dark page had no place for.
                background: 'var(--color-primary-50, var(--ink-3))',
                borderRadius: 6,
                border: '1px dashed var(--color-primary-500, var(--line-strong))',
                minHeight: 40,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <span
                  style={{
                    fontSize: 14,
                    color: 'var(--paper)',
                    fontWeight: 600,
                  }}
                >
                  {componentType}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: 'var(--paper)',
                    background: 'var(--color-primary-100, var(--ink))',
                    padding: '2px 6px',
                    borderRadius: 4,
                  }}
                >
                  Imported
                </span>
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--dim)',
                }}
              >
                from {importSource}
              </div>
            </div>
          );
        }
        // Generic built-in/custom component preview
        return (
          <div
            style={{
              padding: 10,
              background: 'var(--ink)',
              borderRadius: 6,
              border: '1px solid var(--line-soft)',
              fontSize: 12,
              color: 'var(--paper)',
              display: 'grid',
              gap: 4,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 6,
                  background: 'var(--line-soft)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <TokenIcon token={componentMeta?.icon} size={12} />
              </span>
              <strong style={{ fontSize: 12 }}>{componentType}</strong>
            </div>
            {componentMeta?.description && (
              <span style={{ color: 'var(--dim)', fontSize: 11 }}>{componentMeta.description}</span>
            )}
            {element.children.length === 0 && typeof props.children === 'string' && (
              <span data-canvas-leaf-text="true" style={{ overflowWrap: 'anywhere', fontSize: 13 }}>
                {props.children}
              </span>
            )}
          </div>
        );
      }
    }
  };

  const indicatorLineStyle: React.CSSProperties = {
    position: 'absolute',
    left: 4,
    right: 4,
    height: 3,
    background: 'var(--coral)',
    borderRadius: 2,
    opacity: 0.8,
    pointerEvents: 'none',
    zIndex: 20,
  };

  const dropSide = showDropInto ? dropIndicator?.side : undefined;

  return (
    <div ref={wrapperRef} style={styles.wrapper}>
      {showLineBefore && <div style={{ ...indicatorLineStyle, top: -2 }} />}
      <div
        style={containerStyle}
        role="treeitem"
        data-canvas-treeitem="true"
        data-canvas-element-id={elementId}
        tabIndex={onTreeFocusChange ? (focusedElementId === elementId ? 0 : -1) : 0}
        aria-selected={isSelected}
        aria-level={depth + 1}
        aria-expanded={allowsChildren ? true : undefined}
        aria-label={
          element.block
            ? `Select ${blockHeaderText(element) ?? element.componentType} block`
            : isTextNode(element)
              ? `Select the words ${elementLabel(element)}`
              : `Select ${element.componentType} component`
        }
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {(isSelected || isHovered || showDropInto) && (
          <span style={styles.label}>
            {isTextNode(element) ? 'words' : element.componentType}
            {/* Kept short: on a narrow page a longer one wrapped, over the element it names. */}
            {showDropInto && (dropSide === 'start' ? ' (before its words)' : dropSide === 'end' ? ' (after its words)' : ' (drop here)')}
          </span>
        )}
        {/* Which side of its words a drop would go: a bar at that end of them. */}
        {showDropInto && dropSide && <WordsSideBar side={dropSide} />}

        <div style={styles.content} aria-hidden="true">
          {/* The author's notes on this element, as the source has them. */}
          {element.leadingComments?.map((comment, index) => (
            <div key={index} style={styles.comment} data-canvas-comment="true">
              {comment.form === 'html' ? `<!-- ${comment.text} -->` : `// ${comment.text}`}
            </div>
          ))}
          {renderComponentPreview()}
        </div>

        {allowsChildren && (
          <div style={childrenStyle} data-children-area="true" role="group">
            {element.children.length > 0 ? (
              element.children.map((childId) => (
                <CanvasElement
                  key={childId}
                  elementId={childId}
                  depth={depth + 1}
                  focusedElementId={focusedElementId}
                  onTreeFocusChange={onTreeFocusChange}
                />
              ))
            ) : (
              <div style={styles.childrenEmpty}>
                {showDropInto
                  ? 'Release to drop here'
                  : element.block
                    ? 'Drop the elements of this branch here'
                    : 'Drop children here'}
              </div>
            )}
          </div>
        )}

        {isSelected && <SelectionBox />}
      </div>
      {showLineAfter && <div style={{ ...indicatorLineStyle, bottom: -2 }} />}
    </div>
  );
});
