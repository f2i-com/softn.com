/** Module aliases the web app declares. The manifest can override an HTML import map. */
export function readWebImportMap(html: string, manifestImports?: unknown): Record<string, string> {
  const imports: Record<string, string> = Object.create(null);
  function apply(entries: unknown) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return;
    for (const [key, target] of Object.entries(entries)) {
      if (typeof target === 'string') imports[key] = target;
    }
  }
  const scripts = /<script\b[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scripts)) {
    try {
      apply(JSON.parse(match[1])?.imports);
    } catch {
      // The container ignores malformed import maps.
    }
  }
  apply(manifestImports);
  return imports;
}
