/**
 * ComponentPalette - Left sidebar with draggable components
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  paletteComponents,
  getComponentsByCategory,
  categoryOrder,
} from '../../utils/componentRegistry';
import { TokenIcon } from '../icons/TokenIcon';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import { blockPalette } from '../../utils/blocks';
import { placeBySelection } from '../../utils/keyboardMoves';
import { addDropped } from '../../utils/pageDrop';
import { importableFor, pageDragType, type Importable } from '../../utils/pageImports';
import { useFilesStore } from '../../stores/filesStore';
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
  // Longhands, as the dragged state below changes two of them: set as the
  // `border` shorthand, React cleared those two when the drag ended and left
  // the item with no border style at all.
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'transparent',
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
 * Add a component where the selection is, as one undoable step, and select
 * it so its properties are in front of the creator: into the selected
 * element when that takes it, after it when it does not, and at the end of
 * the page when nothing is selected (utils/keyboardMoves.ts). What a
 * double-click and Enter on a palette item do. It used to be the end of
 * the page every time, so nothing could be put inside a container without
 * a drag; and a double-click used to add without recording a step, so Undo
 * could not take it back.
 */
export function insertFromPalette(type: string): string | null {
  const canvas = useCanvasStore.getState();
  // What was added last is still the selection, untouched: the next thing asked for is the
  // next element. A container added that way takes it, which is how a page is built without
  // a mouse (Stack, Card, Heading). A line of words added that way does not take it among
  // its words: Text and then Badge are two elements, as they were asked for, where a Badge
  // inside the Text is what picking the Text oneself and then adding the Badge says.
  const chained = selectionLeftByInsert !== null && canvas.selectedIds === selectionLeftByInsert;
  // Nowhere takes another page; a container that holds one kind is passed by.
  const place = placeBySelection(type, { besideWords: chained });
  if (!place) return null;
  // A page of the project is added by the name this page uses it by, with
  // its import; one the page cannot use is refused, and said why.
  const id = addDropped(type, place.parentId, place.index, place.side, () => useHistoryStore.getState().push(canvas.elements, canvas.rootId));
  if (id === null) return null;
  useCanvasStore.getState().selectElement(id);
  selectionLeftByInsert = useCanvasStore.getState().selectedIds;
  return id;
}

/**
 * Put the focus on an element of the canvas, once it has been drawn there.
 *
 * For what a double-click adds. The press that began it left the focus
 * where it was, which after a search is the search field: Delete, Ctrl+Z
 * and Alt+Shift with an arrow were then the field's own, and edited the
 * search while the element just added sat selected on the canvas. On the
 * element itself every key of the canvas is heard, and the search is not
 * touched. Enter on a row leaves the focus on the row: a page is built from
 * the keyboard by pressing it on one row after another.
 */
function focusOnCanvas(id: string | null): void {
  if (id === null || typeof document === 'undefined') return;
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-canvas-element-id="${id}"]`)?.focus({ preventScroll: false });
  });
}

/**
 * Delete what is selected on the canvas, as one step for Undo. For Delete
 * pressed on a row of the palette, where the focus is after Enter added
 * something: the canvas hears that key only while the focus is in it.
 */
function deleteSelection(): boolean {
  const canvas = useCanvasStore.getState();
  const ids = canvas.selectedIds.filter((id) => id !== canvas.rootId && canvas.elements.has(id));
  if (ids.length === 0) return false;
  useHistoryStore.getState().push(canvas.elements, canvas.rootId);
  for (const id of ids) useCanvasStore.getState().deleteElement(id);
  return true;
}

/**
 * The selection as the last insert left it. The store makes a new list
 * whenever the selection is set, so this being the list that is selected
 * now says nobody has picked anything since, the same element included.
 */
let selectionLeftByInsert: readonly string[] | null = null;

/**
 * A press on a row of the palette: `type` is dragged once the pointer has
 * moved five pixels with the button down. Less than that is a click, or the
 * first half of a double-click, and drags nothing.
 */
function dragOnceMoved(e: React.MouseEvent, type: string, setDraggedType: (type: string | null) => void): void {
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  let dragActivated = false;
  const handleMouseMove = (moveEvent: MouseEvent) => {
    if (dragActivated) return;
    if (Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) >= 5) {
      dragActivated = true;
      setDraggedType(type);
    }
  };
  const handleMouseUp = () => {
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
  };
  window.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('mouseup', handleMouseUp);
}

function ComponentItem({ component }: ComponentItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const setDraggedType = useCanvasStore((state) => state.setDraggedType);
  const draggedType = useCanvasStore((state) => state.draggedType);

  const isDragging = draggedType === component.name;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => dragOnceMoved(e, component.name, setDraggedType),
    [component.name, setDraggedType]
  );

  const handleDoubleClick = useCallback(() => {
    focusOnCanvas(insertFromPalette(component.name));
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
      tabIndex={-1}
      data-palette-row=""
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
      <button type="button" tabIndex={-1} data-palette-row="" style={styles.categoryHeader} onClick={onToggle} aria-expanded={isExpanded}>
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

/**
 * A page of the project, offered beside the library's components: dragged
 * and added the same way. It is put on the page being edited as an element
 * of its name, with the import that binds the name written in that page's
 * header (utils/pageImports.ts). One the page cannot use is shown, and says
 * why, and is not picked up.
 */
function PageItem({ page }: { page: Importable }) {
  const [isHovered, setIsHovered] = useState(false);
  const setDraggedType = useCanvasStore((state) => state.setDraggedType);
  const draggedType = useCanvasStore((state) => state.draggedType);
  const type = pageDragType(page.file.id);
  const fileName = page.file.path.split('/').pop() ?? page.file.path;
  const refused = page.refused !== undefined;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!refused) dragOnceMoved(e, type, setDraggedType);
    },
    [type, refused, setDraggedType]
  );

  const add = useCallback(() => {
    // A refusal is said aloud by what adds it (utils/pageDrop.ts).
    insertFromPalette(type);
  }, [type]);

  const style: React.CSSProperties = {
    ...componentStyle,
    ...(isHovered && !refused ? componentHoverStyle : {}),
    ...(draggedType === type ? componentDraggingStyle : {}),
    ...(refused ? { opacity: 0.55, cursor: 'not-allowed' } : {}),
  };

  return (
    <div
      role="button"
      tabIndex={-1}
      data-palette-row=""
      data-palette-page={page.file.path}
      aria-label={`Add ${fileName}`}
      aria-disabled={refused}
      aria-description={page.refused ?? `A page of this project, used here as ${page.name}`}
      onMouseDown={handleMouseDown}
      onDoubleClick={() => focusOnCanvas(insertFromPalette(type))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          add();
        }
      }}
      style={style}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={page.refused ?? `${page.file.path}, used on this page as <${page.name} />: drag onto the canvas, or double-click to add`}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)' }}>{page.name}</span>
    </div>
  );
}

/** The other pages of the project, as the page being edited could use them. */
function useProjectPages(): Importable[] {
  const activeFileId = useFilesStore((state) => state.activeFileId);
  const uiFiles = useFilesStore((state) => state.uiFiles);
  const imports = useCanvasStore((state) => state.imports);
  return useMemo(() => (activeFileId && uiFiles.has(activeFileId) ? importableFor(activeFileId, uiFiles, imports) : []), [activeFileId, uiFiles, imports]);
}

interface ComponentPaletteProps {
  onToggleDock?: () => void;
}

/**
 * Which sections of the palette are open, kept while the palette is not
 * drawn. It is drawn in Design alone, and each change of view put back the
 * four sections it starts with, whatever had been opened or closed.
 */
const openSections = {
  categories: new Set(['Control flow', 'Layout', 'Form', 'Display']),
  pages: true,
};

export function ComponentPalette({ onToggleDock }: ComponentPaletteProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedCategories, setExpandedCategoriesState] = useState<Set<string>>(() => new Set(openSections.categories));
  const setExpandedCategories = useCallback((update: (previous: Set<string>) => Set<string>) => {
    setExpandedCategoriesState((previous) => {
      const next = update(previous);
      openSections.categories = next;
      return next;
    });
  }, []);
  const componentsByCategory = useMemo(() => getComponentsByCategory(), []);
  const projectPages = useProjectPages();
  const [pagesExpanded, setPagesExpandedState] = useState(() => openSections.pages);
  const setPagesExpanded = useCallback((update: (previous: boolean) => boolean) => {
    setPagesExpandedState((previous) => {
      const next = update(previous);
      openSections.pages = next;
      return next;
    });
  }, []);
  const matchingPages = searchQuery
    ? projectPages.filter((page) => `${page.file.path} ${page.name}`.toLowerCase().includes(searchQuery.toLowerCase()))
    : projectPages;

  // The list is one stop for Tab, and the arrow keys move within it.
  // Every row was a stop of its own: with the four sections that start
  // open that is sixty presses of Tab between the Files panel and the
  // canvas, and over a hundred with all of them open, with no way round.
  // One row holds the stop (the one last used, or the first), as in the
  // canvas's own tree.
  const listRef = useRef<HTMLDivElement>(null);
  const rowsOf = (list: HTMLElement | null): HTMLElement[] => [...(list?.querySelectorAll<HTMLElement>('[data-palette-row]') ?? [])];
  const holdStop = (rows: HTMLElement[], holder: HTMLElement | undefined): void => {
    for (const row of rows) row.tabIndex = row === holder ? 0 : -1;
  };
  // After every drawing: the rows change with the search and with a section opening or closing.
  useEffect(() => {
    const rows = rowsOf(listRef.current);
    holdStop(rows, rows.find((row) => row.tabIndex === 0) ?? rows[0]);
  });
  const onListFocus = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-palette-row]');
    if (row) holdStop(rowsOf(event.currentTarget), row);
  }, []);
  const onListKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    // Delete on a row is the canvas's Delete: see deleteSelection.
    if ((event.key === 'Delete' || event.key === 'Backspace') && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if ((event.target as HTMLElement).closest('[data-palette-row]') && deleteSelection()) event.preventDefault();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const rows = rowsOf(event.currentTarget);
    const at = rows.indexOf((event.target as HTMLElement).closest<HTMLElement>('[data-palette-row]') as HTMLElement);
    if (at === -1) return;
    const to = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : event.key === 'ArrowDown' ? at + 1 : at - 1;
    const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
    event.preventDefault();
    if (!next || next === rows[at]) return;
    holdStop(rows, next);
    next.focus();
    next.scrollIntoView?.({ block: 'nearest' });
  }, []);

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
    ? [...blockPalette, ...paletteComponents].filter(
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
          <span className="bl-badge">{paletteComponents.length}</span>
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
        {/* Where the selection is, and the end of the page with nothing selected (placeBySelection). */}
        <div style={styles.searchHint}>Drag onto the canvas, or double-click (or press Enter) to add into what is selected, or after it.</div>
      </div>

      <div style={styles.list} ref={listRef} data-palette-list="" onKeyDown={onListKeyDown} onFocus={onListFocus}>
        {filteredComponents ? (
          <div style={styles.componentList}>
            {matchingPages.map((page) => (
              <PageItem key={page.file.id} page={page} />
            ))}
            {filteredComponents.map((comp) => (
              <ComponentItem key={comp.name} component={comp} />
            ))}
            {filteredComponents.length === 0 && matchingPages.length === 0 && (
              <div style={{ padding: '12px 8px', color: 'var(--dim)', fontSize: 13 }} role="status">
                Nothing matches “{searchQuery}”. Try a shorter word, like “form” or “list”.
              </div>
            )}
          </div>
        ) : (
          <>
            {/* The project's own pages, first: what a person made is what they reach for. */}
            {projectPages.length > 0 && (
              <div style={styles.category} data-palette-pages="">
                <button type="button" tabIndex={-1} data-palette-row="" style={styles.categoryHeader} onClick={() => setPagesExpanded((open) => !open)} aria-expanded={pagesExpanded}>
                  <span>
                    This project <span style={{ color: 'var(--dimmer)', fontWeight: 400 }}>{projectPages.length}</span>
                  </span>
                  <span aria-hidden="true" style={{ ...styles.categoryChevron, ...(pagesExpanded ? styles.categoryChevronOpen : {}) }}>
                    ›
                  </span>
                </button>
                {pagesExpanded && (
                  <div style={styles.componentList}>
                    {projectPages.map((page) => (
                      <PageItem key={page.file.id} page={page} />
                    ))}
                  </div>
                )}
              </div>
            )}
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
