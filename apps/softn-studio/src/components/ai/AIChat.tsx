import React, { useState, useRef, useEffect } from 'react';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../../stores';
import { Icon } from '../common/Icon';
import { runAgentTurn } from '../../lib/agentOrchestrator';
import { activeAgentRunId, answerAgentQuestion, isRunLive, stopAgentRun } from '../../lib/agent/runAgent';
import { isReadableRun, RunTimeline } from './RunTimeline';
import type { ChatMessage } from '../../types/studio';
import { AIStatusPill, openSetupFor, useAIReadiness } from './AIStatusPill';
import { isHostedEditor } from '@softn/editor-shared/hostedEditor';

export const AIChat: React.FC = () => {
  const {
    messages, agentState, addMessage,
    tokensUsed, iterationsUsed, maxIterations,
    currentStep,
    draftMessage: input, setDraftMessage: setInput,
  } = useAIStore();
  const readiness = useAIReadiness();
  const { blueprint } = useWorkspaceStore();
  // A turn that committed files did so as one VFS transaction under the
  // message's transactionId. While that transaction is still in the
  // history, the message offers to revert it — the whole turn, by id, not
  // "whatever the AI did last".
  const history = useVFSStore((s) => s.history);
  const [revertNotice, setRevertNotice] = useState<{ id: string; text: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const revertTurn = (transactionId: string) => {
    const result = useVFSStore.getState().revertTransaction(transactionId);
    const ws = useWorkspaceStore.getState();
    if (!result.ok) {
      setRevertNotice({ id: transactionId, text: result.reason });
      ws.addConsoleOutput(`[AI] Revert refused: ${result.reason}`);
      return;
    }
    setRevertNotice({ id: transactionId, text: `Reverted ${result.paths.length} file(s): ${result.paths.join(', ')}` });
    ws.setDirty(true);
    ws.addConsoleOutput(`[AI] Reverted turn: ${result.paths.join(', ')}`);
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // A run waiting on a question takes the next message as its answer.
  const waitingRun = (() => {
    const id = activeAgentRunId();
    if (!id || !isRunLive(id)) return null;
    const run = messages.find((m) => m.run?.id === id)?.run;
    return run && run.status === 'waiting' && run.question && !run.question.confirm ? run : null;
  })();

  const handleSend = () => {
    const text = input.trim();
    if (!text || agentState !== 'idle') return;
    if (waitingRun) {
      setInput('');
      void answerAgentQuestion(waitingRun.id, text);
      return;
    }
    if (!hasProvider) { openSettings(); return; }
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    addMessage(msg);
    setInput('');
    runAgentTurn();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Enter also commits an IME candidate. Safari can report composition as
    // finished on that keydown but still marks it with the IME key code.
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const { brief } = useWorkspaceStore();
  // Ready means a provider and a model: sending with less opens the setup
  // for what is missing, and keeps the message as it was typed.
  const hasProvider = readiness.state === 'ready';
  const openSettings = () => openSetupFor(readiness);

  const sendSuggestedPrompt = (text: string) => {
    if (agentState !== 'idle') return;
    if (!hasProvider) { setInput(text); openSettings(); return; }
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    addMessage(msg);
    setInput('');
    runAgentTurn();
  };

  return (
    <div style={styles.container}>
      {/* Provider info bar */}
      <div style={styles.providerBar}>
        {/* Missing a provider or a model, the card below says so and has
            the button; the pill would be a second copy of it. */}
        {hasProvider && (
          <div style={styles.providerBadge}>
            <AIStatusPill />
          </div>
        )}
        <div style={styles.statsRow}>
          <span style={styles.stat}>{iterationsUsed}/{maxIterations} runs</span>
          <span style={styles.statDivider} />
          <span style={styles.stat}>{tokensUsed.toLocaleString()} tokens</span>
        </div>
        {brief && (
          <div style={styles.estimateRow}>
            <span style={styles.estimatePill}>Blueprint ready</span>
            <span style={styles.estimatePill}>{brief.pages.length || 1} page targets</span>
          </div>
        )}
      </div>

      {/* What the AI is missing, and the one button that fixes it. */}
      {/* A hosted editor's AI is its host's; there is no setup to open. */}
      {!hasProvider && !isHostedEditor() && (
        <div style={styles.setupWrap}>
          <div className="st-ai-cta" role="region" aria-label="AI setup">
            <h3 className="st-ai-cta-title">
              {readiness.state === 'no-model' ? `Choose a model for ${readiness.name}` : readiness.state === 'unselected' ? 'Choose a provider' : 'Connect an AI provider'}
            </h3>
            <p>
              {readiness.state === 'no-model'
                ? 'This provider has no model chosen. Pick one of the models it offers, and the AI is ready.'
                : readiness.state === 'unselected'
                  ? 'Pick which of your providers the AI should use.'
                  : 'The AI needs a model to write your app: one on this computer, or your own OpenAI or Anthropic key.'}
            </p>
            <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={openSettings}>
              <Icon name="key" size={14} />
              {readiness.state === 'no-model' ? 'Choose a model' : readiness.state === 'unselected' ? 'Choose a provider' : 'Connect a provider'}
            </button>
          </div>
        </div>
      )}

      {/* Brief context */}
      {brief && messages.length === 0 && (
        <div style={styles.briefContext}>
          <div style={styles.briefContextHeader}>
            <Icon name="file" size={13} color="var(--studio-accent)" />
            <span style={styles.briefContextTitle}>Brief: {brief.appName}</span>
          </div>
          <p style={styles.briefContextDesc}>{brief.description}</p>
          <div style={styles.briefTags}>
            <span style={styles.briefTag}>{brief.target}</span>
            <span style={styles.briefTag}>{brief.style}</span>
            {brief.authNeeded && <span style={styles.briefTag}>auth</span>}
            {brief.pages.map((p) => (
              <span key={p} style={styles.briefTag}>{p}</span>
            ))}
          </div>
        </div>
      )}

      {/* Messages.
          role="log" with a polite live region, because a conversation that
          appends silently is a conversation a screen reader user never hears:
          the model's reply, and any error it came back with, arrived on screen
          with nothing to announce them. Polite rather than assertive so a reply
          waits its turn instead of interrupting whatever is being read. */}
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Conversation"
        style={styles.messages}
      >
        {messages.length === 0 && (
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>
              <Icon name="ai" size={32} color="var(--studio-accent)" />
            </div>
            <p style={styles.emptyTitle}>
              {brief && blueprint ? 'Imported app ready' : brief ? 'Ready to generate' : 'Describe your app'}
            </p>
            <p style={styles.emptyDesc}>
              {brief && blueprint
                ? 'This bundle is loaded into Studio. Use AI to update pages, improve the design, change flows, or prepare the app for export.'
                : brief
                ? 'Your brief is loaded. Send a message to start generating, or refine the details.'
                : 'Tell the AI what you want to build, or use the guided brief wizard for a structured approach.'
              }
            </p>
            {!blueprint && (
              <div style={styles.suggestions}>
                {(brief
                  ? [
                      `Build ${brief.appName} based on my brief`,
                      'Generate the blueprint for review first',
                      'Start with the data model and pages',
                    ]
                  : [
                      'A task manager with categories and due dates',
                      'A recipe book with search and favorites',
                      'A habit tracker with streaks and charts',
                    ]
                ).map((s) => (
                  <button
                    key={s}
                    onClick={() => sendSuggestedPrompt(s)}
                    style={styles.suggestionBtn}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {blueprint && messages.length === 0 && (
              <div style={styles.suggestions}>
                {[
                  'Refresh the styling of this imported app',
                  'Summarize the structure of this bundle before editing',
                  'Improve the main page and make it feel more polished',
                ].map((s) => (
                  <button
                    key={s}
                    onClick={() => sendSuggestedPrompt(s)}
                    style={styles.suggestionBtn}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map((msg) => msg.run ? (
          <div key={msg.id} style={styles.runWrap}>
            {isReadableRun(msg.run) ? <RunTimeline message={msg} /> : <p className="st-run-reason">{msg.content || 'This run’s record could not be read.'}</p>}
          </div>
        ) : (
          <div
            key={msg.id}
            style={{
              ...styles.messageBubble,
              ...(msg.role === 'user' ? styles.userBubble : styles.aiBubble),
            }}
          >
            {msg.role === 'assistant' && (
              <div style={styles.aiAvatar}>
                <Icon name="ai" size={14} color="var(--studio-accent)" />
              </div>
            )}
            <div
              style={{
                ...styles.bubbleContent,
                ...(msg.role === 'user' ? styles.userContent : styles.aiContent),
              }}
            >
              <p style={styles.messageText}>{msg.content}</p>
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div style={styles.toolCards}>
                  {msg.toolCalls.map((tc, i) => (
                    <div key={i} style={styles.toolCard}>
                      <div style={styles.toolCardHeader}>
                        <Icon
                          name={tc.status === 'success' ? 'check' : tc.status === 'error' ? 'x' : 'clock'}
                          size={12}
                          color={tc.status === 'success' ? 'var(--studio-text-muted)' : tc.status === 'error' ? 'var(--studio-error)' : 'var(--studio-warning)'}
                        />
                        <span style={styles.toolName}>{tc.tool}</span>
                      </div>
                      {tc.result && (
                        <pre style={styles.toolResult}>{tc.result}</pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {msg.role === 'assistant' && msg.transactionId && (
                <div style={styles.revertRow}>
                  {history.some((e) => e.transactionId === msg.transactionId) ? (
                    <button
                      onClick={() => revertTurn(msg.transactionId!)}
                      disabled={agentState !== 'idle'}
                      title="Put back every file this turn changed, as one step"
                      style={styles.revertBtn}
                    >
                      <Icon name="undo" size={12} color="var(--studio-error)" />
                      Revert this turn
                    </button>
                  ) : (
                    <span style={styles.revertDone}>
                      {revertNotice?.id === msg.transactionId ? revertNotice.text : 'This turn is no longer in the history.'}
                    </span>
                  )}
                  {revertNotice?.id === msg.transactionId && history.some((e) => e.transactionId === msg.transactionId) && (
                    <span role="alert" style={styles.revertDone}>{revertNotice.text}</span>
                  )}
                </div>
              )}
              {msg.tokens && (
                <span style={styles.tokenCount}>
                  {msg.tokens.input + msg.tokens.output} tokens
                </span>
              )}
            </div>
          </div>
        ))}

        {agentState === 'building' && !messages.at(-1)?.run && (
          <div style={styles.typingIndicator}>
            <div style={styles.aiAvatar}>
              <Icon name="ai" size={14} color="var(--studio-accent)" />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={styles.dots}>
                <span style={{ ...styles.dot, animationDelay: '0ms' }} />
                <span style={{ ...styles.dot, animationDelay: '150ms' }} />
                <span style={{ ...styles.dot, animationDelay: '300ms' }} />
              </div>
              {currentStep && (
                <span style={{ fontFamily: 'var(--studio-mono)', fontSize: 10, color: 'var(--studio-live)' }}>
                  {currentStep}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div style={styles.inputArea}>
        <textarea
          aria-label="Message to AI"
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={waitingRun ? 'Answer the question above…' : blueprint ? 'Ask the AI to change your app…' : 'Describe the app you want to build…'}
          style={styles.textarea}
          rows={1}
          disabled={agentState !== 'idle'}
        />
        {agentState === 'building' ? (
          <button
            onClick={() => stopAgentRun()}
            aria-label="Stop the agent"
            title="Stop the agent; what it already wrote stays"
            style={{ ...styles.sendBtn, background: 'var(--studio-error)' }}
          >
            <Icon name="x" size={16} color="var(--studio-bg)" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            aria-label="Send message"
            title="Send message"
            disabled={!input.trim() || agentState !== 'idle'}
            style={{
              ...styles.sendBtn,
              opacity: input.trim() && agentState === 'idle' ? 1 : 0.4,
              cursor: input.trim() && agentState === 'idle' ? 'pointer' : 'not-allowed',
            }}
          >
            <Icon name="send" size={16} color="var(--studio-bg)" />
          </button>
        )}
      </div>

      <style>{`
        @keyframes softn-dot-pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1); }
        }
      `}</style>
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
  providerBar: {
    padding: '10px 14px',
    borderBottom: '1px solid var(--studio-border)',
    flexShrink: 0,
  },
  providerBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  statsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  estimateRow: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
    marginTop: 8,
  },
  estimatePill: {
    padding: '3px 8px',
    borderRadius: 6,
    border: '1px solid var(--studio-border)',
    color: 'var(--studio-text-muted)',
    fontSize: 11.5,
    fontWeight: 500,
  },
  stat: {
    fontFamily: 'var(--studio-mono)',
    fontSize: 10,
    color: 'var(--studio-text-muted)',
  },
  statDivider: {
    width: 1,
    height: 10,
    background: 'var(--studio-border)',
  },
  setupWrap: {
    padding: '12px 14px 0',
    flexShrink: 0,
  },
  briefContext: {
    margin: '10px 10px 0',
    padding: '10px 12px',
    background: 'var(--studio-accent-soft)',
    border: '1px solid var(--studio-border)',
    borderRadius: 10,
    flexShrink: 0,
  },
  briefContextHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  briefContextTitle: {
    fontFamily: 'var(--studio-display)',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '-0.01em',
    color: 'var(--studio-accent)',
  },
  briefContextDesc: {
    fontSize: 11,
    color: 'var(--studio-text-muted)',
    lineHeight: 1.4,
    margin: '0 0 6px',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  briefTags: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
  },
  briefTag: {
    padding: '2px 6px',
    fontFamily: 'var(--studio-mono)',
    fontSize: 10,
    color: 'var(--studio-accent)',
    background: 'var(--studio-accent-soft)',
    borderRadius: 4,
  },
  messages: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
    padding: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    padding: 20,
    textAlign: 'center',
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    background: 'var(--studio-accent-soft)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontFamily: 'var(--studio-display)',
    fontSize: 19,
    fontWeight: 700,
    letterSpacing: '-0.025em',
    color: 'var(--studio-text)',
    marginBottom: 6,
  },
  emptyDesc: {
    fontSize: 12,
    color: 'var(--studio-text-muted)',
    lineHeight: 1.5,
    maxWidth: 240,
    marginBottom: 16,
  },
  suggestions: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    width: '100%',
  },
  suggestionBtn: {
    padding: '8px 12px',
    fontSize: 12.5,
    color: 'var(--studio-text-muted)',
    background: 'var(--studio-bg)',
    border: '1px solid var(--studio-border)',
    borderRadius: 8,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'border-color 0.15s, color 0.15s',
    fontFamily: 'inherit',
  },
  runWrap: {
    display: 'flex',
    minWidth: 0,
  },
  messageBubble: {
    display: 'flex',
    gap: 8,
    maxWidth: '100%',
  },
  userBubble: {
    justifyContent: 'flex-end',
  },
  aiBubble: {
    justifyContent: 'flex-start',
  },
  aiAvatar: {
    width: 26,
    height: 26,
    borderRadius: 8,
    background: 'var(--studio-accent-soft)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  bubbleContent: {
    maxWidth: '85%',
    borderRadius: 12,
    padding: '8px 12px',
  },
  userContent: {
    background: 'var(--studio-accent)',
    // The accent is the ink inverted — light in the dark theme, dark in the
    // light one — so the page ground is the token that stays legible on it.
    color: 'var(--studio-bg)',
    borderBottomRightRadius: 4,
  },
  aiContent: {
    background: 'var(--studio-surface-hover)',
    color: 'var(--studio-text)',
    borderBottomLeftRadius: 4,
  },
  messageText: {
    fontSize: 13,
    lineHeight: 1.5,
    color: 'inherit',
    margin: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  toolCards: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    marginTop: 8,
  },
  toolCard: {
    background: 'var(--studio-surface)',
    borderRadius: 6,
    padding: '6px 8px',
    border: '1px solid var(--studio-border-subtle)',
  },
  toolCardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  toolName: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--studio-text-muted)',
    fontFamily: 'var(--studio-mono)',
  },
  toolResult: {
    fontSize: 10,
    color: 'var(--studio-text-dim)',
    margin: '4px 0 0',
    whiteSpace: 'pre-wrap',
    fontFamily: 'var(--studio-mono)',
    maxHeight: 80,
    overflow: 'auto',
  },
  revertRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  revertBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '4px 8px',
    border: '1px solid var(--studio-border)',
    borderRadius: 6,
    background: 'transparent',
    color: 'var(--studio-error)',
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  revertDone: {
    fontFamily: 'var(--studio-mono)',
    fontSize: 10,
    color: 'var(--studio-text-dim)',
  },
  tokenCount: {
    display: 'block',
    fontFamily: 'var(--studio-mono)',
    fontSize: 9,
    color: 'inherit',
    opacity: 0.7,
    marginTop: 4,
    textAlign: 'right' as const,
  },
  typingIndicator: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  dots: {
    display: 'flex',
    gap: 4,
    padding: '8px 12px',
    background: 'var(--studio-surface-hover)',
    borderRadius: 12,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    // The agent is mid-turn here — this is the machine actually running.
    background: 'var(--studio-live)',
    display: 'inline-block',
    animation: 'softn-dot-pulse 1s ease-in-out infinite',
  },
  inputArea: {
    padding: 10,
    borderTop: '1px solid var(--studio-border)',
    display: 'flex',
    gap: 8,
    alignItems: 'flex-end',
    flexShrink: 0,
  },
  textarea: {
    flex: 1,
    background: 'var(--studio-bg)',
    border: '1px solid var(--studio-border)',
    borderRadius: 10,
    padding: '10px 12px',
    color: 'var(--studio-text)',
    fontSize: 13,
    lineHeight: 1.4,
    resize: 'none',
    outline: 'none',
    fontFamily: 'inherit',
    minHeight: 40,
    maxHeight: 120,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    background: 'var(--studio-accent)',
    border: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'opacity 0.15s',
    flexShrink: 0,
  },
};
