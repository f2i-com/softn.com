/**
 * Bundle Module Tests
 */

import { describe, it, expect } from 'vitest';
import {
  createBundle,
  createBundleFromFiles,
  readBundle,
  validateManifest,
  createDefaultManifest,
} from '../src/bundle';
import type { SoftNManifest, SoftNBundleInput } from '../src/bundle';

describe('Bundle Module', () => {
  describe('validateManifest', () => {
    it('should validate a valid manifest', () => {
      const manifest: SoftNManifest = {
        name: 'Test App',
        version: '1.0.0',
        main: 'main.ui',
        files: {
          ui: ['main.ui'],
        },
      };

      expect(validateManifest(manifest)).toBe(true);
    });

    it('should reject invalid manifest', () => {
      expect(validateManifest(null)).toBe(false);
      expect(validateManifest({})).toBe(false);
      expect(validateManifest({ name: '' })).toBe(false);
      expect(validateManifest({ name: 'Test', version: '1.0.0' })).toBe(false);
    });
  });

  describe('createDefaultManifest', () => {
    it('should create a default manifest', () => {
      const manifest = createDefaultManifest('My App');

      expect(manifest.name).toBe('My App');
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.main).toBe('main.ui');
      expect(manifest.files.ui).toContain('main.ui');
    });
  });

  describe('createBundle and readBundle', () => {
    it('should create and read a simple bundle', async () => {
      const manifest: SoftNManifest = {
        name: 'Test App',
        version: '1.0.0',
        main: 'main.ui',
        files: {
          ui: ['main.ui'],
        },
      };

      const bundleInput: SoftNBundleInput = {
        manifest,
        files: [
          {
            path: 'main.ui',
            type: 'ui',
            content: '<div>Hello World</div>',
          },
        ],
      };

      // Create bundle
      const bundleData = await createBundle(bundleInput);
      expect(bundleData).toBeInstanceOf(Uint8Array);
      expect(bundleData.length).toBeGreaterThan(0);

      // Read bundle back
      const bundle = await readBundle(bundleData);
      expect(bundle.manifest.name).toBe('Test App');
      expect(bundle.manifest.version).toBe('1.0.0');
      expect(bundle.files.size).toBeGreaterThan(0);
    });

    it('should handle multiple files', async () => {
      const manifest: SoftNManifest = {
        name: 'Multi File App',
        version: '1.0.0',
        main: 'main.ui',
        files: {
          ui: ['main.ui', 'components/header.ui'],
          logic: ['app.logic'],
        },
      };

      const bundleInput: SoftNBundleInput = {
        manifest,
        files: [
          {
            path: 'main.ui',
            type: 'ui',
            content: '<div><Header /></div>',
          },
          {
            path: 'components/header.ui',
            type: 'ui',
            content: '<header>Header</header>',
          },
          {
            path: 'app.logic',
            type: 'logic',
            content: 'let count = 0\nfunction increment() { count++ }',
          },
        ],
      };

      const bundleData = await createBundle(bundleInput);
      const bundle = await readBundle(bundleData);

      expect(bundle.files.size).toBe(4); // manifest + 3 files
      expect(bundle.files.has('main.ui')).toBe(true);
      expect(bundle.files.has('components/header.ui')).toBe(true);
      expect(bundle.files.has('app.logic')).toBe(true);
    });

    it('should handle binary assets', async () => {
      const manifest: SoftNManifest = {
        name: 'Asset App',
        version: '1.0.0',
        main: 'main.ui',
        files: {
          ui: ['main.ui'],
          assets: ['icon.png'],
        },
      };

      // PNG header bytes
      const binaryContent = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

      const bundleInput: SoftNBundleInput = {
        manifest,
        files: [
          {
            path: 'main.ui',
            type: 'ui',
            content: '<div>App</div>',
          },
          {
            path: 'icon.png',
            type: 'asset',
            content: binaryContent,
          },
        ],
      };

      const bundleData = await createBundle(bundleInput);
      const bundle = await readBundle(bundleData);

      const iconFile = bundle.files.get('icon.png');
      expect(iconFile).toBeDefined();
      expect(iconFile!.type).toBe('asset');
    });
  });

  describe('createBundleFromFiles', () => {
    it('should create bundle from file map', async () => {
      const manifest: SoftNManifest = {
        name: 'Map App',
        version: '1.0.0',
        main: 'main.ui',
        files: {
          ui: ['main.ui'],
        },
      };

      const files = new Map<string, string | Uint8Array>();
      files.set('main.ui', '<div>From Map</div>');

      const bundleData = await createBundleFromFiles(manifest, files);
      const bundle = await readBundle(bundleData);

      expect(bundle.manifest.name).toBe('Map App');
      const mainFile = bundle.files.get('main.ui');
      expect(mainFile).toBeDefined();
      expect(mainFile!.content).toBe('<div>From Map</div>');
    });
  });
});
