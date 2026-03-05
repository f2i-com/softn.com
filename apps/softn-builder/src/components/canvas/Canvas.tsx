/**
 * Canvas - Main drop zone for visual drag-drop building
 */

import React, { useCallback, useState, useEffect } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import { CanvasElement } from './CanvasElement';
import { DragLayer } from './DragLayer';

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: '#f8f9fa',
    overflow: 'hidden',
  },
  canvasWrapper: {
    flex: 1,
    overflow: 'auto',
    padding: 20,
    minHeight: 0, // Important for flex scroll
  },
  canvas: {
    minHeight: 'fit-content',
    background: '#fff',
    borderRadius: 8,
    boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
    position: 'relative' as const,
  },
  canvasInner: {
    padding: 16,
    minHeight: 400,
  },
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 300,
    border: '2px dashed #ddd',
    borderRadius: 8,
    color: '#999',
    fontSize: 14,
    margin: 16,
    transition: 'all 0.2s',
  },
  emptyDragOver: {
    borderColor: '#3b82f6',
    background: '#eff6ff',
    color: '#3b82f6',
  },
  dropActive: {
    background: '#e8f4ff',
  },
};

export function Canvas() {
  const [isDragOver, setIsDragOver] = useState(false);

  const rootId = useCanvasStore(s => s.rootId);
  const rootElement = useCanvasStore(s => s.elements.get(s.rootId));
  const draggedType = useCanvasStore(s => s.draggedType);
  const deselectAll = useCanvasStore(s => s.deselectAll);
  const setDraggedType = useCanvasStore(s => s.setDraggedType);

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
      const allElementIds = Array.from(canvasState.elements.keys()).filter((id) => id !== canvasState.rootId);
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
      const entry = historyState.undo();
      if (entry) {
        useCanvasStore.getState().loadState(entry.elements, entry.rootId);
      }
    }

    // Redo
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      const entry = historyState.redo();
      if (entry) {
        useCanvasStore.getState().loadState(entry.elements, entry.rootId);
      }
    }
  }, []);

  const dropIndicator = useCanvasStore((s) => s.dropIndicator);
  const hasChildren = rootElement && rootElement.children.length > 0;

  const rootIndicatorLineStyle: React.CSSProperties = {
    height: 3,
    background: '#3b82f6',
    borderRadius: 2,
    opacity: 0.8,
    margin: '0 4px',
    pointerEvents: 'none',
  };

  return (
    <div style={styles.container}>
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
          tabIndex={0}
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
                    <CanvasElement elementId={childId} />
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
                {isDragOver
                  ? 'Drop here to add component'
                  : 'Drag components here to start building'}
              </div>
            )}
          </div>
        </div>
      </div>
      <DragLayer />
    </div>
  );
}
