// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { inspectBundle } from '@softn/core';
import { useVFSStore, useWorkspaceStore } from '../src/stores';
import { resetProjectSessionForImport } from '../src/lib/projectSession';
import { generateBlueprintFromBrief, projectLogicLanguage, scaffoldProjectFiles } from '../src/lib/studioProject';
import { projectContainerMode } from '../src/lib/sourceKinds';
import { buildAgentSystemPrompt } from '../src/lib/agent/prompt';
import { agentToolsForMode, openAITools, anthropicTools } from '../src/lib/agent/tools';
import { CONTAINER_FIELDNOTES } from '../src/examples/containerFieldnotes';
import { openExampleInStores } from '../src/examples';
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
    expect(prompt).not.toContain('lookup_components');
    expect(prompt).not.toContain('run_app_function');
    expect(prompt).not.toContain('The component list below is complete');
    expect(prompt).not.toContain('- ui-language:');

    const textPrompt = buildAgentSystemPrompt('text');
    expect(textPrompt).not.toContain('lookup_components');
    expect(textPrompt).not.toContain('run_app_function');
    expect(textPrompt).toContain('<h1>Hello, world</h1>');

    const webToolNames = agentToolsForMode('web').map((t) => t.name);
    expect(webToolNames).not.toContain('lookup_components');
    expect(webToolNames).not.toContain('run_app_function');
    expect(openAITools('web').map((t) => t.function.name)).toEqual(webToolNames);
    expect(anthropicTools('web').map((t) => t.name)).toEqual(webToolNames);

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
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.renderedHeadless).toBe(true);
    expect(report.rendered).toContain('Ready from ZIPP TypeScript');
  });

  // The page was read 30 ms after it started, whatever it was doing: an app that draws once a
  // timer has run, or once its data has loaded, was reported as showing nothing or as still starting.
  it('reads a v2 page once it has stopped changing, not a moment after it starts', async () => {
    const vfs = toVfsMap([
      { path: 'manifest.json', content: JSON.stringify({ engine: 2, name: 'Late', version: '1.0.0', main: 'index.html' }) },
      { path: 'permission.json', content: JSON.stringify({ permissions: {} }) },
      {
        path: 'index.html',
        content: `<!DOCTYPE html><html><body><p id="state"></p><script>
          setTimeout(function () { document.getElementById('state').textContent = 'Loading…'; }, 60);
          setTimeout(function () { document.getElementById('state').textContent = 'Three notes loaded'; }, 220);
        </script></body></html>`,
      },
    ]);
    const report = await browserEnvironment.checkApp(vfs, { blueprint: null });
    expect(report.errors).toEqual([]);
    expect(report.rendered).toBe('Three notes loaded');
    expect(report.warnings.join('\n')).not.toMatch(/no visible text/);
  }, 30_000);

  // A check grants nothing, and the container's own words for a refused request read as a fault.
  it('says a request the check did not grant as what it is, for a v2 app that declares the network', async () => {
    const app = (permission: string) =>
      toVfsMap([
        { path: 'manifest.json', content: JSON.stringify({ engine: 2, name: 'Fetcher', version: '1.0.0', main: 'index.html' }) },
        { path: 'permission.json', content: permission },
        {
          path: 'index.html',
          content: `<!DOCTYPE html><html><body><p id="state">Starting</p><script>
            fetch('https://api.example.test/notes.json').then(function () { document.getElementById('state').textContent = 'Loaded'; }, function (error) { console.error(String(error && error.message || error)); });
          </script></body></html>`,
        },
      ]);
    const declared = await browserEnvironment.checkApp(app(JSON.stringify({ permissions: { net: { enabled: true, allowed_hosts: ['api.example.test'] } } })), { blueprint: null });
    const said = [...declared.errors, ...declared.warnings].join('\n');
    expect(said).toMatch(/already declares net/);
    expect(said).not.toMatch(/not permitted by this container/);
    // Not declared: the container's line stands, since declaring it is what is missing.
    const undeclared = await browserEnvironment.checkApp(app(JSON.stringify({ permissions: {} })), { blueprint: null });
    expect([...undeclared.errors, ...undeclared.warnings].join('\n')).toMatch(/not permitted by this container/);
  }, 30_000);

  it('preserves container format and container task graph when opening a bundled Web Container example', () => {
    openExampleInStores(CONTAINER_FIELDNOTES);
    const ws = useWorkspaceStore.getState();
    expect(ws.brief?.appFormat).toBe('container');
    expect(ws.brief?.logicLanguage).toBe('typescript');
    const pagesTask = ws.taskGraph.find((t) => t.id === 'task-pages');
    expect(pagesTask?.files).toEqual(['index.html', 'styles.css', 'app.ts']);
  });
});
