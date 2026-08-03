import { useAIStore, useVFSStore, useWorkspaceStore } from '../stores';

/**
 * Start a successfully decoded import from a clean project session while
 * retaining the user's display preference and provider configuration.
 */
export function resetProjectSessionForImport(): void {
  const theme = useWorkspaceStore.getState().themePreview;
  useWorkspaceStore.getState().reset();
  useWorkspaceStore.getState().setThemePreview(theme);
  useVFSStore.getState().reset();
  useAIStore.getState().resetSession();
}
