/**
 * CanvasElement - Draggable wrapper for components on the canvas
 */

import React, { useCallback, useState, useEffect, useRef, useMemo } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import { useProjectStore } from '../../stores/projectStore';
import { useFilesStore } from '../../stores/filesStore';
import { SelectionBox } from './SelectionBox';
import { getComponentMeta } from '../../utils/componentRegistry';
import { TokenIcon } from '../icons/TokenIcon';
import type { CanvasElement as CanvasElementType } from '../../types/builder';

// Helper to check if dropping is allowed
function canDropOn(targetType: string, draggedType: string | null): boolean {
  const targetMeta = getComponentMeta(targetType);
  if (!targetMeta?.allowChildren) return false;

  // If target has specific childTypes, check if dragged type is allowed
  if (targetMeta.childTypes && targetMeta.childTypes.length > 0 && draggedType) {
    return targetMeta.childTypes.includes(draggedType);
  }

  return true;
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
}

function resolveRelativePath(fromPath: string, relativePath: string): string {
  const parts = fromPath.split('/');
  parts.pop();
  const dir = parts;

  for (const part of relativePath.split('/')) {
    if (part === '..') {
      dir.pop();
    } else if (part !== '.') {
      dir.push(part);
    }
  }

  return dir.join('/');
}

function parseStringLikeVariables(logicSource: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = logicSource.split(/\r?\n/);

  for (const line of lines) {
    const m = line.match(/^\s*(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?)\s*;?\s*$/);
    if (!m) continue;

    const varName = m[1];
    const expr = m[2].trim();
    if (!expr) continue;

    try {
      const ctxKeys = Object.keys(values);
      const ctxVals = ctxKeys.map((k) => values[k]);
      const fn = new Function(
        ...ctxKeys,
        'encodeURIComponent',
        'decodeURIComponent',
        `return (${expr});`
      ) as (...args: unknown[]) => unknown;
      const result = fn(...ctxVals, encodeURIComponent, decodeURIComponent);
      if (typeof result === 'string') {
        values[varName] = result;
      }
    } catch {
      // Skip expressions we can't safely/easily evaluate in design preview.
    }
  }

  return values;
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
    borderColor: '#94a3b8',
    background: 'rgba(148, 163, 184, 0.05)',
  },
  selected: {
    borderColor: '#3b82f6',
    background: 'rgba(59, 130, 246, 0.05)',
  },
  dragging: {
    opacity: 0.5,
  },
  dragOver: {
    borderColor: '#3b82f6',
    background: 'rgba(59, 130, 246, 0.1)',
  },
  label: {
    position: 'absolute' as const,
    top: -10,
    left: 8,
    fontSize: 10,
    fontWeight: 500,
    color: '#3b82f6',
    background: '#fff',
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
    borderColor: '#e2e8f0',
    marginTop: 8,
    transition: 'all 0.2s',
  },
  childrenEmpty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#94a3b8',
    fontSize: 11,
    padding: 16,
  },
  childrenDragOver: {
    borderColor: '#3b82f6',
    background: 'rgba(59, 130, 246, 0.05)',
  },
  notAllowed: {
    cursor: 'not-allowed',
  },
  content: {
    pointerEvents: 'none' as const,
  },
};

export const CanvasElement = React.memo(function CanvasElement({ elementId, depth = 0 }: Props) {
  // Fine-grained store selectors — only re-renders when this element's own state changes.
  const element = useCanvasStore(s => s.elements.get(elementId));
  const isSelected = useCanvasStore(s => s.selectedIds.includes(elementId));
  const isHovered = useCanvasStore(s => s.hoveredId === elementId);
  const isDragging = useCanvasStore(s => s.draggedElementId === elementId);
  const draggedType = useCanvasStore(s => s.draggedType);
  const draggedElementId = useCanvasStore(s => s.draggedElementId);
  const selectElement = useCanvasStore(s => s.selectElement);
  const setHoveredId = useCanvasStore(s => s.setHoveredId);
  const setDraggedElementId = useCanvasStore(s => s.setDraggedElementId);

  const meta = element ? getComponentMeta(element.componentType) : null;
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const assets = useProjectStore((state) => state.assets);
  const projectLogicSource = useProjectStore((state) => state.logicSource);
  const { activeFileId, nodes, uiFiles, logicFiles } = useFilesStore((state) => ({
    activeFileId: state.activeFileId,
    nodes: state.nodes,
    uiFiles: state.uiFiles,
    logicFiles: state.logicFiles,
  }));

  const activeNode = activeFileId ? nodes.get(activeFileId) : null;
  const activeUIFile =
    activeFileId && activeNode?.fileType === 'ui' ? uiFiles.get(activeFileId) : undefined;

  const linkedLogicSource = React.useMemo(() => {
    if (!activeUIFile?.logicSrc) {
      return projectLogicSource;
    }

    const sourcePath = activeUIFile.logicSrc;
    const resolvedPath = resolveRelativePath(activeUIFile.path, sourcePath);
    const pathsToTry = [
      resolvedPath,
      resolvedPath.replace(/^\//, ''),
      sourcePath.replace(/^\.\//, ''),
      sourcePath,
    ];

    if (activeUIFile.path.startsWith('ui/') && sourcePath.startsWith('./')) {
      pathsToTry.push(`logic/${sourcePath.slice(2)}`);
    }

    for (const [, logicFile] of logicFiles) {
      if (pathsToTry.includes(logicFile.path)) {
        return logicFile.content;
      }
    }

    return projectLogicSource;
  }, [activeUIFile, logicFiles, projectLogicSource]);

  const resolvedLogicStrings = React.useMemo(
    () => parseStringLikeVariables(linkedLogicSource || ''),
    [linkedLogicSource]
  );

  // Check if this element can accept the current drag (reads from store directly for fresh state)
  const canAcceptDrop = useCallback(() => {
    if (!meta?.allowChildren || !element) return false;

    const state = useCanvasStore.getState();

    // Check for palette component
    if (state.draggedType) {
      return canDropOn(element.componentType, state.draggedType);
    }

    // Check for canvas element
    if (state.draggedElementId) {
      // Can't drop on self
      if (state.draggedElementId === elementId) return false;

      // Can't drop on descendants
      if (isDescendantOf(state.elements, elementId, state.draggedElementId)) return false;

      const draggedElement = state.elements.get(state.draggedElementId);
      if (draggedElement) {
        return canDropOn(element.componentType, draggedElement.componentType);
      }
    }

    return false;
  }, [meta?.allowChildren, element?.componentType, elementId]);

  // Ref for the wrapper div (used for drop position tracking)
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Track mouse position during drag to compute insertion position
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || !element) return;

    const handleMouseMove = (e: MouseEvent) => {
      const state = useCanvasStore.getState();
      if (!state.draggedType && !state.draggedElementId) return;

      // Don't show indicator on the element being dragged
      if (state.draggedElementId === elementId) return;

      const rect = el.getBoundingClientRect();
      const relativeY = (e.clientY - rect.top) / rect.height;
      const allowsChildren = meta?.allowChildren ?? false;

      const parentId = element.parentId;
      if (!parentId) return;

      const parentElement = state.elements.get(parentId);
      if (!parentElement) return;
      const myIndex = parentElement.children.indexOf(elementId);
      if (myIndex === -1) return;

      let indicator: { parentId: string; index: number };

      if (allowsChildren) {
        // Container: top 25% = before, middle 50% = into, bottom 25% = after
        if (relativeY < 0.25) {
          indicator = { parentId, index: myIndex };
        } else if (relativeY > 0.75) {
          indicator = { parentId, index: myIndex + 1 };
        } else {
          // Drop into this container
          const el = state.elements.get(elementId);
          indicator = { parentId: elementId, index: el?.children.length ?? 0 };
        }
      } else {
        // Leaf: top 50% = before, bottom 50% = after
        if (relativeY < 0.5) {
          indicator = { parentId, index: myIndex };
        } else {
          indicator = { parentId, index: myIndex + 1 };
        }
      }

      // Only update if changed
      const current = state.dropIndicator;
      if (!current || current.parentId !== indicator.parentId || current.index !== indicator.index) {
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
  }, [elementId, element?.parentId, meta?.allowChildren]);

  // Mouse-based drag start for moving existing elements
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Start drag only after small pointer movement threshold.
      if (e.button !== 0) return;

      const state = useCanvasStore.getState();
      if (state.draggedType || state.draggedElementId) return;

      // Don't start drag if clicking on children area
      const target = e.target as HTMLElement;
      if (target.closest('[data-children-area]')) return;

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
        const historyState = useHistoryStore.getState();
        historyState.push(state.elements, state.rootId);
        state.addElement(state.draggedType, indicator.parentId, indicator.index);
        state.setDraggedType(null);
        state.setDropIndicator(null);
        return;
      }

      // Move an existing canvas element
      if (state.draggedElementId && state.draggedElementId !== elementId && indicator) {
        e.stopPropagation();
        const historyState = useHistoryStore.getState();
        historyState.push(state.elements, state.rootId);
        state.moveElement(state.draggedElementId, indicator.parentId, indicator.index);
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
    if (!element || element.componentType !== 'Image') {
      setImagePreviewUrl(null);
      return;
    }

    const src = String(element.props.src || '').trim();
    if (!src) {
      setImagePreviewUrl(null);
      return;
    }

    let resolvedSrc = src;
    const isExpressionSrc = element.expressionProps?.includes('src');
    if (isExpressionSrc && resolvedLogicStrings[src]) {
      resolvedSrc = resolvedLogicStrings[src];
    }

    if (/^(https?:|data:|blob:)/i.test(resolvedSrc)) {
      setImagePreviewUrl(resolvedSrc);
      return;
    }

    const normalizedSrc = resolvedSrc
      .replace(/^\.?\//, '')
      .replace(/^assets\//, '');

    const matchedAsset = assets.find((a) => {
      const name = a.name.replace(/^assets\//, '');
      return name === normalizedSrc || name.endsWith(`/${normalizedSrc}`);
    });

    if (!matchedAsset) {
      setImagePreviewUrl(null);
      return;
    }

    const objectUrl = URL.createObjectURL(
      new Blob([Uint8Array.from(matchedAsset.data)], {
        type: matchedAsset.type || 'application/octet-stream',
      })
    );
    setImagePreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [element?.componentType, element?.props.src, element?.expressionProps, assets, resolvedLogicStrings]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setDraggedElementId(null);
      selectElement(elementId, e.shiftKey);
    },
    [elementId, selectElement, setDraggedElementId]
  );

  // Drop indicator state
  const dropIndicator = useCanvasStore((s) => s.dropIndicator);
  const { showLineBefore, showLineAfter, showDropInto } = useMemo(() => {
    if (!element) return { showLineBefore: false, showLineAfter: false, showDropInto: false };
    const parent = element.parentId ? useCanvasStore.getState().elements.get(element.parentId) : null;
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

  // Render component preview
  const renderComponentPreview = () => {
    const { componentType, props } = element;

    switch (componentType) {
      case 'Button':
        return (
          <button
            style={{
              padding: '8px 16px',
              borderRadius: 4,
              border: 'none',
              background: props.variant === 'secondary' ? '#e2e8f0' : '#3b82f6',
              color: props.variant === 'secondary' ? '#1e293b' : '#fff',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            {(props.children as string) || 'Button'}
          </button>
        );

      case 'Input':
        return (
          <input
            type="text"
            placeholder={(props.placeholder as string) || 'Input'}
            style={{
              padding: '8px 12px',
              borderRadius: 4,
              border: '1px solid #e2e8f0',
              fontSize: 14,
              width: '100%',
            }}
            readOnly
          />
        );

      case 'TextArea':
        return (
          <textarea
            placeholder={(props.placeholder as string) || 'TextArea'}
            style={{
              padding: '8px 12px',
              borderRadius: 4,
              border: '1px solid #e2e8f0',
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
          <span style={{ fontSize: 14, color: '#1e293b' }}>
            {(props.children as string) || 'Text'}
          </span>
        );

      case 'Heading': {
        const HeadingTag = `h${props.level || 1}` as keyof JSX.IntrinsicElements;
        return (
          <HeadingTag style={{ margin: 0, fontSize: props.level === 1 ? 24 : 18 }}>
            {(props.children as string) || 'Heading'}
          </HeadingTag>
        );
      }

      case 'Card':
        return (
          <div
            style={{
              padding: 16,
              borderRadius: 8,
              background: '#fff',
              boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
              border: '1px solid #e2e8f0',
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
              background: '#f8fafc',
              borderRadius: 4,
              minHeight: 40,
            }}
          >
            {/* Children rendered separately */}
          </div>
        );

      case 'Box':
        return (
          <div
            style={{
              padding: 12,
              background: '#f8fafc',
              borderRadius: 4,
              minHeight: 40,
            }}
          />
        );

      case 'Image':
        return (
          <div
            style={{
              width: '100%',
              minHeight: 100,
              background: '#f8fafc',
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#64748b',
              fontSize: 12,
              overflow: 'hidden',
              border: '1px solid #e2e8f0',
            }}
          >
            {imagePreviewUrl ? (
              <img
                src={imagePreviewUrl}
                alt={(props.alt as string) || 'Image'}
                style={{ maxWidth: '100%', maxHeight: 180, objectFit: 'contain' }}
              />
            ) : props.src ? (
              `Missing image source: ${String(props.src)}`
            ) : (
              'No image'
            )}
          </div>
        );

      case 'Alert': {
        const alertBorderColor =
          props.variant === 'error'
            ? '#fecaca'
            : props.variant === 'success'
              ? '#bbf7d0'
              : props.variant === 'warning'
                ? '#fde68a'
                : '#bfdbfe';
        return (
          <div
            style={{
              padding: '12px 16px',
              borderRadius: 4,
              background:
                props.variant === 'error'
                  ? '#fef2f2'
                  : props.variant === 'success'
                    ? '#f0fdf4'
                    : props.variant === 'warning'
                      ? '#fffbeb'
                      : '#eff6ff',
              border: `1px solid ${alertBorderColor}`,
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
                background: 'linear-gradient(135deg, #ede9fe 0%, #ddd6fe 100%)',
                borderRadius: 6,
                border: '1px dashed #8b5cf6',
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
                    color: '#6d28d9',
                    fontWeight: 600,
                  }}
                >
                  {componentType}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: '#8b5cf6',
                    background: '#fff',
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
                  color: '#7c3aed',
                  opacity: 0.8,
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
              background: '#f8fafc',
              borderRadius: 6,
              border: '1px solid #e2e8f0',
              fontSize: 12,
              color: '#334155',
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
                  background: '#e2e8f0',
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
              <span style={{ color: '#64748b', fontSize: 11 }}>{componentMeta.description}</span>
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
    background: '#3b82f6',
    borderRadius: 2,
    opacity: 0.8,
    pointerEvents: 'none',
    zIndex: 20,
  };

  return (
    <div ref={wrapperRef} style={styles.wrapper}>
      {showLineBefore && (
        <div style={{ ...indicatorLineStyle, top: -2 }} />
      )}
      <div
        style={containerStyle}
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {(isSelected || isHovered) && (
          <span style={styles.label}>
            {element.componentType}
            {showDropInto && ' (drop here)'}
          </span>
        )}

        <div style={styles.content}>{renderComponentPreview()}</div>

        {meta?.allowChildren && (
          <div style={childrenStyle} data-children-area="true">
            {element.children.length > 0 ? (
              element.children.map((childId) => (
                <CanvasElement key={childId} elementId={childId} depth={depth + 1} />
              ))
            ) : (
              <div style={styles.childrenEmpty}>
                {showDropInto ? 'Release to drop here' : 'Drop children here'}
              </div>
            )}
          </div>
        )}

        {isSelected && <SelectionBox element={element} />}
      </div>
      {showLineAfter && (
        <div style={{ ...indicatorLineStyle, bottom: -2 }} />
      )}
    </div>
  );
});
