/**
 * The attributes of a tag that are the page's own business, not the
 * component's: its `id`, and whatever is written `data-…` or `aria-…`.
 *
 * A component takes the props it knows and drops the rest, which is right
 * for a prop that means nothing to it and wrong for these. They are how a
 * page's own stylesheet finds an element (`.tool[data-on="true"]`), how a
 * link or a label points at one, and how one is described to a screen
 * reader. Given the props a component did not take, this is the part of
 * them to put on its element.
 */
export function domAttributes(rest: object): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rest)) {
    if (name === 'id' || name.startsWith('data-') || name.startsWith('aria-')) attributes[name] = value;
  }
  return attributes;
}

/**
 * A form control's share of them, in two parts. The `id` and `aria-…` go on
 * the control itself, the element a person focuses and a screen reader names
 * (`aria-label` is how a field with no label on screen is named at all). The
 * `data-…` go where the control's `className` goes, the element a page's
 * rule such as `.pick[data-on="true"]` is written for, which for most
 * controls is the box around the input.
 */
export function controlAttributes(rest: object): { control: Record<string, unknown>; styled: Record<string, unknown> } {
  const control: Record<string, unknown> = {};
  const styled: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(domAttributes(rest))) {
    if (name.startsWith('data-')) styled[name] = value;
    else control[name] = value;
  }
  return { control, styled };
}

/**
 * The ids an `aria-describedby` names: the page's own, then the component's
 * (its help or error text), as one list, or undefined when there are none.
 * Either alone would hide the other from a screen reader.
 */
export function describedBy(given: unknown, own: string | undefined): string | undefined {
  const ids = [typeof given === 'string' ? given.trim() : '', own ?? ''].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

/** The `aria-label` written on the page, when it is text. */
export function givenLabel(attributes: Record<string, unknown>): string | undefined {
  const label = attributes['aria-label'];
  return typeof label === 'string' && label !== '' ? label : undefined;
}
