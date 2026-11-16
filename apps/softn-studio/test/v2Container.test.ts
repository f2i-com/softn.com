// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { inspectBundle } from '@softn/core';
import { useVFSStore, useWorkspaceStore } from '../src/stores';
import { resetProjectSessionForImport } from '../src/lib/projectSession';
import { generateBlueprintFromBrief, projectLogicLanguage, scaffoldProjectFiles } from '../src/lib/studioProject';
import { projectContainerMode } from '../src/lib/sourceKinds';
import { buildAgentSystemPrompt } from '../src/lib/agent/prompt';
import { validateProject } from '../src/lib/validator';
import { buildBundle } from '../src/lib/exportBundle';
import { browserEnvironment } from '../src/lib/agent/appCheck';
import type { ProjectBrief, VFSFile } from '../src/types/studio';

function toVfsMap(list: Array<{ path: string; content: string | Uint8Array }>): Map<string, VFSFile> {
  const map = new Map<string, VFSFile>();
  for (const entry of list) {
    map.set(entry.path, {
      path: entry.path,
      content: entry.content,
      mimeType: 'text/plain',
      lastModified: Date.now(),
      lastModifiedBy: 'user',
      version: 1,
    });
  }
  return map;
}

describe('SoftN Studio v2 Web App Containers', () => {
  beforeEach(() => {
    resetProjectSessionForImport();
  });

  it('scaffolds a 100% standard HTML + CSS + TypeScript v2 container with zero .ui template sugar', () => {
    const brief: ProjectBrief = {
      appName: 'Orbit Planner',
      description: 'Plan orbital maneuvers in a sandboxed container.',
      target: 'web',
      style: 'dark',
      pages: ['Mission', 'Telemetry'],
      collections: ['Maneuvers'],
      authNeeded: false,
      referenceImages: [],
      appFormat: 'container',
      logicLanguage: 'typescript',
    };
    const blueprint = generateBlueprintFromBrief(brief);
    const scaffolded = scaffoldProjectFiles(brief, blueprint);
    const vfs = toVfsMap(scaffolded);

    expect(projectContainerMode(vfs, brief)).toBe('web');
    expect(projectLogicLanguage(vfs, brief)).toBe('typescript');
    expect(vfs.has('index.html')).toBe(true);
    expect(vfs.has('styles.css')).toBe(true);
    expect(vfs.has('app.ts')).toBe(true);
    expect(vfs.has('xdb/maneuvers.xdb')).toBe(true);

    const html = String(vfs.get('index.html')!.content);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<script type="module" src="./app.ts"></script>');
    expect(html).not.toContain('<App');
    expect(html).not.toContain('<logic');
    expect(html).not.toContain('#each');

    const notes = validateProject(vfs, blueprint).filter((e) => e.level === 'error');
    expect(notes).toEqual([]);

    const exported = buildBundle(vfs);
    const report = inspectBundle(exported);
    expect(report.problem).toBeNull();
    expect(report.execution).toBe('worker');
  });

  it('emits the v2 Web Container system prompt and catches missing script/stylesheet references', () => {
    const brief: ProjectBrief = {
      appName: 'Field Kit',
      description: 'Offline checklist.',
      target: 'web',
      style: 'clean',
      pages: ['Home'],
      collections: [],
      authNeeded: false,
      referenceImages: [],
      appFormat: 'container',
      logicLanguage: 'javascript',
    };
    const blueprint = generateBlueprintFromBrief(brief);
    const scaffolded = scaffoldProjectFiles(brief, blueprint);
    const vfs = toVfsMap(scaffolded);

    useWorkspaceStore.getState().setBrief(brief);
    useWorkspaceStore.getState().setBlueprint(blueprint);
    useVFSStore.getState().openFiles(
      scaffolded.map((f) => ({ path: f.path, content: String(f.content) }))
    );

    const prompt = buildAgentSystemPrompt('openai');
    expect(prompt).toContain('# How to build a SoftN v2 Web App Container');
    expect(prompt).toContain("'three'");
    expect(prompt).not.toContain('<logic src=');

    // Break stylesheet reference and confirm validator catches it
    vfs.delete('styles.css');
    const errors = validateProject(vfs, blueprint);
    expect(errors.some((e) => e.type === 'missing-reference' && e.message.includes('styles.css'))).toBe(true);
  });

  it('executes a v2 Web Container headlessly inside the ZIPP WASM sandbox via browserEnvironment.checkApp', async () => {
    const vfs = toVfsMap([
      {
        path: 'manifest.json',
        content: JSON.stringify({
          formatVersion: 2,
          engine: 2,
          name: 'Headless Probe',
          version: '1.0.0',
          description: 'Headless container test',
          main: 'index.html',
          config: { execution: 'worker' },
        }),
      },
      {
        path: 'permission.json',
        content: JSON.stringify({ permissions: {} }),
      },
      {
        path: 'index.html',
        content: `<!DOCTYPE html><html><body><h1 id="headline">Booting</h1><script type="module" src="./app.ts"></script></body></html>`,
      },
      {
        path: 'app.ts',
        content: `const label: string = 'Ready from ZIPP TypeScript';\nconst el = document.getElementById('headline');\nif (el) el.textContent = label;\n`,
      },
    ]);

    const report = await browserEnvironment.checkApp(vfs, { blueprint: null });
    expect(report.ok).toBe(true);
    expect(report.renderedHeadless).toBe(true);
    expect(report.rendered).toContain('Ready from ZIPP TypeScript');
  });
});
