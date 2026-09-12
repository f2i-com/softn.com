/** The homepage app must also be a useful, visually editable Builder example. */
import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { unzipSync, strFromU8 } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { ComponentRegistry, parse, renderDocument, type SoftNRenderContext } from '@softn/core';
import { assessSourceFidelity, parseSource } from './sourceParser';
import { useFilesStore } from '../stores/filesStore';

const exampleRoot = new URL('../../../../examples/fieldnotes/', import.meta.url);
const source = readFileSync(new URL('ui/main.ui', exampleRoot), 'utf8');
const bundle = unzipSync(new Uint8Array(readFileSync(new URL('../../apps/softn-site/public/examples/Fieldnotes.softn', exampleRoot))));
const FILE_ID = 'main_ui';

function render(sourceText: string, state: Record<string, unknown>): string {
  const registry = new ComponentRegistry();
  registry.register('App', ({ children }: { children?: React.ReactNode }) => React.createElement('main', null, children));
  const context: SoftNRenderContext = {
    state, setState: () => {}, data: {}, props: {},
    functions: { showTasks: () => {}, toggleTask: () => {}, addTask: () => {} },
    asyncFunctions: {}, computed: {},
  };
  return renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(parse(sourceText), context, registry)));
}

beforeEach(() => {
  useFilesStore.getState().reset();
  useFilesStore.getState().initializeProject();
});

describe('the shipped Fieldnotes example', () => {
  it('ships current editable source and passes the real visual editor fidelity check', () => {
    expect(strFromU8(bundle['ui/main.ui'])).toBe(source);
    expect(strFromU8(bundle['logic/main.logic'])).toBe(readFileSync(new URL('logic/main.logic', exampleRoot), 'utf8'));
    expect(assessSourceFidelity(source)).toEqual({ lossless: true, reasons: [] });
  });

  it('keeps behavior, styling, bindings and collection references after a real visual text edit', () => {
    const store = () => useFilesStore.getState();
    store().updateUIFileSource(FILE_ID, source);
    const parsed = parseSource(source);
    store().syncUIFileElements(FILE_ID, parsed.elements, parsed.rootId);
    const elements = new Map([...parsed.elements].map(([id, element]) => [id, { ...element, props: { ...element.props } }]));
    const title = [...elements.values()].find(element => element.componentType === 'h1');
    expect(title).toBeDefined();
    title!.props.children = 'Make room for your next idea.';
    store().updateUIFile(FILE_ID, elements, parsed.rootId);
    const edited = store().uiFiles.get(FILE_ID)!;
    expect(edited.visualEditBlocked).toBeUndefined();
    expect(edited.originalSource).toContain('Make room for your next idea.');
    expect(assessSourceFidelity(edited.originalSource!)).toEqual({ lossless: true, reasons: [] });
    expect(edited.originalSource).toContain('<logic src="../logic/main.logic" />');
    expect(edited.originalSource).toContain('<collection name="tasks" as="tasks" />');
    expect(edited.originalSource?.match(/<style>[\s\S]*?<\/style>/)?.[0]).toBe(source.match(/<style>[\s\S]*?<\/style>/)?.[0]);

    const defaults = { title: '', lane: 'Design', totalCount: 2, activeCount: 1, doneCount: 1, message: 'Task saved.', error: '' };
    const tasks = [
      { id: 'one', data: { title: 'Sketch', lane: 'Design', done: false } },
      { id: 'two', data: { title: 'Build', lane: 'Build', done: true } },
    ];
    for (const state of [
      { ...defaults, filter: 'all', shown: tasks },
      { ...defaults, filter: 'done', shown: [tasks[1]], error: 'Give your task a name first.' },
      { ...defaults, filter: 'active', shown: [] },
    ]) {
      expect(render(edited.originalSource!, state)).toBe(render(source, state).replace('Make space for what matters.', 'Make room for your next idea.'));
    }
  });
});
