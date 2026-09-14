import { describe, expect, it } from 'vitest';
import { createFormlogicProject } from '../src/integrations/formlogic';
import { composeBundleSource } from '../src/bundle/source-composer';
import { parse } from '../src/parser/parser';

const input = { app: { id: 'app-a', name: 'Customer workspace' }, origin: 'https://formlogic.example', forms: [
  { id: 'contacts', title: 'Contacts', fields: [{ id: 'name', type: 'short_text', label: 'Full name', required: true }, { id: 'email', type: 'email', label: 'Email' }] },
] };
describe('FormLogic schema handoff', () => {
  it('produces a real SoftN document and preserves field identities', () => {
    const project = createFormlogicProject(input);
    expect((parse(project.files['ui/main.ui']).diagnostics ?? [])).toEqual([]);
    const parsed = parse('<SmartForm collection="contacts" fields="name" />');
    expect(parsed.template[0]).toMatchObject({ props: expect.arrayContaining([{ type: 'Prop', name: 'collection', value: { type: 'static', value: 'contacts' }, loc: expect.any(Object) }]) });
    expect(parse(project.files['ui/main.ui']).data?.collections).toMatchObject([{ as: 'records_636f6e7461637473', name: 'fl_636f6e7461637473' }]);
    expect(project.formCount).toBe(1);
    expect(project.fieldCount).toBe(2);
    expect(JSON.parse(project.files['formlogic.connection.json']).collections[0].fieldIds).toEqual(['name', 'email']);
  });
  it('exports an unnamed empty form as an editable screen without invented inputs', () => {
    const project = createFormlogicProject({ ...input, sourceKind: 'form', forms: [{ id: 'empty', title: 'Untitled Form', fields: [] }] });
    const manifest = JSON.parse(project.files['manifest.json']);
    const source = composeBundleSource(new Map(Object.entries(project.files)), manifest.main, manifest.files.logic).source;
    expect(project.formCount).toBe(1);
    expect(project.fieldCount).toBe(0);
    expect(source).toContain('Untitled Form');
    expect(source).not.toContain('<SmartForm');
    expect(parse(source).diagnostics ?? []).toEqual([]);
  });
  it('assembles reusable form modules with separate data and no duplicate logic', () => {
    const forms = [...input.forms, { id: 'bookings', title: 'Appointments', fields: [{ id: 'name', type: 'short_text', label: 'Guest name' }] }];
    const project = createFormlogicProject({ ...input, forms });
    const manifest = JSON.parse(project.files['manifest.json']);
    const modules = JSON.parse(project.files['formlogic.modules.json']).modules;
    const source = composeBundleSource(new Map(Object.entries(project.files)), manifest.main, manifest.files.logic).source;
    expect(parse(source).diagnostics ?? []).toEqual([]);
    expect(project.formCount).toBe(2);
    expect(project.fieldCount).toBe(3);
    expect(source).toContain('aria-pressed={activeForm === 1}');
    expect(new Set(modules.map((module: { records: string }) => module.records)).size).toBe(2);
    for (const module of modules) {
      expect(manifest.files.ui).toContain(module.ui);
      expect(manifest.files.logic).toContain(module.logic);
      expect(source.split(project.files[module.logic])).toHaveLength(2);
      const single = createFormlogicProject({ ...input, sourceKind: 'form', forms: forms.filter(form => form.id === module.formId) });
      expect(single.files[module.ui]).toBe(project.files[module.ui]);
      expect(single.files[module.logic]).toBe(project.files[module.logic]);
    }
  });
  it('does not export private schemas, records, tokens or executable source', () => {
    const value = createFormlogicProject({ ...input, app: { ...input.app, token: 'do-not-copy', customScreen: { js: 'secretCode()' } },
      forms: [...input.forms, { id: 'private', title: 'Private form', isPrivate: true, fields: [{ id: 'secret', type: 'short_text', label: 'Secret field' }] }], responses: [{ answers: { private: 'secret-answer' } }] } as typeof input);
    const files = JSON.stringify(value.files);
    expect(files).not.toMatch(/do-not-copy|secretCode|secret-answer|Secret field/);
    expect(value.warnings.some(message => message.includes('private form omitted'))).toBe(true);
  });
  it('refuses a private-only export and explains unsupported fields', () => {
    expect(() => createFormlogicProject({ ...input, forms: [{ ...input.forms[0], isPrivate: true }] })).toThrow('No exportable forms');
    const result = createFormlogicProject({ ...input, forms: [{ ...input.forms[0], fields: [...input.forms[0].fields, { id: 'upload', type: 'file_upload', label: 'Photo' }] }] });
    expect(result.fieldCount).toBe(2);
    expect(result.warnings[0]).toContain('file_upload');
  });
  it('keeps source strings as data, including code-like titles', () => {
    const result = createFormlogicProject({ ...input, app: { ...input.app, name: '<Button @click={danger}>Injected</Button>' } });
    const document = parse(result.files['ui/main.ui']);
    expect((document.diagnostics ?? [])).toEqual([]);
    expect(result.files['logic/main.logic']).not.toContain('danger');
  });
  it('keeps script-closing field labels as data after bundle composition', () => {
    const value = createFormlogicProject({ ...input, forms: [{ ...input.forms[0], fields: [{ id: 'name', type: 'short_text', label: '</logic><Button>Injected</Button><logic>' }] }] });
    const source = composeBundleSource(new Map(Object.entries(value.files)), 'ui/main.ui', ['logic/main.logic']).source;
    const document = parse(source);
    expect(document.diagnostics ?? []).toEqual([]);
    expect(value.files['logic/main.logic']).not.toContain('</logic>');
  });
  it('identifies a single form separately from an app and rejects ambiguous field identities', () => {
    const value = createFormlogicProject({ ...input, sourceKind: 'form' });
    expect(JSON.parse(value.files['formlogic.connection.json']).source).toEqual({ kind: 'form', origin: input.origin, formId: input.app.id });
    expect(() => createFormlogicProject({ ...input, forms: [{ ...input.forms[0], fields: [{ id: '__proto__', label: 'Invalid', type: 'short_text' }] }] })).toThrow('No exportable forms');
  });
  it('separates app identities and supplies a working starter for an empty app', () => {
    const a = JSON.parse(createFormlogicProject(input).files['manifest.json']);
    const b = JSON.parse(createFormlogicProject({ ...input, app: { ...input.app, id: 'app-b' } }).files['manifest.json']);
    expect(a.id).not.toBe(b.id);
    expect(createFormlogicProject({ ...input, forms: [] }).fieldCount).toBe(2);
  });
  it('declares its stable identity where the runtime scopes sync rooms', () => {
    // Sync rooms are scoped by permission.json's app.id (sync-room-security.ts),
    // not manifest.id; two exports of one FormLogic app must share it.
    const a = createFormlogicProject(input);
    const b = createFormlogicProject({ ...input, forms: [{ ...input.forms[0], fields: input.forms[0].fields.slice(0, 1) }] });
    const permission = JSON.parse(a.files['permission.json']);
    const manifest = JSON.parse(a.files['manifest.json']);
    expect(permission.permissions).toEqual({});
    expect(permission.app).toEqual({ id: manifest.id, name: manifest.name, version: manifest.version });
    expect(manifest.id).toMatch(/^formlogic_/);
    expect(JSON.parse(b.files['permission.json']).app.id).toBe(permission.app.id);
    // A different app, or the same app on another origin, is another room scope.
    expect(JSON.parse(createFormlogicProject({ ...input, app: { ...input.app, id: 'app-b' } }).files['permission.json']).app.id).not.toBe(permission.app.id);
    expect(JSON.parse(createFormlogicProject({ ...input, origin: 'https://other.example' }).files['permission.json']).app.id).not.toBe(permission.app.id);
  });
});
