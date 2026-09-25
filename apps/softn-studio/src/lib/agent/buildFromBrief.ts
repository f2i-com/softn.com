/**
 * The new-app flow's hand-off: the brief wizard scaffolds a starting point,
 * the blueprint is approved, and an agent run builds the app the brief
 * describes — plan, write, check, fix, finish — instead of leaving the
 * scaffold for the person to ask about.
 */

import { resolveModel } from '../aiProvider';
import { useAIStore } from '../../stores/aiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { startAgentRun } from './runAgent';

/** Whether a build can start now: a brief, and a provider with a model. */
export function canBuildFromBrief(): boolean {
  const ai = useAIStore.getState();
  const provider = ai.providers.find((p) => p.id === ai.activeProviderId);
  return Boolean(useWorkspaceStore.getState().brief && provider && resolveModel(provider, ai.modelProfile.builder));
}

/**
 * Start the build run for the brief, with a request in the chat that says
 * what it is for. Returns false (and does nothing) when it cannot start.
 */
export function buildFromBrief(): boolean {
  if (!canBuildFromBrief() || useAIStore.getState().agentState === 'building') return false;
  const ws = useWorkspaceStore.getState();
  const brief = ws.brief!;
  const pages = brief.pages.length > 0 ? ` Pages: ${brief.pages.join(', ')}.` : '';
  const collections = brief.collections.length > 0 ? ` Data: ${brief.collections.join(', ')}.` : '';
  useAIStore.getState().addMessage({
    id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `b-${Date.now()}`,
    role: 'user',
    content: `Build ${brief.appName} as the brief describes: ${brief.description}${pages}${collections}`,
    timestamp: Date.now(),
  });
  // Open the chat, where the run shows. setLeftPanel toggles a panel that is
  // already open, so it is only called when the chat is not showing.
  if (ws.leftPanel !== 'ai' || !ws.leftPanelExpanded) ws.setLeftPanel('ai');
  void startAgentRun({ kind: 'build' });
  return true;
}
