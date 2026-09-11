/**
 * PropertyPanel - Right sidebar for editing component properties
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import { useProjectStore } from '../../stores/projectStore';
import { getComponentMeta } from '../../utils/componentRegistry';
import { blockHeaderText } from '../../utils/sourceGenerator';
import { blockDescription, isBlockHead } from '../../utils/blocks';
import type { CanvasBlock, PropSchema } from '../../types/builder';

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: '100%',
    height: '100%',
    background: 'var(--ink-2)',
    borderLeft: '1px solid var(--line-soft)',
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
    gap: 8,
  },
  headerTitle: {
    fontWeight: 600,
    fontSize: 14,
    color: 'var(--paper)',
  },
  dockBtn: {
    border: '1px solid var(--line)',
    background: 'var(--ink-2)',
    color: 'var(--dim)',
    borderRadius: 6,
    fontSize: 11,
    padding: '3px 7px',
    lineHeight: 1,
    cursor: 'pointer',
  },
  content: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'hidden',
    scrollbarGutter: 'stable',
    padding: 16,
  },
  // The panel is 320px wide and full height, and this used to be one grey
  // sentence pinned to the top of it, with the rest of the column empty. It
  // centres now and says what to do rather than only what is missing.
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: '24px 28px',
    textAlign: 'center' as const,
    color: 'var(--dimmer)',
    fontSize: 13,
  },
  emptyTitle: {
    fontFamily: 'var(--b-display)',
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: '-0.01em',
    color: 'var(--paper)',
  },
  emptyHint: {
    fontSize: 12.5,
    lineHeight: 1.55,
    color: 'var(--dim)',
    maxWidth: 240,
  },
  componentInfo: {
    marginBottom: 16,
    padding: 12,
    background: 'var(--ink)',
    borderRadius: 8,
  },
  componentName: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--paper)',
    marginBottom: 4,
  },
  componentDescription: {
    fontSize: 12,
    color: 'var(--dim)',
  },
  section: {
    marginBottom: 16,
    border: '1px solid var(--line-soft)',
    borderRadius: 8,
    overflow: 'hidden',
    background: 'var(--ink-2)',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '8px 10px',
    background: 'var(--ink)',
    borderBottom: '1px solid var(--line-soft)',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--dim)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  sectionToggle: {
    border: '1px solid var(--line)',
    background: 'var(--ink-2)',
    borderRadius: 6,
    color: 'var(--dim)',
    fontSize: 11,
    width: 22,
    height: 20,
    cursor: 'pointer',
    lineHeight: 1,
    padding: 0,
  },
  sectionBody: {
    padding: 10,
  },
  field: {
    marginBottom: 12,
  },
  label: {
    display: 'block',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--dim)',
    marginBottom: 4,
  },
  input: {
    width: '100%',
    padding: '8px 10px',
    border: '1px solid var(--line-soft)',
    borderRadius: 6,
    fontSize: 13,
    outline: 'none',
  },
  select: {
    width: '100%',
    padding: '8px 10px',
    border: '1px solid var(--line-soft)',
    borderRadius: 6,
    fontSize: 13,
    outline: 'none',
    background: 'var(--ink-2)',
  },
  checkbox: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  checkboxInput: {
    width: 16,
    height: 16,
  },
  colorInput: {
    width: 40,
    height: 32,
    padding: 2,
    border: '1px solid var(--line-soft)',
    borderRadius: 4,
    cursor: 'pointer',
  },
  colorRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  textarea: {
    width: '100%',
    padding: '8px 10px',
    border: '1px solid var(--line-soft)',
    borderRadius: 6,
    fontSize: 13,
    outline: 'none',
    minHeight: 80,
    resize: 'vertical' as const,
    fontFamily: 'monospace',
  },
  fieldHint: {
    marginTop: 4,
    fontSize: 11,
    color: 'var(--dim)',
  },
  fieldSubLabel: {
    display: 'block',
    fontSize: 11,
    color: 'var(--dim)',
    marginBottom: 4,
  },
  actionRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 6,
  },
  actionBtn: {
    border: '1px solid var(--line)',
    background: 'var(--ink)',
    color: 'var(--paper)',
    borderRadius: 6,
    fontSize: 12,
    padding: '5px 9px',
    cursor: 'pointer',
  },
  actionBtnDanger: {
    color: '#dc2626',
  },
};

interface PropEditorProps {
  propDef: PropSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}

interface PropertyPanelProps {
  onToggleDock?: () => void;
}

function PropEditor({ propDef, value, onChange }: PropEditorProps) {
  switch (propDef.type) {
    case 'string':
      return (
        <input
          type="text"
          style={styles.input}
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={propDef.description}
        />
      );

    case 'number':
      return (
        <input
          type="number"
          style={styles.input}
          value={(value as number) ?? ''}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
        />
      );

    case 'boolean':
      return (
        <div style={styles.checkbox}>
          <input
            type="checkbox"
            style={styles.checkboxInput}
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span style={{ fontSize: 12, color: 'var(--dim)' }}>{value ? 'Yes' : 'No'}</span>
        </div>
      );

    case 'select':
      return (
        <select
          style={styles.select}
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">-- Select --</option>
          {propDef.options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );

    case 'color':
      return (
        <div style={styles.colorRow}>
          <input
            type="color"
            style={styles.colorInput}
            value={(value as string) || '#000000'}
            onChange={(e) => onChange(e.target.value)}
          />
          <input
            type="text"
            style={{ ...styles.input, flex: 1 }}
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder="#000000"
          />
        </div>
      );

    case 'expression':
      return (
        <input
          type="text"
          style={{ ...styles.input, fontFamily: 'monospace' }}
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="{expression}"
        />
      );

    case 'json':
      return (
        <textarea
          style={styles.textarea}
          value={typeof value === 'object' ? JSON.stringify(value, null, 2) : (value as string) || ''}
          onChange={(e) => {
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              // keep editing invalid JSON
            }
          }}
          placeholder={propDef.description || 'JSON value'}
        />
      );

    case 'event':
      return (
        <div>
          <input
            type="text"
            style={{ ...styles.input, fontFamily: 'monospace' }}
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder="functionName()"
            title="Enter a function name from Logic tab"
          />
          <small style={{ fontSize: 10, color: 'var(--dimmer)', marginTop: 2, display: 'block' }}>
            Function defined in Logic tab
          </small>
        </div>
      );

    default:
      return (
        <input
          type="text"
          style={styles.input}
          value={String(value || '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

export function PropertyPanel({ onToggleDock }: PropertyPanelProps) {
  const selectedIds = useCanvasStore(s => s.selectedIds);
  const updateElementProps = useCanvasStore(s => s.updateElementProps);
  const updateElement = useCanvasStore(s => s.updateElement);
  const selectedElement = useCanvasStore(s =>
    s.selectedIds.length === 1 ? s.elements.get(s.selectedIds[0]) ?? null : null
  );
  const push = useHistoryStore(s => s.push);
  const assets = useProjectStore((state) => state.assets);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  const meta = useMemo(() => {
    if (selectedElement) return getComponentMeta(selectedElement.componentType);
    return null;
  }, [selectedElement]);

  const handlePropChange = useCallback(
    (propName: string, value: unknown) => {
      if (!selectedElement) return;
      const { elements, rootId } = useCanvasStore.getState();
      push(elements, rootId);
      updateElementProps(selectedElement.id, { [propName]: value });
    },
    [selectedElement, push, updateElementProps]
  );

  const handleEventChange = useCallback(
    (eventName: string, handler: string) => {
      if (!selectedElement) return;
      const { elements, rootId } = useCanvasStore.getState();
      push(elements, rootId);
      const events = { ...(selectedElement.events || {}), [eventName]: handler };
      if (!handler) delete events[eventName];
      updateElement(selectedElement.id, { events });
    },
    [selectedElement, push, updateElement]
  );

  const handleBindingChange = useCallback(
    (bindingName: string, expr: string) => {
      if (!selectedElement) return;
      const { elements, rootId } = useCanvasStore.getState();
      push(elements, rootId);
      const bindings = { ...(selectedElement.bindings || {}), [bindingName]: expr };
      if (!expr) delete bindings[bindingName];
      updateElement(selectedElement.id, { bindings });
    },
    [selectedElement, push, updateElement]
  );

  const handleDirectiveChange = useCallback(
    (field: 'conditionalIf' | 'loopEach' | 'loopAs', value: string) => {
      if (!selectedElement) return;
      const { elements, rootId } = useCanvasStore.getState();
      push(elements, rootId);
      updateElement(selectedElement.id, { [field]: value || undefined });
    },
    [selectedElement, push, updateElement]
  );

  // A block's header — its condition, or its loop variables and list — is
  // edited here as the block's own fields. Blocks are elements of the model
  // (types/builder.ts, CanvasBlock) and the generator prints what is set,
  // so an emptied field is dropped from the header rather than printed empty.
  const handleBlockChange = useCallback(
    (field: keyof Omit<CanvasBlock, 'kind'>, value: string) => {
      if (!selectedElement?.block) return;
      const { elements, rootId } = useCanvasStore.getState();
      push(elements, rootId);
      const block: CanvasBlock = { ...selectedElement.block };
      if (value) block[field] = value;
      else delete block[field];
      updateElement(selectedElement.id, { block });
    },
    [selectedElement, push, updateElement]
  );

  const withHistory = useCallback(
    (action: () => void) => {
      const { elements, rootId } = useCanvasStore.getState();
      push(elements, rootId);
      action();
    },
    [push]
  );

  const wrapSelected = useCallback(
    (kind: 'if' | 'each') => {
      if (!selectedElement) return;
      withHistory(() => useCanvasStore.getState().wrapElement(selectedElement.id, kind));
    },
    [selectedElement, withHistory]
  );

  const addBranch = useCallback(
    (kind: 'elseif' | 'else' | 'empty') => {
      if (!selectedElement) return;
      withHistory(() => useCanvasStore.getState().addBlockBranch(selectedElement.id, kind));
    },
    [selectedElement, withHistory]
  );

  const unwrapSelected = useCallback(() => {
    if (!selectedElement) return;
    withHistory(() => useCanvasStore.getState().unwrapBlock(selectedElement.id));
  }, [selectedElement, withHistory]);

  const removeSelected = useCallback(() => {
    if (!selectedElement) return;
    withHistory(() => useCanvasStore.getState().deleteElement(selectedElement.id));
  }, [selectedElement, withHistory]);

  // Which alternate branches the selected block already has, so a second
  // #else or #empty is not offered.
  const existingBranches = useMemo(() => {
    if (!selectedElement?.block) return new Set<string>();
    const { elements } = useCanvasStore.getState();
    return new Set(
      selectedElement.children
        .map((cid) => elements.get(cid)?.block?.kind)
        .filter((kind): kind is CanvasBlock['kind'] => kind !== undefined)
    );
  }, [selectedElement]);

  const groupedProps = useMemo(() => {
    if (!meta) return null;

    const groups: Record<string, PropSchema[]> = { main: [], style: [], events: [], advanced: [] };

    for (const prop of meta.propSchema) {
      if (prop.type === 'event') groups.events.push(prop);
      else if (prop.name === 'className' || prop.name === 'style') groups.style.push(prop);
      else if (prop.name === 'children' || ['variant', 'size', 'disabled'].includes(prop.name)) groups.main.push(prop);
      else groups.advanced.push(prop);
    }

    return groups;
  }, [meta]);

  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const isCollapsed = useCallback((key: string) => Boolean(collapsedSections[key]), [collapsedSections]);

  const imageAssetOptions = useMemo(() => {
    const files = assets
      .map((asset) => asset.name.replace(/^assets\//, ''))
      .filter((name) => /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name))
      .sort((a, b) => a.localeCompare(b));
    return files.map((name) => `assets/${name}`);
  }, [assets]);

  const renderPropField = useCallback(
    (prop: PropSchema) => {
      if (!selectedElement) return null;

      const currentValue = selectedElement.props[prop.name];
      const isImageSrc = selectedElement.componentType === 'Image' && prop.name === 'src';

      if (isImageSrc) {
        const normalizedCurrent = String(currentValue || '').trim();
        const selectedAssetValue = imageAssetOptions.includes(normalizedCurrent) ? normalizedCurrent : '';

        return (
          <div key={prop.name} style={styles.field}>
            <label style={styles.label}>{prop.name}</label>
            <label style={styles.fieldSubLabel}>Asset</label>
            <select
              style={styles.select}
              value={selectedAssetValue}
              onChange={(e) => handlePropChange(prop.name, e.target.value)}
            >
              <option value="">-- Select asset image --</option>
              {imageAssetOptions.map((assetPath) => (
                <option key={assetPath} value={assetPath}>
                  {assetPath}
                </option>
              ))}
            </select>
            <label style={{ ...styles.fieldSubLabel, marginTop: 8 }}>Manual value</label>
            <input
              type="text"
              style={styles.input}
              value={normalizedCurrent}
              onChange={(e) => handlePropChange(prop.name, e.target.value)}
              placeholder="https://... or appIconUrl"
            />
            <div style={styles.fieldHint}>
              Use an asset path, URL/data URI, or a logic variable name.
            </div>
          </div>
        );
      }

      return (
        <div key={prop.name} style={styles.field}>
          <label style={styles.label}>{prop.name === 'children' ? 'Text Content' : prop.name}</label>
          <PropEditor
            propDef={prop}
            value={selectedElement.props[prop.name]}
            onChange={(value) => handlePropChange(prop.name, value)}
          />
        </div>
      );
    },
    [selectedElement, imageAssetOptions, handlePropChange]
  );

  const header = (
    <div style={styles.header}>
      <span style={styles.headerTitle}>Properties</span>
      {onToggleDock && (
        <button style={styles.dockBtn} onClick={onToggleDock} title="Hide Inspector panel">
          Hide
        </button>
      )}
    </div>
  );

  if (!selectedElement) {
    return (
      <div style={styles.container}>
        {header}
        <div style={styles.empty}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--dimmer)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 4h7v7H4z" />
            <path d="M13.5 13.5 20 20" />
            <path d="M13 13h3.5M13 13v3.5" />
          </svg>
          <div style={styles.emptyTitle}>Nothing selected</div>
          <div style={styles.emptyHint}>
            Pick an element on the canvas, or in the hierarchy below, and its properties appear here.
          </div>
        </div>
      </div>
    );
  }

  if (selectedIds.length > 1) {
    return (
      <div style={styles.container}>
        {header}
        <div style={styles.empty}>{selectedIds.length} elements selected</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {header}

      <div style={styles.content}>
        <div style={styles.componentInfo}>
          <div style={styles.componentName}>
            {blockHeaderText(selectedElement) ?? selectedElement.componentType}
          </div>
          {meta && <div style={styles.componentDescription}>{meta.description}</div>}
          {selectedElement.block && (
            <div style={styles.componentDescription}>{blockDescription(selectedElement.block)}</div>
          )}
        </div>

        {selectedElement.block && (
          <div style={styles.section} data-block-editor={selectedElement.block.kind}>
            <div style={styles.sectionHeader}>
              <div style={styles.sectionTitle}>Block</div>
            </div>
            <div style={styles.sectionBody}>
              {(selectedElement.block.kind === 'if' || selectedElement.block.kind === 'elseif') && (
                <div style={styles.field}>
                  <label style={styles.label}>condition</label>
                  <input
                    type="text"
                    style={{ ...styles.input, fontFamily: 'monospace' }}
                    value={selectedElement.block.condition || ''}
                    onChange={(e) => handleBlockChange('condition', e.target.value)}
                    placeholder="condition"
                    data-block-field="condition"
                  />
                </div>
              )}
              {selectedElement.block.kind === 'each' && (
                <>
                  <div style={styles.field}>
                    <label style={styles.label}>item</label>
                    <input
                      type="text"
                      style={{ ...styles.input, fontFamily: 'monospace' }}
                      value={selectedElement.block.itemName || ''}
                      onChange={(e) => handleBlockChange('itemName', e.target.value)}
                      placeholder="item"
                      data-block-field="itemName"
                    />
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>index (optional)</label>
                    <input
                      type="text"
                      style={{ ...styles.input, fontFamily: 'monospace' }}
                      value={selectedElement.block.indexName || ''}
                      onChange={(e) => handleBlockChange('indexName', e.target.value)}
                      placeholder="i"
                      data-block-field="indexName"
                    />
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>in list</label>
                    <input
                      type="text"
                      style={{ ...styles.input, fontFamily: 'monospace' }}
                      value={selectedElement.block.iterable || ''}
                      onChange={(e) => handleBlockChange('iterable', e.target.value)}
                      placeholder="items"
                      data-block-field="iterable"
                    />
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>key (optional)</label>
                    <input
                      type="text"
                      style={{ ...styles.input, fontFamily: 'monospace' }}
                      value={selectedElement.block.keyExpression || ''}
                      onChange={(e) => handleBlockChange('keyExpression', e.target.value)}
                      placeholder="item.id"
                      data-block-field="keyExpression"
                    />
                  </div>
                </>
              )}
              <div style={styles.actionRow}>
                {selectedElement.block.kind === 'if' && (
                  <>
                    <button style={styles.actionBtn} onClick={() => addBranch('elseif')} data-block-action="add-elseif">
                      Add #elseif
                    </button>
                    {!existingBranches.has('else') && (
                      <button style={styles.actionBtn} onClick={() => addBranch('else')} data-block-action="add-else">
                        Add #else
                      </button>
                    )}
                  </>
                )}
                {selectedElement.block.kind === 'each' && !existingBranches.has('empty') && (
                  <button style={styles.actionBtn} onClick={() => addBranch('empty')} data-block-action="add-empty">
                    Add #empty
                  </button>
                )}
                {isBlockHead(selectedElement) ? (
                  <button
                    style={styles.actionBtn}
                    onClick={unwrapSelected}
                    title="Remove the block; the elements of its main branch stay, its other branches go"
                    data-block-action="unwrap"
                  >
                    Unwrap
                  </button>
                ) : (
                  <button
                    style={{ ...styles.actionBtn, ...styles.actionBtnDanger }}
                    onClick={removeSelected}
                    title="Remove this branch and everything in it"
                    data-block-action="remove-branch"
                  >
                    Remove branch
                  </button>
                )}
              </div>
              <div style={styles.fieldHint}>
                {isBlockHead(selectedElement)
                  ? 'Drop elements into the block on the canvas to fill its branch.'
                  : 'This branch belongs to the block above it.'}
              </div>
            </div>
          </div>
        )}

        {!selectedElement.block && selectedElement.parentId && (
          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <div style={styles.sectionTitle}>Control flow</div>
            </div>
            <div style={styles.sectionBody}>
              <div style={styles.actionRow}>
                <button style={styles.actionBtn} onClick={() => wrapSelected('if')} data-block-action="wrap-if">
                  Wrap in #if
                </button>
                <button style={styles.actionBtn} onClick={() => wrapSelected('each')} data-block-action="wrap-each">
                  Wrap in #each
                </button>
              </div>
              <div style={styles.fieldHint}>
                Puts a block around this element; its condition or list is edited on the block.
              </div>
            </div>
          </div>
        )}

        {groupedProps && (
          <>
            {groupedProps.main.length > 0 && (
              <div style={styles.section}>
                <div style={styles.sectionHeader}>
                  <div style={styles.sectionTitle}>Main</div>
                  <button style={styles.sectionToggle} onClick={() => toggleSection('main')}>
                    {isCollapsed('main') ? '+' : '-'}
                  </button>
                </div>
                {!isCollapsed('main') && (
                  <div style={styles.sectionBody}>
                    {groupedProps.main.map((prop) => (
                      renderPropField(prop)
                    ))}
                  </div>
                )}
              </div>
            )}

            {groupedProps.advanced.length > 0 && (
              <div style={styles.section}>
                <div style={styles.sectionHeader}>
                  <div style={styles.sectionTitle}>Advanced</div>
                  <button style={styles.sectionToggle} onClick={() => toggleSection('advanced')}>
                    {isCollapsed('advanced') ? '+' : '-'}
                  </button>
                </div>
                {!isCollapsed('advanced') && (
                  <div style={styles.sectionBody}>
                    {groupedProps.advanced.map((prop) => (
                      renderPropField(prop)
                    ))}
                  </div>
                )}
              </div>
            )}

            {groupedProps.style.length > 0 && (
              <div style={styles.section}>
                <div style={styles.sectionHeader}>
                  <div style={styles.sectionTitle}>Style</div>
                  <button style={styles.sectionToggle} onClick={() => toggleSection('style')}>
                    {isCollapsed('style') ? '+' : '-'}
                  </button>
                </div>
                {!isCollapsed('style') && (
                  <div style={styles.sectionBody}>
                    {groupedProps.style.map((prop) => (
                      renderPropField(prop)
                    ))}
                  </div>
                )}
              </div>
            )}

            {groupedProps.events.length > 0 && (
              <div style={styles.section}>
                <div style={styles.sectionHeader}>
                  <div style={styles.sectionTitle}>Events (Schema)</div>
                  <button style={styles.sectionToggle} onClick={() => toggleSection('schemaEvents')}>
                    {isCollapsed('schemaEvents') ? '+' : '-'}
                  </button>
                </div>
                {!isCollapsed('schemaEvents') && (
                  <div style={styles.sectionBody}>
                    {groupedProps.events.map((prop) => (
                      renderPropField(prop)
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Handlers, bindings and inline directives are a component's; a
            block has none, and its header is the Block section above. */}
        {!selectedElement.block && (
        <>
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <div style={styles.sectionTitle}>Event Handlers</div>
            <button style={styles.sectionToggle} onClick={() => toggleSection('handlers')}>
              {isCollapsed('handlers') ? '+' : '-'}
            </button>
          </div>
          {!isCollapsed('handlers') && (
            <div style={styles.sectionBody}>
              {['click', 'change', 'submit', 'input', 'focus', 'blur', 'keydown', 'keyup'].map((eventName) => {
                const value = selectedElement.events?.[eventName] || '';
                return (
                  <div key={eventName} style={styles.field}>
                    <label style={styles.label}>@{eventName}</label>
                    <input
                      type="text"
                      style={{ ...styles.input, fontFamily: 'monospace' }}
                      value={value}
                      onChange={(e) => handleEventChange(eventName, e.target.value)}
                      placeholder="handler()"
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <div style={styles.sectionTitle}>Bindings</div>
            <button style={styles.sectionToggle} onClick={() => toggleSection('bindings')}>
              {isCollapsed('bindings') ? '+' : '-'}
            </button>
          </div>
          {!isCollapsed('bindings') && (
            <div style={styles.sectionBody}>
              {['bind', 'value', 'checked', 'selected', 'disabled', 'visible', 'class', 'style'].map((bindingName) => {
                const value = selectedElement.bindings?.[bindingName] || '';
                return (
                  <div key={bindingName} style={styles.field}>
                    <label style={styles.label}>:{bindingName}</label>
                    <input
                      type="text"
                      style={{ ...styles.input, fontFamily: 'monospace' }}
                      value={value}
                      onChange={(e) => handleBindingChange(bindingName, e.target.value)}
                      placeholder="{expression}"
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <div style={styles.sectionTitle}>Directives</div>
            <button style={styles.sectionToggle} onClick={() => toggleSection('directives')}>
              {isCollapsed('directives') ? '+' : '-'}
            </button>
          </div>
          {!isCollapsed('directives') && (
            <div style={styles.sectionBody}>
              <div style={styles.field}>
                <label style={styles.label}>if</label>
                <input
                  type="text"
                  style={{ ...styles.input, fontFamily: 'monospace' }}
                  value={selectedElement.conditionalIf || ''}
                  onChange={(e) => handleDirectiveChange('conditionalIf', e.target.value)}
                  placeholder="condition"
                />
              </div>
              <div style={styles.field}>
                <label style={styles.label}>each</label>
                <input
                  type="text"
                  style={{ ...styles.input, fontFamily: 'monospace' }}
                  value={selectedElement.loopEach || ''}
                  onChange={(e) => handleDirectiveChange('loopEach', e.target.value)}
                  placeholder="collection"
                />
              </div>
              <div style={styles.field}>
                <label style={styles.label}>as</label>
                <input
                  type="text"
                  style={{ ...styles.input, fontFamily: 'monospace' }}
                  value={selectedElement.loopAs || ''}
                  onChange={(e) => handleDirectiveChange('loopAs', e.target.value)}
                  placeholder="item, index"
                />
              </div>
            </div>
          )}
        </div>
        </>
        )}
      </div>
    </div>
  );
}
