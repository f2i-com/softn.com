/**
 * Canvas Store - Manages canvas elements, selection, and drag-drop state
 */

import { create } from 'zustand';
import { useProjectStore } from './projectStore';
import type { CanvasBlock, CanvasElement, CanvasState, UIImport } from '../types/builder';
import { debug } from '../utils/debug';
import { branchEnd, defaultBlock, isBlockHead, isContinuationType } from '../utils/blocks';
import { starterProps } from '../utils/starterProps';

function generateId(): string {
  return `el_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

interface CanvasStore extends CanvasState {
  // Imports tracking for current file
  imports: UIImport[];
  setImports: (imports: UIImport[]) => void;
  isImportedComponent: (componentType: string) => boolean;
  getImportSource: (componentType: string) => string | null;

  // Actions
  /**
   * Add an element. With `starter`, it is given what its registry entry
   * says a new one starts with (utils/starterProps.ts): that is a component
   * taken from the palette. Without, it has no props, for a caller that sets
   * its own (a project template).
   */
  addElement: (type: string, parentId: string | null, index?: number, options?: { starter?: boolean }) => string;
  updateElement: (id: string, updates: Partial<CanvasElement>) => void;
  updateElementProps: (id: string, props: Record<string, unknown>) => void;
  deleteElement: (id: string) => void;
  moveElement: (id: string, newParentId: string | null, index: number) => void;
  duplicateElement: (id: string) => string | null;

  // Control-flow blocks (utils/blocks.ts). None of these push history; the
  // caller does, as for every other edit.
  /**
   * Put an `#if` or `#each` around the element, in its place: the block
   * takes the element's slot in the parent and the element becomes the
   * block's branch. Returns the block's id, or null for the root or for a
   * continuation branch.
   */
  wrapElement: (id: string, kind: 'if' | 'each') => string | null;
  /**
   * Add an `#elseif` or `#else` branch to an `#if`, or an `#empty` branch to
   * an `#each`. An `#elseif` goes before the `#else` if there is one; a second
   * `#else` or `#empty` is refused. Returns the branch's id, or null.
   */
  addBlockBranch: (blockId: string, kind: 'elseif' | 'else' | 'empty') => string | null;
  /**
   * Remove an `#if` or `#each` but keep what its main branch holds: the
   * branch's elements take the block's slot in the parent, and the block's
   * alternate branches go with the block.
   */
  unwrapBlock: (id: string) => void;

  // Selection
  selectElement: (id: string, addToSelection?: boolean) => void;
  deselectAll: () => void;
  selectMultiple: (ids: string[]) => void;

  // Hover
  setHoveredId: (id: string | null) => void;

  // Clipboard
  copySelected: () => void;
  paste: (parentId: string | null) => void;
  cutSelected: () => void;

  // Drag state
  setDraggedType: (type: string | null) => void;
  setDropTargetId: (id: string | null) => void;
  setDraggedElementId: (id: string | null) => void;
  setDropIndicator: (indicator: { parentId: string; index: number } | null) => void;
  draggedElementId: string | null;

  // Reset
  reset: () => void;
  loadState: (elements: Map<string, CanvasElement>, rootId: string, imports?: UIImport[]) => void;

  // Get element
  getElement: (id: string) => CanvasElement | undefined;
  getChildren: (id: string) => CanvasElement[];
  getParent: (id: string) => CanvasElement | undefined;
}

const initialRootId = 'root_app';
const initialElements = new Map<string, CanvasElement>([
  [
    initialRootId,
    {
      id: initialRootId,
      componentType: 'App',
      props: { theme: 'system' },
      children: [],
      parentId: null,
    },
  ],
]);

export const useCanvasStore = create<CanvasStore>((set, get) => {
  const edit: typeof set = (...args) => {
    const before = get();
    set(...(args as Parameters<typeof set>));
    if (get() !== before) useProjectStore.getState().markDirty();
  };
  return ({
  elements: new Map(initialElements),
  rootId: initialRootId,
  selectedIds: [],
  hoveredId: null,
  clipboard: [],
  clipboardTree: new Map(),
  draggedType: null,
  dropTargetId: null,
  draggedElementId: null,
  dropIndicator: null,
  imports: [],

  setImports: (imports) => {
    set({ imports });
  },

  isImportedComponent: (componentType) => {
    return get().imports.some((imp) => imp.name === componentType);
  },

  getImportSource: (componentType) => {
    const imp = get().imports.find((i) => i.name === componentType);
    return imp ? imp.source : null;
  },

  addElement: (type, parentId, index, options) => {
    const id = generateId();
    const parent = parentId || get().rootId;
    const starter = options?.starter ? starterProps(type) : null;

    edit((state) => {
      const newElements = new Map(state.elements);

      // Create new element
      const newElement: CanvasElement = {
        id,
        componentType: type,
        props: starter ? starter.props : {},
        events: {},
        bindings: {},
        expressionProps: starter ? starter.expressionProps : [],
        children: [],
        parentId: parent,
      };
      // A block dropped from the palette starts with a header to edit; an
      // element without one would print as a bare keyword the parser rejects.
      const block = defaultBlock(type);
      if (block) newElement.block = block;

      newElements.set(id, newElement);

      // Add to parent's children
      const parentElement = newElements.get(parent);
      if (parentElement) {
        const newChildren = [...parentElement.children];
        // An element of a block goes in its branch, before any `#else` or
        // `#empty`: after one it would be written inside that branch.
        const end = isContinuationType(type) ? newChildren.length : branchEnd(parentElement, newElements);
        newChildren.splice(index !== undefined && index >= 0 ? Math.min(index, end) : end, 0, id);
        newElements.set(parent, { ...parentElement, children: newChildren });
      }

      return { elements: newElements, selectedIds: [id] };
    });

    return id;
  },

  updateElement: (id, updates) => {
    edit((state) => {
      const element = state.elements.get(id);
      if (!element) return state;

      const newElements = new Map(state.elements);
      newElements.set(id, { ...element, ...updates });
      return { elements: newElements };
    });
  },

  updateElementProps: (id, props) => {
    edit((state) => {
      const element = state.elements.get(id);
      if (!element) return state;

      const newElements = new Map(state.elements);
      newElements.set(id, {
        ...element,
        props: { ...element.props, ...props },
      });
      return { elements: newElements };
    });
  },

  deleteElement: (id) => {
    const state = get();
    if (id === state.rootId) return; // Cannot delete root

    edit((state) => {
      const element = state.elements.get(id);
      if (!element) return state;

      const newElements = new Map(state.elements);

      // Recursively delete children
      const deleteRecursive = (elementId: string) => {
        const el = newElements.get(elementId);
        if (el) {
          el.children.forEach(deleteRecursive);
          newElements.delete(elementId);
        }
      };
      deleteRecursive(id);

      // Remove from parent's children
      if (element.parentId) {
        const parent = newElements.get(element.parentId);
        if (parent) {
          newElements.set(element.parentId, {
            ...parent,
            children: parent.children.filter((cid) => cid !== id),
          });
        }
      }

      // Update selection: the element and whatever it held are gone from it.
      const newSelectedIds = state.selectedIds.filter((sid) => newElements.has(sid));

      return { elements: newElements, selectedIds: newSelectedIds };
    });
  },

  moveElement: (id, newParentId, index) => {
    edit((state) => {
      const element = state.elements.get(id);
      if (!element) return state;
      if (id === state.rootId) return state; // Cannot move root
      // An `#else` or `#empty` is a branch of its block and has no meaning
      // anywhere else.
      if (isContinuationType(element.componentType)) return state;

      const targetParentId = newParentId || state.rootId;

      // Validate target parent exists
      if (!state.elements.has(targetParentId)) return state;

      // Prevent moving to self or descendant
      const isDescendant = (parentId: string, childId: string): boolean => {
        if (parentId === childId) return true;
        const parent = state.elements.get(parentId);
        if (!parent) return false;
        return parent.children.some((cid) => isDescendant(cid, childId));
      };

      if (isDescendant(id, targetParentId)) return state;

      const newElements = new Map(state.elements);

      // `index` is a place in the target's list as it stands, the moved
      // element included when it is already there: that is the list the
      // canvas shows and counts in. Taking the element out moves every
      // place after its own up by one, and it used to land one too far.
      let at = index;
      if (element.parentId === targetParentId) {
        const from = state.elements.get(targetParentId)?.children.indexOf(id) ?? -1;
        if (from !== -1 && from < at) at -= 1;
      }

      // Remove from old parent
      if (element.parentId) {
        const oldParent = newElements.get(element.parentId);
        if (oldParent) {
          newElements.set(element.parentId, {
            ...oldParent,
            children: oldParent.children.filter((cid) => cid !== id),
          });
        }
      }

      // Add to new parent, within its own branch (see addElement).
      const newParent = newElements.get(targetParentId);
      if (newParent) {
        const newChildren = [...newParent.children];
        newChildren.splice(Math.max(0, Math.min(at, branchEnd(newParent, newElements))), 0, id);
        newElements.set(targetParentId, { ...newParent, children: newChildren });
      }

      // Update element's parent reference
      newElements.set(id, { ...element, parentId: targetParentId });

      return { elements: newElements };
    });
  },

  duplicateElement: (id) => {
    const state = get();
    const element = state.elements.get(id);
    if (!element || id === state.rootId) return null;

    const newId = generateId();

    edit((state) => {
      const newElements = new Map(state.elements);

      // Deep clone the element and its children
      const cloneRecursive = (el: CanvasElement, newParentId: string | null): CanvasElement => {
        const clonedId = el.id === id ? newId : generateId();
        const clonedChildren = el.children.map((childId) => {
          const child = state.elements.get(childId);
          if (child) {
            const cloned = cloneRecursive(child, clonedId);
            newElements.set(cloned.id, cloned);
            return cloned.id;
          }
          return childId;
        });

        return {
          ...el,
          id: clonedId,
          parentId: newParentId,
          children: clonedChildren,
          props: { ...el.props },
          events: el.events ? { ...el.events } : undefined,
          bindings: el.bindings ? { ...el.bindings } : undefined,
          expressionProps: el.expressionProps ? [...el.expressionProps] : undefined,
          ...(el.block ? { block: { ...el.block } } : {}),
        };
      };

      const cloned = cloneRecursive(element, element.parentId);
      newElements.set(cloned.id, cloned);

      // Add to parent's children after the original
      if (element.parentId) {
        const parent = newElements.get(element.parentId);
        if (parent) {
          const originalIndex = parent.children.indexOf(id);
          const newChildren = [...parent.children];
          if (originalIndex === -1) {
            newChildren.push(cloned.id);
          } else {
            newChildren.splice(originalIndex + 1, 0, cloned.id);
          }
          newElements.set(element.parentId, { ...parent, children: newChildren });
        }
      }

      return { elements: newElements, selectedIds: [cloned.id] };
    });

    return newId;
  },

  wrapElement: (id, kind) => {
    const state = get();
    const element = state.elements.get(id);
    if (!element || !element.parentId || id === state.rootId) return null;
    // A continuation belongs to its block; wrapped, it would be an #else
    // inside an #if inside the #if it continues — a chain nothing prints.
    if (isContinuationType(element.componentType)) return null;
    const parent = state.elements.get(element.parentId);
    if (!parent) return null;

    const blockId = generateId();
    const block: CanvasBlock =
      kind === 'if' ? { kind: 'if', condition: 'true' } : { kind: 'each', iterable: 'items', itemName: 'item' };

    edit((current) => {
      const newElements = new Map(current.elements);
      newElements.set(blockId, {
        id: blockId,
        componentType: `#${kind}`,
        props: {},
        events: {},
        bindings: {},
        expressionProps: [],
        block,
        children: [id],
        parentId: parent.id,
      });
      newElements.set(parent.id, {
        ...parent,
        children: parent.children.map((cid) => (cid === id ? blockId : cid)),
      });
      newElements.set(id, { ...element, parentId: blockId });
      return { elements: newElements, selectedIds: [blockId] };
    });

    return blockId;
  },

  addBlockBranch: (blockId, kind) => {
    const state = get();
    const head = state.elements.get(blockId);
    if (!head?.block || !isBlockHead(head)) return null;
    if ((kind === 'empty') !== (head.block.kind === 'each')) return null;

    const branches = head.children
      .map((cid) => state.elements.get(cid))
      .filter((el): el is CanvasElement => el !== undefined && isContinuationType(el.componentType));
    if (kind !== 'elseif' && branches.some((el) => el.block?.kind === kind)) return null;

    const branchId = generateId();
    const block: CanvasBlock = kind === 'elseif' ? { kind: 'elseif', condition: 'true' } : { kind };

    edit((current) => {
      const newElements = new Map(current.elements);
      newElements.set(branchId, {
        id: branchId,
        componentType: `#${kind}`,
        props: {},
        events: {},
        bindings: {},
        expressionProps: [],
        block,
        children: [],
        parentId: blockId,
      });
      // An #elseif sits before the #else; any other branch goes last.
      const children = [...head.children];
      const elseIndex =
        kind === 'elseif' ? children.findIndex((cid) => newElements.get(cid)?.block?.kind === 'else') : -1;
      if (elseIndex === -1) children.push(branchId);
      else children.splice(elseIndex, 0, branchId);
      newElements.set(blockId, { ...head, children });
      return { elements: newElements, selectedIds: [branchId] };
    });

    return branchId;
  },

  unwrapBlock: (id) => {
    const state = get();
    const head = state.elements.get(id);
    if (!head?.block || !isBlockHead(head) || !head.parentId) return;
    const parent = state.elements.get(head.parentId);
    if (!parent) return;

    edit((current) => {
      const newElements = new Map(current.elements);
      const kept: string[] = [];
      const deleteRecursive = (elementId: string) => {
        const el = newElements.get(elementId);
        if (!el) return;
        el.children.forEach(deleteRecursive);
        newElements.delete(elementId);
      };
      for (const cid of head.children) {
        const child = newElements.get(cid);
        if (!child) continue;
        if (isContinuationType(child.componentType)) {
          deleteRecursive(cid);
        } else {
          kept.push(cid);
          newElements.set(cid, { ...child, parentId: parent.id });
        }
      }
      newElements.delete(id);
      newElements.set(parent.id, {
        ...parent,
        children: parent.children.flatMap((cid) => (cid === id ? kept : [cid])),
      });
      return {
        elements: newElements,
        selectedIds: current.selectedIds.includes(id)
          ? kept.slice(0, 1)
          : current.selectedIds.filter((sid) => newElements.has(sid)),
      };
    });
  },

  selectElement: (id, addToSelection = false) => {
    set((state) => {
      if (addToSelection) {
        if (state.selectedIds.includes(id)) {
          return { selectedIds: state.selectedIds.filter((sid) => sid !== id) };
        }
        return { selectedIds: [...state.selectedIds, id] };
      }
      return { selectedIds: [id] };
    });
  },

  deselectAll: () => {
    set({ selectedIds: [] });
  },

  selectMultiple: (ids) => {
    set({ selectedIds: ids });
  },

  setHoveredId: (id) => {
    set({ hoveredId: id });
  },

  copySelected: () => {
    const state = get();
    // An element selected together with something that holds it is copied
    // as part of that, not a second time on its own.
    const selected = new Set(state.selectedIds);
    const heldBySelected = (el: CanvasElement): boolean => {
      for (let parent = el.parentId; parent; parent = state.elements.get(parent)?.parentId ?? null) {
        if (selected.has(parent)) return true;
      }
      return false;
    };
    const clipboard = state.selectedIds
      .map((id) => state.elements.get(id))
      .filter((el): el is CanvasElement => el !== undefined && !heldBySelected(el));

    // Snapshot the descendants too. paste resolves children from this rather
    // than from the live map, so a cut cannot empty the clipboard out from
    // under itself: by paste time the originals are gone, every child lookup
    // returned undefined, and what came back was the element stripped of
    // everything it contained — a Card that arrived with no card in it.
    const clipboardTree = new Map<string, CanvasElement>();
    const collect = (el: CanvasElement) => {
      clipboardTree.set(el.id, el);
      for (const childId of el.children) {
        const child = state.elements.get(childId);
        if (child && !clipboardTree.has(childId)) collect(child);
      }
    };
    clipboard.forEach(collect);

    set({ clipboard, clipboardTree });
  },

  paste: (parentId) => {
    const state = get();
    if (state.clipboard.length === 0) return;

    const targetParentId = parentId || state.rootId;
    const newIds: string[] = [];

    edit((currentState) => {
      const newElements = new Map(currentState.elements);

      // Deep clone function to recursively clone element and children
      const deepCloneElement = (el: CanvasElement, newParentId: string): string => {
        const newId = generateId();

        // Recursively clone children first
        const clonedChildIds = el.children
          .map((childId) => {
            const child = currentState.clipboardTree.get(childId) ?? currentState.elements.get(childId);
            if (child) {
              return deepCloneElement(child, newId);
            }
            return null;
          })
          .filter((id): id is string => id !== null);

        const pastedElement: CanvasElement = {
          ...el,
          id: newId,
          parentId: newParentId,
          children: clonedChildIds,
          props: { ...el.props },
          events: el.events ? { ...el.events } : undefined,
          bindings: el.bindings ? { ...el.bindings } : undefined,
          expressionProps: el.expressionProps ? [...el.expressionProps] : undefined,
          ...(el.block ? { block: { ...el.block } } : {}),
        };

        newElements.set(newId, pastedElement);
        return newId;
      };

      currentState.clipboard.forEach((el) => {
        const newId = deepCloneElement(el, targetParentId);
        newIds.push(newId);

        // Add to parent
        const parent = newElements.get(targetParentId);
        if (parent) {
          newElements.set(targetParentId, {
            ...parent,
            children: [...parent.children, newId],
          });
        }
      });

      return { elements: newElements, selectedIds: newIds };
    });
  },

  cutSelected: () => {
    get().copySelected();
    const selectedIds = [...get().selectedIds];
    selectedIds.forEach((id) => get().deleteElement(id));
  },

  setDraggedType: (type) => {
    set({ draggedType: type });
  },

  setDropTargetId: (id) => {
    set({ dropTargetId: id });
  },

  setDraggedElementId: (id) => {
    set({ draggedElementId: id });
  },

  setDropIndicator: (indicator) => {
    set({ dropIndicator: indicator });
  },

  reset: () => {
    set({
      elements: new Map(initialElements),
      rootId: initialRootId,
      selectedIds: [],
      hoveredId: null,
      clipboard: [],
  clipboardTree: new Map(),
      draggedType: null,
      dropTargetId: null,
      draggedElementId: null,
      dropIndicator: null,
      imports: [],
    });
  },

  loadState: (elements, rootId, imports = []) => {
    debug('[canvasStore] loadState called:', {
      elementsSize: elements.size,
      rootId,
      rootElement: elements.get(rootId),
      imports: imports.length,
    });
    set({
      elements,
      rootId,
      selectedIds: [],
      hoveredId: null,
      clipboard: [],
  clipboardTree: new Map(),
      imports,
    });
  },

  getElement: (id) => {
    return get().elements.get(id);
  },

  getChildren: (id) => {
    const element = get().elements.get(id);
    if (!element) return [];
    return element.children
      .map((cid) => get().elements.get(cid))
      .filter((el): el is CanvasElement => el !== undefined);
  },

  getParent: (id) => {
    const element = get().elements.get(id);
    if (!element || !element.parentId) return undefined;
    return get().elements.get(element.parentId);
  },
});
});
