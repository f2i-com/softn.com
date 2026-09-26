/**
 * Studio's side of the bridge's `agentRuns` capability: a host (FormLogic)
 * can open a project with a request for the agent, and hears how the agent is
 * doing. The host takes the person to Studio to watch their app being built,
 * and holds its own "review" and "close" while a run writes.
 */

import { reportHostedAgentStatus, type HostedAgentStatus, type HostedBrief } from '@softn/editor-shared/hostedEditor';
import { useAIStore } from '../../stores/aiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { AgentRunRecord } from './types';
import { startAgentRun } from './runAgent';

/**
 * Put the host's request in the chat as the person's message and start a run
 * for it, with the chat open so the run shows. Returns the run, or null (and
 * does nothing) while a run is already going.
 */
export function startRunFromBrief(brief: HostedBrief): Promise<void> | null {
  const ai = useAIStore.getState();
  if (ai.agentState === 'building') return null;
  ai.addMessage({
    id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `h-${Date.now()}`,
    role: 'user',
    content: brief.prompt,
    timestamp: Date.now(),
  });
  const ws = useWorkspaceStore.getState();
  // setLeftPanel toggles a panel that is already open, so it is only called when the chat is not showing.
  if (ws.leftPanel !== 'ai' || !ws.leftPanelExpanded) ws.setLeftPanel('ai');
  return startAgentRun({ kind: brief.kind });
}

/** The newest run in the chat, if there is one. */
function latestRun(): AgentRunRecord | undefined {
  const { messages } = useAIStore.getState();
  for (let i = messages.length - 1; i >= 0; i--) {
    const run = messages[i].run;
    if (run) return run;
  }
  return undefined;
}

/** Where the agent is, as the host hears it. */
export function currentAgentStatus(): HostedAgentStatus {
  const { agentState, currentStep } = useAIStore.getState();
  const run = latestRun();
  if (agentState === 'building') return { state: 'running', step: currentStep || undefined };
  if (!run) return { state: 'idle' };
  // A run the store no longer drives (the page reloaded under it) is not running here.
  const state = run.status === 'running' ? 'paused' : run.status;
  return {
    state,
    summary: run.status === 'finished' ? run.summary : undefined,
    reason: state === 'paused' || state === 'stopped' || state === 'failed' ? run.reason : undefined,
  };
}

/**
 * Report the agent's status to the host whenever it changes, until the
 * returned function is called. Step text changes quickly while a run works,
 * so reports are coalesced to one every 250 ms; a run starting or ending is
 * reported at once.
 */
export function reportAgentStatusToHost(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastState = '';
  const send = () => { timer = null; reportHostedAgentStatus(currentAgentStatus()); };
  const unsubscribe = useAIStore.subscribe(() => {
    const state = currentAgentStatus().state;
    if (state !== lastState) {
      lastState = state;
      if (timer) clearTimeout(timer);
      send();
      return;
    }
    if (!timer) timer = setTimeout(send, 250);
  });
  send();
  return () => { unsubscribe(); if (timer) clearTimeout(timer); };
}
