import React, { useEffect, useRef, useState } from 'react';
import { useAIStore } from '../../stores';
import { MAX_ITERATIONS_BOUNDS, TOKEN_BUDGET_BOUNDS, MAX_OUTPUT_TOKENS_BOUNDS, REQUEST_TIMEOUT_BOUNDS_MS, MAX_STEPS_BOUNDS, RUN_TOKEN_BUDGET_BOUNDS } from '../../stores/aiStore';
import { testProvider } from '../../lib/aiProvider';
import { Icon } from '../common/Icon';
import { IntegerLimitInput } from '../common/IntegerLimitInput';
import { ModelPicker } from '../ai/ModelPicker';
import { useProviderModels } from '../ai/useProviderModels';
import type { ProviderConfig } from '../../types/studio';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What a provider row says under its name: how it is reached. */
function providerMeta(provider: ProviderConfig): string {
  const where = provider.type === 'local' || provider.type === 'custom'
    ? hostOf(provider.baseUrl || 'http://localhost:11434')
    : provider.type === 'openai' ? 'OpenAI API' : 'Anthropic API';
  const key = provider.apiKey ? 'key saved' : provider.type === 'local' || provider.type === 'custom' ? 'no key' : 'no key saved';
  return `${where} · ${key}`;
}

/**
 * The generation model, chosen from the active provider's own list. Empty
 * means the model saved with the provider, which is what the first choice
 * says — by its name, since it is a real model and not a Studio default.
 */
const GenerationModel: React.FC<{ provider: ProviderConfig }> = ({ provider }) => {
  const builder = useAIStore((s) => s.modelProfile.builder);
  const updateModelProfile = useAIStore((s) => s.updateModelProfile);
  const list = useProviderModels(provider);
  return (
    <section className="st-settings-section" aria-labelledby="studio-generation-model">
      <h3 id="studio-generation-model" className="st-settings-heading">Generation model</h3>
      <p className="st-settings-note">
        Which of {provider.name}’s models writes the app. Leave it on the provider’s model unless you want a different one for generation only.
      </p>
      {list.state === 'loading' && <p className="st-settings-note" role="status">Loading {provider.name}’s models…</p>}
      {list.state === 'error' && <p className="st-setup-error" role="alert">{list.message}</p>}
      <ModelPicker
        key={list.state}
        label="Model for generation"
        models={list.state === 'ok' ? list.models : null}
        value={builder}
        onChange={(next) => updateModelProfile({ builder: next.trim() })}
        emptyChoice={provider.modelId ? `Same as the provider: ${provider.modelId}` : 'Same as the provider'}
        manualByDefault={list.state === 'error'}
      />
    </section>
  );
};

type TestState = { state: 'running' } | { state: 'ok'; text: string } | { state: 'error'; text: string };

/**
 * Test one saved provider the way generation uses it, from its row. The
 * result stays on the row, in words, until the provider changes.
 */
const ProviderTest: React.FC<{ provider: ProviderConfig; label: string }> = ({ provider, label }) => {
  const [test, setTest] = useState<TestState | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => setTest(null), [provider]);
  const run = async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setTest({ state: 'running' });
    const result = await testProvider(provider, { signal: current.signal });
    if (current.signal.aborted) return;
    setTest(result.ok
      ? { state: 'ok', text: result.replied ? 'Connected: the model replied.' : 'Connected. Choose a model to test a reply.' }
      : { state: 'error', text: result.message });
  };
  return (
    <>
      <button type="button" className="st-btn st-btn-ghost st-btn-xs" onClick={() => void run()} disabled={test?.state === 'running'} aria-label={`Test ${label}`}>
        {test?.state === 'running' ? 'Testing…' : 'Test'}
      </button>
      {test && test.state !== 'running' && (
        <p className={`st-provider-test${test.state === 'error' ? ' is-error' : ''}`} role="status">{test.text}</p>
      )}
    </>
  );
};

export const SettingsPanel: React.FC = () => {
  const {
    providers, removeProvider,
    activeProviderId, setActiveProvider,
    maxIterations, tokenBudget, setMaxIterations, setTokenBudget,
    requestTimeoutMs, setRequestTimeoutMs, maxOutputTokens, setMaxOutputTokens,
    iterationsUsed, tokensUsed, resetBudget,
    agentSettings, updateAgentSettings, openProviderSetup,
  } = useAIStore();
  const [settingsTab, setSettingsTab] = useState<'ai' | 'general'>('ai');
  const active = providers.find((p) => p.id === activeProviderId) ?? null;

  return (
    <div className="st-settings">
      <div className="st-tabs" role="tablist" aria-label="Settings">
        {(['ai', 'general'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={settingsTab === tab}
            className="st-tab"
            onClick={() => setSettingsTab(tab)}
          >
            <Icon name={tab === 'ai' ? 'ai' : 'settings'} size={14} />
            {tab === 'ai' ? 'AI' : 'General'}
          </button>
        ))}
      </div>

      <div className="st-settings-body" role="tabpanel">
        {settingsTab === 'ai' && (
          <>
            <section className="st-settings-section" aria-labelledby="studio-providers-heading">
              <h3 id="studio-providers-heading" className="st-settings-heading">Providers</h3>
              <p className="st-settings-note">
                The AI runs on the provider you choose. Keys stay in this browser and go only to their provider.
              </p>

              {providers.length > 0 && (
                <ul className="st-provider-list">
                  {providers.map((p) => {
                    const isActive = activeProviderId === p.id;
                    const label = `${p.name}${p.modelId ? ` (${p.modelId})` : ''}`;
                    return (
                      <li key={p.id} className="st-provider-row" data-active={isActive || undefined}>
                        <button
                          type="button"
                          className="st-provider-main"
                          onClick={() => setActiveProvider(p.id)}
                          aria-label={`Use ${label}`}
                          aria-pressed={isActive}
                        >
                          <span className="st-provider-radio" aria-hidden="true" />
                          <span className="st-provider-text">
                            <span className="st-provider-name">{p.name}</span>
                            {p.modelId
                              ? <span className="st-provider-model">{p.modelId}</span>
                              : <span className="st-provider-missing">No model chosen</span>}
                            <span className="st-provider-meta">{providerMeta(p)}</span>
                          </span>
                        </button>
                        <div className="st-provider-actions">
                          {!p.modelId ? (
                            <button type="button" className="st-btn st-btn-sm st-btn-primary" onClick={() => openProviderSetup(p.id)}>
                              Choose a model
                            </button>
                          ) : (
                            <>
                              <ProviderTest provider={p} label={label} />
                              <button type="button" className="st-icon-btn" onClick={() => openProviderSetup(p.id)} aria-label={`Edit ${label}`} title="Edit">
                                <Icon name="edit" size={14} />
                              </button>
                            </>
                          )}
                          <button type="button" className="st-icon-btn" onClick={() => removeProvider(p.id)} aria-label={`Remove ${label}`} title="Remove">
                            <Icon name="trash" size={14} />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* Adding and editing open the same AI setup dialog the chat and the
                  bar use: the panel is too narrow for the setup's choices, and a
                  second copy of it here drifted from the first. */}
              {providers.length === 0 ? (
                <div className="st-ai-cta">
                  <h4 className="st-ai-cta-title">No provider yet</h4>
                  <p>Connect a model on this computer, or your own OpenAI or Anthropic key, to start generating.</p>
                  <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={() => openProviderSetup(null)}>
                    <Icon name="plus" size={14} />
                    Connect a provider
                  </button>
                </div>
              ) : (
                <button type="button" className="st-btn st-btn-sm st-settings-add" onClick={() => openProviderSetup(null)}>
                  <Icon name="plus" size={14} />
                  Add a provider
                </button>
              )}
            </section>

            {active && <GenerationModel provider={active} />}

            <section className="st-settings-section" aria-labelledby="studio-agent-heading">
              <h3 id="studio-agent-heading" className="st-settings-heading">Agent runs</h3>
              <p className="st-settings-note">
                The AI builds by calling tools in a loop — reading, editing, checking — until your request is done. These bound one run and each of its replies.
              </p>
              <div className="st-limits">
                <div className="st-limit-row">
                  <div className="st-limit-text">
                    <label htmlFor="studio-agent-steps" className="st-limit-label">Max steps</label>
                    <span className="st-limit-hint">Tool calls before a run stops and asks to continue</span>
                  </div>
                  <IntegerLimitInput
                    id="studio-agent-steps"
                    className="st-input st-input-mono st-limit-input"
                    min={MAX_STEPS_BOUNDS.min}
                    max={MAX_STEPS_BOUNDS.max}
                    value={agentSettings.maxSteps}
                    onCommit={(maxSteps) => updateAgentSettings({ maxSteps })}
                  />
                </div>
                <div className="st-limit-row">
                  <div className="st-limit-text">
                    <label htmlFor="studio-agent-budget" className="st-limit-label">Tokens per run</label>
                    <span className="st-limit-hint">
                      A run stops and asks to continue past this. Counted in effective tokens: prompt tokens the provider serves from its cache count at a tenth on Anthropic and half on OpenAI-compatible providers, and tokens written to Anthropic&apos;s cache at 1.25×
                    </span>
                  </div>
                  <IntegerLimitInput
                    id="studio-agent-budget"
                    className="st-input st-input-mono st-limit-input"
                    min={RUN_TOKEN_BUDGET_BOUNDS.min}
                    max={RUN_TOKEN_BUDGET_BOUNDS.max}
                    step={50000}
                    value={agentSettings.runTokenBudget}
                    onCommit={(runTokenBudget) => updateAgentSettings({ runTokenBudget })}
                  />
                </div>
                <div className="st-limit-row">
                  <div className="st-limit-text">
                    <label htmlFor="studio-max-output-tokens" className="st-limit-label">Max output tokens</label>
                    <span className="st-limit-hint">
                      The longest one reply may be ({MAX_OUTPUT_TOKENS_BOUNDS.min.toLocaleString()}–{MAX_OUTPUT_TOKENS_BOUNDS.max.toLocaleString()}). Reasoning models spend output tokens thinking before they answer, from this same allowance, so set it well above what a file needs. A reply cut off here is not applied; the step is tried once more, asking for shorter reasoning. Keep it within what the model allows.
                    </span>
                  </div>
                  <IntegerLimitInput
                    id="studio-max-output-tokens"
                    className="st-input st-input-mono st-limit-input"
                    min={MAX_OUTPUT_TOKENS_BOUNDS.min}
                    max={MAX_OUTPUT_TOKENS_BOUNDS.max}
                    step={1024}
                    value={maxOutputTokens}
                    onCommit={setMaxOutputTokens}
                  />
                </div>
                <div className="st-limit-row">
                  <label className="st-limit-text" htmlFor="studio-agent-autocheck">
                    <span className="st-limit-label">Check after each change</span>
                    <span className="st-limit-hint">Compose and render the app after every step that writes, and show the agent what broke</span>
                  </label>
                  <input id="studio-agent-autocheck" className="st-limit-check" type="checkbox" checked={agentSettings.autoCheck} onChange={(e) => updateAgentSettings({ autoCheck: e.target.checked })} />
                </div>
                <div className="st-limit-row">
                  <label className="st-limit-text" htmlFor="studio-agent-deletes">
                    <span className="st-limit-label">Ask before deleting</span>
                    <span className="st-limit-hint">Ask you when a run deletes more than three files</span>
                  </label>
                  <input id="studio-agent-deletes" className="st-limit-check" type="checkbox" checked={agentSettings.confirmDeletes} onChange={(e) => updateAgentSettings({ confirmDeletes: e.target.checked })} />
                </div>
              </div>
            </section>

            <section className="st-settings-section" aria-labelledby="studio-budget-heading">
              <h3 id="studio-budget-heading" className="st-settings-heading">Budget limits</h3>
              <div className="st-limits">
                <div className="st-limit-row">
                  <div className="st-limit-text">
                    <label htmlFor="studio-max-iterations" className="st-limit-label">Max runs</label>
                    <span className="st-limit-hint">Agent runs per session</span>
                  </div>
                  <IntegerLimitInput
                    id="studio-max-iterations"
                    className="st-input st-input-mono st-limit-input"
                    min={MAX_ITERATIONS_BOUNDS.min}
                    max={MAX_ITERATIONS_BOUNDS.max}
                    value={maxIterations}
                    onCommit={setMaxIterations}
                  />
                </div>
                <div className="st-limit-row">
                  <div className="st-limit-text">
                    <label htmlFor="studio-token-budget" className="st-limit-label">Token budget</label>
                    <span className="st-limit-hint">Tokens per session</span>
                  </div>
                  <IntegerLimitInput
                    id="studio-token-budget"
                    className="st-input st-input-mono st-limit-input"
                    min={TOKEN_BUDGET_BOUNDS.min}
                    max={TOKEN_BUDGET_BOUNDS.max}
                    step={10000}
                    value={tokenBudget}
                    onCommit={setTokenBudget}
                  />
                </div>
                <div className="st-limit-row">
                  <div className="st-limit-text">
                    <span className="st-limit-label">Used</span>
                    <span className="st-limit-hint">{iterationsUsed} {iterationsUsed === 1 ? 'run' : 'runs'}, {tokensUsed.toLocaleString()} tokens</span>
                  </div>
                  <button type="button" className="st-btn st-btn-sm" onClick={() => resetBudget()}>
                    Reset
                  </button>
                </div>
              </div>
              <p className="st-settings-note">
                Changes apply when you leave a field or press Enter; Escape cancels an unfinished edit.
                The token budget is a guardrail, not a billing cap: Studio counts what the provider reports and refuses a request the remainder cannot cover. The provider bills what it bills.
              </p>
            </section>

            {/* Per-request limits. The timeout is in seconds because that is
                how a person thinks about waiting. Both are kept with the
                providers, never in a project. */}
            <section className="st-settings-section" aria-labelledby="studio-request-heading">
              <h3 id="studio-request-heading" className="st-settings-heading">Per-request limits</h3>
              <div className="st-limits">
                <div className="st-limit-row">
                  <div className="st-limit-text">
                    <label htmlFor="studio-request-timeout" className="st-limit-label">Request timeout</label>
                    <span className="st-limit-hint">Seconds to wait for one reply ({REQUEST_TIMEOUT_BOUNDS_MS.min / 1000}–{REQUEST_TIMEOUT_BOUNDS_MS.max / 1000})</span>
                  </div>
                  <IntegerLimitInput
                    id="studio-request-timeout"
                    className="st-input st-input-mono st-limit-input"
                    min={REQUEST_TIMEOUT_BOUNDS_MS.min / 1000}
                    max={REQUEST_TIMEOUT_BOUNDS_MS.max / 1000}
                    step={5}
                    value={Math.round(requestTimeoutMs / 1000)}
                    onCommit={(seconds) => setRequestTimeoutMs(seconds * 1000)}
                  />
                </div>
              </div>
              <p className="st-settings-note">
                Max output tokens, under Agent runs, is reserved from the session budget before each request: a request is refused when the remaining budget is below it.
              </p>
            </section>
          </>
        )}

        {/* What is true today: where the theme is set, what the words in the
            bar mean, and what the keyboard does. */}
        {settingsTab === 'general' && (
          <>
            <section className="st-settings-section">
              <h3 className="st-settings-heading">Theme</h3>
              <p className="st-settings-note">
                Studio follows the light and dark switch in the bar at the top of the page, shared with the rest of SoftN. There is no separate Studio theme.
              </p>
            </section>
            <section className="st-settings-section">
              <h3 className="st-settings-heading">Saving and the bar</h3>
              <p className="st-settings-note">
                <strong>Save project</strong> happens on its own after each change, to this browser only; the bar shows Saved, Saving or Not saved. Browser storage is not a backup.
              </p>
              <p className="st-settings-note">
                <strong>Preview</strong> is the canvas. <strong>Run</strong> opens the bundle in the SoftN runtime. <strong>Export bundle</strong> downloads a .softn file. <strong>Publish</strong> sends the bundle to the directory’s publish page.
              </p>
            </section>
            <section className="st-settings-section">
              <h3 className="st-settings-heading">Keyboard</h3>
              <p className="st-settings-note">
                Escape closes the expanded preview, the project menu and the AI setup; Tab, Enter and Space work on every control. There is nothing to configure here.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
};
