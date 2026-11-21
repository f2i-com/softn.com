// @vitest-environment jsdom
/**
 * Editing backend & project extra files (PHP, Rust, SQL, Cargo.toml, etc.) inside Builder:
 * - Extra files stored in `source.extraEntries` can be created, opened, edited, and deleted
 * - Edits are preserved byte-for-byte in the exported `.softn` bundle without polluting `files.logic`
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { useProjectStore } from '../../stores/projectStore';
import { buildProjectBundle } from '../../utils/buildProjectBundle';
import { ExtraFileEditor } from './ExtraFileEditor';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe('Builder backend / extra file editing', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    useCanvasStore.getState().reset();
    useProjectStore.getState().reset();
    useFilesStore.getState().reset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('creates, opens, edits, and exports PHP and Rust backend files without polluting files.logic', async () => {
    const project = useProjectStore.getState();
    project.setExtraEntry('server/index.php', strToU8('<?php\necho "v1";\n'));
    project.setExtraEntry('backend/src/main.rs', strToU8('fn main() { println!("v1"); }\n'));
    project.openExtraFile('server/index.php');

    expect(useProjectStore.getState().activeExtraPath).toBe('server/index.php');
    expect(useProjectStore.getState().openExtraTabs).toEqual(['server/index.php']);

    act(() => root.render(React.createElement(ExtraFileEditor, { path: 'server/index.php' })));
    expect(host.querySelector('[data-extra-language]')?.getAttribute('data-extra-language')).toBe('php');
    expect(host.textContent).toContain('Backend');
    expect(host.textContent).toContain('server/index.php');

    // Update PHP & Rust files
    useProjectStore.getState().setExtraEntry('server/index.php', strToU8('<?php\necho "v2";\n'));
    useProjectStore.getState().setExtraEntry('backend/src/main.rs', strToU8('fn main() { println!("v2"); }\n'));

    // Export bundle and confirm both edited backend files are inside and NOT in files.logic
    const zipped = await buildProjectBundle();
    const entries = unzipSync(zipped);
    expect(strFromU8(entries['server/index.php'])).toBe('<?php\necho "v2";\n');
    expect(strFromU8(entries['backend/src/main.rs'])).toBe('fn main() { println!("v2"); }\n');
    const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as { files?: { logic?: string[] } };
    expect(manifest.files?.logic ?? []).not.toContain('server/index.php');
    expect(manifest.files?.logic ?? []).not.toContain('backend/src/main.rs');

    // Opening a regular file clears activeExtraPath automatically
    const uiId = [...useFilesStore.getState().uiFiles.keys()][0];
    useFilesStore.getState().openFile(uiId);
    expect(useProjectStore.getState().activeExtraPath).toBeNull();
  });
});
