/**
 * The shell and the web runtime import these by name; the detailed tests of
 * each module live with the web app (apps/softn-web/test), which exercises
 * them through its re-export shims. This pins the package surface itself.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import * as shell from '../src/index';
import { readZip, requestedCapabilities, withheldPermissions } from '../src/bundleProcessor';
import { warmFirstScreen } from '../src/zipWarmup';

describe('@softn/runtime-shell', () => {
  it('exports the bundle pipeline, the warm-up and the frame bar', () => {
    for (const name of ['readZip', 'processBundle', 'loadXDBData', 'createAssetResolver', 'createImportResolver', 'extractPermissions', 'requestedCapabilities', 'withheldPermissions', 'CAPABILITIES', 'warmFirstScreen', 'FrameBar']) {
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
});
