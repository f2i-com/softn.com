/**
 * Canvas Store - Manages canvas elements, selection, and drag-drop state
 */

import { create } from 'zustand';
import type { CanvasElement, CanvasState, UIImport } from '../types/builder';
import { debug } from '../utils/debug';

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
  addElement: (type: string, parentId: string | null, index?: number) => string;
  updateElement: (id: string, updates: Partial<CanvasElement>) => void;
  updateElementProps: (id: string, props: Record<string, unknown>) => void;
  deleteElement: (id: string) => void;
  moveElement: (id: string, newParentId: string | null, index: number) => void;
  duplicateElement: (id: string) => string | null;

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
      props: { theme: 'light' },
      children: [],
      parentId: null,
    },
  ],
]);

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  elements: new Map(initialElements),
  rootId: initialRootId,
  selectedIds: [],
  hoveredId: null,
  clipboard: [],
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

  addElement: (type, parentId, index) => {
    const id = generateId();
    const parent = parentId || get().rootId;

    set((state) => {
      const newElements = new Map(state.elements);

      // Create new element
      const newElement: CanvasElement = {
        id,
        componentType: type,
        props: {},
        events: {},
        bindings: {},
        expressionProps: [],
        children: [],
        parentId: parent,
      };

      newElements.set(id, newElement);

      // Add to parent's children
      const parentElement = newElements.get(parent);
      if (parentElement) {
        const newChildren = [...parentElement.children];
        if (index !== undefined && index >= 0) {
          newChildren.splice(index, 0, id);
        } else {
          newChildren.push(id);
        }
        newElements.set(parent, { ...parentElement, children: newChildren });
      }

      return { elements: newElements, selectedIds: [id] };
    });

    return id;
  },

  updateElement: (id, updates) => {
    set((state) => {
      const element = state.elements.get(id);
      if (!element) return state;

      const newElements = new Map(state.elements);
      newElements.set(id, { ...element, ...updates });
      return { elements: newElements };
    });
  },

  updateElementProps: (id, props) => {
    set((state) => {
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

    set((state) => {
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

      // Update selection
      const newSelectedIds = state.selectedIds.filter((sid) => sid !== id);

      return { elements: newElements, selectedIds: newSelectedIds };
    });
  },

  moveElement: (id, newParentId, index) => {
    set((state) => {
      const element = state.elements.get(id);
      if (!element) return state;
      if (id === state.rootId) return state; // Cannot move root

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

      // Add to new parent
      const newParent = newElements.get(targetParentId);
      if (newParent) {
        const newChildren = [...newParent.children];
        newChildren.splice(index, 0, id);
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

    set((state) => {
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
    const clipboard = state.selectedIds
      .map((id) => state.elements.get(id))
      .filter((el): el is CanvasElement => el !== undefined);
    set({ clipboard });
  },

  paste: (parentId) => {
    const state = get();
    if (state.clipboard.length === 0) return;

    const targetParentId = parentId || state.rootId;
    const newIds: string[] = [];

    set((currentState) => {
      const newElements = new Map(currentState.elements);

      // Deep clone function to recursively clone element and children
      const deepCloneElement = (el: CanvasElement, newParentId: string): string => {
        const newId = generateId();

        // Recursively clone children first
        const clonedChildIds = el.children
          .map((childId) => {
            const child = currentState.elements.get(childId);
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
}));
