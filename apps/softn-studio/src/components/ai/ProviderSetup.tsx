import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useAIStore } from '../../stores';
import { Icon } from '../common/Icon';
import { ModelPicker } from './ModelPicker';
import { testProvider } from '../../lib/aiProvider';
import {
  LOCAL_SERVERS,
  ProviderConnectionError,
  defaultBaseUrl,
  listModels,
  type ModelInfo,
} from '../../lib/providerConnection';
import type { LocalServerKind, ProviderConfig, ProviderType } from '../../types/studio';

interface ProviderSetupProps {
  /** The provider to edit; absent or null to add one. */
  provider?: ProviderConfig | null;
  /** After the provider is saved and made the active one. */
  onDone?(provider: ProviderConfig): void;
  onCancel?(): void;
  /** Text for the cancel button; no button without `onCancel`. */
  cancelLabel?: string;
  /** Narrow: the settings panel. Wide: the dashboard and the dialog. */
  layout?: 'wide' | 'narrow';
}

const CHOICES: { type: ProviderType; title: string; line: string; icon: 'desktop' | 'key' }[] = [
  { type: 'local', title: 'Local model', line: 'Runs on your computer: free and private. Needs Ollama, LM Studio or another OpenAI-compatible server running.', icon: 'desktop' },
  { type: 'openai', title: 'OpenAI API key', line: 'Uses your OpenAI account. OpenAI bills that account for what the AI does.', icon: 'key' },
  { type: 'anthropic', title: 'Anthropic API key', line: 'Uses your Anthropic account. Anthropic bills that account for what the AI does.', icon: 'key' },
];

const KEY_PAGES: Partial<Record<ProviderType, { href: string; label: string }>> = {
  openai: { href: 'https://platform.openai.com/api-keys', label: 'Create a key in the OpenAI dashboard' },
  anthropic: { href: 'https://console.anthropic.com/settings/keys', label: 'Create a key in the Anthropic console' },
};

const TYPE_NAME: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  local: 'Local model',
  custom: 'OpenAI-compatible endpoint',
};

/** An address the setup accepts: http or https, no credentials, no fragment. */
function checkAddress(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
    return null;
  } catch {
    return 'Enter a full http:// or https:// address, without a username, password or #fragment.';
  }
}

function hostName(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

type Listing =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ok'; models: ModelInfo[] }
  | { state: 'error'; message: string };

type TestState =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ok'; message: string }
  | { state: 'error'; message: string };

/**
 * Connect a provider: where the AI runs, how to reach it, which model.
 *
 * One component for every place a provider is set up — the dashboard's
 * first-visit step, the dialog the AI prompts open, and Settings — so the
 * three can never disagree about what a provider needs. The steps are in
 * order and each is shown when the one before it is done: choose a kind,
 * connect (which lists the provider's models), choose a model, then test
 * and save. Nothing here suggests a model name: the list is the
 * provider's own.
 */
export const ProviderSetup: React.FC<ProviderSetupProps> = ({ provider, onDone, onCancel, cancelLabel = 'Cancel', layout = 'wide' }) => {
  const id = useId();
  const editing = !!provider;
  const [type, setType] = useState<ProviderType | null>(provider?.type ?? null);
  const [serverKind, setServerKind] = useState<LocalServerKind>(provider?.serverKind ?? 'ollama');
  const [baseUrl, setBaseUrl] = useState(() => {
    if (!provider) return '';
    if (provider.type === 'local' || provider.type === 'custom') return provider.baseUrl ?? defaultBaseUrl(provider.type, provider.serverKind);
    return '';
  });
  const [apiKey, setApiKey] = useState('');
  const [orgId, setOrgId] = useState(provider?.orgId ?? '');
  const [modelId, setModelId] = useState(provider?.modelId ?? '');
  const [listing, setListing] = useState<Listing>({ state: 'idle' });
  const [test, setTest] = useState<TestState>({ state: 'idle' });
  const [formError, setFormError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(provider?.type === 'custom');
  // Editing a provider starts at its model: how it connects is already
  // settled, and is one line with a button to change it.
  const [connectionOpen, setConnectionOpen] = useState(!provider);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const isLocal = type === 'local' || type === 'custom';
  /** A saved key is kept when the field is left empty on an edit of the same kind. */
  const keptKey = editing && provider!.type === type ? provider!.apiKey : '';
  const effectiveKey = apiKey.trim() || keptKey;

  /** The provider as the form currently describes it. */
  const draft = useCallback((): ProviderConfig | null => {
    if (!type) return null;
    const address = baseUrl.trim();
    const name = type === 'local'
      ? (serverKind === 'other' ? hostName(address) || LOCAL_SERVERS.other.label : LOCAL_SERVERS[serverKind].label)
      : type === 'custom'
        ? hostName(address) || 'OpenAI-compatible'
        : TYPE_NAME[type];
    return {
      id: provider?.id ?? crypto.randomUUID(),
      type,
      name,
      apiKey: effectiveKey,
      // A cloud provider keeps whatever address it was saved with (an older
      // one stored its full endpoint); a new one uses the provider's own.
      baseUrl: isLocal ? address || undefined : provider?.type === type ? provider?.baseUrl : undefined,
      modelId: modelId.trim() || undefined,
      orgId: type === 'openai' && orgId.trim() ? orgId.trim() : undefined,
      serverKind: type === 'local' ? serverKind : undefined,
    };
  }, [type, baseUrl, serverKind, provider, effectiveKey, isLocal, modelId, orgId]);

  /** Why the connection details are not usable yet, or null. */
  const detailsProblem = (): string | null => {
    if (!type) return 'Choose where the AI runs.';
    if (!isLocal && !effectiveKey) return `Paste your ${TYPE_NAME[type]} API key.`;
    if (isLocal) {
      if (!baseUrl.trim()) return 'Enter the server’s address.';
      return checkAddress(baseUrl.trim());
    }
    return null;
  };

  const connect = async () => {
    const problem = detailsProblem();
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError('');
    const candidate = draft();
    if (!candidate) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const request = ++requestRef.current;
    setListing({ state: 'loading' });
    setTest({ state: 'idle' });
    try {
      const models = await listModels(candidate, { signal: controller.signal });
      if (request !== requestRef.current) return;
      setListing({ state: 'ok', models });
    } catch (err) {
      if (request !== requestRef.current) return;
      if (err instanceof ProviderConnectionError && err.kind === 'cancelled') return;
      setListing({ state: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  // Editing a provider that can already connect — typically one saved
  // without a model — goes straight to its model list.
  // (Run again on StrictMode's remount: the first run's request was
  // aborted by the unmount in between.)
  useEffect(() => {
    if (!provider) return;
    if (provider.type === 'anthropic' || provider.type === 'openai' ? provider.apiKey : true) void connect();
    // Only on mount, for the provider being edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetConnection = () => {
    requestRef.current++;
    abortRef.current?.abort();
    setListing({ state: 'idle' });
    setTest({ state: 'idle' });
    setFormError('');
  };

  const chooseType = (next: ProviderType) => {
    if (next === type) return;
    setType(next);
    setApiKey('');
    setModelId('');
    setOrgId('');
    if (next === 'local') setBaseUrl(LOCAL_SERVERS[serverKind].baseUrl);
    else if (next === 'custom') setBaseUrl('');
    resetConnection();
  };

  const chooseServer = (next: LocalServerKind) => {
    setServerKind(next);
    // Only replace an address that is still some server's default.
    const defaults = Object.values(LOCAL_SERVERS).map((server) => server.baseUrl);
    if (!baseUrl.trim() || defaults.includes(baseUrl.trim())) setBaseUrl(LOCAL_SERVERS[next].baseUrl);
    resetConnection();
  };

  const runTest = async () => {
    const candidate = draft();
    if (!candidate?.modelId) {
      setTest({ state: 'error', message: 'Choose a model first, then test.' });
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const request = ++requestRef.current;
    setTest({ state: 'running' });
    const result = await testProvider(candidate, { signal: controller.signal });
    if (request !== requestRef.current) return;
    if (result.ok) {
      if (result.models.length > 0) setListing({ state: 'ok', models: result.models });
      setTest({
        state: 'ok',
        message: result.modelListed === false
          ? `${candidate.modelId} replied, although it is not in the provider’s model list.`
          : `Connected. ${candidate.modelId} replied.`,
      });
    } else if (result.kind !== 'cancelled') {
      setTest({ state: 'error', message: result.message });
    }
  };

  const save = () => {
    const problem = detailsProblem();
    if (problem) {
      setFormError(problem);
      return;
    }
    const candidate = draft();
    if (!candidate) return;
    if (!candidate.modelId) {
      setFormError('Choose a model. Every request uses it, and Studio never picks one for you.');
      return;
    }
    const ai = useAIStore.getState();
    ai.saveProvider(candidate);
    ai.setActiveProvider(candidate.id);
    onDone?.(candidate);
  };

  const connected = listing.state === 'ok' || listing.state === 'error';
  const stepState = (step: 1 | 2 | 3): 'done' | 'current' | 'waiting' => {
    if (step === 1) return type ? 'done' : 'current';
    if (step === 2) return !type ? 'waiting' : listing.state === 'ok' ? 'done' : 'current';
    return connected ? (modelId ? 'done' : 'current') : 'waiting';
  };

  const keyPage = type ? KEY_PAGES[type] : undefined;

  return (
    <div className="st-setup" data-layout={layout}>
      {!connectionOpen && provider && (
        <div className="st-setup-summary">
          <span className="st-setup-summary-text">
            <span className="st-setup-summary-name">{TYPE_NAME[provider.type]}</span>
            <span className="st-setup-summary-meta">
              {provider.type === 'local' || provider.type === 'custom'
                ? hostName(provider.baseUrl || defaultBaseUrl(provider.type, provider.serverKind))
                : provider.apiKey ? 'API key saved' : 'No key saved'}
              {listing.state === 'loading' ? ' · connecting…' : listing.state === 'ok' ? ' · connected' : ''}
            </span>
          </span>
          <button type="button" className="st-btn st-btn-sm" onClick={() => setConnectionOpen(true)}>
            Change connection
          </button>
        </div>
      )}
      {!connectionOpen && listing.state === 'error' && (
        <div className="st-setup-error" role="alert">
          <strong>Could not list the models.</strong>
          <span>{listing.message}</span>
        </div>
      )}
      <ol className="st-setup-steps" data-collapsed={!connectionOpen || undefined}>
        {/* 1. Where the AI runs */}
        <li className="st-setup-step" data-state={stepState(1)} hidden={!connectionOpen}>
          <h3 className="st-setup-step-title" id={`${id}-kind`}>Where should the AI run?</h3>
          <div className="st-choices" role="radiogroup" aria-labelledby={`${id}-kind`}>
            {CHOICES.map((choice) => (
              <label key={choice.type} className="st-choice" data-checked={type === choice.type || undefined}>
                <input
                  type="radio"
                  name={`${id}-type`}
                  value={choice.type}
                  checked={type === choice.type}
                  onChange={() => chooseType(choice.type)}
                />
                <span className="st-choice-icon" aria-hidden="true"><Icon name={choice.icon} size={16} /></span>
                <span className="st-choice-text">
                  <span className="st-choice-title">{choice.title}</span>
                  <span className="st-choice-line">{choice.line}</span>
                </span>
              </label>
            ))}
          </div>
          {showAdvanced ? (
            <label className="st-choice st-choice-compact" data-checked={type === 'custom' || undefined}>
              <input type="radio" name={`${id}-type`} value="custom" checked={type === 'custom'} onChange={() => chooseType('custom')} />
              <span className="st-choice-text">
                <span className="st-choice-title">Other OpenAI-compatible endpoint</span>
                <span className="st-choice-line">A hosted gateway, or a server on another machine, that speaks the OpenAI chat completions API.</span>
              </span>
            </label>
          ) : (
            <button type="button" className="st-link-btn st-setup-advanced" onClick={() => setShowAdvanced(true)}>
              Other OpenAI-compatible endpoint…
            </button>
          )}
        </li>

        {/* 2. How to reach it */}
        <li className="st-setup-step" data-state={stepState(2)} hidden={!connectionOpen}>
          <h3 className="st-setup-step-title">{isLocal ? 'Where is the server?' : 'Connect your account'}</h3>
          {!type ? (
            <p className="st-setup-wait">Choose where the AI runs first.</p>
          ) : (
            <form
              className="st-setup-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void connect();
              }}
            >
              {type === 'local' && (
                <div className="st-segmented" role="radiogroup" aria-label="Local server">
                  {(Object.keys(LOCAL_SERVERS) as LocalServerKind[]).map((kind) => (
                    <label key={kind} className="st-segment" data-checked={serverKind === kind || undefined}>
                      <input type="radio" name={`${id}-server`} checked={serverKind === kind} onChange={() => chooseServer(kind)} />
                      {LOCAL_SERVERS[kind].label}
                    </label>
                  ))}
                </div>
              )}

              {isLocal && (
                <div className="st-field">
                  <label htmlFor={`${id}-address`} className="st-field-label">Server address</label>
                  <input
                    id={`${id}-address`}
                    type="url"
                    className="st-input st-input-mono"
                    value={baseUrl}
                    onChange={(e) => { setBaseUrl(e.target.value); if (listing.state !== 'idle') resetConnection(); }}
                    placeholder={type === 'custom' ? 'https://example.com/v1' : LOCAL_SERVERS[serverKind].baseUrl}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="st-field-hint">
                    {type === 'local' ? LOCAL_SERVERS[serverKind].help : 'The API base, usually ending in /v1. It has to allow requests from this page (CORS).'}
                  </span>
                </div>
              )}

              <div className="st-field">
                <label htmlFor={`${id}-key`} className="st-field-label">
                  API key{isLocal && <span className="st-field-optional"> (only if the server asks for one)</span>}
                </label>
                <input
                  id={`${id}-key`}
                  type="password"
                  className="st-input st-input-mono"
                  value={apiKey}
                  onChange={(e) => { setApiKey(e.target.value); if (listing.state !== 'idle') resetConnection(); }}
                  placeholder={keptKey ? 'Saved — leave empty to keep it' : ''}
                  autoComplete="off"
                  spellCheck={false}
                />
                {keyPage && (
                  <a className="st-field-hint st-ext-link" href={keyPage.href} target="_blank" rel="noreferrer">
                    {keyPage.label}
                    <span aria-hidden="true">↗</span>
                  </a>
                )}
              </div>

              {type === 'openai' && (
                <details className="st-setup-more" open={!!orgId || undefined}>
                  <summary>More options</summary>
                  <div className="st-field">
                    <label htmlFor={`${id}-org`} className="st-field-label">Organization ID <span className="st-field-optional">(optional)</span></label>
                    <input
                      id={`${id}-org`}
                      className="st-input st-input-mono"
                      value={orgId}
                      onChange={(e) => setOrgId(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <span className="st-field-hint">Only for a key that belongs to more than one organization.</span>
                  </div>
                </details>
              )}

              <p className="st-setup-privacy">
                <Icon name="info" size={13} />
                <span>
                  {isLocal
                    ? 'Requests go straight from this browser to the server. Your project never passes through SoftN.'
                    : `The key is saved in this browser’s local storage for this site — not encrypted, and readable by anyone who can use this browser profile. It is sent only to ${TYPE_NAME[type]}, straight from this browser; SoftN never sees it or your project. Remove it here at any time.`}
                </span>
              </p>

              {formError && !connected && <p className="st-setup-error" role="alert">{formError}</p>}

              <div className="st-setup-actions">
                <button type="submit" className={listing.state === 'ok' ? 'st-btn' : 'st-btn st-btn-primary'} aria-busy={listing.state === 'loading' || undefined} disabled={listing.state === 'loading'}>
                  {listing.state === 'loading' ? 'Connecting…' : listing.state === 'idle' ? 'Connect' : 'Connect again'}
                </button>
              </div>

              {listing.state === 'error' && (
                <div className="st-setup-error" role="alert">
                  <strong>Could not list the models.</strong>
                  <span>{listing.message}</span>
                </div>
              )}
            </form>
          )}
        </li>

        {/* 3. Which model */}
        <li className="st-setup-step" data-state={stepState(3)}>
          <h3 className="st-setup-step-title">Choose a model</h3>
          {!connected ? (
            <p className="st-setup-wait" role="status">
              {listing.state === 'loading'
                ? 'Asking the provider for its models…'
                : 'Connect first: the list comes from the provider, so it is always current.'}
            </p>
          ) : (
            <>
              <ModelPicker
                key={listing.state === 'ok' ? `list-${listing.models.length}` : 'manual'}
                label="Model"
                models={listing.state === 'ok' ? listing.models : null}
                value={modelId}
                onChange={(next) => { setModelId(next); setTest({ state: 'idle' }); setFormError(''); }}
                manualByDefault={listing.state !== 'ok'}
              />
              {formError && <p className="st-setup-error" role="alert">{formError}</p>}
              <div aria-live="polite">
                {test.state === 'ok' && <p className="st-setup-ok"><Icon name="check" size={14} />{test.message}</p>}
                {test.state === 'error' && <p className="st-setup-error" role="alert">{test.message}</p>}
              </div>
              <div className="st-setup-actions">
                {onCancel && <button type="button" className="st-btn st-btn-ghost" onClick={onCancel}>{cancelLabel}</button>}
                <button type="button" className="st-btn" onClick={() => void runTest()} disabled={!modelId || test.state === 'running'} aria-busy={test.state === 'running' || undefined}>
                  {test.state === 'running' ? 'Testing…' : 'Test connection'}
                </button>
                <button type="button" className="st-btn st-btn-primary" onClick={save} disabled={!modelId}>
                  {editing ? 'Save' : 'Save and use'}
                </button>
              </div>
            </>
          )}
          {!connected && onCancel && (
            <div className="st-setup-actions">
              <button type="button" className="st-btn st-btn-ghost" onClick={onCancel}>{cancelLabel}</button>
            </div>
          )}
        </li>
      </ol>
    </div>
  );
};
