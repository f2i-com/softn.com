/**
 * What index.php tells the page about itself.
 *
 * The shell is rendered on the server, so the page does not fetch a
 * runtime.config.json the way apps/softn-single does; the PHP host writes this
 * JSON into a `<script type="application/json">` and everything else — the
 * title, theme, permissions, source — arrives in the source pack that the
 * endpoint answers. Only the endpoint is trusted from here, and only when it
 * is a path on this origin: a scheme or a `//` prefix would make every asset
 * URL the resolver mints look like egress to the runtime's markup judge, and
 * would let a tampered page send the visitor's requests elsewhere.
 */
export interface BootConfig {
  version: 1;
  /** Path-absolute URL of index.php, e.g. `/games/index.php`. */
  endpoint: string;
  loadingText: string;
}

export function parseBoot(input: unknown): BootConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('Invalid boot configuration');
  const c = input as Record<string, unknown>;
  if (
    Object.keys(c).some((k) => !['version', 'endpoint', 'loadingText'].includes(k)) ||
    c.version !== 1
  )
    throw Error('Invalid boot configuration');
  if (
    typeof c.endpoint !== 'string' ||
    !c.endpoint.startsWith('/') ||
    c.endpoint.startsWith('//') ||
    c.endpoint.startsWith('/\\') ||
    c.endpoint.length > 2048 ||
    /[?#\s]/.test(c.endpoint)
  )
    throw Error('Invalid endpoint');
  if (
    c.loadingText !== undefined &&
    (typeof c.loadingText !== 'string' || c.loadingText.length > 160)
  )
    throw Error('Invalid loading text');
  return {
    version: 1,
    endpoint: c.endpoint,
    loadingText: (c.loadingText as string) ?? 'Loading…',
  };
}

export function readBoot(doc: Document): BootConfig {
  const element = doc.getElementById('softn-boot');
  if (!element || element.getAttribute('type') !== 'application/json')
    throw Error('Boot configuration missing');
  return parseBoot(JSON.parse(element.textContent ?? 'null'));
}
