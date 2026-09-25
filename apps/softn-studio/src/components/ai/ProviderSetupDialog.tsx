import React from 'react';
import { useModalFocus } from '@softn/editor-shared/useModalFocus';
import { useAIStore } from '../../stores';
import { Icon } from '../common/Icon';
import { ProviderSetup } from './ProviderSetup';

/**
 * The AI setup, over whatever is on screen. Every place that would use the
 * AI without a provider — the chat, the new-app wizard, the AI pill in the
 * bar — opens this instead of leaving a control that does nothing. It is
 * the same `ProviderSetup` the dashboard and Settings show.
 */
export const ProviderSetupDialog: React.FC = () => {
  const dialog = useAIStore((s) => s.setupDialog);
  const providers = useAIStore((s) => s.providers);
  const close = useAIStore((s) => s.closeProviderSetup);
  const ref = useModalFocus(!!dialog, close);
  if (!dialog) return null;
  const provider = dialog.providerId ? providers.find((p) => p.id === dialog.providerId) ?? null : null;
  const title = provider ? (provider.modelId ? `Edit ${provider.name}` : `Choose a model for ${provider.name}`) : 'Connect an AI provider';

  return (
    <div className="st-dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={ref} className="st-dialog" role="dialog" aria-modal="true" aria-labelledby="st-setup-dialog-title" tabIndex={-1}>
        <div className="st-dialog-head">
          <div>
            <h2 id="st-setup-dialog-title" className="st-dialog-title">{title}</h2>
            <p className="st-dialog-sub">
              {provider && !provider.modelId
                ? 'Studio no longer picks a model for you. Choose one of the models this provider offers.'
                : 'Studio’s AI runs on a provider you choose: a model on your computer, or your own OpenAI or Anthropic account.'}
            </p>
          </div>
          <button type="button" className="st-icon-btn" onClick={close} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="st-dialog-body">
          <ProviderSetup key={dialog.providerId ?? 'new'} provider={provider} onDone={close} onCancel={close} />
        </div>
      </div>
    </div>
  );
};
