/**
 * Canvas - Main drop zone for visual drag-drop building
 */

import React, { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import { useFilesStore } from '../../stores/filesStore';
import { useSourceFidelity, summariseReasons } from '../../utils/useSourceFidelity';
import { CanvasElement } from './CanvasElement';
import { AppPage, DrawnThemeProvider } from './DrawnComponent';
import { DragLayer } from './DragLayer';
import { canDropInto, isPaletteType } from '../../utils/blocks';
import { redoCanvas, undoCanvas } from '../../utils/canvasHistory';
import { useDragAutoScroll } from '../../utils/dragScroll';
import { useDrawnTheme } from '../../utils/drawnTheme';
import { addDropped } from '../../utils/pageDrop';
import { pasteBySelection } from '../../utils/keyboardMoves';
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
  // The artboard: the frame the app's page is drawn in. The frame is the
  // editor's, as the area around it is; the page inside it is the app's, in
  // the project's theme (AppPage, and [data-builder-page] in builder.css).
  canvas: {
    minHeight: 'fit-content',
    borderRadius: 8,
    boxShadow: '0 1px 2px rgba(20, 24, 29, 0.08), 0 0 0 1px var(--line)',
    position: 'relative' as const,
  },
  canvasInner: {
    padding: 16,
    minHeight: 400,
    borderRadius: 8,
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 300,
    padding: 24,
    // Longhands: a drag over it changes the colour (see inlineStyleStates.test.ts).
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: 'var(--line-strong)',
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
  // The words of the sentence that open the panel it speaks of.
  emptyButton: {
    padding: 0,
    border: 'none',
    background: 'none',
    font: 'inherit',
    fontWeight: 600,
    color: 'var(--paper)',
    textDecoration: 'underline',
    textUnderlineOffset: 3,
    cursor: 'pointer',
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
  // Read by a screen reader, seen by nobody.
  announcement: {
    position: 'absolute',
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
};

interface CanvasProps {
  /**
   * Open the Components panel. Given only while that panel is shut (in a
   * narrow window it starts as a rail): the empty page then offers to open
   * it, where it used to say to drag from a panel that was not there.
   */
  onShowComponents?: () => void;
}

export function Canvas({ onShowComponents }: CanvasProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [focusedElementId, setFocusedElementId] = useState<string | null>(null);
  // The part of the canvas that scrolls, which a drag held at its edge moves.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useDragAutoScroll(scrollerRef);
  const drawnTheme = useDrawnTheme();

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

      // Use dropIndicator if available, otherwise append to root
      const indicator = state.dropIndicator;
      const parent = state.elements.get(indicator ? indicator.parentId : state.rootId);
      // What may hold what is asked here too: let go over the background,
      // a drag had nothing in its way.
      if (parent && canDropInto(parent, state.draggedType, { elements: state.elements })) {
        addDropped(state.draggedType, parent.id, indicator?.index, indicator?.side, () => useHistoryStore.getState().push(state.elements, state.rootId));
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
      const page = state.elements.get(state.rootId);

      // Only something the palette offers: whatever text was dragged in from
      // another window used to become an element called by that text.
      if (componentType && page && isPaletteType(componentType) && canDropInto(page, componentType, { elements: state.elements })) {
        const historyState = useHistoryStore.getState();

        // Save history before change
        historyState.push(state.elements, state.rootId);

        // Add the element to the root
        state.addElement(componentType, state.rootId, undefined, { starter: true });

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
    const mod = e.ctrlKey || e.metaKey;
    // As a small letter whatever Caps Lock says: with it on the keyboard
    // sends `Z`, and none of these were heard.
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (mod && key === 'a') {
      e.preventDefault();
      const allElementIds = Array.from(canvasState.elements.keys()).filter(
        (id) => id !== canvasState.rootId
      );
      canvasState.selectMultiple(allElementIds);
      return;
    }

    // Paste goes where the selection is, and to the end of the page with
    // nothing selected (utils/keyboardMoves.ts).
    if (mod && key === 'v') {
      e.preventDefault();
      pasteBySelection();
      return;
    }

    // Undo and redo, which need nothing selected. In the app the workspace
    // hears these first, wherever the focus is (useWorkspaceShortcuts).
    if (mod && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undoCanvas();
      return;
    }
    if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
      e.preventDefault();
      redoCanvas();
      return;
    }

    if (!hasSelection) return;

    // Delete selected elements
    if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault();
      historyState.push(canvasState.elements, canvasState.rootId);
      canvasState.selectedIds.forEach((id) => {
        if (id !== canvasState.rootId) {
          useCanvasStore.getState().deleteElement(id);
        }
      });
    }

    // Copy
    if (mod && key === 'c') {
      e.preventDefault();
      canvasState.copySelected();
    }

    // Paste
    // Cut
    if (mod && key === 'x') {
      e.preventDefault();
      historyState.push(canvasState.elements, canvasState.rootId);
      canvasState.cutSelected();
    }

    // Duplicate
    if (mod && key === 'd') {
      e.preventDefault();
      historyState.push(canvasState.elements, canvasState.rootId);
      canvasState.selectedIds.forEach((id) => {
        useCanvasStore.getState().duplicateElement(id);
      });
    }

  }, []);

  const dropIndicator = useCanvasStore((s) => s.dropIndicator);
  const announcement = useCanvasStore((s) => s.announcement);
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

  // Between two elements of the page, and in nobody's way: its margins
  // take back the room its height takes. In the flow it pushed the element
  // below it down, out from under a pointer held at that element's top
  // edge, which read as the pointer leaving and withdrew the place.
  const rootIndicatorLineStyle: React.CSSProperties = {
    height: 3,
    background: 'var(--coral)',
    borderRadius: 2,
    opacity: 0.8,
    marginTop: -1.5,
    marginBottom: -1.5,
    marginLeft: 4,
    marginRight: 4,
    position: 'relative',
    zIndex: 20,
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
      <div style={styles.canvasWrapper} ref={scrollerRef} data-canvas-scroller="">
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
          data-app-tokens={drawnTheme.tokens}
          role="tree"
          aria-label="Component canvas"
          aria-multiselectable="true"
        >
          {/* The app's theme for the components drawn as themselves: its
              tokens, written once and reached by an attribute, and which
              side of it each is drawn in. */}
          <DrawnThemeProvider theme={drawnTheme}>
          <AppPage style={styles.canvasInner}>
            {hasChildren ? (
              rootElement.children.map((childId, idx) => {
                const showLineBefore =
                  dropIndicator?.parentId === rootId && dropIndicator?.index === idx;
                const isLast = idx === rootElement.children.length - 1;
                const showLineAfter =
                  isLast && dropIndicator?.parentId === rootId && dropIndicator?.index === idx + 1;
                return (
                  <React.Fragment key={childId}>
                    {showLineBefore && <div style={rootIndicatorLineStyle} data-drop-line="" />}
                    <CanvasElement
                      elementId={childId}
                      focusedElementId={effectiveFocusedElementId}
                      onTreeFocusChange={setFocusedElementId}
                    />
                    {showLineAfter && <div style={rootIndicatorLineStyle} data-drop-line="" />}
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
                      {onShowComponents ? (
                        <>
                          <button type="button" style={styles.emptyButton} onClick={onShowComponents} data-action="show-components">
                            Open Components
                          </button>
                          , then drag one onto this page, or double-click it to add it here.
                        </>
                      ) : (
                        'Drag one from Components onto this page, or double-click it to add it here.'
                      )}{' '}
                      Pick anything you add to change its properties on the right.
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
          </AppPage>
          </DrawnThemeProvider>
        </div>
      </div>
      <DragLayer />
      {/* What a move made from the keyboard did, for a person who cannot
          see the canvas: read out, and not drawn. */}
      <div role="status" aria-live="polite" data-canvas-announcement="" style={styles.announcement}>
        {announcement}
      </div>
    </div>
  );
}
