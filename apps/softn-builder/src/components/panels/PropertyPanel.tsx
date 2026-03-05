/**
 * PropertyPanel - Right sidebar for editing component properties
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import { useProjectStore } from '../../stores/projectStore';
import { getComponentMeta } from '../../utils/componentRegistry';
import type { PropSchema } from '../../types/builder';

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: '100%',
    height: '100%',
    background: '#fff',
    borderLeft: '1px solid #e2e8f0',
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
    gap: 8,
  },
  headerTitle: {
    fontWeight: 600,
    fontSize: 14,
    color: '#1e293b',
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
  content: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'hidden',
    scrollbarGutter: 'stable',
    padding: 16,
  },
  empty: {
    padding: 24,
    textAlign: 'center' as const,
    color: '#94a3b8',
    fontSize: 13,
  },
  componentInfo: {
    marginBottom: 16,
    padding: 12,
    background: '#f8fafc',
    borderRadius: 8,
  },
  componentName: {
    fontSize: 16,
    fontWeight: 600,
    color: '#1e293b',
    marginBottom: 4,
  },
  componentDescription: {
    fontSize: 12,
    color: '#64748b',
  },
  section: {
    marginBottom: 16,
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    background: '#fff',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '8px 10px',
    background: '#f8fafc',
    borderBottom: '1px solid #e2e8f0',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: '#64748b',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  sectionToggle: {
    border: '1px solid #cbd5e1',
    background: '#fff',
    borderRadius: 6,
    color: '#64748b',
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
    color: '#374151',
    marginBottom: 4,
  },
  input: {
    width: '100%',
    padding: '8px 10px',
    border: '1px solid #e2e8f0',
    borderRadius: 6,
    fontSize: 13,
    outline: 'none',
  },
  select: {
    width: '100%',
    padding: '8px 10px',
    border: '1px solid #e2e8f0',
    borderRadius: 6,
    fontSize: 13,
    outline: 'none',
    background: '#fff',
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
    border: '1px solid #e2e8f0',
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
    border: '1px solid #e2e8f0',
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
    color: '#64748b',
  },
  fieldSubLabel: {
    display: 'block',
    fontSize: 11,
    color: '#64748b',
    marginBottom: 4,
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
          <span style={{ fontSize: 12, color: '#64748b' }}>{value ? 'Yes' : 'No'}</span>
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
          <small style={{ fontSize: 10, color: '#94a3b8', marginTop: 2, display: 'block' }}>
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
        <div style={styles.empty}>Select an element to edit its properties</div>
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
          <div style={styles.componentName}>{selectedElement.componentType}</div>
          {meta && <div style={styles.componentDescription}>{meta.description}</div>}
        </div>

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
      </div>
    </div>
  );
}
