/**
 * PropertyPanel - the properties of what is selected on the canvas.
 *
 * It names the selection and what can be done to it (move, duplicate,
 * delete), then the element's own properties, then the groups a person goes
 * to less often, the seldom-needed ones folded to their headings. A new
 * selection is read from the top.
 *
 * Its look is classes in styles/builder.css ("Properties panel"), which go
 * by the panel's own width: it stands in a column beside the canvas and, on
 * a phone or a tablet, in a sheet as wide as the screen.
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import { useProjectStore } from '../../stores/projectStore';
import { toast } from '../../stores/notificationStore';
import { useCurrentAssets } from '../../utils/projectAssets';
import { PICTURE_ACCEPT, PICTURE_PATTERN, addAssetFiles } from '../../utils/addAssets';
import { assetCall, assetCallPath } from '../../utils/assetSource';
import { isRemoteAddress, remoteShown, showRemotePicture, useShownPictures } from '../../utils/remotePictures';
import { useFilesStore } from '../../stores/filesStore';
import { ACCESSIBILITY_PROP_NAMES, getComponentMeta } from '../../utils/componentRegistry';
import { dockLogicFile, entryFileId, logicLanguageOf, resolveImportPath, type LogicLanguage } from '../../utils/logicFiles';
import { callArgumentCount, callableNames, endsFinished, handlerFor, handlerTarget, isFunctionName, logicFunctions, withNewFunction, type LogicFunction } from '../../utils/logicFunctions';
import { eventKeyFor } from '../../utils/eventProps';
import { nativeElementMeta } from '../../utils/nativeHtmlMetadata';
import { blockHeaderText } from '../../utils/sourceGenerator';
import { blockDescription, hasTextField, isBlockHead, isTextNode, textNodeMeta } from '../../utils/blocks';
import { controlFor, propState, shownValue, withProp, writtenValue, type PropControl, type PropState } from '../../utils/propValues';
import type { CanvasBlock, PropSchema } from '../../types/builder';
import { PAGE_TYPE } from '../../types/builder';
import { ExpressionField } from './ExpressionField';
import { GrowingField } from './GrowingField';
import { ProjectThemeField } from './ProjectThemeField';
import { SelectionActions } from './SelectionActions';

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
  /** The files-store id of that file, for writing a new function into it. */
  logicId: string | null;
  /** Whether the file ends where a new function can be written (utils/logicFunctions.ts, endsFinished). */
  finished: boolean;
  language: LogicLanguage;
  functions: LogicFunction[];
  callable: Set<string>;
}

function useHandlerHelp(): HandlerHelp {
  const retainedSource = useProjectStore((state) => state.source);
  const activeFileId = useFilesStore((state) => state.activeFileId);
  const uiFiles = useFilesStore((state) => state.uiFiles);
  const logicFiles = useFilesStore((state) => state.logicFiles);
  // The page the selected element is on. With a logic file or an asset open
  // the panel still holds the last page (hooks/useActiveFileOnCanvas.ts), and
  // the logic was read from the file that was open, which is no page: the
  // entry's logic was offered, and a handler made from here went there.
  const canvasPageId = useCanvasStore((state) => state.pageId);
  const pageId = activeFileId && uiFiles.has(activeFileId) ? activeFileId : canvasPageId ?? activeFileId;
  return useMemo(() => {
    const file = dockLogicFile(pageId, uiFiles, logicFiles, entryFileId(uiFiles, retainedSource));
    if (!file) return { logicPath: null, logicId: null, finished: false, language: 'javascript', functions: [], callable: new Set<string>() };
    const language = logicLanguageOf(file.path);
    // JavaScript logic files are composed into one scope, so a helper's
    // functions are callable too; a Python module's are callable only as
    // the linked module defines or imports them.
    const scope = language === 'python'
      ? [file.content]
      : [...logicFiles.values()].filter((other) => logicLanguageOf(other.path) === language).map((other) => other.content);
    return {
      logicPath: file.path,
      logicId: file.id,
      finished: endsFinished(file.content, language),
      language,
      functions: logicFunctions(file.content, language),
      callable: callableNames(scope, language),
    };
  }, [pageId, uiFiles, logicFiles, retainedSource]);
}

/** How many of the logic file's functions a handler field offers at once. */
const HANDLER_SUGGESTIONS = 8;

interface HandlerFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  help: HandlerHelp;
  /** Make the function the handler names, in the logic file the page runs. */
  onCreate: (name: string) => void;
}

/**
 * A handler field: free text, as a handler may be any expression, with the
 * logic file's functions offered as suggestions and a warning — never a
 * refusal — when it calls a function the file does not define.
 */
function HandlerField({ id, value, onChange, onBlur, help, onCreate }: HandlerFieldProps) {
  const target = handlerTarget(value);
  const missing = help.logicPath && target && !help.callable.has(target) ? target : null;
  // The logic file's functions, offered while the field is empty or holds the start of a
  // name: once it holds a handler there is nothing left to suggest. They were the options of
  // a one-line box's list; the box grows now (GrowingField.tsx), and a box of several lines
  // has no such list, so they stand under it while it has the focus.
  const start = value.trim();
  const named = /^[A-Za-z_$][\w$]*$/.test(start);
  const matching = start === '' || named ? help.functions.filter((fn) => fn.name.toLowerCase().startsWith(start.toLowerCase())) : [];
  const offered = matching.slice(0, HANDLER_SUGGESTIONS);
  return (
    <div className="bl-pp-handler">
      <GrowingField
        id={id}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        placeholder="handler()"
        lines
      />
      {offered.length > 0 && (
        <div className="bl-pp-suggest" role="group" aria-label={`Functions in ${help.logicPath}`} data-handler-suggestions>
          {offered.map((fn) => (
            <button
              key={fn.name}
              type="button"
              className="bl-pp-chip"
              title={`${fn.name}(${fn.params})`}
              data-suggest={fn.name}
              // The press does not take the focus from the field it fills.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChange(handlerFor(fn, help.language))}
            >
              {fn.name}
            </button>
          ))}
          {matching.length > offered.length && <span className="bl-pp-chip-more">{`and ${matching.length - offered.length} more: type the start of a name`}</span>}
        </div>
      )}
      {missing && (
        <div className="bl-pp-warning" role="status" data-handler-warning={missing}>
          {`No function named ${missing} in ${help.logicPath}.`}
        </div>
      )}
      {/* The way on from the warning: the function, empty, at the end of
          the file. Not where the name is one the language cannot take, nor
          while the file ends inside something unfinished, where what was
          added would land in the middle of it. */}
      {missing && isFunctionName(missing, help.language) && (help.finished ? (
        <button type="button" className="bl-btn bl-btn-sm" style={{ marginTop: 6 }} onClick={() => onCreate(missing)} data-action="create-handler">
          {`Create ${missing}`}
        </button>
      ) : (
        <div className="bl-pp-hint" data-handler-unfinished>
          {`${help.logicPath} ends inside something unfinished (an open bracket, string or comment). Finish it, and ${missing} can be created from here.`}
        </div>
      ))}
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
  /** The property as the model holds it: its value, and whether that is an expression. */
  state: PropState;
  /** Called with the property as it should now be held. */
  onChange: (next: PropState) => void;
  /** Ends the run of edits that Undo takes back as one step. */
  endEdit: () => void;
}

interface PropertyPanelProps {
  onToggleDock?: () => void;
}

function PropEditor({ id, propDef, state, onChange, endEdit }: PropEditorProps) {
  const control = controlFor(propDef, state);
  const shown = shownValue(propDef, state);
  const write = (input: string | number | boolean): boolean => {
    const next = writtenValue(propDef, state, input);
    if (next) onChange(next);
    return next !== null;
  };

  switch (control) {
    case 'string':
      return (
        <input
          id={id}
          type="text"
          className="bl-pp-control"
          value={shown as string}
          onChange={(e) => write(e.target.value)}
          placeholder={propDef.description}
        />
      );

    case 'number':
      return (
        <input
          id={id}
          type="number"
          className="bl-pp-control"
          value={shown as number | string}
          onChange={(e) => write(e.target.value)}
        />
      );

    // A tick beside its label; ticked or not says all that "Yes" and "No" after it did.
    case 'boolean':
      return (
        <input
          id={id}
          type="checkbox"
          className="bl-pp-check"
          checked={shown === true}
          onChange={(e) => write(e.target.checked)}
        />
      );

    case 'select':
      return (
        <select
          id={id}
          className="bl-pp-control"
          value={shown as string}
          onChange={(e) => write(e.target.value)}
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
        <div className="bl-pp-row">
          <input
            id={id}
            type="color"
            className="bl-pp-swatch"
            value={(shown as string) || '#000000'}
            onChange={(e) => write(e.target.value)}
          />
          {/* The label names the picker; this is the same colour, typed. */}
          <input
            type="text"
            className="bl-pp-control"
            value={shown as string}
            onChange={(e) => write(e.target.value)}
            placeholder="#000000"
            aria-label={`${propDef.name}, as text`}
          />
        </div>
      );

    // An expression, and a list or a record, which is an expression that is
    // one: the same box, as tall as what is in it (ExpressionField.tsx).
    case 'expression':
    case 'json':
      return (
        <ExpressionField
          id={id}
          shown={shown as string}
          placeholder={
            control === 'json'
              ? propDef.description || 'a list, a record or a name from the logic'
              : propDef.type === 'expression'
                ? 'an expression, such as count > 0'
                : 'an expression; empty it for the usual control'
          }
          onInput={write}
          written={(text) => {
            const next = writtenValue(propDef, state, text);
            return next !== null && next.isExpression && typeof next.value === 'string' ? next.value : null;
          }}
          endEdit={endEdit}
        />
      );
  }
}

interface GroupProps {
  /** The group's key: what `data-prop-group` says, and what its being open is kept under. */
  name: string;
  title: string;
  open: boolean;
  onToggle: (name: string) => void;
  /** How many of its fields hold something: said on the heading while the group is closed. */
  set?: number;
  onBlur?: () => void;
  children: React.ReactNode;
}

/**
 * A group of fields that folds to its heading. They were cards, each with a
 * border, a header bar and padding of its own inside the panel's: a line and
 * a small heading now, with the fields at the panel's own edge. Closed over
 * something that is set, the heading says how many are.
 */
function Group({ name, title, open, onToggle, set = 0, onBlur, children }: GroupProps) {
  const hidden = !open && set > 0;
  return (
    <section className="bl-pp-group" data-prop-group={name}>
      <button type="button" className="bl-pp-group-head" onClick={() => onToggle(name)} aria-expanded={open}>
        <span>{title}</span>
        <span className="bl-pp-group-set" data-group-set={hidden ? set : undefined}>{hidden ? `${set} set` : ''}</span>
        <svg className="bl-pp-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.5 1.5 7 5 3.5 8.5" />
        </svg>
      </button>
      {open && (
        <div className="bl-pp-group-body" onBlur={onBlur}>
          {children}
        </div>
      )}
    </section>
  );
}

/** The groups a person seldom needs: closed until asked for, unless something in them is set. */
const STARTS_CLOSED: ReadonlySet<string> = new Set(['bindings', 'handlers', 'style', 'directives']);

/** The bindings the panel offers on every component. */
const BINDINGS = ['bind', 'value', 'checked', 'selected', 'disabled', 'visible', 'class', 'style'];

/**
 * The controls that stand beside their label on one line: a choice, a
 * number, a tick, a colour, a word or two of text. An expression has the
 * panel's width under its label, since it may be a list; so do an element's
 * words. Which it is goes by the kind of field and never by how much is in
 * it, so a field does not move while it is typed in.
 */
const BESIDE_LABEL: ReadonlySet<PropControl> = new Set<PropControl>(['string', 'number', 'boolean', 'select', 'color']);

/** A plain text property, for a field that is one whatever the registry calls it. */
const STRING_PROP: PropSchema = { name: 'src', type: 'string' };

/** What a `:binding` holds: an expression and nothing else. */
const BINDING_PROP: PropSchema = { name: 'bind', type: 'expression' };

export function PropertyPanel({ onToggleDock }: PropertyPanelProps) {
  const selectedIds = useCanvasStore(s => s.selectedIds);
  const updateElement = useCanvasStore(s => s.updateElement);
  const selectedElement = useCanvasStore(s =>
    s.selectedIds.length === 1 ? s.elements.get(s.selectedIds[0]) ?? null : null
  );
  const push = useHistoryStore(s => s.push);
  // Leaving a field ends its run of edits: the next edit to it is a step of its own.
  const endEdit = useHistoryStore(s => s.endCoalescing);
  const handlerHelp = useHandlerHelp();
  const assets = useCurrentAssets();
  // The groups a person has opened or closed by hand, which stay so from one
  // element to the next while the panel is up; and the selected element with
  // the groups that held something when it was picked (see `isOpen`).
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState<{ id: string | null; held: string[] }>({ id: null, held: [] });
  // The part of the panel that scrolls.
  const body = useRef<HTMLDivElement>(null);

  const meta = useMemo(() => {
    if (selectedElement && isTextNode(selectedElement)) return textNodeMeta;
    if (selectedElement) return nativeElementMeta(selectedElement) ?? getComponentMeta(selectedElement.componentType);
    return null;
  }, [selectedElement]);

  const handlePropChange = useCallback(
    (propName: string, next: PropState) => {
      if (!selectedElement) return;
      const { elements, rootId } = useCanvasStore.getState();
      // Keyed by field, so typing into one is a single undo step, not one per
      // keystroke; the other field handlers below are keyed the same way.
      push(elements, rootId, `${selectedElement.id}:prop:${propName}`);
      // The value and whether it is an expression are one change: a field
      // that wrote only the value left text under an expression's braces.
      const current = elements.get(selectedElement.id) ?? selectedElement;
      updateElement(selectedElement.id, withProp(current, propName, next));
    },
    [selectedElement, push, updateElement]
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

  // The function a handler names, made in the logic file the page runs: one
  // step for Undo, the file and the canvas together (the step carries the
  // file's text, and utils/canvasHistory.ts puts it back).
  const createHandler = useCallback(
    (eventName: string, name: string) => {
      if (!selectedElement || !handlerHelp.logicId) return;
      const files = useFilesStore.getState();
      const file = files.logicFiles.get(handlerHelp.logicId);
      if (!file) return;
      const { elements, rootId } = useCanvasStore.getState();
      const element = elements.get(selectedElement.id) ?? selectedElement;
      const handler = element.events?.[eventName] ?? '';
      const next = withNewFunction(file.content, name, callArgumentCount(handler), handlerHelp.language);
      if (next === null) return;
      endEdit();
      push(elements, rootId, undefined, [{ id: file.id, content: file.content, expects: next }]);
      files.updateLogicFile(file.id, next);
      // Bound by its bare name a handler is called with the event, which a
      // Python function taking nothing refuses: it is called through an
      // arrow that drops the event, as one picked from the suggestions is.
      if (handlerHelp.language === 'python' && handler.trim() === name) {
        updateElement(element.id, { events: { ...(element.events ?? {}), [eventName]: handlerFor({ name, params: '' }, 'python') } });
      }
    },
    [selectedElement, handlerHelp, push, endEdit, updateElement]
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

  // Whether the selected element's content is edited as the elements it
  // holds, and not in a Text field of its own.
  const wordsAmongElements =
    selectedElement !== null && !isTextNode(selectedElement) && selectedElement.children.length > 0 && hasTextField(selectedElement.componentType);

  // A page of the project used on this one: the path its import is written
  // with, where the selected element's name is one the page imports.
  const importedSource = useCanvasStore((s) =>
    selectedElement && !selectedElement.block ? s.imports.find((imp) => imp.name === selectedElement.componentType)?.source : undefined
  );
  const pagePath = useFilesStore((s) => (s.activeFileId ? s.uiFiles.get(s.activeFileId)?.path : undefined));
  const importedPath =
    importedSource === undefined || pagePath === undefined
      ? undefined
      : importedSource.startsWith('@')
        ? importedSource
        : resolveImportPath(pagePath.replace(/^\//, ''), importedSource);
  const importedFileId = useFilesStore((s) =>
    importedPath === undefined ? undefined : [...s.uiFiles.values()].find((file) => file.path.replace(/^\//, '') === importedPath)?.id
  );

  // The page itself: the root of the file, where it is an App.
  const isPage = useCanvasStore((s) => selectedElement !== null && selectedElement.id === s.rootId && selectedElement.componentType === PAGE_TYPE);

  // Whether any of what it holds is words, which the note under its name
  // sends a person to; one that holds an Icon and nothing else has none.
  const holdsWords = useCanvasStore((s) =>
    wordsAmongElements && selectedElement !== null && selectedElement.children.some((id) => {
      const child = s.elements.get(id);
      return child !== undefined && isTextNode(child);
    })
  );

  const groupedProps = useMemo(() => {
    if (!meta) return null;

    // `own` is what the component takes and no other group does: its words,
    // its look, its data. Those are first in the panel, under no heading.
    const groups: { own: PropSchema[]; accessibility: PropSchema[]; style: PropSchema[]; events: PropSchema[] } = { own: [], accessibility: [], style: [], events: [] };

    for (const prop of meta.propSchema) {
      // Words that stand among elements are elements themselves, each with
      // its own field. A Text field here wrote text the file never got: the
      // generator writes an element's children, or its text, not both.
      if (prop.name === 'children' && wordsAmongElements) continue;
      if (prop.type === 'event') groups.events.push(prop);
      else if (prop.name === 'className' || prop.name === 'style') groups.style.push(prop);
      else if (ACCESSIBILITY_PROP_NAMES.has(prop.name)) groups.accessibility.push(prop);
      else groups.own.push(prop);
    }

    return groups;
  }, [meta, wordsAmongElements]);

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

  const picturesShown = useShownPictures();
  // Each picture at the path it has in the project, which is what `asset("…")`
  // is given: `assets/` was put before every path, so a picture a bundle keeps
  // elsewhere (`images/hero.png`) was offered where the app has no file. One
  // with no path of its own is under assets/, where the export writes it.
  const imageAssetOptions = useMemo(
    () =>
      assets
        .map((asset) => asset.bundlePath ?? `assets/${asset.name.replace(/^assets\//, '')}`)
        .filter((path) => PICTURE_PATTERN.test(path))
        .sort((a, b) => a.localeCompare(b)),
    [assets]
  );

  // A picture from the person's computer: into the project's assets, and
  // then the source of the element it was asked for (utils/addAssets.ts).
  const pictureInput = useRef<HTMLInputElement>(null);
  const takePicture = useCallback(
    async (file: File | undefined, propName: string) => {
      if (!file) return;
      if (!PICTURE_PATTERN.test(file.name)) {
        toast.error(`${file.name} is not a picture this can show. Choose a PNG, JPEG, GIF, WebP, SVG or BMP.`);
        return;
      }
      const { added, refused } = await addAssetFiles([file]);
      if (refused.length > 0) toast.error(refused[0]);
      if (added.length > 0) handlePropChange(propName, { value: assetCall(added[0].path), isExpression: true });
    },
    [handlePropChange]
  );

  const renderPropField = useCallback(
    (prop: PropSchema) => {
      if (!selectedElement) return null;

      const currentValue = selectedElement.props[prop.name];
      // A picture: an Image's, and an Avatar's, which had no list of the
      // project's pictures and so no way to be given one but by typing.
      const isImageSrc = (selectedElement.componentType === 'Image' || selectedElement.componentType === 'Avatar') && prop.name === 'src';

      if (isImageSrc) {
        const normalizedCurrent = String(currentValue || '').trim();
        // The app is given a file of its own by `asset("…")` (utils/
        // assetSource.ts). This list wrote the bare path, which the canvas
        // drew and the app could not load; a path written before is said to
        // be one, and choosing the picture again writes it as the app reads it.
        const srcIsExpression = propState(selectedElement, prop.name).isExpression;
        const calledPath = srcIsExpression ? assetCallPath(normalizedCurrent) : null;
        const selectedAssetValue = calledPath !== null && imageAssetOptions.includes(calledPath) ? calledPath : '';
        const writtenAsPath = !srcIsExpression && imageAssetOptions.includes(normalizedCurrent.replace(/^\.\//, ''));

        return (
          <div key={prop.name} className="bl-pp-field">
            <span className="bl-pp-label">{prop.name}</span>
            <label htmlFor={`panel-${selectedElement.id}-src-asset`} className="bl-pp-sub">Asset</label>
            <div className="bl-pp-row">
              <select
                id={`panel-${selectedElement.id}-src-asset`}
                className="bl-pp-control"
                value={selectedAssetValue}
                onChange={(e) =>
                  handlePropChange(prop.name, e.target.value ? { value: assetCall(e.target.value), isExpression: true } : { value: undefined, isExpression: false })
                }
              >
                <option value="">{imageAssetOptions.length === 0 ? 'No pictures yet' : 'Choose a picture…'}</option>
                {imageAssetOptions.map((assetPath) => (
                  <option key={assetPath} value={assetPath}>
                    {assetPath}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="bl-btn bl-btn-sm"
                style={{ flexShrink: 0 }}
                data-action="add-picture"
                title="Add a picture from your computer to the project, and show it here"
                aria-label="Add a picture from your computer"
                onClick={() => pictureInput.current?.click()}
              >
                Add…
              </button>
              <input
                ref={pictureInput}
                type="file"
                accept={PICTURE_ACCEPT}
                hidden
                tabIndex={-1}
                aria-hidden="true"
                data-add-picture-input=""
                onChange={(e) => {
                  const picked = e.target.files?.[0];
                  // Emptied, so that the same file can be picked again.
                  e.target.value = '';
                  void takePicture(picked, prop.name);
                }}
              />
            </div>
            <label htmlFor={`panel-${selectedElement.id}-src-manual`} className="bl-pp-sub" style={{ marginTop: 6 }}>Or a URL, or a value from the logic</label>
            <input
              id={`panel-${selectedElement.id}-src-manual`}
              type="text"
              className="bl-pp-control"
              value={shownValue(STRING_PROP, propState(selectedElement, prop.name)) as string}
              onChange={(e) => {
                const next = writtenValue(STRING_PROP, propState(selectedElement, prop.name), e.target.value);
                if (next) handlePropChange(prop.name, next);
              }}
              placeholder="https://… or {appIconUrl}"
            />
            {/* A picture at an address is not fetched by the canvas until it is asked for
                (utils/remotePictures.ts). The canvas offers that beside the picture's place; this is
                the same, where the keyboard reaches. */}
            {selectedElement.componentType === 'Image' && !srcIsExpression && isRemoteAddress(normalizedCurrent) && !remoteShown(normalizedCurrent) && (
              <div className="bl-notice" role="status" data-remote-picture-note="" style={{ marginTop: 6, borderRadius: 'var(--bl-radius-sm)' }}>
                Not loaded on the canvas: it asks nothing of another site until you say so.{' '}
                <button type="button" className="bl-btn bl-btn-sm" data-action="show-remote-picture-panel" onClick={() => showRemotePicture(normalizedCurrent)}>
                  Show it on the canvas
                </button>
              </div>
            )}
            {writtenAsPath && (
              <div className="bl-notice" role="status" data-src-as-path="" style={{ marginTop: 6, borderRadius: 'var(--bl-radius-sm)' }}>
                {normalizedCurrent} is written as a path, which the app does not load. Choose it under Asset to write it as the app reads it.
              </div>
            )}
            <div className="bl-pp-hint">
              Choose a picture of the project or add one from your computer, or write a URL or data URI, or a value from the logic in braces: {'{appIconUrl}'}.
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
          <div key={prop.name} className="bl-pp-field" data-inline="">
            <label htmlFor={id} className="bl-pp-label">@{key}</label>
            <HandlerField
              id={id}
              value={selectedElement.events?.[key] ?? ''}
              onChange={(value) => handleEventChange(key, value)}
              onBlur={endEdit}
              help={handlerHelp}
              onCreate={(name) => createHandler(key, name)}
            />
          </div>
        );
      }

      const state = propState(selectedElement, prop.name);
      const control = controlFor(prop, state);
      const id = `property-${selectedElement.id}-${prop.name}`;
      const beside = prop.name !== 'children' && BESIDE_LABEL.has(control);
      return (
        <div key={prop.name} className="bl-pp-field" data-control={control} data-inline={beside ? '' : undefined} onBlur={endEdit}>
          <label htmlFor={id} className="bl-pp-label">{prop.name === 'children' ? 'Text' : prop.name}</label>
          <PropEditor
            id={id}
            propDef={prop}
            state={state}
            onChange={(next) => handlePropChange(prop.name, next)}
            endEdit={endEdit}
          />
          {/* A text field shows its description as a placeholder; every
              other control would hide it, so it is said beneath. */}
          {prop.description && prop.type !== 'string' && prop.type !== 'json' && (
            <div className="bl-pp-hint">{prop.description}</div>
          )}
        </div>
      );
    },
    // picturesShown: the note under a picture's address goes when the picture has been asked for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedElement, imageAssetOptions, handlePropChange, handleEventChange, endEdit, handlerHelp, createHandler, picturesShown, takePicture]
  );

  // How many fields of each group hold something. A group that is closed
  // over any of them says so on its heading, so nothing set is out of sight
  // without a sign of it.
  const setIn = useMemo((): Record<string, number> => {
    if (!selectedElement || !groupedProps) return {};
    const written = (prop: PropSchema) => selectedElement.props[prop.name] !== undefined && selectedElement.props[prop.name] !== null;
    return {
      events: groupedProps.events.filter((prop) => Boolean(selectedElement.events?.[eventKeyFor(prop.name)])).length,
      accessibility: groupedProps.accessibility.filter(written).length,
      bindings: BINDINGS.filter((name) => Boolean(selectedElement.bindings?.[name])).length,
      handlers: genericEvents.filter((name) => Boolean(selectedElement.events?.[name])).length,
      style: groupedProps.style.filter(written).length,
      directives: [selectedElement.conditionalIf, selectedElement.loopEach, selectedElement.loopAs].filter(Boolean).length,
    };
  }, [selectedElement, groupedProps, genericEvents]);

  // The groups that held something when this element was picked: those are
  // open from the start, the seldom-needed ones too. Asked once for each
  // element and not as it is edited, or the group a person is typing in
  // would fold under them when they emptied its last field.
  const pickedId = selectedElement?.id ?? null;
  let heldAtPick = picked.held;
  if (picked.id !== pickedId) {
    heldAtPick = Object.keys(setIn).filter((name) => setIn[name] > 0);
    setPicked({ id: pickedId, held: heldAtPick });
  }
  // An element with no fields of its own (a component the Builder does not
  // know) has its groups and nothing else: folded, the panel would look as
  // if there were nothing to set on it.
  const bare = !groupedProps || (groupedProps.own.length === 0 && groupedProps.events.length === 0 && groupedProps.accessibility.length === 0);
  const isOpen = (name: string): boolean => toggled[name] ?? (bare || !STARTS_CLOSED.has(name) || heldAtPick.includes(name));
  const toggleGroup = (name: string) => setToggled((before) => ({ ...before, [name]: !isOpen(name) }));

  // A new selection is read from its top. The panel kept the place the last
  // element was scrolled to, so the next one opened at its last group.
  // Typing in a field selects nothing, and moves nothing.
  const selectionKey = selectedIds.join(' ');
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [selectionKey]);

  // The buttons that deleted it went with the selection, and the focus with
  // them. The canvas is given it where it can take it (selectionMoves.ts);
  // in a sheet over the canvas it cannot, and the panel keeps it.
  const afterDelete = useCallback(() => {
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (now instanceof HTMLElement && now !== document.body && now.isConnected) return;
      body.current?.focus();
    });
  }, []);

  // What is selected, as the header names it: an element's tag as the source
  // would show it, a block's own first line, or how many elements.
  const several = selectedIds.length > 1;
  const selectionName = several
    ? `${selectedIds.length} elements selected`
    : selectedElement
      ? blockHeaderText(selectedElement) ?? (isTextNode(selectedElement) ? 'Words' : selectedElement.componentType)
      : null;
  // What it is, in the component's own few words, beside the name: it had
  // lines of its own above the fields. Not of a page used inside another,
  // which is said what it is at more length below.
  const selectionKind = !several && importedPath === undefined ? meta?.description ?? null : null;

  const themeGroup = (
    <Group name="theme" title="Project theme" open={isOpen('theme')} onToggle={toggleGroup}>
      <ProjectThemeField />
    </Group>
  );

  // Last in the panel, and small: it is seldom wanted, and it stood above
  // every element's own properties as a card with two lines of explanation.
  const wrapRow = selectedElement && !selectedElement.block && selectedElement.parentId && (
    <div className="bl-pp-group bl-pp-wrap" data-prop-group="control-flow">
      <div className="bl-pp-buttons">
        <button type="button" className="bl-btn bl-btn-sm bl-pp-mono" onClick={() => wrapSelected('if')} data-block-action="wrap-if">
          Wrap in #if
        </button>
        <button type="button" className="bl-btn bl-btn-sm bl-pp-mono" onClick={() => wrapSelected('each')} data-block-action="wrap-each">
          Wrap in #each
        </button>
      </div>
      <div className="bl-pp-hint">The condition or list is edited on the block.</div>
    </div>
  );

  let content: React.ReactNode;

  if (several) {
    // Asked first: with several selected there is no single selected element,
    // and the panel used to say "Nothing selected" to a selection of three.
    content = (
      <div className="bl-pp-block">
        <div className="bl-pp-about">
          Properties are edited one element at a time: pick one to edit it. Duplicate and delete, above, act on all of them.
        </div>
      </div>
    );
  } else if (!selectedElement) {
    // Said at the top, in a line or two. It was a picture, a title and a
    // paragraph centred in the height of the column, with the project's
    // theme, which is what there is to change here, at the bottom of it.
    content = (
      <>
        <div className="bl-pp-block" data-nothing-selected="">
          <div className="bl-pp-lead">Nothing selected</div>
          <div className="bl-pp-about">Pick an element on the canvas or in the hierarchy to change it here.</div>
        </div>
        {/* What belongs to the project and to no element. */}
        {themeGroup}
      </>
    );
  } else if (importedPath !== undefined) {
    // A page used inside another is an include: the app is put together by
    // putting its content where the tag stands, in this page's own scope, and
    // what is written on the tag is dropped (core, source-composer.ts). So it
    // is offered no property, event or binding, which would each do nothing;
    // it is said what it is, and its file is a press away.
    content = (
      <>
        <div className="bl-pp-block">
          <div className="bl-pp-about" data-imported-page="">
            A page used inside another is its content; it reads this page’s state.
          </div>
          <div className="bl-pp-about bl-pp-mono" style={{ overflowWrap: 'anywhere' }}>{importedPath}</div>
          {importedFileId ? (
            <button
              type="button"
              className="bl-btn bl-btn-sm"
              data-action="open-imported-page"
              onClick={() => useFilesStore.getState().openFile(importedFileId)}
            >
              Open {importedPath}
            </button>
          ) : (
            <div className="bl-pp-hint" data-imported-missing="">
              The project has no {importedPath}: where this is used the app will say “Unknown component”. Make the file, or take this element out.
            </div>
          )}
          <div className="bl-pp-hint">
            What is written on its tag, and anything put inside it, is dropped when the app is put together. What it shows is changed in its own file.
          </div>
        </div>
        {wrapRow}
      </>
    );
  } else {
    const block = selectedElement.block;
    // The element's own properties, first: its words, then the rest in the
    // order the component lists them. They were two cards, Main and
    // Advanced, under a card for control flow, and most of what a component
    // takes (a list's `data`, an Input's `value`) was in the second.
    const listed = groupedProps?.own ?? [];
    const own = [...listed.filter((prop) => prop.name === 'children'), ...listed.filter((prop) => prop.name !== 'children')];
    const events = groupedProps?.events ?? [];
    const accessibility = groupedProps?.accessibility ?? [];
    const style = groupedProps?.style ?? [];
    // Handlers, bindings and inline directives are a component's; a block
    // has none, and its header is its own fields above. Words have none either.
    const component = !block && !isTextNode(selectedElement);

    content = (
      <>
        <div className="bl-pp-block">
          {block && <div className="bl-pp-about">{blockDescription(block)}</div>}
          {wordsAmongElements && holdsWords && (
            <div className="bl-pp-about" data-words-among-elements>
              Its words stand among the elements it holds. Pick the words on the canvas, or in the hierarchy, to change them.
            </div>
          )}
          {wordsAmongElements && !holdsWords && (
            <div className="bl-pp-about" data-holds-elements>
              What it shows is the elements it holds. It has a Text field again when it holds none.
            </div>
          )}

          {/* A block's header, as the block's own fields. */}
          {block && (
            <div className="bl-pp-stack" data-block-editor={block.kind} onBlur={endEdit}>
              {(block.kind === 'if' || block.kind === 'elseif') && (
                <div className="bl-pp-field">
                  <label htmlFor={`panel-${selectedElement.id}-condition-1`} className="bl-pp-label">condition</label>
                  {/* As tall as the condition is long: it was one line, and a long one was read by arrowing through it. */}
                  <GrowingField
                    id={`panel-${selectedElement.id}-condition-1`}
                    value={block.condition || ''}
                    onChange={(text) => handleBlockChange('condition', text)}
                    placeholder="condition"
                    data-block-field="condition"
                  />
                </div>
              )}
              {block.kind === 'each' && (
                <>
                  {/* Two names, each a word: side by side at any width. */}
                  <div className="bl-pp-fields bl-pp-pairs">
                    <div className="bl-pp-field">
                      <label htmlFor={`panel-${selectedElement.id}-item-2`} className="bl-pp-label">item</label>
                      <input
                        id={`panel-${selectedElement.id}-item-2`}
                        type="text"
                        className="bl-pp-control bl-pp-mono"
                        value={block.itemName || ''}
                        onChange={(e) => handleBlockChange('itemName', e.target.value)}
                        placeholder="item"
                        data-block-field="itemName"
                      />
                    </div>
                    <div className="bl-pp-field">
                      <label htmlFor={`panel-${selectedElement.id}-index-optional-3`} className="bl-pp-label">index (optional)</label>
                      <input
                        id={`panel-${selectedElement.id}-index-optional-3`}
                        type="text"
                        className="bl-pp-control bl-pp-mono"
                        value={block.indexName || ''}
                        onChange={(e) => handleBlockChange('indexName', e.target.value)}
                        placeholder="i"
                        data-block-field="indexName"
                      />
                    </div>
                  </div>
                  <div className="bl-pp-fields">
                    <div className="bl-pp-field">
                      <label htmlFor={`panel-${selectedElement.id}-in-list-4`} className="bl-pp-label">in list</label>
                      <GrowingField
                        id={`panel-${selectedElement.id}-in-list-4`}
                        value={block.iterable || ''}
                        onChange={(text) => handleBlockChange('iterable', text)}
                        placeholder="items"
                        data-block-field="iterable"
                      />
                    </div>
                    <div className="bl-pp-field">
                      <label htmlFor={`panel-${selectedElement.id}-key-optional-5`} className="bl-pp-label">key (optional)</label>
                      <GrowingField
                        id={`panel-${selectedElement.id}-key-optional-5`}
                        value={block.keyExpression || ''}
                        onChange={(text) => handleBlockChange('keyExpression', text)}
                        placeholder="item.id"
                        data-block-field="keyExpression"
                      />
                    </div>
                  </div>
                </>
              )}
              <div className="bl-pp-buttons">
                {block.kind === 'if' && (
                  <>
                    <button type="button" className="bl-btn bl-btn-sm bl-pp-mono" onClick={() => addBranch('elseif')} data-block-action="add-elseif">
                      Add #elseif
                    </button>
                    {!existingBranches.has('else') && (
                      <button type="button" className="bl-btn bl-btn-sm bl-pp-mono" onClick={() => addBranch('else')} data-block-action="add-else">
                        Add #else
                      </button>
                    )}
                  </>
                )}
                {block.kind === 'each' && !existingBranches.has('empty') && (
                  <button type="button" className="bl-btn bl-btn-sm bl-pp-mono" onClick={() => addBranch('empty')} data-block-action="add-empty">
                    Add #empty
                  </button>
                )}
                {isBlockHead(selectedElement) ? (
                  <button
                    type="button"
                    className="bl-btn bl-btn-sm bl-pp-mono"
                    onClick={unwrapSelected}
                    title="Remove the block; the elements of its main branch stay, its other branches go"
                    data-block-action="unwrap"
                  >
                    Unwrap
                  </button>
                ) : (
                  <button
                    type="button"
                    className="bl-btn bl-btn-sm bl-pp-mono"
                    style={{ color: 'var(--danger)' }}
                    onClick={removeSelected}
                    title="Remove this branch and everything in it"
                    data-block-action="remove-branch"
                  >
                    Remove branch
                  </button>
                )}
              </div>
              <div className="bl-pp-hint">
                {isBlockHead(selectedElement)
                  ? 'Drop elements into the block on the canvas to fill its branch.'
                  : 'This branch belongs to the block above it.'}
              </div>
            </div>
          )}

          {own.length > 0 && <div className="bl-pp-fields" data-prop-group="own">{own.map((prop) => renderPropField(prop))}</div>}
        </div>

        {/* The page: the project's theme beside the page's own `theme`
            above, since which of the two it is drawn in is a question about
            both. */}
        {isPage && themeGroup}

        {events.length > 0 && (
          <Group name="events" title="Component events" open={isOpen('events')} onToggle={toggleGroup} set={setIn.events}>
            <div className="bl-pp-note">{handlerNote(handlerHelp)}</div>
            <div className="bl-pp-fields">{events.map((prop) => renderPropField(prop))}</div>
          </Group>
        )}

        {accessibility.length > 0 && (
          <Group name="accessibility" title="Accessibility" open={isOpen('accessibility')} onToggle={toggleGroup} set={setIn.accessibility}>
            <div className="bl-pp-fields">{accessibility.map((prop) => renderPropField(prop))}</div>
          </Group>
        )}

        {component && (
          <Group name="bindings" title="Bindings" open={isOpen('bindings')} onToggle={toggleGroup} set={setIn.bindings} onBlur={endEdit}>
            <div className="bl-pp-fields">
              {BINDINGS.map((bindingName) => {
                const value = selectedElement.bindings?.[bindingName] || '';
                const written = (text: string): string | null => {
                  const next = writtenValue(BINDING_PROP, { value, isExpression: true }, text);
                  if (next === null) return null;
                  return typeof next.value === 'string' ? next.value : '';
                };
                return (
                  <div key={bindingName} className="bl-pp-field" data-inline="">
                    <label htmlFor={`panel-${selectedElement.id}-bind-${bindingName}`} className="bl-pp-label">:{bindingName}</label>
                    {/* An expression, held to the rule of every other
                        expression field: braces typed around it are taken
                        off, and it is written once it reads as a whole one.
                        The placeholder used to be `{expression}`, and
                        `{about}` typed as it showed was `:bind={{about}}`. */}
                    <ExpressionField
                      id={`panel-${selectedElement.id}-bind-${bindingName}`}
                      shown={value}
                      placeholder={bindingName === 'bind' ? 'a name from the logic, such as title' : 'an expression'}
                      onInput={(text) => {
                        const next = written(text);
                        if (next === null) return false;
                        handleBindingChange(bindingName, next);
                        return true;
                      }}
                      written={written}
                      endEdit={endEdit}
                    />
                  </div>
                );
              })}
            </div>
          </Group>
        )}

        {component && (
          <Group name="handlers" title="Event handlers" open={isOpen('handlers')} onToggle={toggleGroup} set={setIn.handlers}>
            {events.length === 0 && <div className="bl-pp-note">{handlerNote(handlerHelp)}</div>}
            <div className="bl-pp-fields">
              {genericEvents.map((eventName) => {
                const value = selectedElement.events?.[eventName] || '';
                const id = `handler-${selectedElement.id}-${eventName}`;
                return (
                  <div key={eventName} className="bl-pp-field" data-inline="">
                    <label htmlFor={id} className="bl-pp-label">@{eventName}</label>
                    <HandlerField
                      id={id}
                      value={value}
                      onChange={(next) => handleEventChange(eventName, next)}
                      onBlur={endEdit}
                      help={handlerHelp}
                      onCreate={(name) => createHandler(eventName, name)}
                    />
                  </div>
                );
              })}
            </div>
          </Group>
        )}

        {style.length > 0 && (
          <Group name="style" title="Style" open={isOpen('style')} onToggle={toggleGroup} set={setIn.style}>
            <div className="bl-pp-fields">{style.map((prop) => renderPropField(prop))}</div>
          </Group>
        )}

        {component && (
          <Group name="directives" title="Directives" open={isOpen('directives')} onToggle={toggleGroup} set={setIn.directives} onBlur={endEdit}>
            <div className="bl-pp-fields">
              <div className="bl-pp-field" data-inline="">
                <label htmlFor={`panel-${selectedElement.id}-if-6`} className="bl-pp-label">if</label>
                <GrowingField
                  id={`panel-${selectedElement.id}-if-6`}
                  value={selectedElement.conditionalIf || ''}
                  onChange={(text) => handleDirectiveChange('conditionalIf', text)}
                  placeholder="condition"
                />
              </div>
              <div className="bl-pp-field" data-inline="">
                <label htmlFor={`panel-${selectedElement.id}-each-7`} className="bl-pp-label">each</label>
                <GrowingField
                  id={`panel-${selectedElement.id}-each-7`}
                  value={selectedElement.loopEach || ''}
                  onChange={(text) => handleDirectiveChange('loopEach', text)}
                  placeholder="collection"
                />
              </div>
              <div className="bl-pp-field" data-inline="">
                <label htmlFor={`panel-${selectedElement.id}-as-8`} className="bl-pp-label">as</label>
                <input
                  id={`panel-${selectedElement.id}-as-8`}
                  type="text"
                  className="bl-pp-control bl-pp-mono"
                  value={selectedElement.loopAs || ''}
                  onChange={(e) => handleDirectiveChange('loopAs', e.target.value)}
                  placeholder="item, index"
                />
              </div>
            </div>
          </Group>
        )}

        {wrapRow}
      </>
    );
  }

  return (
    <div className="bl-pp">
      <div className="bl-pp-head">
        <span className="bl-pp-title">Properties</span>
        {onToggleDock && (
          <button type="button" className="bl-mini" onClick={onToggleDock} title="Hide the properties panel" aria-label="Hide properties panel">
            Hide
          </button>
        )}
      </div>

      {/* What is selected and what can be done to it, where it stays while
          the fields scroll: there was no way to move, copy or remove an
          element but a key (SelectionActions.tsx). */}
      {selectionName !== null && (
        <div className="bl-pp-sel">
          <div className="bl-pp-what" title={selectionKind ? `${selectionName}: ${selectionKind}` : selectionName}>
            <span className="bl-pp-name" data-selection-name="" data-several={several ? '' : undefined}>{selectionName}</span>
            {selectionKind && <span className="bl-pp-kind" data-selection-kind="">{selectionKind}</span>}
          </div>
          <SelectionActions onDeleted={afterDelete} />
        </div>
      )}

      {/* Made anew for each selection: what is half typed in a field of one
          element is never shown in the same field of the next. */}
      <div ref={body} className="bl-pp-body" role="group" aria-label="Properties" tabIndex={-1}>
        <React.Fragment key={selectionKey}>{content}</React.Fragment>
      </div>
    </div>
  );
}
