import type { CanvasElement, ComponentMeta, PropSchema } from '../types/builder';

// Inspector metadata for native markup that already exists in an opened app.
// These are not palette items and never execute or render the app's markup.
const TAGS = new Set(('a abbr address article aside audio b blockquote br button canvas caption code col colgroup dd del details div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr i img input label legend li main mark nav ol optgroup option output p picture pre progress section select small source span strong sub summary sup table tbody td textarea th thead time tr track u ul video wbr').split(' '));
const VOID = new Set('br col hr img input source track wbr'.split(' '));
const FORMS = new Set('button fieldset form input label optgroup option output select textarea'.split(' '));

const attributes: Record<string, PropSchema[]> = {
  a: [{ name: 'href', type: 'string' }, { name: 'target', type: 'string' }],
  button: [{ name: 'type', type: 'select', options: ['button', 'submit', 'reset'] }, { name: 'disabled', type: 'boolean' }],
  input: [
    { name: 'type', type: 'string' }, { name: 'name', type: 'string' }, { name: 'placeholder', type: 'string' },
    { name: 'value', type: 'string' }, { name: 'maxLength', type: 'number' }, { name: 'required', type: 'boolean' },
    { name: 'disabled', type: 'boolean' }, { name: 'checked', type: 'boolean' },
  ],
  select: [{ name: 'name', type: 'string' }, { name: 'disabled', type: 'boolean' }, { name: 'multiple', type: 'boolean' }],
  option: [{ name: 'value', type: 'string' }, { name: 'disabled', type: 'boolean' }],
  textarea: [{ name: 'name', type: 'string' }, { name: 'placeholder', type: 'string' }, { name: 'rows', type: 'number' }, { name: 'disabled', type: 'boolean' }],
  label: [{ name: 'htmlFor', type: 'string' }],
  img: [{ name: 'src', type: 'string' }, { name: 'alt', type: 'string' }, { name: 'width', type: 'number' }, { name: 'height', type: 'number' }],
};

export function getNativeHtmlMeta(name: string): ComponentMeta | undefined {
  if (!TAGS.has(name)) return undefined;
  return {
    name, category: FORMS.has(name) ? 'Form' : 'Layout', icon: 'code',
    description: `Native ${name} element. Use Preview to run its styles and behavior.`,
    defaultProps: {}, allowChildren: !VOID.has(name),
    propSchema: [
      ...(!VOID.has(name) ? [{ name: 'children', type: 'string' as const }] : []),
      ...(attributes[name] ?? []),
      { name: 'id', type: 'string' }, { name: 'className', type: 'string' },
      { name: 'style', type: 'json' }, { name: 'aria-label', type: 'string' },
    ],
  };
}

/** Preserve the representation of existing native attributes, including expressions. */
export function nativeElementMeta(element: CanvasElement): ComponentMeta | undefined {
  const base = getNativeHtmlMeta(element.componentType);
  if (!base) return undefined;
  const byName = new Map(base.propSchema.map(prop => [prop.name, { ...prop }]));
  for (const [name, value] of Object.entries(element.props)) {
    if (!byName.has(name)) {
      byName.set(name, { name, type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : typeof value === 'object' ? 'json' : 'string' });
    }
  }
  for (const name of element.expressionProps ?? []) {
    const prop = byName.get(name);
    if (prop) byName.set(name, { ...prop, type: 'expression' });
  }
  // A container's child elements, not an ignored text field, own its content.
  if (element.children.length > 0) byName.delete('children');
  return { ...base, propSchema: [...byName.values()] };
}
