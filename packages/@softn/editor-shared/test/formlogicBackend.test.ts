import { describe, expect, it } from 'vitest';
import { addFormLogicBackend, appendBackendRoute } from '../src/formlogicBackend';

describe('private backend authoring', () => {
  it('creates a same-origin backend until an operator adds another browser origin', () => {
    expect(addFormLogicBackend({}, []).manifest.config).toEqual({ server: { allowedOrigins: [] } });
  });
  it('keeps existing private code, origins and manifest fields when first adding the backend', () => {
    const config = { server: { allowedOrigins: ['https://custom.example'] }, theme: 'dark' };
    const result = addFormLogicBackend({ engine: 2, config }, ['server/main.logic', 'SERVER/api-1.logic']);
    expect(result.entry).toBe('server/api-2.logic');
    expect(result.manifest.config).toEqual(config);
    expect(Object.keys(result.files)).toEqual([result.entry]);
    const reopened = addFormLogicBackend(result.manifest, Object.keys(result.files));
    expect(reopened.manifest).toBe(result.manifest);
    expect(reopened.files).toEqual({});
    expect(() => addFormLogicBackend(result.manifest, [])).toThrow(/Restore/);
  });

  it('appends a private handler for one method and path, and refuses duplicate or invalid handlers', () => {
    const result = appendBackendRoute([], '', 'POST', '/api/notes', 'createNote');
    expect(result.routes).toEqual([{ method: 'POST', path: '/api/notes', handler: 'createNote', transaction: 'write', authorization: 'application' }]);
    expect(result.source).toContain('function createNote(req)');
    expect(() => appendBackendRoute(result.routes, result.source, 'GET', '/api/notes', 'createNote')).toThrow(/already exists/);
    expect(() => appendBackendRoute(result.routes, result.source, 'POST', '/api/notes', 'addNote')).toThrow(/already exists/);
    expect(() => appendBackendRoute([], '', 'GET', '/api/notes', 'default')).toThrow(/function name/);
  });
});
