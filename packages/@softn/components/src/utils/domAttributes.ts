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
