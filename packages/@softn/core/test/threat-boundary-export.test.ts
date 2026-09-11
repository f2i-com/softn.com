/**
 * The threat-boundary matrix, authoring side (QA-02 in the audit): what
 * Studio's export and preview may and may not carry.
 *
 * Two boundaries, both about Studio, both pinned from here because the
 * modules are plain functions and a source file, and this package's suite
 * is where the rest of the matrix lives:
 *
 * 1. Key material never appears in an exported bundle or a share address.
 *    Studio keeps the model provider's API key in the AI store, persisted
 *    under its own localStorage key; the project's files are a separate
 *    map. `buildBundle` archives that map and nothing else — minus
 *    `builder/`, Studio's own working state. Pinned: with a provider key in
 *    the AI store, with a copy of the persisted AI snapshot sitting in the
 *    project under `builder/`, and with the key smeared across localStorage,
 *    no entry of the archive contains the key, no `builder/` entry is
 *    archived, and the manifest written into the archive says nothing of it.
 *    (The hand-off address is covered in threat-boundary-runtime.test.ts.)
 *
 * 2. The export never widens the declaration. `permission.json` goes into
 *    the archive byte for byte; the export normalises the manifest, not the
 *    permissions, and a project with no `permission.json` exports none — so
 *    the runtime denies everything, which is the audited default.
 *
 * 3. The HTML preview's iframe sandbox. VisualCanvas previews a model's or
 *    an imported bundle's HTML in an iframe with `sandbox="allow-scripts"`
 *    and no `allow-same-origin`: with both, the blob inherits Studio's
 *    origin and can read localStorage — where that API key is. The attribute
 *    is a literal in the JSX, so the exact token set is pinned by reading
 *    the source: rendering the canvas would need Studio's stores, its
 *    renderer and a blob URL, and would pin the same literal.
 *
 * The Studio modules are imported by relative path: this workspace's tests
 * are the only place QA-02 may add files, and the two functions under test
 * depend on nothing of Studio's beyond `fflate`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBundle, normalizeManifestForBundle } from '../../../../apps/softn-studio/src/lib/exportBundle';
import { inspectDeclaration } from '../src/runtime/capabilities';

const here = path.dirname(fileURLToPath(import.meta.url));
const studioSrc = path.resolve(here, '../../../../apps/softn-studio/src');

interface VFSFileLike {
  path: string;
  content: string | Uint8Array;
  mimeType: string;
  lastModified: number;
  lastModifiedBy: 'user' | 'ai';
  version: number;
}

const SECRET = 'sk-ant-api03-EXAMPLE-NOT-A-REAL-KEY-abcdef0123456789';

function file(p: string, content: string | Uint8Array): [string, VFSFileLike] {
  return [p, { path: p, content, mimeType: typeof content === 'string' ? 'text/plain' : 'application/octet-stream', lastModified: 1, lastModifiedBy: 'user', version: 1 }];
}

/** A project the way Studio holds one while someone with a configured provider is editing it. */
function projectWithSecrets(): Map<string, VFSFileLike> {
  const aiSnapshot = JSON.stringify({
    providers: [{ id: 'p1', type: 'anthropic', name: 'Work', apiKey: SECRET }],
    activeProviderId: 'p1',
  });
  return new Map<string, VFSFileLike>([
    file('manifest.json', JSON.stringify({ name: 'Keyed', entry: 'ui/main.ui' })),
    file('permission.json', JSON.stringify({ permissions: { net: { enabled: true, allowed_hosts: ['api.example'] } } })),
    file('ui/main.ui', '<App><Text>hi</Text></App>\n'),
    file('logic/main.logic', 'let n = 1\n'),
    file('data/notes.xdb', '{"collection":"notes","records":[]}\n'),
    // Studio's own working state, which some earlier versions mirrored into
    // the project: never part of the bundle.
    file('builder/ai.json', aiSnapshot),
    file('builder/state.json', JSON.stringify({ lastPrompt: `use ${SECRET}` })),
  ]);
}

function entriesOf(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, data] of Object.entries(unzipSync(bytes))) out[name] = new TextDecoder().decode(data);
  return out;
}

describe('key material never appears in an exported bundle', () => {
  beforeEach(() => {
    // The AI snapshot as Studio persists it, plus the key under every other
    // key a careless export might sweep up.
    localStorage.setItem('softn.studio.ai.v1', JSON.stringify({ providers: [{ id: 'p1', type: 'anthropic', name: 'Work', apiKey: SECRET }] }));
    localStorage.setItem('softn.studio.workspace.v1', JSON.stringify({ projectName: 'Keyed', apiKey: SECRET }));
    localStorage.setItem('unrelated', SECRET);
  });
  afterEach(() => localStorage.clear());

  it('archives the project files only, without builder/ and without the key', () => {
    const entries = entriesOf(buildBundle(projectWithSecrets()));
    expect(Object.keys(entries).sort()).toEqual(['data/notes.xdb', 'logic/main.logic', 'manifest.json', 'permission.json', 'ui/main.ui']);
    for (const [name, text] of Object.entries(entries)) {
      expect(text, `${name} carries the provider key`).not.toContain(SECRET);
      expect(text, `${name} carries an apiKey field`).not.toMatch(/apiKey/);
    }
    expect(Object.keys(entries).some((name) => name.startsWith('builder/'))).toBe(false);
  });

  it('a stored export (level 0) is the same set of entries, still without the key', () => {
    const stored = buildBundle(projectWithSecrets(), 0);
    const raw = new TextDecoder('latin1').decode(stored);
    // Level 0 stores entries uncompressed, so the archive bytes themselves are searchable.
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('builder/');
    expect(Object.keys(entriesOf(stored)).sort()).toEqual(['data/notes.xdb', 'logic/main.logic', 'manifest.json', 'permission.json', 'ui/main.ui']);
  });

  it('the normalised manifest lists the project groups and never the builder/ files', () => {
    const manifest = JSON.parse(normalizeManifestForBundle(projectWithSecrets())!) as { main: string; files: Record<string, string[]> };
    expect(manifest.main).toBe('ui/main.ui');
    const listed = Object.values(manifest.files).flat();
    expect(listed.some((p) => p.startsWith('builder/'))).toBe(false);
    expect(listed).not.toContain('permission.json');
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
  });
});

describe('the export never widens the declaration', () => {
  it('writes permission.json exactly as the project holds it', () => {
    const project = projectWithSecrets();
    const declared = (project.get('permission.json')!.content as string);
    const entries = entriesOf(buildBundle(project));
    expect(entries['permission.json']).toBe(declared);
    expect(inspectDeclaration(JSON.parse(entries['permission.json'])).requested).toEqual(['net']);
  });

  it('a project without permission.json exports without one, which the runtime reads as "nothing"', () => {
    const project = projectWithSecrets();
    project.delete('permission.json');
    const entries = entriesOf(buildBundle(project));
    expect(entries['permission.json']).toBeUndefined();
    // The manifest's own `files` groups do not smuggle a declaration in either.
    const manifest = JSON.parse(entries['manifest.json']) as Record<string, unknown>;
    expect(manifest.permissions).toBeUndefined();
    expect(inspectDeclaration(manifest).requested).toEqual([]);
  });

  it('an empty declaration stays empty: the export adds no capability for anything the project uses', () => {
    const project = projectWithSecrets();
    project.set('permission.json', file('permission.json', '{"permissions":{}}')[1]);
    // Logic that reaches for the network does not earn `net`.
    project.set('logic/main.logic', file('logic/main.logic', 'let r = softn.net.fetch("https://api.example/")\n')[1]);
    const entries = entriesOf(buildBundle(project));
    expect(entries['permission.json']).toBe('{"permissions":{}}');
    expect(inspectDeclaration(JSON.parse(entries['permission.json'])).requested).toEqual([]);
  });
});

describe("Studio's HTML preview iframe sandbox", () => {
  const source = fs.readFileSync(path.join(studioSrc, 'components/canvas/VisualCanvas.tsx'), 'utf8');

  it('every iframe in the canvas is sandboxed with exactly allow-scripts, and never allow-same-origin', () => {
    const iframes = source.match(/<iframe\b[\s\S]*?>/g) ?? [];
    expect(iframes.length, 'the canvas previews HTML in an iframe').toBeGreaterThan(0);
    for (const tag of iframes) {
      // Comments inside the JSX element are prose about the flag; strip them before reading attributes.
      const attrs = tag.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/[^\n]*/g, '');
      const sandbox = attrs.match(/\bsandbox=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/);
      expect(sandbox, `iframe has a literal sandbox attribute:\n${tag}`).not.toBeNull();
      const tokens = (sandbox![1] ?? sandbox![2] ?? sandbox![3]).trim().split(/\s+/).filter(Boolean).sort();
      expect(tokens).toEqual(['allow-scripts']);
      expect(tokens).not.toContain('allow-same-origin');
      expect(attrs).not.toMatch(/\ballow=/);
      expect(attrs).not.toMatch(/\bsrcDoc=/i);
    }
  });
});
