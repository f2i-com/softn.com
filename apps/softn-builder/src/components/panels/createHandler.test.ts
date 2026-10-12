// @vitest-environment jsdom
/**
 * A handler that names a function the logic does not have can be given one.
 *
 * The panel said "No function named addTask in logic/main.logic" and left
 * it there: the way on was to open the logic dock, find the end of the file
 * and type the function, in whichever language the file is. It now offers
 * to make it: an empty function of that name at the end of the file the
 * page runs, taking what the handler passes it, as one step for Undo.
 *
 * Where writing it could not be right it is not offered: a name the
 * language cannot take, and a file whose end is inside something
 * unfinished, where what was added would land in the middle of it.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSource } from '../../utils/sourceParser';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { useHistoryStore } from '../../stores/historyStore';
import { redoCanvas, undoCanvas } from '../../utils/canvasHistory';
import { logicFunctions } from '../../utils/logicFunctions';
import { PropertyPanel } from './PropertyPanel';

let root: Root | undefined;
let host: HTMLDivElement;
let buttonId: string;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useCanvasStore.getState().reset();
  useFilesStore.getState().reset();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

function mount(language: 'javascript' | 'python', logic?: string): void {
  useFilesStore.getState().reset(language);
  if (logic !== undefined) useFilesStore.getState().updateLogicFile(logicFile().id, logic);
  const parsed = parseSource('<App><Button>Go</Button></App>');
  buttonId = [...parsed.elements.values()].find((element) => element.componentType === 'Button')!.id;
  useCanvasStore.getState().loadState(parsed.elements, parsed.rootId);
  useCanvasStore.getState().selectElement(buttonId);
  useHistoryStore.getState().clear();
  root = createRoot(host);
  act(() => root!.render(React.createElement(PropertyPanel)));
}

function logicFile() {
  return [...useFilesStore.getState().logicFiles.values()][0];
}

function handler(text: string): void {
  const label = [...host.querySelectorAll('label')].find((element) => element.textContent === '@click')!;
  const input = document.getElementById(label.htmlFor) as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Leaving the field ends its run of edits, as it does for a person.
  act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
}

const offer = () => host.querySelector<HTMLButtonElement>('[data-action="create-handler"]');
const warning = () => host.querySelector('[data-handler-warning]')?.textContent ?? null;
const click = () => useCanvasStore.getState().elements.get(buttonId)!.events?.click;

describe('a handler that names a function the logic does not have', () => {
  it('is offered the function, which is added to the end of the file', () => {
    mount('javascript');
    const before = logicFile().content;
    handler('addTask()');
    expect(offer()?.textContent).toBe('Create addTask');
    act(() => offer()!.click());
    expect(logicFile().content).toBe(`${before}\nfunction addTask() {\n}\n`);
    expect(logicFunctions(logicFile().content, 'javascript').map((fn) => fn.name)).toContain('addTask');
    // It is there now: nothing to warn of, nothing to offer.
    expect(warning()).toBeNull();
    expect(offer()).toBeNull();
    expect(click()).toBe('addTask()');
  });

  it('takes what the handler passes it', () => {
    mount('javascript');
    handler('remove(task.id, "now")');
    act(() => offer()!.click());
    expect(logicFile().content).toContain('\nfunction remove(first, second) {\n}\n');
  });

  it('is one step for Undo, and Redo puts it back', () => {
    mount('javascript');
    const before = logicFile().content;
    handler('addTask()');
    const steps = useHistoryStore.getState().past.length;
    act(() => offer()!.click());
    expect(useHistoryStore.getState().past).toHaveLength(steps + 1);
    const made = logicFile().content;

    act(() => { undoCanvas(); });
    expect(logicFile().content).toBe(before);
    expect(click()).toBe('addTask()');
    expect(warning()).toBe('No function named addTask in logic/main.logic.');
    act(() => { redoCanvas(); });
    expect(logicFile().content).toBe(made);
    expect(warning()).toBeNull();
  });

  it('does not take back what has been written in the file since: Undo leaves a file that has moved on', () => {
    // Create addTask, write its body in the dock, change something on the
    // canvas, Undo twice: the second Undo put the file back to before the
    // function was made, and the body went with it.
    mount('javascript');
    handler('addTask()');
    act(() => offer()!.click());
    const written = logicFile().content.replace('function addTask() {\n}', 'function addTask() {\n  count++\n}');
    act(() => useFilesStore.getState().updateLogicFile(logicFile().id, written));

    act(() => { undoCanvas(); });
    expect(logicFile().content).toBe(written);
    // And Redo does not write the empty function over it either.
    act(() => { redoCanvas(); });
    expect(logicFile().content).toBe(written);
  });

  it('is written in Python for a Python file, and is called so that the event it would be passed is dropped', () => {
    mount('python');
    const before = logicFile().content;
    handler('save');
    act(() => offer()!.click());
    expect(logicFile().content).toBe(`${before}\n\ndef save():\n    pass\n`);
    // Bound by its bare name it would be called with the event, which a
    // function taking nothing refuses.
    expect(click()).toBe('() => save()');
    act(() => { undoCanvas(); });
    expect(logicFile().content).toBe(before);
    expect(click()).toBe('save');
  });

  it('takes a Python function’s arguments by position', () => {
    mount('python');
    handler('remove(task)');
    act(() => offer()!.click());
    expect(logicFile().content).toContain('\n\ndef remove(first):\n    pass\n');
    expect(click()).toBe('remove(task)');
  });

  it('gives a file that does not end in a line break one first', () => {
    mount('javascript', 'let count = 0');
    handler('reset()');
    act(() => offer()!.click());
    expect(logicFile().content).toBe('let count = 0\n\nfunction reset() {\n}\n');
  });
});

describe('where writing the function could not be right', () => {
  it('is not offered for a name the language cannot take', () => {
    mount('python');
    handler('$save()');
    expect(warning()).toContain('$save');
    expect(offer()).toBeNull();
    handler('class()');
    expect(offer()).toBeNull();
  });

  it.each([
    ['an open function', 'function save() {\n  count = 1\n'],
    ['an open comment', 'let a = 1\n/* notes\n'],
    ['an open string', 'let a = `one\n'],
    ['an open list', 'let rows = [\n  1,\n'],
  ])('is not offered while the file ends inside %s, and says why', (_what, logic) => {
    mount('javascript', logic);
    handler('addTask()');
    expect(offer()).toBeNull();
    expect(host.querySelector('[data-handler-unfinished]')?.textContent).toContain('logic/main.logic');
    expect(logicFile().content).toBe(logic);
  });

  it('is not offered while a Python file ends inside an open bracket or a block with no body', () => {
    mount('python', 'rows = [\n  1,\n');
    handler('save()');
    expect(offer()).toBeNull();
    act(() => useFilesStore.getState().updateLogicFile(logicFile().id, 'def load():\n'));
    expect(offer()).toBeNull();
    act(() => useFilesStore.getState().updateLogicFile(logicFile().id, 'count = 0\n'));
    expect(offer()).not.toBeNull();
  });

  it('is not misled by a brace in a string or a comment', () => {
    mount('javascript', 'let open = "{"\n// an odd } here\nlet text = \'it\\\'s {\'\n');
    handler('addTask()');
    expect(offer()).not.toBeNull();
  });
});

describe('with a logic file open in the middle', () => {
  // With a logic file open, the canvas, the Hierarchy and the Properties still
  // hold the last page (hooks/useActiveFileOnCanvas.ts). The panel read the
  // logic to write into from the file that was open, which is no page, and
  // fell back to the entry's: the function went into logic/main.logic while
  // the page on the canvas runs logic/other.logic, so its handler still
  // named nothing.
  it('writes the function into the logic of the page on the canvas', () => {
    useFilesStore.getState().reset('javascript');
    const files = useFilesStore.getState();
    const otherPage = files.createFile('ui', 'other.ui', 'ui');
    const otherLogic = files.createFile('logic', 'other.logic', 'logic');
    useFilesStore.getState().updateUIFileLogicSrc(otherPage, '../logic/other.logic');
    const mainLogic = [...useFilesStore.getState().logicFiles.values()].find((file) => file.path.endsWith('main.logic'))!;
    const parsed = parseSource('<App><Button>Go</Button></App>');
    buttonId = [...parsed.elements.values()].find((element) => element.componentType === 'Button')!.id;
    // The other page is on the canvas, and then a logic file is opened.
    useCanvasStore.getState().loadState(parsed.elements, parsed.rootId, [], [], otherPage);
    useFilesStore.getState().openFile(otherLogic);
    useCanvasStore.getState().selectElement(buttonId);
    useHistoryStore.getState().clear();
    root = createRoot(host);
    act(() => root!.render(React.createElement(PropertyPanel)));

    const mainBefore = mainLogic.content;
    handler('addTask()');
    expect(warning()).toBe('No function named addTask in logic/other.logic.');
    act(() => offer()!.click());
    expect(useFilesStore.getState().logicFiles.get(otherLogic)!.content).toContain('function addTask() {\n}');
    expect(useFilesStore.getState().logicFiles.get(mainLogic.id)!.content).toBe(mainBefore);
  });
});
