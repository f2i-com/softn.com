import type React from 'react';

/** The parts of a border a component writes one by one. */
const OWN_BORDER = [
  'borderWidth',
  'borderStyle',
  'borderColor',
  'borderBottomWidth',
  'borderBottomStyle',
  'borderBottomColor',
] as const;

/**
 * A component's own style with the author's laid over it, where the author's
 * `border` takes the place of the component's border whole.
 *
 * A field writes its border in parts (`borderWidth`, `borderStyle`,
 * `borderColor`) so that focus, an error or success can change the colour
 * alone. An author who gives `style={{ border: "1px solid gold" }}` wins on
 * the first drawing, because their style is written last. On the next state
 * change React writes only the part that changed, `borderColor`, and that
 * lands over the author's border: the field was gold until it was first
 * focused, and the component's grey ever after. With the author's `border`
 * given, the component's parts are left out, so there is nothing to land.
 */
export function withAuthorStyle(own: React.CSSProperties, style: React.CSSProperties | undefined): React.CSSProperties {
  if (!style) return own;
  if (style.border === undefined) return { ...own, ...style };
  const merged: React.CSSProperties = { ...own };
  for (const part of OWN_BORDER) delete merged[part];
  return { ...merged, ...style };
}
