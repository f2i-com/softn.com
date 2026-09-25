/**
 * The shell and the web runtime import these by name; the detailed tests of
 * each module live with the web app (apps/softn-web/test), which exercises
 * them through its re-export shims. This pins the package surface itself.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import * as shell from '../src/index';
import { processBundle, readZip, requestedCapabilities, withheldPermissions } from '../src/bundleProcessor';
import { warmFirstScreen } from '../src/zipWarmup';
import { composeBundleSource } from '@softn/core';

describe('@softn/runtime-shell', () => {
  it('exports the bundle pipeline, the warm-up, the frame bar and consent', () => {
    for (const name of ['readZip', 'processBundle', 'loadXDBData', 'createAssetResolver', 'createImportResolver', 'extractPermissions', 'requestedCapabilities', 'withheldPermissions', 'CAPABILITIES', 'warmFirstScreen', 'FrameBar', 'PermissionBar', 'PermissionPrompt', 'PERMISSION_INFO', 'grantKey', 'hasSavedGrant', 'saveGrant', 'grantCovers', 'diffCapabilities']) {
      expect(typeof (shell as Record<string, unknown>)[name], name).toMatch(/function|object/);
    }
  });

  it('reads an archive and reports what it asks for', async () => {
    const bytes = zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'Notes', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] } })),
      'permission.json': strToU8(JSON.stringify({ permissions: { camera: { enabled: true } } })),
      'ui/main.ui': strToU8('<App />'),
    });
    const files = readZip(bytes);
    expect(files.textFiles.has('manifest.json')).toBe(true);
    const permissions = { permissions: { camera: { enabled: true } } };
    expect(requestedCapabilities(permissions)).toContain('camera');
    expect(withheldPermissions(permissions).permissions).toEqual({});
    expect(typeof warmFirstScreen).toBe('function');
  });

  it('reads Python logic as text, so the composer finds the app’s main.py', () => {
    const bytes = zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'Counter', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.py', 'logic/helpers.py'] } })),
      'ui/main.ui': strToU8('<logic src="../logic/main.py" />\n<Button @click={increment}>{count}</Button>'),
      'logic/main.py': strToU8('from helpers import step\ncount = 0\ndef increment():\n    global count\n    count += step\n'),
      'logic/helpers.py': strToU8('step = 1\n'),
    });
    const files = readZip(bytes);
    expect(files.binaryFiles.has('logic/main.py')).toBe(false);
    expect(files.textFiles.get('logic/main.py')).toContain('def increment');
    const composed = composeBundleSource(files.textFiles, 'ui/main.ui', ['logic/main.py', 'logic/helpers.py']);
    expect(composed.languages).toContain('python');
    expect(Object.keys(composed.python?.files ?? {}).sort()).toEqual(['helpers', 'main']);

    // What a host renders is processBundle's result, and it must carry the
    // project too: it was typed as three fields, every host passed on those
    // three, and a Python app ran with no logic in every runtime.
    const processed = processBundle(files.textFiles, { name: 'Counter', version: '1.0.0', main: 'ui/main.ui', files: { logic: ['logic/main.py', 'logic/helpers.py'] } } as never);
    expect(processed.python?.modules).toEqual(['helpers', 'main']);
    expect(processed.python?.packages).toEqual([]);
  });
});
