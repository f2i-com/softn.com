/**
 * On-Demand `<softn-*>` Custom Element UI Extension Loader.
 *
 * When the container's HTML or dynamic DOM creates a `<softn-*>` tag
 * (e.g. `<softn-chart>`, `<softn-datagrid>`, `<softn-pixel-canvas>`),
 * this registry dynamically loads and defines only that element!
 * Plain HTML apps download 0 bytes of UI extension code.
 */

type ExtensionLoader = () => Promise<void>;

const extensionLoaders = new Map<string, ExtensionLoader>();
const inFlight = new Map<string, Promise<void>>();

const BUILTIN_EXTENSIONS = new Set(['softn-datagrid', 'softn-chart']);

export function registerUiExtension(tagName: string, loader: ExtensionLoader): void {
  const lower = tagName.toLowerCase();
  if (!lower.startsWith('softn-') || lower === 'softn-app') return;
  extensionLoaders.set(lower, loader);
}

/** Whether `tagName` is an allowlisted host-provided SoftN UI extension element. */
export function isAllowedUiExtension(tagName: string): boolean {
  const lower = tagName.toLowerCase();
  return BUILTIN_EXTENSIONS.has(lower) || extensionLoaders.has(lower);
}

export function ensureUiExtension(tagName: string, runtimeUrl = '/runtime/'): Promise<void> {
  const lower = tagName.toLowerCase();
  if (!isAllowedUiExtension(lower)) return Promise.resolve();
  if (typeof customElements !== 'undefined' && customElements.get(lower)) {
    return Promise.resolve();
  }
  const existing = inFlight.get(lower);
  if (existing) return existing;

  const registered = extensionLoaders.get(lower);
  const promise = (
    registered
      ? registered()
      : loadBuiltinExtension(lower, runtimeUrl)
  ).catch((err) => {
    inFlight.delete(lower);
    console.warn(`[SoftN] Could not load UI extension <${lower}>:`, err);
  });

  inFlight.set(lower, promise);
  return promise;
}

async function loadBuiltinExtension(tag: string, _runtimeUrl: string): Promise<void> {
  if (typeof customElements === 'undefined' || customElements.get(tag)) return;

  switch (tag) {
    case 'softn-datagrid': {
      const { defineSoftnDataGrid } = await import('./datagrid');
      defineSoftnDataGrid();
      return;
    }
    case 'softn-chart': {
      const { defineSoftnChart } = await import('./chart');
      defineSoftnChart();
      return;
    }
    default:
      // Never dynamically import arbitrary remote modules from untrusted guest tag names.
      return;
  }
}
