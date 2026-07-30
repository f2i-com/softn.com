import React, { useState } from 'react';
import { useAIStore } from '../../stores';
import { Icon } from '../common/Icon';
import type { ProviderType } from '../../types/studio';

export const SettingsPanel: React.FC = () => {
  const {
    providers, addProvider, removeProvider,
    activeProviderId, setActiveProvider,
    modelProfile, updateModelProfile,
    maxIterations, tokenBudget, setMaxIterations, setTokenBudget,
    iterationsUsed, tokensUsed, resetBudget,
  } = useAIStore();
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [newProviderType, setNewProviderType] = useState<ProviderType>('anthropic');
  const [newApiKey, setNewApiKey] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  const [newModelId, setNewModelId] = useState('');
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
    if (!newApiKey.trim() && newProviderType !== 'custom') return;
    const id = crypto.randomUUID();
    const names: Record<ProviderType, string> = {
      anthropic: 'Anthropic',
      openai: 'OpenAI',
      custom: newBaseUrl ? (() => { try { return new URL(newBaseUrl).hostname; } catch { return 'Custom AI'; } })() : 'Local AI',
    };
    addProvider({
      id,
      type: newProviderType,
      name: names[newProviderType],
      apiKey: newApiKey,
      baseUrl: newBaseUrl || undefined,
      modelId: newModelId || undefined,
    });
    setActiveProvider(id);
    setNewApiKey('');
    setNewBaseUrl('');
    setNewModelId('');
    setShowAddProvider(false);
  };

  return (
    <div style={styles.container}>
      {/* Tab header */}
      <div style={styles.tabs}>
        <button
          onClick={() => setSettingsTab('ai')}
          style={{ ...styles.tab, ...(settingsTab === 'ai' ? styles.tabActive : {}) }}
        >
          <Icon name="ai" size={14} />
          AI
        </button>
        <button
          onClick={() => setSettingsTab('general')}
          style={{ ...styles.tab, ...(settingsTab === 'general' ? styles.tabActive : {}) }}
        >
          <Icon name="settings" size={14} />
          General
        </button>
      </div>

      <div style={styles.content}>
        {settingsTab === 'ai' && (
          <>
            {/* API Providers */}
              <div style={styles.fieldGroup}>
                <label style={styles.label}>API Providers</label>

                {providers.length === 0 && !showAddProvider && (
                  <div style={styles.emptyProviders}>
                    <Icon name="key" size={20} color="var(--studio-text-dim)" />
                    <p style={styles.emptyText}>No providers configured</p>
                    <p style={styles.emptyHint}>Add your API key to start generating</p>
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
                          {p.apiKey ? `${p.apiKey.slice(0, 7)}...${p.apiKey.slice(-4)}` : 'No key'}
                          {p.baseUrl && <span> · {p.baseUrl.replace(/^https?:\/\//, '').split('/')[0]}</span>}
                        </div>
                      </div>
                    </button>
                    <button
                      onClick={() => removeProvider(p.id)}
                      style={styles.removeBtn}
                    >
                      <Icon name="trash" size={14} color="var(--studio-text-dim)" />
                    </button>
                  </div>
                ))}

                {showAddProvider ? (
                  <div style={styles.addForm}>
                    <div style={styles.addFormField}>
                      <label style={styles.fieldLabel}>Provider preset</label>
                      <select
                        style={styles.select}
                        value={newProviderType}
                        onChange={(e) => {
                          const t = e.target.value as ProviderType;
                          setNewProviderType(t);
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
                      <label style={styles.fieldLabel}>
                        API Key {newProviderType === 'custom' && <span style={{ fontWeight: 400, color: 'var(--studio-text-dim)' }}>(optional for local)</span>}
                      </label>
                      <input
                        style={styles.input}
                        type="password"
                        value={newApiKey}
                        onChange={(e) => setNewApiKey(e.target.value)}
                        placeholder={newProviderType === 'anthropic' ? 'sk-ant-...' : newProviderType === 'openai' ? 'sk-...' : 'API key (if needed)'}
                      />
                    </div>

                    <div style={styles.addFormField}>
                      <label style={styles.fieldLabel}>Model name</label>
                      <input
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
                      <label style={styles.fieldLabel}>
                        Endpoint URL <span style={{ fontWeight: 400, color: 'var(--studio-text-dim)' }}>(optional override)</span>
                      </label>
                      <input
                        style={styles.input}
                        value={newBaseUrl}
                        onChange={(e) => setNewBaseUrl(e.target.value)}
                        placeholder={defaultEndpoints[newProviderType]}
                      />
                      <span style={styles.fieldHint}>
                        Leave blank to use the default. Set a custom URL for proxies, OpenRouter, Ollama, LM Studio, etc.
                      </span>
                    </div>

                    <p style={styles.keyNotice}>
                      <Icon name="info" size={12} color="var(--studio-text-dim)" />
                      Keys are stored in your browser only. Never sent to SoftN servers.
                    </p>

                    <div style={styles.addFormActions}>
                      <button onClick={() => setShowAddProvider(false)} style={styles.cancelBtn}>
                        Cancel
                      </button>
                      <button onClick={handleAddProvider} style={styles.saveBtn}>
                        Save Provider
                      </button>
                    </div>
                  </div>
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
                <label style={styles.label}>Model Assignments</label>
                <p style={styles.emptyHint}>Assign models to each AI agent role</p>
                <div style={styles.modelGrid}>
                  {([
                    { role: 'architect' as const, label: 'Architect', hint: 'Plans app structure' },
                    { role: 'builder' as const, label: 'Builder', hint: 'Generates code' },
                    { role: 'repair' as const, label: 'Repair', hint: 'Fixes errors' },
                    { role: 'vision' as const, label: 'Vision', hint: 'Reads screenshots' },
                  ]).map((m) => (
                    <div key={m.role} style={styles.modelRow}>
                      <div style={styles.modelInfo}>
                        <span style={styles.modelRoleName}>{m.label}</span>
                        <span style={styles.modelRoleHint}>{m.hint}</span>
                      </div>
                      <input
                        style={styles.modelInput}
                        value={modelProfile[m.role]}
                        onChange={(e) => updateModelProfile({ [m.role]: e.target.value })}
                        placeholder="claude-sonnet-4-6"
                      />
                    </div>
                  ))}
                </div>
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
            </div>

          </>
        )}

        {settingsTab === 'general' && (
          <>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Theme</label>
              <p style={styles.emptyHint}>Theme settings coming soon</p>
            </div>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Keyboard Shortcuts</label>
              <p style={styles.emptyHint}>Shortcut configuration coming soon</p>
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
    fontSize: 10,
    color: 'var(--studio-text-dim)',
    fontFamily: 'var(--studio-mono)',
  },
  removeBtn: {
    width: 28,
    height: 28,
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
