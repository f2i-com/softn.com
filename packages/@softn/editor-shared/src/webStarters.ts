export const WEB_STARTERS = [
  { id: 'vanilla', label: 'Vanilla JS', sourceFile: 'app.js', name: 'Trail log', description: 'Count the sections you finish on a walk.' },
  { id: 'react', label: 'React', sourceFile: 'app.js', name: 'Practice set', description: 'Keep track of the rounds in a practice session.' },
  { id: 'vue', label: 'Vue', sourceFile: 'app.js', name: 'Reading log', description: 'Log the pages you read in a sitting.' },
] as const;

export const COMPONENT_STARTERS = {
  react: { ...WEB_STARTERS[1], id: 'react-jsx', label: 'React JSX', format: 'JSX', sourceFile: 'App.jsx' },
  vue: { ...WEB_STARTERS[2], id: 'vue-sfc', label: 'Vue SFC', format: 'Vue single-file component', sourceFile: 'App.vue' },
} as const;
export type WebStarter = typeof WEB_STARTERS[number] | typeof COMPONENT_STARTERS[keyof typeof COMPONENT_STARTERS];
export type WebStarterId = WebStarter['id'];
export interface StarterFile { path: string; content: string }

interface StarterOptions {
  name?: string;
  description?: string;
  theme?: 'light' | 'dark' | 'system';
}

/** Keep the project picker small. App source and the selected production framework load on creation. */
export async function createWebStarter(id: WebStarterId, options: StarterOptions = {}): Promise<StarterFile[]> {
  const metadata = [...WEB_STARTERS, ...Object.values(COMPONENT_STARTERS)].find((starter) => starter.id === id);
  if (!metadata) throw new Error(`Unknown web starter: ${id}`);
  try {
    const { buildStarter } = await import('./starters/buildStarter');
    return await buildStarter(id, options.name?.trim() || metadata.name, options.description ?? metadata.description, options.theme ?? 'system');
  } catch (cause) {
    // A stale editor tab or an incomplete offline install can lose a lazy chunk.
    if (cause instanceof TypeError && /dynamically imported module|importing a module script failed/i.test(cause.message)) {
      throw new Error(`The ${metadata.label} starter files are unavailable. Save your work and reload the editor while online, then try again.`, { cause });
    }
    throw cause;
  }
}
