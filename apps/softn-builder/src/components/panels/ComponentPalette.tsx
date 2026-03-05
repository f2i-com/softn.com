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
import type { ComponentMeta } from '../../types/builder';

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: 260,
    background: '#ffffff',
    borderRight: '1px solid #e2e8f0',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid #e2e8f0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontWeight: 700,
    fontSize: 14,
    color: '#0f172a',
    background: 'linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)',
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
  badge: {
    fontSize: 11,
    color: '#1d4ed8',
    background: '#dbeafe',
    borderRadius: 999,
    padding: '2px 8px',
    fontWeight: 700,
  },
  dockBtn: {
    border: '1px solid #cbd5e1',
    background: '#ffffff',
    color: '#64748b',
    borderRadius: 6,
    fontSize: 11,
    padding: '3px 7px',
    lineHeight: 1,
    cursor: 'pointer',
  },
  search: {
    padding: '8px 12px',
    borderBottom: '1px solid #e2e8f0',
  },
  searchInput: {
    width: '100%',
    padding: '9px 12px',
    border: '1px solid #cbd5e1',
    borderRadius: 8,
    fontSize: 13,
    outline: 'none',
    background: '#f8fafc',
  },
  list: {
    flex: 1,
    overflow: 'auto',
    padding: '8px 0',
  },
  category: {
    marginBottom: 4,
  },
  categoryHeader: {
    padding: '8px 16px',
    fontSize: 11,
    fontWeight: 700,
    color: '#475569',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  categoryChevron: {
    fontSize: 11,
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
  padding: '8px 10px',
  margin: '2px 0',
  borderRadius: 8,
  cursor: 'grab',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  color: '#0f172a',
  transition: 'all 0.15s',
  userSelect: 'none',
  border: '1px solid transparent',
};

const componentHoverStyle: React.CSSProperties = {
  background: '#f1f5f9',
};

const componentDraggingStyle: React.CSSProperties = {
  opacity: 0.55,
  background: '#dbeafe',
};

const iconChipStyle: React.CSSProperties = {
  width: 20,
  height: 20,
  borderRadius: 6,
  background: '#e2e8f0',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

interface ComponentItemProps {
  component: ComponentMeta;
}

function ComponentItem({ component }: ComponentItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const setDraggedType = useCanvasStore((state) => state.setDraggedType);
  const addElement = useCanvasStore((state) => state.addElement);
  const rootId = useCanvasStore((state) => state.rootId);
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
    addElement(component.name, rootId);
  }, [component.name, addElement, rootId]);

  const style: React.CSSProperties = {
    ...componentStyle,
    ...(isHovered ? componentHoverStyle : {}),
    ...(isDragging ? componentDraggingStyle : {}),
  };

  return (
    <div
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      style={style}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={`${component.description} (drag or double-click to add)`}
    >
      <span style={{ fontSize: 12, opacity: 0.7 }}>+</span>
      <span style={{ flex: 1 }}>{component.name}</span>
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
      <div style={styles.categoryHeader} onClick={onToggle}>
        <span>
          {category} <span style={{ opacity: 0.7 }}>({components.length})</span>
        </span>
        <span
          style={{
            ...styles.categoryChevron,
            ...(isExpanded ? styles.categoryChevronOpen : {}),
          }}
        >
          {'>'}
        </span>
      </div>

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
    new Set(['Layout', 'Form', 'Display'])
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

  const filteredComponents = searchQuery
    ? componentRegistry.filter(
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
          <span style={styles.badge}>{componentRegistry.length}</span>
        </div>
        <div style={styles.headerRight}>
          {onToggleDock && (
            <button style={styles.dockBtn} onClick={onToggleDock} title="Hide Components panel">
              Hide
            </button>
          )}
        </div>
      </div>

      <div style={styles.search}>
        <input
          type="text"
          placeholder="Search components..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={styles.searchInput}
        />
      </div>

      <div style={styles.list}>
        {filteredComponents ? (
          <div style={styles.componentList}>
            {filteredComponents.map((comp) => (
              <ComponentItem key={comp.name} component={comp} />
            ))}
            {filteredComponents.length === 0 && (
              <div style={{ padding: 16, color: '#94a3b8', fontSize: 13 }}>No components found</div>
            )}
          </div>
        ) : (
          categoryOrder.map((category) => {
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
          })
        )}
      </div>
    </div>
  );
}
