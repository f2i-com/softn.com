/**
 * Sanitize an SVG `fill` or `stroke` paint value so untrusted app props
 * (e.g. `<Icon color="url(https://evil.example/track#x)">` or chart series
 * colors) can never trigger zero-interaction network egress via CSS/SVG
 * paint-server `url(...)` references or CSS escape smuggling.
 */

const SAFE_COLOR_RE =
  /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|[a-z]{3,24}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(\s*[0-9a-z.,%\s/+-]+\s*\)|var\(\s*--[a-zA-Z0-9_-]+(?:\s*,\s*(?:#[0-9a-f]{3,8}|[a-z]{3,24}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]+\)))?\s*\))$/i;

export function safeSvgPaint(value: unknown, fallback = 'currentColor'): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160) return fallback;
  // Reject any CSS escape, URL/image function, or attribute-breaking token up front.
  if (/[\\;{}<>]|(?:url|image-set|src|expression)\s*\(/i.test(trimmed)) return fallback;
  return SAFE_COLOR_RE.test(trimmed) ? trimmed : fallback;
}
