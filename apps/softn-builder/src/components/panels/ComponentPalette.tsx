/**
 * ComponentPalette - Left sidebar with draggable components
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  componentRegistry,
  getComponentsByCategory,
  categoryOrder,
} from '../../utils/componentRegistry';
import { TokenIcon } from '../icons/TokenIcon';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import { blockPalette } from '../../utils/blocks';
import type { ComponentMeta } from '../../types/builder';

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: 260,
    background: 'var(--ink-2)',
    borderRight: '1px solid var(--line-soft)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--line-soft)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontFamily: 'var(--display)',
    fontWeight: 700,
    fontSize: 14,
    letterSpacing: '-0.01em',
    color: 'var(--paper)',
    background: 'var(--ink-2)',
    gap: 8,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  search: {
    padding: '8px 12px',
    borderBottom: '1px solid var(--line-soft)',
  },
  searchInput: {
    width: '100%',
    padding: '8px 10px',
    borderRadius: 8,
    fontSize: 13,
  },
  searchHint: {
    marginTop: 6,
    fontSize: 11.5,
    lineHeight: 1.4,
    color: 'var(--dim)',
  },
  list: {
    flex: 1,
    overflow: 'auto',
    padding: '8px 0',
  },
  category: {
    marginBottom: 4,
  },
  // A section inside the panel: small and dim, in sentence case.
  categoryHeader: {
    width: '100%',
    padding: '8px 16px',
    border: 'none',
    background: 'transparent',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--dim)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    textAlign: 'left',
  },
  categoryChevron: {
    fontSize: 13,
    lineHeight: 1,
    transition: 'transform 0.2s',
  },
  categoryChevronOpen: {
    transform: 'rotate(90deg)',
  },
  componentList: {
    padding: '0 8px',
  },
};

const componentStyle: React.CSSProperties = {
  padding: '6px 10px',
  margin: '1px 0',
  borderRadius: 6,
  cursor: 'grab',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  color: 'var(--paper)',
  transition: 'background 0.15s',
  userSelect: 'none',
  border: '1px solid transparent',
};

const componentHoverStyle: React.CSSProperties = {
  background: 'var(--bl-hover)',
};

const componentDraggingStyle: React.CSSProperties = {
  opacity: 0.55,
  background: 'var(--bl-select)',
  borderStyle: 'dashed',
  borderColor: 'var(--line-strong)',
};

const iconChipStyle: React.CSSProperties = {
  width: 20,
  height: 20,
  borderRadius: 6,
  background: 'var(--line-soft)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

interface ComponentItemProps {
  component: ComponentMeta;
}

/**
 * Add a component at the end of the page, as one undoable step, and select
 * it so its properties are in front of the creator. What a double-click and
 * Enter on a palette item do; a double-click used to add without recording
 * a step, so Undo could not take it back.
 */
export function insertFromPalette(type: string): string {
  const canvas = useCanvasStore.getState();
  useHistoryStore.getState().push(canvas.elements, canvas.rootId);
  const id = canvas.addElement(type, canvas.rootId);
  useCanvasStore.getState().selectElement(id);
  return id;
}

function ComponentItem({ component }: ComponentItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const setDraggedType = useCanvasStore((state) => state.setDraggedType);
  const draggedType = useCanvasStore((state) => state.draggedType);

  const isDragging = draggedType === component.name;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      let dragActivated = false;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (dragActivated) return;
        const deltaX = Math.abs(moveEvent.clientX - startX);
        const deltaY = Math.abs(moveEvent.clientY - startY);
        if (deltaX + deltaY >= 5) {
          dragActivated = true;
          setDraggedType(component.name);
        }
      };

      const handleMouseUp = () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [component.name, setDraggedType]
  );

  const handleDoubleClick = useCallback(() => {
    insertFromPalette(component.name);
  }, [component.name]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        insertFromPalette(component.name);
      }
    },
    [component.name]
  );

  const style: React.CSSProperties = {
    ...componentStyle,
    ...(isHovered ? componentHoverStyle : {}),
    ...(isDragging ? componentDraggingStyle : {}),
  };

  return (
    <div
      role="button"
      tabIndex={0}
      data-palette-item={component.name}
      aria-label={`Add ${component.name}`}
      aria-description={component.description}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      style={style}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={`${component.description} — drag onto the canvas, or double-click to add`}
    >
      <span style={{ flex: 1, fontFamily: component.name.startsWith('#') ? 'var(--mono)' : undefined, color: component.name.startsWith('#') ? 'var(--coral)' : undefined }}>
        {component.name}
      </span>
      <span style={iconChipStyle}>
        <TokenIcon token={component.icon} size={12} />
      </span>
    </div>
  );
}

interface CategorySectionProps {
  category: string;
  components: ComponentMeta[];
  isExpanded: boolean;
  onToggle: () => void;
}

function CategorySection({ category, components, isExpanded, onToggle }: CategorySectionProps) {
  return (
    <div style={styles.category}>
      <button type="button" style={styles.categoryHeader} onClick={onToggle} aria-expanded={isExpanded}>
        <span>
          {category} <span style={{ color: 'var(--dimmer)', fontWeight: 400 }}>{components.length}</span>
        </span>
        <span
          aria-hidden="true"
          style={{
            ...styles.categoryChevron,
            ...(isExpanded ? styles.categoryChevronOpen : {}),
          }}
        >
          ›
        </span>
      </button>

      {isExpanded && (
        <div style={styles.componentList}>
          {components.map((comp) => (
            <ComponentItem key={comp.name} component={comp} />
          ))}
        </div>
      )}
    </div>
  );
}

interface ComponentPaletteProps {
  onToggleDock?: () => void;
}

export function ComponentPalette({ onToggleDock }: ComponentPaletteProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(['Control flow', 'Layout', 'Form', 'Display'])
  );
  const componentsByCategory = useMemo(() => getComponentsByCategory(), []);

  // Ensure drag visuals always clear even if mouseup happens outside canvas.
  // Uses requestAnimationFrame to defer cleanup by one frame so React mouseup
  // handlers on canvas elements fire first.
  useEffect(() => {
    const handleWindowMouseUp = () => {
      requestAnimationFrame(() => {
        const s = useCanvasStore.getState();
        if (s.draggedType) s.setDraggedType(null);
        if (s.draggedElementId) s.setDraggedElementId(null);
        if (s.dropIndicator) s.setDropIndicator(null);
      });
    };
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => window.removeEventListener('mouseup', handleWindowMouseUp);
  }, []);

  const toggleCategory = (category: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  // The two blocks a creator can start with sit in the palette beside the
  // components: dragged and dropped the same way, and an element dropped
  // into one becomes its branch. Their alternate branches (#elseif, #else,
  // #empty) are added from the block's properties, not from here.
  const filteredComponents = searchQuery
    ? [...blockPalette, ...componentRegistry].filter(
        (c) =>
          c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.description.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : null;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span>Components</span>
          <span className="bl-badge">{componentRegistry.length}</span>
        </div>
        <div style={styles.headerRight}>
          {onToggleDock && (
            <button className="bl-mini" onClick={onToggleDock} title="Hide the components panel" aria-label="Hide components panel">
              Hide
            </button>
          )}
        </div>
      </div>

      <div style={styles.search}>
        <input
          type="search"
          placeholder="Search components…"
          aria-label="Search components"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={styles.searchInput}
        />
        <div style={styles.searchHint}>Drag onto the canvas, or double-click (or press Enter) to add at the end.</div>
      </div>

      <div style={styles.list}>
        {filteredComponents ? (
          <div style={styles.componentList}>
            {filteredComponents.map((comp) => (
              <ComponentItem key={comp.name} component={comp} />
            ))}
            {filteredComponents.length === 0 && (
              <div style={{ padding: '12px 8px', color: 'var(--dim)', fontSize: 13 }} role="status">
                Nothing matches “{searchQuery}”. Try a shorter word, like “form” or “list”.
              </div>
            )}
          </div>
        ) : (
          <>
            <CategorySection
              category="Control flow"
              components={blockPalette}
              isExpanded={expandedCategories.has('Control flow')}
              onToggle={() => toggleCategory('Control flow')}
            />
            {categoryOrder.map((category) => {
              const components = componentsByCategory.get(category) || [];
              if (components.length === 0) return null;

              return (
                <CategorySection
                  key={category}
                  category={category}
                  components={components}
                  isExpanded={expandedCategories.has(category)}
                  onToggle={() => toggleCategory(category)}
                />
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
