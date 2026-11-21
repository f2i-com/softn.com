import { describe, expect, it } from 'vitest';
import { detectWebContainer } from '../src/containerBundle';
import { createUiBackendBridge, hasEmbeddedBackend } from '../src/uiBackendBridge';

describe('frontend/backend format decoupling', () => {
  it('keeps classic .ui apps on @softn/core even when manifest.backend + SQLite are declared', () => {
    const uiWithPhp = new Map<string, string>([
      [
        'manifest.json',
        JSON.stringify({
          name: 'UI Notes PHP',
          version: '1.0.0',
          main: 'ui/main.ui',
          backend: { runtime: 'php', entry: 'backend/index.php', mode: 'api', routes: ['/api/'] },
          databases: [{ name: 'app', engine: 'sqlite', file: 'app.db', seedSql: 'backend/schema.sql' }],
        }),
      ],
      ['ui/main.ui', '<App><Text>Hello</Text></App>'],
      ['backend/index.php', '<?php echo json_encode(["ok" => true]);'],
    ]);
    expect(detectWebContainer(uiWithPhp).isWebContainer).toBe(false);

    // Classic Studio `.ui`-style HTML template (no engine: 2, no <!DOCTYPE html>)
    const classicHtmlWithPhp = new Map<string, string>([
      [
        'manifest.json',
        JSON.stringify({
          name: 'Classic Template PHP',
          version: '1.0.0',
          main: 'index.html',
          backend: { runtime: 'php', entry: 'backend/index.php', mode: 'api', routes: ['/api/'] },
        }),
      ],
      ['index.html', '<script src="main.js"></script>\n<App><Heading>Notes</Heading></App>'],
      ['backend/index.php', '<?php echo json_encode(["ok" => true]);'],
    ]);
    expect(detectWebContainer(classicHtmlWithPhp).isWebContainer).toBe(false);

    // Standard Web Container with backend STILL runs in @softn/container
    const webContainerWithPhp = new Map<string, string>([
      [
        'manifest.json',
        JSON.stringify({
          engine: 2,
          name: 'Web Container PHP',
          version: '2.0.0',
          main: 'index.html',
          backend: { runtime: 'php', entry: 'backend/index.php', mode: 'api', routes: ['/api/'] },
        }),
      ],
      ['index.html', '<!DOCTYPE html><html><body><div id="app"></div></body></html>'],
      ['backend/index.php', '<?php echo json_encode(["ok" => true]);'],
    ]);
    expect(detectWebContainer(webContainerWithPhp).isWebContainer).toBe(true);
  });

  it('detects embedded backend manifests and passes non-matching external URLs through as null', async () => {
    expect(hasEmbeddedBackend(null)).toBe(false);
    expect(hasEmbeddedBackend({ name: 'Plain' })).toBe(false);
    const manifest = {
      name: 'UI + Backend',
      main: 'ui/main.ui',
      backend: { runtime: 'javascript', entry: 'backend/server.js', mode: 'api', routes: ['/api/'] },
    };
    expect(hasEmbeddedBackend(manifest)).toBe(true);

    const bridge = createUiBackendBridge({
      appId: 'test-ui-backend',
      manifest,
      textFiles: { 'backend/server.js': 'function handleRequest() { return { status: 200, body: "{}" }; }' },
      binaryFiles: {},
      persistStorage: false,
      isolation: 'inline',
    });
    expect(bridge).not.toBeNull();
    try {
      // External HTTPS URL not matching `/api/` falls through (`null`) to AppNetwork + permission.json
      const external = await bridge!.netFetchHandler('https://api.example.com/data', { method: 'GET' });
      expect(external).toBeNull();
    } finally {
      bridge?.dispose();
    }
  });
});
