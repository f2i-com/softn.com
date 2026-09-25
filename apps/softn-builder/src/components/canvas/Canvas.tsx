/**
 * Canvas - Main drop zone for visual drag-drop building
 */

import React, { useCallback, useState, useEffect, useMemo } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import { useFilesStore } from '../../stores/filesStore';
import { useSourceFidelity, summariseReasons } from '../../utils/useSourceFidelity';
import { CanvasElement } from './CanvasElement';
import { DragLayer } from './DragLayer';
import { isDesktop } from '../../utils/desktop';
import { isHostedEditor } from '@softn/editor-shared/hostedEditor';

/** The finished example the site links into Builder, served beside it. */
export const EXAMPLE_BUNDLE_PATH = '/examples/Fieldnotes.softn';

const styles: Record<string, React.CSSProperties> = {
  // The chrome's ground around the artboard, so the canvas sits in the
  // workspace the way the preview's device frame does.
  container: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--ink-3)',
    overflow: 'hidden',
  },
  canvasWrapper: {
    flex: 1,
    overflow: 'auto',
    padding: 20,
    minHeight: 0, // Important for flex scroll
  },
  // The artboard: always paper, in either theme, and marked so builder.css
  // gives everything drawn on it the light tokens (see [data-builder-canvas]).
  canvas: {
    minHeight: 'fit-content',
    background: 'var(--ink-2)',
    color: 'var(--paper)',
    borderRadius: 8,
    boxShadow: '0 1px 2px rgba(20, 24, 29, 0.08), 0 0 0 1px var(--line)',
    position: 'relative' as const,
  },
  canvasInner: {
    padding: 16,
    minHeight: 400,
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 300,
    padding: 24,
    border: '1.5px dashed var(--line-strong)',
    borderRadius: 8,
    color: 'var(--dim)',
    fontSize: 13,
    lineHeight: 1.55,
    textAlign: 'center',
    margin: 16,
    transition: 'border-color 0.2s, background 0.2s',
  },
  emptyTitle: {
    fontFamily: 'var(--display)',
    fontSize: 17,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: 'var(--paper)',
  },
  emptyLink: {
    marginTop: 6,
    fontSize: 12.5,
    color: 'var(--paper)',
    textDecoration: 'underline',
    textUnderlineOffset: 3,
    textDecorationColor: 'var(--line-strong)',
  },
  // A drop target: the ink, not an accent.
  emptyDragOver: {
    borderColor: 'var(--paper)',
    background: 'var(--bl-select)',
    color: 'var(--paper)',
  },
  dropActive: {
    boxShadow: '0 0 0 2px var(--line-strong)',
  },
};

export function Canvas() {
  const [isDragOver, setIsDragOver] = useState(false);
  const [focusedElementId, setFocusedElementId] = useState<string | null>(null);

  const rootId = useCanvasStore((s) => s.rootId);
  const elements = useCanvasStore((s) => s.elements);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const rootElement = elements.get(rootId);
  const draggedType = useCanvasStore((s) => s.draggedType);
  const deselectAll = useCanvasStore((s) => s.deselectAll);
  const setDraggedType = useCanvasStore((s) => s.setDraggedType);

  // Whether the file this canvas shows can be written back from it. When it
  // cannot, the store keeps the source and refuses the edit; the creator is
  // told here rather than finding out at export.
  const activeFile = useFilesStore((s) => (s.activeFileId ? s.uiFiles.get(s.activeFileId) : undefined));
  const { fidelity, blocked } = useSourceFidelity(activeFile);
  const sourceOnly = fidelity !== null && !fidelity.lossless;

  // Fallback drop handler for the canvas background (appends to root)
  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const state = useCanvasStore.getState();
    if (state.draggedType) {
      e.preventDefault();
      e.stopPropagation();

      const historyState = useHistoryStore.getState();
      historyState.push(state.elements, state.rootId);

      // Use dropIndicator if available, otherwise append to root
      const indicator = state.dropIndicator;
      if (indicator) {
        state.addElement(state.draggedType, indicator.parentId, indicator.index);
      } else {
        state.addElement(state.draggedType, state.rootId);
      }
      state.setDraggedType(null);
      state.setDropIndicator(null);
    }
  }, []);

  // Track when dragging enters/leaves the canvas
  const handleMouseEnter = useCallback(() => {
    const state = useCanvasStore.getState();
    if (state.draggedType) {
      setIsDragOver(true);
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  // Clear local drag-over styling when drag ends (cleanup handled globally by ComponentPalette)
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      setIsDragOver(false);
    };
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      if (!isDragOver) {
        setIsDragOver(true);
      }
    },
    [isDragOver]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.stopPropagation();
    // Only set false if we're leaving the canvas entirely
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      // Get component type from store (primary) or fallback to dataTransfer
      const state = useCanvasStore.getState();
      const componentType = state.draggedType || e.dataTransfer.getData('text/plain');

      if (componentType) {
        const historyState = useHistoryStore.getState();

        // Save history before change
        historyState.push(state.elements, state.rootId);

        // Add the element to the root
        state.addElement(componentType, state.rootId);

        // Clear dragged type
        setDraggedType(null);
      }
    },
    [setDraggedType]
  );

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        deselectAll();
      }
    },
    [deselectAll]
  );

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const canvasState = useCanvasStore.getState();
    const historyState = useHistoryStore.getState();
    const hasSelection = canvasState.selectedIds.length > 0;

    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      const allElementIds = Array.from(canvasState.elements.keys()).filter(
        (id) => id !== canvasState.rootId
      );
      canvasState.selectMultiple(allElementIds);
      return;
    }

    // Paste can work with no selection (falls back to root).
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      e.preventDefault();
      historyState.push(canvasState.elements, canvasState.rootId);
      canvasState.paste(null);
      return;
    }

    if (!hasSelection) return;

    // Delete selected elements
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      historyState.push(canvasState.elements, canvasState.rootId);
      canvasState.selectedIds.forEach((id) => {
        if (id !== canvasState.rootId) {
          useCanvasStore.getState().deleteElement(id);
        }
      });
    }

    // Copy
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault();
      canvasState.copySelected();
    }

    // Paste
    // Cut
    if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
      e.preventDefault();
      historyState.push(canvasState.elements, canvasState.rootId);
      canvasState.cutSelected();
    }

    // Duplicate
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
      e.preventDefault();
      historyState.push(canvasState.elements, canvasState.rootId);
      canvasState.selectedIds.forEach((id) => {
        useCanvasStore.getState().duplicateElement(id);
      });
    }

    // Undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      const canvas = useCanvasStore.getState();
      const entry = historyState.undo({
        elements: canvas.elements,
        rootId: canvas.rootId,
        timestamp: Date.now(),
      });
      if (entry) {
        useCanvasStore.getState().loadState(entry.elements, entry.rootId);
      }
    }

    // Redo
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      const canvas = useCanvasStore.getState();
      const entry = historyState.redo({
        elements: canvas.elements,
        rootId: canvas.rootId,
        timestamp: Date.now(),
      });
      if (entry) {
        useCanvasStore.getState().loadState(entry.elements, entry.rootId);
      }
    }
  }, []);

  const dropIndicator = useCanvasStore((s) => s.dropIndicator);
  const hasChildren = rootElement && rootElement.children.length > 0;
  const visibleElementIds = useMemo(() => {
    if (!rootElement) return [];
    const visible: string[] = [];
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const element = elements.get(id);
      if (!element) return;
      visible.push(id);
      for (const childId of element.children) visit(childId);
    };
    for (const childId of rootElement.children) visit(childId);
    return visible;
  }, [elements, rootElement]);
  const effectiveFocusedElementId = visibleElementIds.includes(focusedElementId ?? '')
    ? focusedElementId
    : (selectedIds.find((id) => visibleElementIds.includes(id)) ?? visibleElementIds[0] ?? null);

  const rootIndicatorLineStyle: React.CSSProperties = {
    height: 3,
    background: 'var(--coral)',
    borderRadius: 2,
    opacity: 0.8,
    margin: '0 4px',
    pointerEvents: 'none',
  };

  return (
    <div style={styles.container}>
      {(sourceOnly || blocked) && (
        <div className="bl-notice" role="status" data-fidelity="source-only">
          {blocked
            ? `Not written back: this file has constructs the visual editor cannot write (${summariseReasons(blocked)}). Edit its source instead.`
            : `Source-only file: it has constructs the visual editor cannot write back (${summariseReasons(fidelity!.reasons)}). Canvas edits will not be saved; edit its source instead.`}
        </div>
      )}
      <div style={styles.canvasWrapper}>
        <div
          style={{
            ...styles.canvas,
            ...(isDragOver || draggedType ? styles.dropActive : {}),
          }}
          onClick={handleCanvasClick}
          onKeyDown={handleKeyDown}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onMouseUp={handleMouseUp}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          tabIndex={hasChildren ? undefined : 0}
          data-builder-canvas=""
          role="tree"
          aria-label="Component canvas"
          aria-multiselectable="true"
        >
          <div style={styles.canvasInner}>
            {hasChildren ? (
              rootElement.children.map((childId, idx) => {
                const showLineBefore =
                  dropIndicator?.parentId === rootId && dropIndicator?.index === idx;
                const isLast = idx === rootElement.children.length - 1;
                const showLineAfter =
                  isLast && dropIndicator?.parentId === rootId && dropIndicator?.index === idx + 1;
                return (
                  <React.Fragment key={childId}>
                    {showLineBefore && <div style={rootIndicatorLineStyle} />}
                    <CanvasElement
                      elementId={childId}
                      focusedElementId={effectiveFocusedElementId}
                      onTreeFocusChange={setFocusedElementId}
                    />
                    {showLineAfter && <div style={rootIndicatorLineStyle} />}
                  </React.Fragment>
                );
              })
            ) : (
              <div
                style={{
                  ...styles.empty,
                  ...(isDragOver ? styles.emptyDragOver : {}),
                }}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                {isDragOver ? (
                  'Drop to add it here'
                ) : (
                  <>
                    <span style={styles.emptyTitle}>Start with a component</span>
                    <span style={{ maxWidth: 360 }}>
                      Drag one from Components onto this page, or double-click it to add it here. Pick anything
                      you add to change its properties on the right.
                    </span>
                    {!isDesktop() && !isHostedEditor() && (
                      <a href={`?open=${encodeURIComponent(EXAMPLE_BUNDLE_PATH)}`} style={styles.emptyLink} data-action="open-example">
                        Or open a finished example to see how one is built
                      </a>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <DragLayer />
    </div>
  );
}
