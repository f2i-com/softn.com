import React from 'react';
import { isHostedEditor } from '@softn/editor-shared/hostedEditor';
import { useAIStore, useWorkspaceStore } from '../../stores';
import { isRunLive } from '../../lib/agent/runAgent';
import { nextStepFor, type NextStepContext } from '../../lib/agent/failureNextStep';
import { Icon } from '../common/Icon';
import { openSetupFor, useAIReadiness } from './AIStatusPill';

/**
 * Above the box a message is typed in, after a run that did not finish: what
 * happened in a line, what to do, and the control to do it with (the reason a
 * run stopped was kept in the store and never shown; lib/agent/failureNextStep.ts).
 * It goes when the next run starts, when the stopped one goes on, or when it
 * is dismissed.
 */
export function FailureNextStep({ onOpenSettings }: {
  /** Show the settings, where they are not a panel beside the chat (a phone). */
  onOpenSettings?: () => void;
}): React.ReactElement | null {
  const failure = useAIStore((s) => s.lastFailure);
  const agentState = useAIStore((s) => s.agentState);
  const last = useAIStore((s) => s.messages.at(-1));
  const provider = useAIStore((s) => s.providers.find((p) => p.id === s.activeProviderId) ?? null);
  const readiness = useAIReadiness();
  if (!failure || agentState !== 'idle') return null;

  // Whether the run that stopped can go on from where it is: it is the last thing in the chat
  // and still this page's.
  const run = last?.run;
  const goOn: NextStepContext['goOn'] = run && isRunLive(run.id)
    ? run.status === 'paused' ? 'resume' : run.status === 'failed' || run.status === 'stopped' ? 'continue' : undefined
    : undefined;
  const step = nextStepFor(failure, { providerName: provider?.name, goOn, hosted: isHostedEditor() });
  if (!step) return null;

  const open = () => {
    const ai = useAIStore.getState();
    if (step.action?.opens === 'limits') {
      // The limits are in Settings, under AI: the panel beside the chat, or a phone's own tab.
      if (onOpenSettings) onOpenSettings();
      else useWorkspaceStore.getState().setLeftPanel('settings');
    } else if (step.action?.opens === 'provider' && provider) {
      ai.openProviderSetup(provider.id);
    } else {
      openSetupFor(readiness);
    }
  };

  return (
    <div className="st-next-step" role="group" aria-label="What to do next">
      <span className="st-next-step-mark" aria-hidden="true"><Icon name="alert-circle" size={15} /></span>
      <div className="st-next-step-text">
        <strong>{step.title}</strong>
        <span>{step.advice}</span>
      </div>
      <div className="st-next-step-actions">
        {step.action && (
          <button type="button" className="st-btn st-btn-sm st-btn-primary" onClick={open}>
            {step.action.label}
          </button>
        )}
        <button type="button" className="st-icon-btn" onClick={() => useAIStore.getState().setLastFailure(null)} aria-label="Dismiss" title="Dismiss">
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  );
}
