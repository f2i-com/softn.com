import React, { useState } from 'react';
import { useAIStore } from '../../stores';
import { MAX_OUTPUT_TOKENS_BOUNDS, REQUEST_TIMEOUT_BOUNDS_MS } from '../../stores/aiStore';
import { Icon } from '../common/Icon';
import type { ProviderType } from '../../types/studio';

export const SettingsPanel: React.FC = () => {
  const {
    providers, addProvider, removeProvider,
    activeProviderId, setActiveProvider,
    modelProfile, updateModelProfile,
    maxIterations, tokenBudget, setMaxIterations, setTokenBudget,
    requestTimeoutMs, setRequestTimeoutMs, maxOutputTokens, setMaxOutputTokens,
    iterationsUsed, tokensUsed, resetBudget,
  } = useAIStore();
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [newProviderType, setNewProviderType] = useState<ProviderType>('anthropic');
  const [newApiKey, setNewApiKey] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  const [newModelId, setNewModelId] = useState('');
  const [providerError, setProviderError] = useState('');
  const [settingsTab, setSettingsTab] = useState<'ai' | 'general'>('ai');

  const defaultModels: Record<ProviderType, string> = {
    anthropic: 'claude-sonnet-4-6',
    openai: 'gpt-5.4',
    custom: '',
  };
  const defaultEndpoints: Record<ProviderType, string> = {
    anthropic: 'https://api.anthropic.com/v1/messages',
    openai: 'https://api.openai.com/v1/chat/completions',
    custom: 'http://localhost:11434/v1/chat/completions',
  };

  const handleAddProvider = () => {
    const apiKey = newApiKey.trim();
    const baseUrl = newBaseUrl.trim();
    const modelId = newModelId.trim();
    if (!apiKey && newProviderType !== 'custom') {
      setProviderError('Enter an API key, or choose Custom / Local AI for a server without a key.');
      return;
    }
    if (newProviderType === 'custom' && !modelId) {
      setProviderError('Enter the model name loaded by your local server or custom provider.');
      return;
    }
    if (baseUrl) {
      try {
        const endpoint = new URL(baseUrl);
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error();
      } catch {
        setProviderError('Enter a full HTTP or HTTPS endpoint without a username, password, or fragment.');
        return;
      }
    }
    setProviderError('');
    const id = crypto.randomUUID();
    const names: Record<ProviderType, string> = {
      anthropic: 'Anthropic',
      openai: 'OpenAI',
      custom: baseUrl ? new URL(baseUrl).hostname : 'Local AI',
    };
    addProvider({
      id,
      type: newProviderType,
      name: names[newProviderType],
      apiKey,
      baseUrl: baseUrl || undefined,
      modelId: modelId || undefined,
    });
    setActiveProvider(id);
    setNewApiKey('');
    setNewBaseUrl('');
    setNewModelId('');
    setShowAddProvider(false);
  };

  return (
    <div className="studio-settings" style={styles.container}>
      <style>{`.studio-settings :is(input, select, button):focus-visible { outline: 2px solid var(--studio-accent) !important; outline-offset: 3px; }
        .studio-settings :is(input, select) { box-sizing: border-box; }
        @media (max-width: 767px) { .studio-settings :is(input, select) { font-size: 16px !important; } }`}</style>
      {/* Tab header */}
      <div style={styles.tabs}>
        <button
          onClick={() => setSettingsTab('ai')}
          aria-pressed={settingsTab === 'ai'}
          style={{ ...styles.tab, ...(settingsTab === 'ai' ? styles.tabActive : {}) }}
        >
          <Icon name="ai" size={14} />
          AI
        </button>
        <button
          onClick={() => setSettingsTab('general')}
          aria-pressed={settingsTab === 'general'}
          style={{ ...styles.tab, ...(settingsTab === 'general' ? styles.tabActive : {}) }}
        >
          <Icon name="settings" size={14} />
          General
        </button>
      </div>

      <div style={styles.content}>
        {settingsTab === 'ai' && (
          <>
            <div style={styles.setupIntro}>
              <Icon name="ai" size={22} color="var(--studio-accent)" />
              <div>
                <h2 style={styles.setupTitle}>Your AI, your workspace</h2>
                <p style={styles.emptyHint}>Choose a provider, set its model, then return to AI Chat. Projects and API keys stay in this browser; generation sends your project context to your chosen provider.</p>
              </div>
            </div>
            {/* API Providers */}
              <div style={styles.fieldGroup}>
                <label style={styles.label}>API Providers</label>

                {providers.length === 0 && !showAddProvider && (
                  <div style={styles.emptyProviders}>
                    <Icon name="key" size={20} color="var(--studio-text-dim)" />
                    <p style={styles.emptyText}>No providers configured</p>
                    <p style={styles.emptyHint}>Connect a provider or a local model to start generating</p>
                  </div>
                )}

                {providers.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      ...styles.providerRow,
                      ...(activeProviderId === p.id ? styles.providerRowActive : {}),
                    }}
                  >
                    <button
                      onClick={() => setActiveProvider(p.id)}
                      aria-label={`Use ${p.name}${p.modelId ? ` (${p.modelId})` : ''}`}
                      aria-pressed={activeProviderId === p.id}
                      style={styles.providerInfo}
                    >
                      <div style={{
                        ...styles.providerDot,
                        background: activeProviderId === p.id ? 'var(--studio-success)' : 'var(--studio-text-dim)',
                      }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={styles.providerName}>
                          {p.name}
                          {p.modelId && <span style={styles.providerModel}> · {p.modelId}</span>}
                        </div>
                        <div style={styles.providerKey}>
                          {p.apiKey ? 'API key saved' : 'No key required'}
                          {p.baseUrl && <span> · {p.baseUrl.replace(/^https?:\/\//, '').split('/')[0]}</span>}
                        </div>
                      </div>
                    </button>
                    <button
                      onClick={() => removeProvider(p.id)}
                      aria-label={`Remove ${p.name}${p.modelId ? ` (${p.modelId})` : ''}`}
                      style={styles.removeBtn}
                    >
                      <Icon name="trash" size={14} color="var(--studio-text-dim)" />
                    </button>
                  </div>
                ))}

                {showAddProvider ? (
                  <form style={styles.addForm} noValidate onSubmit={(e) => { e.preventDefault(); handleAddProvider(); }}>
                    <div style={styles.addFormField}>
                      <label htmlFor="studio-provider-preset" style={styles.fieldLabel}>Provider preset</label>
                      <select
                        id="studio-provider-preset"
                        style={styles.select}
                        value={newProviderType}
                        onChange={(e) => {
                          const t = e.target.value as ProviderType;
                          setNewProviderType(t);
                          setNewApiKey('');
                          setProviderError('');
                          setNewModelId('');
                          setNewBaseUrl('');
                        }}
                      >
                        <option value="anthropic">Anthropic (Claude)</option>
                        <option value="openai">OpenAI-compatible</option>
                        <option value="custom">Custom / Local AI</option>
                      </select>
                    </div>

                    <div style={styles.addFormField}>
                      <label htmlFor="studio-provider-key" style={styles.fieldLabel}>
                        API Key {newProviderType === 'custom' && <span style={{ fontWeight: 400, color: 'var(--studio-text-dim)' }}>(optional for local)</span>}
                      </label>
                      <input
                        id="studio-provider-key"
                        autoComplete="off"
                        style={styles.input}
                        type="password"
                        value={newApiKey}
                        onChange={(e) => setNewApiKey(e.target.value)}
                        placeholder={newProviderType === 'anthropic' ? 'sk-ant-...' : newProviderType === 'openai' ? 'sk-...' : 'API key (if needed)'}
                      />
                    </div>

                    <div style={styles.addFormField}>
                      <label htmlFor="studio-provider-model" style={styles.fieldLabel}>Model name</label>
                      <input
                        id="studio-provider-model"
                        style={styles.input}
                        value={newModelId}
                        onChange={(e) => setNewModelId(e.target.value)}
                        placeholder={defaultModels[newProviderType] || 'e.g. llama3, mistral, gemma2...'}
                      />
                      <span style={styles.fieldHint}>
                        {newProviderType === 'anthropic'
                          ? `Default: ${defaultModels.anthropic}`
                          : newProviderType === 'openai'
                          ? `Default: ${defaultModels.openai}`
                          : 'Required for custom endpoints'}
                      </span>
                    </div>

                    <div style={styles.addFormField}>
                      <label htmlFor="studio-provider-endpoint" style={styles.fieldLabel}>
                        Endpoint URL <span style={{ fontWeight: 400, color: 'var(--studio-text-dim)' }}>(optional override)</span>
                      </label>
                      <input
                        id="studio-provider-endpoint"
                        type="url"
                        style={styles.input}
                        value={newBaseUrl}
                        onChange={(e) => setNewBaseUrl(e.target.value)}
                        placeholder={defaultEndpoints[newProviderType]}
                      />
                      <span style={styles.fieldHint}>
                        Use the full completion endpoint, including /v1/chat/completions for compatible servers. Leave blank for the preset above. The server must allow requests from this browser.
                      </span>
                    </div>

                    <p style={styles.keyNotice}>
                      <Icon name="info" size={12} color="var(--studio-text-dim)" />
                      Keys are stored in your browser only. Never sent to SoftN servers.
                    </p>

                    {providerError && <p role="alert" style={{ ...styles.fieldHint, color: 'var(--studio-error)', marginBottom: 10 }}>{providerError}</p>}

                    <div style={styles.addFormActions}>
                      <button type="button" onClick={() => { setShowAddProvider(false); setNewApiKey(''); setProviderError(''); }} style={styles.cancelBtn}>
                        Cancel
                      </button>
                      <button type="submit" style={styles.saveBtn}>
                        Save Provider
                      </button>
                    </div>
                  </form>
                ) : (
                  <button
                    onClick={() => setShowAddProvider(true)}
                    style={styles.addProviderBtn}
                  >
                    <Icon name="plus" size={14} />
                    Add Provider
                  </button>
                )}
              </div>

            {/* Model profile */}
            {providers.length > 0 && (
              <div style={styles.fieldGroup}>
                <label htmlFor="studio-generation-model" style={styles.label}>Generation model override</label>
                <input
                  id="studio-generation-model"
                  style={styles.input}
                  value={modelProfile.builder}
                  onChange={(e) => updateModelProfile({ builder: e.target.value.trim() })}
                  placeholder={providers.find((p) => p.id === activeProviderId)?.modelId || 'Use the provider’s default model'}
                />
                <p style={styles.fieldHint}>Optional. All generation requests use this model on the selected provider. Leave blank to use the model saved with that provider. Update or clear this override when switching providers.</p>
              </div>
            )}

            {/* Budget limits */}
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Budget Limits</label>
              <div style={styles.modelGrid}>
                <div style={styles.modelRow}>
                  <div style={styles.modelInfo}>
                    <span style={styles.modelRoleName}>Max iterations</span>
                    <span style={styles.modelRoleHint}>Per generation cycle</span>
                  </div>
                  <input
                    style={styles.modelInput}
                    type="number"
                    min={1}
                    max={100}
                    value={maxIterations}
                    onChange={(e) => setMaxIterations(Number(e.target.value) || 15)}
                  />
                </div>
                <div style={styles.modelRow}>
                  <div style={styles.modelInfo}>
                    <span style={styles.modelRoleName}>Token budget</span>
                    <span style={styles.modelRoleHint}>Max tokens per session</span>
                  </div>
                  <input
                    style={styles.modelInput}
                    type="number"
                    min={1000}
                    max={1000000}
                    step={10000}
                    value={tokenBudget}
                    onChange={(e) => setTokenBudget(Number(e.target.value) || 50000)}
                  />
                </div>
                <div style={styles.modelRow}>
                  <div style={styles.modelInfo}>
                    <span style={styles.modelRoleName}>Used</span>
                    <span style={styles.modelRoleHint}>{iterationsUsed} iterations, {tokensUsed.toLocaleString()} tokens</span>
                  </div>
                  <button
                    onClick={() => resetBudget()}
                    style={styles.cancelBtn}
                  >
                    Reset
                  </button>
                </div>
              </div>
              <p style={styles.fieldHint}>
                The token budget is a guardrail, not a billing cap: Studio counts what the provider reports and refuses a request the remainder cannot cover. The provider bills what it bills.
              </p>
            </div>

            {/* Per-request limits. These existed in the store (STU-05) with no
                way to set them; the timeout is shown in seconds because that is
                how a person thinks about waiting. Both are kept in the settings
                key with the providers, never in a project. */}
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Per-request limits</label>
              <div style={styles.modelGrid}>
                <div style={styles.modelRow}>
                  <div style={styles.modelInfo}>
                    <label htmlFor="studio-request-timeout" style={styles.modelRoleName}>Request timeout</label>
                    <span style={styles.modelRoleHint}>Seconds to wait for one reply ({REQUEST_TIMEOUT_BOUNDS_MS.min / 1000}–{REQUEST_TIMEOUT_BOUNDS_MS.max / 1000})</span>
                  </div>
                  <input
                    id="studio-request-timeout"
                    style={styles.modelInput}
                    type="number"
                    min={REQUEST_TIMEOUT_BOUNDS_MS.min / 1000}
                    max={REQUEST_TIMEOUT_BOUNDS_MS.max / 1000}
                    step={5}
                    value={Math.round(requestTimeoutMs / 1000)}
                    onChange={(e) => setRequestTimeoutMs(Number(e.target.value) * 1000)}
                  />
                </div>
                <div style={styles.modelRow}>
                  <div style={styles.modelInfo}>
                    <label htmlFor="studio-max-output-tokens" style={styles.modelRoleName}>Max output tokens</label>
                    <span style={styles.modelRoleHint}>Per reply ({MAX_OUTPUT_TOKENS_BOUNDS.min.toLocaleString()}–{MAX_OUTPUT_TOKENS_BOUNDS.max.toLocaleString()})</span>
                  </div>
                  <input
                    id="studio-max-output-tokens"
                    style={styles.modelInput}
                    type="number"
                    min={MAX_OUTPUT_TOKENS_BOUNDS.min}
                    max={MAX_OUTPUT_TOKENS_BOUNDS.max}
                    step={1024}
                    value={maxOutputTokens}
                    onChange={(e) => setMaxOutputTokens(Number(e.target.value))}
                  />
                </div>
              </div>
              <p style={styles.fieldHint}>
                Max output tokens is sent to the provider as its output cap and is reserved from the session budget before each request: a request is refused when the remaining budget is below this number, and a reply that hits the cap is reported as truncated and not applied. Set it above what a whole file needs, and no higher than the model allows.
              </p>
            </div>

          </>
        )}

        {/* The General tab said "coming soon" twice and offered nothing. What
            it says now is what is true today: where the theme is set, what the
            words in the bar mean, and what the keyboard does. */}
        {settingsTab === 'general' && (
          <>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Theme</label>
              <p style={styles.emptyHint}>
                Studio follows the light/dark switch in the bar at the top of the page, shared with the rest of SoftN. There is no separate Studio theme.
              </p>
            </div>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Saving and the bar</label>
              <p style={styles.emptyHint}>
                <strong>Save project</strong> happens on its own after each change, to this browser only; the bar shows Saved, Saving or Not saved. Browser storage is not a backup.
                <br />
                <strong>Preview</strong> is the canvas. <strong>Run</strong> opens the bundle in the SoftN runtime. <strong>Export bundle</strong> downloads a .softn file. <strong>Publish</strong> sends the bundle to the directory’s publish page.
              </p>
            </div>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Keyboard</label>
              <p style={styles.emptyHint}>
                Shortcuts are fixed: Escape closes the expanded preview and the project menu; Tab, Enter and Space work on every control. There is nothing to configure here.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
  setupIntro: {
    display: 'flex',
    gap: 10,
    padding: '16px 12px',
    marginBottom: 20,
    border: '1px solid var(--studio-border)',
    borderRadius: 10,
    background: 'var(--studio-accent-soft)',
  },
  setupTitle: {
    margin: '0 0 6px',
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--studio-text)',
  },
  tabs: {
    display: 'flex',
    borderBottom: '1px solid var(--studio-border)',
    flexShrink: 0,
  },
  tab: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '10px 0',
    border: 'none',
    borderBottomWidth: 2,
    borderBottomStyle: 'solid',
    borderBottomColor: 'transparent',
    background: 'transparent',
    color: 'var(--studio-text-dim)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  },
  tabActive: {
    color: 'var(--studio-text)',
    borderBottomColor: 'var(--studio-accent)',
  },
  content: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
    padding: 14,
  },
  fieldGroup: {
    marginBottom: 20,
  },
  label: {
    display: 'block',
    fontFamily: 'var(--studio-mono)',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--studio-text-dim)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    marginBottom: 8,
  },
  fieldLabel: {
    display: 'block',
    fontFamily: 'var(--studio-mono)',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--studio-text-muted)',
    marginBottom: 4,
  },
  emptyProviders: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '16px 12px',
    gap: 4,
    textAlign: 'center',
  },
  emptyText: {
    fontSize: 12,
    color: 'var(--studio-text-dim)',
    margin: 0,
  },
  emptyHint: {
    fontSize: 11,
    color: 'var(--studio-text-dim)',
    margin: 0,
    lineHeight: 1.4,
  },
  providerRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '8px 10px',
    borderRadius: 7,
    border: '1px solid var(--studio-border-subtle)',
    marginBottom: 4,
    transition: 'all 0.15s',
  },
  providerRowActive: {
    background: 'var(--studio-accent-soft)',
    borderColor: 'var(--studio-accent-soft)',
  },
  providerInfo: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontFamily: 'inherit',
    padding: 0,
  },
  providerDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  providerName: {
    overflowWrap: 'anywhere',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--studio-text)',
  },
  providerModel: {
    fontSize: 10,
    fontWeight: 400,
    color: 'var(--studio-text-muted)',
    fontFamily: 'var(--studio-mono)',
  },
  providerKey: {
    overflowWrap: 'anywhere',
    fontSize: 10,
    color: 'var(--studio-text-dim)',
    fontFamily: 'var(--studio-mono)',
  },
  removeBtn: {
    width: 40,
    height: 40,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    borderRadius: 5,
    cursor: 'pointer',
    fontFamily: 'inherit',
    opacity: 0.6,
  },
  addProviderBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '8px 10px',
    border: '1px dashed var(--studio-border-strong)',
    borderRadius: 7,
    background: 'transparent',
    color: 'var(--studio-text-dim)',
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    justifyContent: 'center',
    marginTop: 4,
  },
  addForm: {
    padding: '12px',
    background: 'var(--studio-surface)',
    borderRadius: 8,
    border: '1px solid var(--studio-border)',
    marginTop: 6,
  },
  addFormField: {
    marginBottom: 10,
  },
  input: {
    width: '100%',
    minHeight: 40,
    padding: '8px 10px',
    background: 'var(--studio-surface)',
    border: '1px solid var(--studio-border)',
    borderRadius: 6,
    color: 'var(--studio-text)',
    fontSize: 13,
    outline: 'none',
    fontFamily: 'inherit',
  },
  select: {
    width: '100%',
    minHeight: 40,
    padding: '8px 10px',
    background: 'var(--studio-bg-elevated)',
    border: '1px solid var(--studio-border)',
    borderRadius: 6,
    color: 'var(--studio-text)',
    fontSize: 13,
    outline: 'none',
    fontFamily: 'inherit',
  },
  fieldHint: {
    display: 'block',
    fontSize: 10,
    color: 'var(--studio-text-dim)',
    marginTop: 4,
    lineHeight: 1.4,
  },
  keyNotice: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10,
    color: 'var(--studio-text-dim)',
    margin: '8px 0 10px',
    lineHeight: 1.4,
  },
  addFormActions: {
    display: 'flex',
    gap: 6,
    justifyContent: 'flex-end',
  },
  cancelBtn: {
    minHeight: 40,
    padding: '6px 12px',
    border: '1px solid var(--studio-border)',
    borderRadius: 6,
    background: 'transparent',
    color: 'var(--studio-text-muted)',
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  saveBtn: {
    minHeight: 40,
    padding: '6px 12px',
    border: 'none',
    borderRadius: 6,
    background: 'var(--studio-accent)',
    color: 'var(--studio-bg)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  modelGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 8,
  },
  modelRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '8px 10px',
    background: 'var(--studio-surface)',
    border: '1px solid var(--studio-border)',
    borderRadius: 7,
  },
  modelInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    minWidth: 0,
    flex: 1,
  },
  modelRoleName: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--studio-text)',
  },
  modelRoleHint: {
    fontSize: 10,
    color: 'var(--studio-text-dim)',
  },
  modelInput: {
    width: 120,
    padding: '5px 8px',
    background: 'var(--studio-surface)',
    border: '1px solid var(--studio-border)',
    borderRadius: 5,
    color: 'var(--studio-text)',
    fontSize: 11,
    outline: 'none',
    fontFamily: 'var(--studio-mono)',
    flexShrink: 0,
  },
};
