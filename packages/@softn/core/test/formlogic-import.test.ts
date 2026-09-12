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
    expect(parse(project.files['ui/main.ui']).data?.collections).toMatchObject([{ as: 'records0', name: 'fl_636f6e7461637473' }]);
    expect(project.formCount).toBe(1);
    expect(project.fieldCount).toBe(2);
    expect(JSON.parse(project.files['formlogic.connection.json']).collections[0].fieldIds).toEqual(['name', 'email']);
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
});
