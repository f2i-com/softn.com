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

export function registerUiExtension(tagName: string, loader: ExtensionLoader): void {
  extensionLoaders.set(tagName.toLowerCase(), loader);
}

export function ensureUiExtension(tagName: string, runtimeUrl = '/runtime/'): Promise<void> {
  const lower = tagName.toLowerCase();
  if (!lower.startsWith('softn-') || lower === 'softn-app') return Promise.resolve();
  if (typeof customElements !== 'undefined' && customElements.get(lower)) {
    return Promise.resolve();
  }
  const existing = inFlight.get(lower);
  if (existing) return existing;

  const registered = extensionLoaders.get(lower);
  const promise = (
    registered
      ? registered()
      : loadBuiltinOrRemoteExtension(lower, runtimeUrl)
  ).catch((err) => {
    console.warn(`[SoftN] Could not load UI extension <${lower}>:`, err);
  });

  inFlight.set(lower, promise);
  return promise;
}

async function loadBuiltinOrRemoteExtension(tag: string, runtimeUrl: string): Promise<void> {
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
    default: {
      const base = runtimeUrl.endsWith('/') ? runtimeUrl : `${runtimeUrl}/`;
      const name = tag.slice('softn-'.length);
      await import(/* @vite-ignore */ `${base}ui/${name}.js`);
    }
  }
}
