import React, { useState, useRef, useEffect } from 'react';
import { useAIStore, useWorkspaceStore } from '../../stores';
import { Icon } from '../common/Icon';
import { runAgentTurn, abortAgentTurn } from '../../lib/agentOrchestrator';
import type { ChatMessage } from '../../types/studio';

export const AIChat: React.FC = () => {
  const {
    messages, agentState, addMessage,
    tokensUsed, iterationsUsed, maxIterations,
    activeProviderId, providers, currentStep,
  } = useAIStore();
  const { blueprint } = useWorkspaceStore();
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || agentState !== 'idle') return;
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const provider = providers.find((p) => p.id === activeProviderId);
  const { brief, setLeftPanel } = useWorkspaceStore();
  const hasProvider = !!provider;

  const sendSuggestedPrompt = (text: string) => {
    if (agentState !== 'idle') return;
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
        <div style={styles.providerBadge}>
          <Icon name="ai" size={12} color={hasProvider ? 'var(--studio-accent)' : 'var(--studio-error)'} />
          <span style={styles.providerName}>
            {provider?.name || 'No provider'}
          </span>
          {!hasProvider && (
            <button
              onClick={() => setLeftPanel('settings')}
              style={styles.setupLink}
            >
              Set up
            </button>
          )}
        </div>
        <div style={styles.statsRow}>
          <span style={styles.stat}>{iterationsUsed}/{maxIterations} steps</span>
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

      {/* No provider banner */}
      {!hasProvider && messages.length === 0 && (
        <button
          onClick={() => setLeftPanel('settings')}
          style={styles.setupBanner}
        >
          <Icon name="key" size={18} color="var(--studio-warning)" />
          <div style={styles.setupBannerText}>
            <span style={styles.setupBannerTitle}>Configure AI to get started</span>
            <span style={styles.setupBannerDesc}>
              Add your API key in Settings to get started
            </span>
          </div>
          <Icon name="chevron-right" size={16} color="var(--studio-text-dim)" />
        </button>
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

        {messages.map((msg) => (
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
                          color={tc.status === 'success' ? 'var(--studio-success)' : tc.status === 'error' ? 'var(--studio-error)' : 'var(--studio-warning)'}
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
              {msg.tokens && (
                <span style={styles.tokenCount}>
                  {msg.tokens.input + msg.tokens.output} tokens
                </span>
              )}
            </div>
          </div>
        ))}

        {agentState === 'building' && (
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
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={blueprint ? 'Ask the AI to modify your app...' : 'Describe the app you want to build...'}
          style={styles.textarea}
          rows={1}
          disabled={agentState !== 'idle'}
        />
        {agentState === 'building' ? (
          <button
            onClick={abortAgentTurn}
            aria-label="Stop generating"
            title="Stop generating"
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
  providerName: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--studio-text)',
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
    padding: '4px 8px',
    borderRadius: 999,
    background: 'var(--studio-accent-soft)',
    color: 'var(--studio-accent)',
    fontFamily: 'var(--studio-mono)',
    fontSize: 10,
    fontWeight: 700,
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
  setupLink: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--studio-accent)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    textDecoration: 'underline',
    fontFamily: 'inherit',
  },
  setupBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    margin: '10px 10px 0',
    padding: '12px 14px',
    background: 'var(--studio-surface)',
    border: '1px solid var(--studio-warning)',
    borderRadius: 10,
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontFamily: 'inherit',
    flexShrink: 0,
  },
  setupBannerText: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
  },
  setupBannerTitle: {
    fontFamily: 'var(--studio-display)',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '-0.01em',
    color: 'var(--studio-warning)',
  },
  setupBannerDesc: {
    fontSize: 10,
    color: 'var(--studio-text-muted)',
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
    fontSize: 11,
    color: 'var(--studio-text-muted)',
    background: 'var(--studio-panel)',
    border: '1px solid var(--studio-border)',
    borderRadius: 8,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'all 0.15s',
    fontFamily: 'inherit',
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
    // The coral fill is light in dark theme and dark in light theme, so the
    // page ground is the only token that stays legible on it in both.
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
    background: 'var(--studio-surface)',
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
    transition: 'all 0.15s',
    flexShrink: 0,
  },
};
