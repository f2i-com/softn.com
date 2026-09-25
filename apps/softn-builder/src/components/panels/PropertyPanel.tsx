/**
 * PropertyPanel - Right sidebar for editing component properties
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import { useProjectStore } from '../../stores/projectStore';
import { useFilesStore } from '../../stores/filesStore';
import { ACCESSIBILITY_PROP_NAMES, getComponentMeta } from '../../utils/componentRegistry';
import { dockLogicFile, entryFileId, logicLanguageOf, type LogicLanguage } from '../../utils/logicFiles';
import { callableNames, handlerFor, handlerTarget, logicFunctions, type LogicFunction } from '../../utils/logicFunctions';
import { eventKeyFor } from '../../utils/eventProps';
import { nativeElementMeta } from '../../utils/nativeHtmlMetadata';
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
    fontFamily: 'var(--display)',
    fontWeight: 700,
    fontSize: 14,
    letterSpacing: '-0.01em',
    color: 'var(--paper)',
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
    fontFamily: 'var(--display)',
    fontSize: 16,
    fontWeight: 700,
    letterSpacing: '-0.01em',
    color: 'var(--paper)',
  },
  emptyHint: {
    fontSize: 12.5,
    lineHeight: 1.55,
    color: 'var(--dim)',
    maxWidth: 240,
  },
  // The selected element: its tag in the language's colour, as the source
  // would show it, then what it is.
  componentInfo: {
    marginBottom: 14,
    padding: '2px 2px 12px',
    borderBottom: '1px solid var(--line-soft)',
  },
  componentName: {
    fontFamily: 'var(--mono)',
    fontSize: 15,
    fontWeight: 500,
    color: 'var(--coral)',
    marginBottom: 4,
    overflowWrap: 'anywhere',
  },
  componentDescription: {
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--dim)',
  },
  section: {
    marginBottom: 12,
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
    padding: '7px 10px',
    background: 'var(--ink)',
    borderBottom: '1px solid var(--line-soft)',
  },
  // A section inside the panel: small, sentence case, never tracked capitals.
  sectionTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--paper)',
  },
  // The whole header folds the section, not only a 22px "+" at its end.
  sectionToggle: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    width: '100%',
    padding: '7px 10px',
    border: 'none',
    background: 'var(--ink)',
    color: 'var(--paper)',
    fontSize: 12,
    fontWeight: 600,
    textAlign: 'left',
    cursor: 'pointer',
  },
  sectionChevron: {
    color: 'var(--dim)',
    fontSize: 13,
    lineHeight: 1,
    transition: 'transform 0.15s',
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
    borderRadius: 6,
    fontSize: 13,
  },
  select: {
    width: '100%',
    padding: '7px 8px',
    borderRadius: 6,
    fontSize: 13,
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
    border: '1px solid var(--line)',
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
    borderRadius: 6,
    fontSize: 12.5,
    minHeight: 80,
    resize: 'vertical' as const,
    fontFamily: 'var(--mono)',
  },
  fieldHint: {
    marginTop: 4,
    fontSize: 11.5,
    lineHeight: 1.45,
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
    fontFamily: 'var(--mono)',
  },
  actionBtnDanger: {
    color: 'var(--danger)',
  },
  handlerWarning: {
    marginTop: 4,
    fontSize: 11.5,
    color: 'var(--warn)',
  },
  sectionNote: {
    fontSize: 11,
    color: 'var(--dim)',
    marginBottom: 10,
    lineHeight: 1.45,
  },
};

/** The DOM events the panel offers on every element. */
const GENERIC_EVENTS = ['click', 'change', 'submit', 'input', 'focus', 'blur', 'keydown', 'keyup'];

/**
 * What a handler field knows about the logic it calls into: the file the
 * dock edits (the one the active UI file links, else the entry's), its
 * functions in file order, and every name a handler may call without a
 * warning.
 */
interface HandlerHelp {
  logicPath: string | null;
  language: LogicLanguage;
  functions: LogicFunction[];
  callable: Set<string>;
}

function useHandlerHelp(): HandlerHelp {
  const retainedSource = useProjectStore((state) => state.source);
  const activeFileId = useFilesStore((state) => state.activeFileId);
  const uiFiles = useFilesStore((state) => state.uiFiles);
  const logicFiles = useFilesStore((state) => state.logicFiles);
  return useMemo(() => {
    const file = dockLogicFile(activeFileId, uiFiles, logicFiles, entryFileId(uiFiles, retainedSource));
    if (!file) return { logicPath: null, language: 'javascript', functions: [], callable: new Set<string>() };
    const language = logicLanguageOf(file.path);
    // JavaScript logic files are composed into one scope, so a helper's
    // functions are callable too; a Python module's are callable only as
    // the linked module defines or imports them.
    const scope = language === 'python'
      ? [file.content]
      : [...logicFiles.values()].filter((other) => logicLanguageOf(other.path) === language).map((other) => other.content);
    return {
      logicPath: file.path,
      language,
      functions: logicFunctions(file.content, language),
      callable: callableNames(scope, language),
    };
  }, [activeFileId, uiFiles, logicFiles, retainedSource]);
}

interface HandlerFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  help: HandlerHelp;
}

/**
 * A handler field: free text, as a handler may be any expression, with the
 * logic file's functions offered as suggestions and a warning — never a
 * refusal — when it calls a function the file does not define.
 */
function HandlerField({ id, value, onChange, onBlur, help }: HandlerFieldProps) {
  const listId = `${id}-functions`;
  const target = handlerTarget(value);
  const missing = help.logicPath && target && !help.callable.has(target) ? target : null;
  return (
    <div>
      <input
        id={id}
        type="text"
        style={{ ...styles.input, fontFamily: 'var(--mono)' }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder="handler()"
        list={help.functions.length > 0 ? listId : undefined}
        autoComplete="off"
        spellCheck={false}
      />
      {help.functions.length > 0 && (
        <datalist id={listId}>
          {help.functions.map((fn) => (
            <option key={fn.name} value={handlerFor(fn, help.language)} label={`${fn.name}(${fn.params})`} />
          ))}
        </datalist>
      )}
      {missing && (
        <div style={styles.handlerWarning} role="status" data-handler-warning={missing}>
          {`No function named ${missing} in ${help.logicPath}.`}
        </div>
      )}
    </div>
  );
}

/** The line at the top of an events section: where the suggestions come from. */
function handlerNote(help: HandlerHelp): string {
  if (!help.logicPath) return 'This file links no logic file, so there are no functions to suggest. A handler can still be any expression.';
  if (help.functions.length === 0) return `${help.logicPath} defines no functions yet. Add one in the logic dock below the canvas.`;
  return help.language === 'python'
    ? `Suggestions are the functions in ${help.logicPath}. One without parameters is inserted as () => name(), because a handler is passed the event.`
    : `Suggestions are the functions in ${help.logicPath}; a handler can also be any expression.`;
}

interface PropEditorProps {
  id: string;
  propDef: PropSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}

interface PropertyPanelProps {
  onToggleDock?: () => void;
}

function PropEditor({ id, propDef, value, onChange }: PropEditorProps) {
  switch (propDef.type) {
    case 'string':
      return (
        <input
          id={id}
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
          id={id}
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
            id={id}
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
          id={id}
          style={styles.select}
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
        >
          {/* Empty writes no attribute, so the component's own default applies. */}
          <option value="">{propDef.default !== undefined && propDef.default !== '' ? `Default (${String(propDef.default)})` : 'Default'}</option>
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
            id={id}
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
          id={id}
          type="text"
          style={{ ...styles.input, fontFamily: 'var(--mono)' }}
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="{expression}"
        />
      );

    case 'json':
      return (
        <textarea
          id={id}
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

    default:
      return (
        <input
          id={id}
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
  // Leaving a field ends its run of edits: the next edit to it is a step of its own.
  const endEdit = useHistoryStore(s => s.endCoalescing);
  const handlerHelp = useHandlerHelp();
  const assets = useProjectStore((state) => state.assets);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  const meta = useMemo(() => {
    if (selectedElement) return nativeElementMeta(selectedElement) ?? getComponentMeta(selectedElement.componentType);
    return null;
  }, [selectedElement]);

  const handlePropChange = useCallback(
    (propName: string, value: unknown) => {
      if (!selectedElement) return;
      const { elements, rootId } = useCanvasStore.getState();
      // Keyed by field, so typing into one is a single undo step, not one per
      // keystroke; the other field handlers below are keyed the same way.
      push(elements, rootId, `${selectedElement.id}:prop:${propName}`);
      updateElementProps(selectedElement.id, { [propName]: value });
    },
    [selectedElement, push, updateElementProps]
  );

  const handleEventChange = useCallback(
    (eventName: string, handler: string) => {
      if (!selectedElement) return;
      const { elements, rootId } = useCanvasStore.getState();
      push(elements, rootId, `${selectedElement.id}:event:${eventName}`);
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
      push(elements, rootId, `${selectedElement.id}:binding:${bindingName}`);
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
      push(elements, rootId, `${selectedElement.id}:directive:${field}`);
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
      push(elements, rootId, `${selectedElement.id}:block:${field}`);
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

    const groups: Record<string, PropSchema[]> = { main: [], accessibility: [], style: [], events: [], advanced: [] };

    for (const prop of meta.propSchema) {
      if (prop.type === 'event') groups.events.push(prop);
      else if (prop.name === 'className' || prop.name === 'style') groups.style.push(prop);
      else if (prop.name === 'children' || ['variant', 'size', 'disabled'].includes(prop.name)) groups.main.push(prop);
      else if (ACCESSIBILITY_PROP_NAMES.has(prop.name)) groups.accessibility.push(prop);
      else groups.advanced.push(prop);
    }

    return groups;
  }, [meta]);

  // The DOM events every element takes, less those the component lists as
  // its own: a Button's onClick was offered twice, as its component event and
  // as a generic @click — two fields writing one handler. The runtime maps
  // `@keydown` and `@keyDown` to the same prop, so the match ignores case,
  // but a generic field whose own spelling holds a handler stays, or that
  // handler would be hidden from the panel.
  const genericEvents = useMemo(() => {
    const own = new Set((groupedProps?.events ?? []).map((prop) => eventKeyFor(prop.name)));
    const ownLower = new Set([...own].map((key) => key.toLowerCase()));
    return GENERIC_EVENTS.filter(
      (name) => !own.has(name) && (!ownLower.has(name) || selectedElement?.events?.[name] !== undefined)
    );
  }, [groupedProps, selectedElement]);

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
            <span style={styles.label}>{prop.name}</span>
            <label htmlFor={`panel-${selectedElement.id}-src-asset`} style={styles.fieldSubLabel}>Asset</label>
            <select
              id={`panel-${selectedElement.id}-src-asset`}
              style={styles.select}
              value={selectedAssetValue}
              onChange={(e) => handlePropChange(prop.name, e.target.value)}
            >
              <option value="">Choose an image from assets…</option>
              {imageAssetOptions.map((assetPath) => (
                <option key={assetPath} value={assetPath}>
                  {assetPath}
                </option>
              ))}
            </select>
            <label htmlFor={`panel-${selectedElement.id}-src-manual`} style={{ ...styles.fieldSubLabel, marginTop: 8 }}>Or a path, URL or variable</label>
            <input
              id={`panel-${selectedElement.id}-src-manual`}
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

      // A component callback (`onRemove`) is an event, not a prop: it is
      // read from and written to the element's event map under its `@` key,
      // so the file says `@remove={drop(item)}` and the runtime wires the
      // handler up. Written as a string prop it reached the component as
      // text and did nothing.
      if (prop.type === 'event') {
        const key = eventKeyFor(prop.name);
        const id = `property-${selectedElement.id}-${prop.name}`;
        return (
          <div key={prop.name} style={styles.field}>
            <label htmlFor={id} style={styles.label}>@{key}</label>
            <HandlerField
              id={id}
              value={selectedElement.events?.[key] ?? ''}
              onChange={(value) => handleEventChange(key, value)}
              onBlur={endEdit}
              help={handlerHelp}
            />
          </div>
        );
      }

      return (
        <div key={prop.name} style={styles.field} onBlur={endEdit}>
          <label htmlFor={`property-${selectedElement.id}-${prop.name}`} style={styles.label}>{prop.name === 'children' ? 'Text' : prop.name}</label>
          <PropEditor
            id={`property-${selectedElement.id}-${prop.name}`}
            propDef={prop}
            value={selectedElement.props[prop.name]}
            onChange={(value) => handlePropChange(prop.name, value)}
          />
          {/* A text field shows its description as a placeholder; every
              other control would hide it, so it is said beneath. */}
          {prop.description && prop.type !== 'string' && prop.type !== 'json' && (
            <div style={styles.fieldHint}>{prop.description}</div>
          )}
        </div>
      );
    },
    [selectedElement, imageAssetOptions, handlePropChange, handleEventChange, endEdit, handlerHelp]
  );

  const header = (
    <div style={styles.header}>
      <span style={styles.headerTitle}>Properties</span>
      {onToggleDock && (
        <button className="bl-mini" onClick={onToggleDock} title="Hide the properties panel" aria-label="Hide properties panel">
          Hide
        </button>
      )}
    </div>
  );

  // Asked first: with several selected there is no single selected element,
  // and the panel used to say "Nothing selected" to a selection of three.
  if (selectedIds.length > 1) {
    return (
      <div style={styles.container}>
        {header}
        <div style={styles.empty}>
          <div style={styles.emptyTitle}>{selectedIds.length} elements selected</div>
          <div style={styles.emptyHint}>
            Properties are edited one element at a time: pick one to edit it. Copy, cut, duplicate and delete act on all of them.
          </div>
        </div>
      </div>
    );
  }

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
          <div style={styles.section} data-block-editor={selectedElement.block.kind} onBlur={endEdit}>
            <div style={styles.sectionHeader}>
              <div style={styles.sectionTitle}>Block</div>
            </div>
            <div style={styles.sectionBody}>
              {(selectedElement.block.kind === 'if' || selectedElement.block.kind === 'elseif') && (
                <div style={styles.field}>
                  <label htmlFor={`panel-${selectedElement.id}-condition-1`} style={styles.label}>condition</label>
                  <input
                    id={`panel-${selectedElement.id}-condition-1`}
                    type="text"
                    style={{ ...styles.input, fontFamily: 'var(--mono)' }}
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
                    <label htmlFor={`panel-${selectedElement.id}-item-2`} style={styles.label}>item</label>
                    <input
                      id={`panel-${selectedElement.id}-item-2`}
                      type="text"
                      style={{ ...styles.input, fontFamily: 'var(--mono)' }}
                      value={selectedElement.block.itemName || ''}
                      onChange={(e) => handleBlockChange('itemName', e.target.value)}
                      placeholder="item"
                      data-block-field="itemName"
                    />
                  </div>
                  <div style={styles.field}>
                    <label htmlFor={`panel-${selectedElement.id}-index-optional-3`} style={styles.label}>index (optional)</label>
                    <input
                      id={`panel-${selectedElement.id}-index-optional-3`}
                      type="text"
                      style={{ ...styles.input, fontFamily: 'var(--mono)' }}
                      value={selectedElement.block.indexName || ''}
                      onChange={(e) => handleBlockChange('indexName', e.target.value)}
                      placeholder="i"
                      data-block-field="indexName"
                    />
                  </div>
                  <div style={styles.field}>
                    <label htmlFor={`panel-${selectedElement.id}-in-list-4`} style={styles.label}>in list</label>
                    <input
                      id={`panel-${selectedElement.id}-in-list-4`}
                      type="text"
                      style={{ ...styles.input, fontFamily: 'var(--mono)' }}
                      value={selectedElement.block.iterable || ''}
                      onChange={(e) => handleBlockChange('iterable', e.target.value)}
                      placeholder="items"
                      data-block-field="iterable"
                    />
                  </div>
                  <div style={styles.field}>
                    <label htmlFor={`panel-${selectedElement.id}-key-optional-5`} style={styles.label}>key (optional)</label>
                    <input
                      id={`panel-${selectedElement.id}-key-optional-5`}
                      type="text"
                      style={{ ...styles.input, fontFamily: 'var(--mono)' }}
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
                    <button className="bl-btn bl-btn-sm" style={styles.actionBtn} onClick={() => addBranch('elseif')} data-block-action="add-elseif">
                      Add #elseif
                    </button>
                    {!existingBranches.has('else') && (
                      <button className="bl-btn bl-btn-sm" style={styles.actionBtn} onClick={() => addBranch('else')} data-block-action="add-else">
                        Add #else
                      </button>
                    )}
                  </>
                )}
                {selectedElement.block.kind === 'each' && !existingBranches.has('empty') && (
                  <button className="bl-btn bl-btn-sm" style={styles.actionBtn} onClick={() => addBranch('empty')} data-block-action="add-empty">
                    Add #empty
                  </button>
                )}
                {isBlockHead(selectedElement) ? (
                  <button
                    className="bl-btn bl-btn-sm"
                    style={styles.actionBtn}
                    onClick={unwrapSelected}
                    title="Remove the block; the elements of its main branch stay, its other branches go"
                    data-block-action="unwrap"
                  >
                    Unwrap
                  </button>
                ) : (
                  <button
                    className="bl-btn bl-btn-sm" style={{ ...styles.actionBtn, ...styles.actionBtnDanger }}
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
                <button className="bl-btn bl-btn-sm" style={styles.actionBtn} onClick={() => wrapSelected('if')} data-block-action="wrap-if">
                  Wrap in #if
                </button>
                <button className="bl-btn bl-btn-sm" style={styles.actionBtn} onClick={() => wrapSelected('each')} data-block-action="wrap-each">
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
                <button
                  type="button"
                  style={styles.sectionToggle}
                  onClick={() => toggleSection('main')}
                  aria-expanded={!isCollapsed('main')}
                >
                  <span>Main</span>
                  <span aria-hidden="true" style={{ ...styles.sectionChevron, transform: isCollapsed('main') ? undefined : 'rotate(90deg)' }}>›</span>
                </button>
                {!isCollapsed('main') && (
                  <div style={styles.sectionBody}>
                    {groupedProps.main.map((prop) => (
                      renderPropField(prop)
                    ))}
                  </div>
                )}
              </div>
            )}

            {groupedProps.accessibility.length > 0 && (
              <div style={styles.section} data-prop-group="accessibility">
                <button
                  type="button"
                  style={styles.sectionToggle}
                  onClick={() => toggleSection('accessibility')}
                  aria-expanded={!isCollapsed('accessibility')}
                >
                  <span>Accessibility</span>
                  <span aria-hidden="true" style={{ ...styles.sectionChevron, transform: isCollapsed('accessibility') ? undefined : 'rotate(90deg)' }}>›</span>
                </button>
                {!isCollapsed('accessibility') && (
                  <div style={styles.sectionBody}>
                    {groupedProps.accessibility.map((prop) => (
                      renderPropField(prop)
                    ))}
                  </div>
                )}
              </div>
            )}

            {groupedProps.advanced.length > 0 && (
              <div style={styles.section}>
                <button
                  type="button"
                  style={styles.sectionToggle}
                  onClick={() => toggleSection('advanced')}
                  aria-expanded={!isCollapsed('advanced')}
                >
                  <span>Advanced</span>
                  <span aria-hidden="true" style={{ ...styles.sectionChevron, transform: isCollapsed('advanced') ? undefined : 'rotate(90deg)' }}>›</span>
                </button>
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
                <button
                  type="button"
                  style={styles.sectionToggle}
                  onClick={() => toggleSection('style')}
                  aria-expanded={!isCollapsed('style')}
                >
                  <span>Style</span>
                  <span aria-hidden="true" style={{ ...styles.sectionChevron, transform: isCollapsed('style') ? undefined : 'rotate(90deg)' }}>›</span>
                </button>
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
                <button
                  type="button"
                  style={styles.sectionToggle}
                  onClick={() => toggleSection('schemaEvents')}
                  aria-expanded={!isCollapsed('schemaEvents')}
                >
                  <span>Component events</span>
                  <span aria-hidden="true" style={{ ...styles.sectionChevron, transform: isCollapsed('schemaEvents') ? undefined : 'rotate(90deg)' }}>›</span>
                </button>
                {!isCollapsed('schemaEvents') && (
                  <div style={styles.sectionBody}>
                    <div style={styles.sectionNote}>{handlerNote(handlerHelp)}</div>
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
          <button
            type="button"
            style={styles.sectionToggle}
            onClick={() => toggleSection('handlers')}
            aria-expanded={!isCollapsed('handlers')}
          >
            <span>Event handlers</span>
            <span aria-hidden="true" style={{ ...styles.sectionChevron, transform: isCollapsed('handlers') ? undefined : 'rotate(90deg)' }}>›</span>
          </button>
          {!isCollapsed('handlers') && (
            <div style={styles.sectionBody}>
              {!groupedProps?.events.length && <div style={styles.sectionNote}>{handlerNote(handlerHelp)}</div>}
              {genericEvents.map((eventName) => {
                const value = selectedElement.events?.[eventName] || '';
                const id = `handler-${selectedElement.id}-${eventName}`;
                return (
                  <div key={eventName} style={styles.field}>
                    <label htmlFor={id} style={styles.label}>@{eventName}</label>
                    <HandlerField
                      id={id}
                      value={value}
                      onChange={(next) => handleEventChange(eventName, next)}
                      onBlur={endEdit}
                      help={handlerHelp}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={styles.section}>
          <button
            type="button"
            style={styles.sectionToggle}
            onClick={() => toggleSection('bindings')}
            aria-expanded={!isCollapsed('bindings')}
          >
            <span>Bindings</span>
            <span aria-hidden="true" style={{ ...styles.sectionChevron, transform: isCollapsed('bindings') ? undefined : 'rotate(90deg)' }}>›</span>
          </button>
          {!isCollapsed('bindings') && (
            <div style={styles.sectionBody} onBlur={endEdit}>
              {['bind', 'value', 'checked', 'selected', 'disabled', 'visible', 'class', 'style'].map((bindingName) => {
                const value = selectedElement.bindings?.[bindingName] || '';
                return (
                  <div key={bindingName} style={styles.field}>
                    <label htmlFor={`panel-${selectedElement.id}-bind-${bindingName}`} style={styles.label}>:{bindingName}</label>
                    <input
                      id={`panel-${selectedElement.id}-bind-${bindingName}`}
                      type="text"
                      style={{ ...styles.input, fontFamily: 'var(--mono)' }}
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
          <button
            type="button"
            style={styles.sectionToggle}
            onClick={() => toggleSection('directives')}
            aria-expanded={!isCollapsed('directives')}
          >
            <span>Directives</span>
            <span aria-hidden="true" style={{ ...styles.sectionChevron, transform: isCollapsed('directives') ? undefined : 'rotate(90deg)' }}>›</span>
          </button>
          {!isCollapsed('directives') && (
            <div style={styles.sectionBody} onBlur={endEdit}>
              <div style={styles.field}>
                <label htmlFor={`panel-${selectedElement.id}-if-6`} style={styles.label}>if</label>
                <input
                  id={`panel-${selectedElement.id}-if-6`}
                  type="text"
                  style={{ ...styles.input, fontFamily: 'var(--mono)' }}
                  value={selectedElement.conditionalIf || ''}
                  onChange={(e) => handleDirectiveChange('conditionalIf', e.target.value)}
                  placeholder="condition"
                />
              </div>
              <div style={styles.field}>
                <label htmlFor={`panel-${selectedElement.id}-each-7`} style={styles.label}>each</label>
                <input
                  id={`panel-${selectedElement.id}-each-7`}
                  type="text"
                  style={{ ...styles.input, fontFamily: 'var(--mono)' }}
                  value={selectedElement.loopEach || ''}
                  onChange={(e) => handleDirectiveChange('loopEach', e.target.value)}
                  placeholder="collection"
                />
              </div>
              <div style={styles.field}>
                <label htmlFor={`panel-${selectedElement.id}-as-8`} style={styles.label}>as</label>
                <input
                  id={`panel-${selectedElement.id}-as-8`}
                  type="text"
                  style={{ ...styles.input, fontFamily: 'var(--mono)' }}
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
