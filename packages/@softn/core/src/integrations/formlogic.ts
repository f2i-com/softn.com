/** FormLogic → SoftN schema handoff. No records, credentials or executable
 * FormLogic code cross this boundary. Keep this module dependency-free so
 * FormLogic can vendor the exact adapter without importing the whole renderer. */
export interface FormlogicField {
  id: string;
  type: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  properties?: { options?: Array<{ label: string; value: string }>; min?: number; max?: number };
  validation?: unknown[];
  conditionalLogic?: unknown;
}
export interface FormlogicSchema {
  id: string;
  title: string;
  fields: FormlogicField[];
  isPrivate?: boolean;
  encryption?: { mode?: string };
}
export interface FormlogicProjectInput {
  app: { id: string; name: string; description?: string };
  origin: string;
  sourceKind?: 'app' | 'form';
  forms: FormlogicSchema[];
}
export interface FormlogicProject {
  files: Record<string, string>;
  warnings: string[];
  formCount: number;
  fieldCount: number;
}

const TYPES: Record<string, string> = {
  short_text: 'text', long_text: 'textarea', email: 'email', phone: 'tel',
  number: 'number', url: 'url', date: 'date', dropdown: 'select', multiple_choice: 'select',
};
const json = (value: unknown) => JSON.stringify(value, null, 2);
// Escape tag delimiters in DSL literals, including strings inside external logic.
const literal = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
const token = (value: string) => {
  // Stable encoded identity; unlike a slug, different punctuation cannot collide.
  return Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join('');
};

export function createFormlogicProject(input: FormlogicProjectInput): FormlogicProject {
  const origin = new URL(input.origin);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('A valid FormLogic origin is required.');
  if (!input.app.id || !input.app.name.trim()) throw new Error('The app needs an identity and name.');
  if (input.forms.length > 30) throw new Error('Export up to 30 forms at a time.');
  if (new Set(input.forms.map(form => form.id)).size !== input.forms.length) throw new Error('Duplicate form identities are not allowed.');
  const warnings: string[] = [];
  const schemas = input.forms.length ? input.forms : [{ id: 'starter', title: 'Notes', fields: [
    { id: 'title', type: 'short_text', label: 'Title', required: true },
    { id: 'notes', type: 'long_text', label: 'Notes' },
  ] }];
  const collections = schemas.flatMap(form => {
    if (form.isPrivate || form.encryption?.mode === 'private') {
      warnings.push(`${form.title}: private form omitted; encryption is not transferred to the starter.`);
      return [];
    }
    if (form.id.length > 128 || form.fields.length > 200) throw new Error('A form exceeds the export limits.');
    if (new Set(form.fields.map(field => field.id)).size !== form.fields.length) throw new Error(`Duplicate fields in ${form.title}.`);
    const fields = form.fields.flatMap(field => {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(field.id) || ['__proto__', 'prototype', 'constructor', 'id', 'collection', 'data', 'created_at', 'updated_at', 'deleted'].includes(field.id)) {
        warnings.push(`${form.title} / ${field.label}: this field identity needs a custom mapping and was omitted.`); return [];
      }
      const type = Object.hasOwn(TYPES, field.type) ? TYPES[field.type] : undefined;
      if (!type) { warnings.push(`${form.title} / ${field.label}: ${field.type} needs a custom app component and was omitted.`); return []; }
      if (field.validation?.length || field.conditionalLogic) warnings.push(`${form.title} / ${field.label}: review custom validation and conditional rules in the app editor.`);
      return [{ name: field.id, type, label: field.label, required: !!field.required,
        ...(field.placeholder ? { placeholder: field.placeholder } : {}),
        ...(type === 'select' ? { options: (field.properties?.options ?? []).map(option => ({ label: option.label, value: option.value })) } : {}),
        ...(type === 'number' && Number.isFinite(field.properties?.min) ? { min: field.properties!.min } : {}),
        ...(type === 'number' && Number.isFinite(field.properties?.max) ? { max: field.properties!.max } : {}),
      }];
    });
    if (!fields.length && form.fields.length) { warnings.push(`${form.title}: no supported input fields to export.`); return []; }
    return [{ sourceFormId: form.id, collection: `fl_${token(form.id)}`, title: form.title, fields }];
  });
  if (!collections.length) throw new Error('No exportable forms. Add a plain form with supported fields first.');
  // Stable names keep a form's code identical in standalone and multi-form apps.
  // The source composer combines component logic into one scope.
  const modules = collections.map(form => ({
    ...form, component: `Form${token(form.sourceFormId)}`,
    ui: `ui/forms/${token(form.sourceFormId)}.ui`, logic: `logic/forms/${token(form.sourceFormId)}.logic`,
    fieldsName: `fields_${token(form.sourceFormId)}`, recordsName: `records_${token(form.sourceFormId)}`,
  }));
  const moduleFiles: Record<string, string> = {};
  for (const form of modules) {
    moduleFiles[form.logic] = `let ${form.fieldsName} = ${literal(form.fields)};`;
    moduleFiles[form.ui] = `<logic src="../../${form.logic}" />
<Box style={{minWidth:"0"}}>
  <Heading level={2} style={{marginBottom:"20px",overflowWrap:"anywhere"}}>{${literal(form.title)}}</Heading>
${form.fields.length ? `  #if (${form.fieldsName})
  <SmartForm collection="${form.collection}" fields={${form.fieldsName}} submitText="Add record" />
  #end
  <Heading level={3} style={{marginTop:"28px",marginBottom:"12px"}}>Saved records</Heading>
  <Box style={{overflowX:"auto",maxWidth:"100%"}}><SmartGrid data={${form.recordsName}} columns={${literal(form.fields.map(field => field.name).join(","))}} columnLabels={${literal(Object.fromEntries(form.fields.map(field => [field.name, field.label])))}} searchable sortable pageable pageSize={10} /></Box>` : `  <Text>Add fields to this screen in the app editor to start collecting records.</Text>`}
</Box>`;
  }
  const logic = 'let activeForm = 0;';
  const data = modules.map(form => `  <collection name="${form.collection}" as="${form.recordsName}" />`).join('\n');
  const imports = modules.map(form => `<import ${form.component} from="./forms/${token(form.sourceFormId)}.ui" />`).join('\n');
  const navigation = collections.length > 1 ? `<nav className="fl-navigation" aria-label="Forms">${collections.map((form, index) => `<button type="button" aria-pressed={activeForm === ${index}} @click={() => activeForm = ${index}} title={${literal(form.title)}}>{${literal(form.title)}}</button>`).join('\n')}</nav>` : '';
  const screens = modules.map((form, index) => `
    <Box className="fl-section" style={{borderRadius:"16px",display:activeForm === ${index} ? "block" : "none"}}>
      <${form.component} />
    </Box>`).join('\n');
  const manifest = { id: `formlogic_${token(origin.origin + '/' + (input.sourceKind ?? 'app') + '/' + input.app.id)}`, name: input.app.name,
    description: input.app.description ?? '', version: '1.0.0', main: 'ui/main.ui',
    files: { ui: ['ui/main.ui', ...modules.map(form => form.ui)], logic: ['logic/main.logic', ...modules.map(form => form.logic)], xdb: [], assets: [] },
    config: { theme: { mode: 'system' } } };
  const files = {
    ...moduleFiles,
    'manifest.json': json(manifest),
    // No capability is asked for. The bundle's identity goes here as well as
    // in manifest.json: sync rooms are scoped by permission.json's `app.id`
    // (see sync-room-security.ts), so two exports of one FormLogic app — with
    // different bytes, so different host digests — meet in the same room
    // once a user grants sync. Bundles exported before this carried only
    // `manifest.id`, which nothing scopes by, and keep their per-export scope.
    'permission.json': json({ permissions: {}, app: { id: manifest.id, name: manifest.name, version: manifest.version } }),
    'logic/main.logic': logic,
    'ui/main.ui': `${imports}
<logic src="../logic/main.logic" />
<data>\n${data}\n</data>
<style>
.fl-workspace { width:100%; max-width:1120px; margin:auto; padding:clamp(12px,4vw,40px); padding-bottom:max(24px,env(safe-area-inset-bottom)); box-sizing:border-box; }
.fl-navigation { display:flex; gap:8px; overflow-x:auto; max-width:100%; padding:8px 2px 12px; margin-top:20px; scroll-snap-type:x proximity; }
.fl-navigation button { flex:0 0 auto; max-width:240px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; scroll-snap-align:start; min-height:44px; padding:10px 16px; border:1px solid var(--color-border,#d1d5db); border-radius:12px; background:var(--color-surface,#fff); color:var(--color-text,#172033); cursor:pointer; font:inherit; }
.fl-navigation button[aria-pressed="true"] { background:var(--color-primary-600,#4f46e5); border-color:var(--color-primary-600,#4f46e5); color:#fff; }
.fl-navigation button:focus-visible { outline:2px solid var(--color-primary-500,#6366f1); outline-offset:2px; }
.fl-section { margin-top:24px; padding:clamp(16px,3vw,28px); border:1px solid var(--border-color, #d1d5db); border-radius:16px; min-width:0; }
.fl-workspace input, .fl-workspace select, .fl-workspace textarea { min-width:0; min-height:44px; max-width:100%; box-sizing:border-box; }
@media(max-width:600px) { .fl-workspace input, .fl-workspace select, .fl-workspace textarea { font-size:16px; } }
</style>
<App><Box className="fl-workspace">
  <Text style={{fontSize:"12px",fontWeight:600,letterSpacing:"0.08em"}}>FORMLOGIC</Text>
  <Heading level={1} style={{fontSize:"clamp(24px,5vw,36px)",lineHeight:1.2,marginTop:"8px",overflowWrap:"anywhere"}}>{${literal(input.app.name)}}</Heading>
  <Text style={{display:"block",marginTop:"8px"}}>{${literal(input.app.description || 'Your custom app workspace.')}}</Text>
  <Text style={{display:"block",marginTop:"8px",fontSize:"13px",color:"var(--color-text-secondary)"}}>Records entered here stay on this device. This copy does not sync with your workspace.</Text>
${navigation}
${screens}
</Box></App>`,
    'formlogic.connection.json': json({ schema: 'formlogic.softn/v1', source: { origin: origin.origin, kind: input.sourceKind ?? 'app', ...(input.sourceKind === 'form' ? { formId: input.app.id } : { appId: input.app.id }) },
      storage: 'local-xdb', sync: false, collections: collections.map(form => ({ formId: form.sourceFormId, collection: form.collection, fieldIds: form.fields.map(field => field.name) })) }),
    'formlogic.modules.json': json({ version: 1, modules: modules.map(form => ({ formId: form.sourceFormId, component: form.component, ui: form.ui, logic: form.logic, collection: form.collection, records: form.recordsName })) }),
    'README.md': `# ${input.app.name} — SoftN starter\n\nOpen this .softn file in the SoftN builder or web runtime. The generated SmartForm and SmartGrid screens use isolated local XDB storage (localStorage in the browser; SQLite in the desktop host).\n\nNo existing FormLogic responses, account credentials, encrypted forms, automations or role grants are included. This is an independent starter, not a live mirror. Source form identities are recorded in formlogic.connection.json for an explicit future bridge.\n\nFor shared server SQLite, deploy a separate private server API v1 bundle with per-app registration, migrations and authorization. See softn.com/docs/engineering/SINGLE_APP_PRIVATE.md and apps/softn-host-rust/PRIVATE_BACKEND.md in the source repository. Do not put private server code, tokens or databases in this client archive.\n\n## Editable form modules\nEach form has its own ui/forms/<identity>.ui screen and logic/forms/<identity>.logic field definitions. The main screen imports these modules, declares their collections, and provides navigation. A blank form is a real empty screen; no sample fields are added.\n\n## Combine forms into one app\nIn FormLogic, add your forms to an app, open App Studio, and choose Create app project. Select the forms to include and download one .softn project with navigation between them.\n\nTo reuse a customised module in another SoftN app, copy its UI and logic files without renaming them, add both paths to manifest.json, then import its component in your main UI. Add its collection and records alias to the main data block; formlogic.modules.json lists the exact names. Render the component wherever you want it. Keep existing customised files when an identical form identity is already present. Re-exporting from FormLogic generates a fresh copy and does not merge changes made in the external editor.\n\n## Conversion notes\n${warnings.length ? warnings.map(w => '- ' + w).join('\n') : 'Supported input fields were converted. Review validation and access requirements before publishing.'}\n`,
  };
  if (JSON.stringify(files).length > 2_000_000) throw new Error('The generated starter exceeds 2 MB. Export fewer fields.');
  return { files, warnings, formCount: collections.length, fieldCount: collections.reduce((sum, form) => sum + form.fields.length, 0) };
}
