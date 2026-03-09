import React, { useState } from 'react';
import { useWorkspaceStore, useAIStore } from '../../stores';
import { Icon } from '../common/Icon';
import { runAgentTurn } from '../../lib/agentOrchestrator';

export const Inspector: React.FC = () => {
  const { selectedComponentId, blueprint } = useWorkspaceStore();
  const [aiPrompt, setAiPrompt] = useState('');

  const componentTypeLabel = selectedComponentId?.split('.').pop() ?? 'Component';

  if (!selectedComponentId) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <span style={styles.headerEyebrow}>Canvas Inspector</span>
          <span style={styles.headerTitle}>Inspector</span>
        </div>
        <div style={styles.emptyState}>
          {blueprint ? (
            <>
              <Icon name="target" size={28} color="var(--studio-text-dim)" />
              <p style={styles.emptyText}>
                Select a component on the canvas, then use the AI prompt below to modify it
              </p>
            </>
          ) : (
            <>
              <Icon name="layout" size={28} color="var(--studio-text-dim)" />
              <p style={styles.emptyText}>
                Use the AI chat to generate your app, then select components here to refine them
              </p>
            </>
          )}
        </div>
        {/* AI edit prompt — always visible */}
        <div style={styles.aiSection}>
          <div style={styles.aiHeader}>
            <Icon name="sparkles" size={14} color="var(--studio-accent)" />
            <span style={styles.aiLabel}>AI Edit</span>
          </div>
          <div style={styles.aiInputRow}>
            <input
              style={styles.aiInput}
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="Describe a change..."
              onKeyDown={(e) => {
                if (e.key === 'Enter' && aiPrompt.trim()) {
                  const text = aiPrompt.trim();
                  const msg = {
                    id: crypto.randomUUID(),
                    role: 'user' as const,
                    content: text,
                    timestamp: Date.now(),
                  };
                  useAIStore.getState().addMessage(msg);
                  useWorkspaceStore.getState().setLeftPanel('ai');
                  setAiPrompt('');
                  runAgentTurn();
                }
              }}
            />
            <button
              onClick={() => {
                if (!aiPrompt.trim()) return;
                const text = aiPrompt.trim();
                const msg = {
                  id: crypto.randomUUID(),
                  role: 'user' as const,
                  content: text,
                  timestamp: Date.now(),
                };
                useAIStore.getState().addMessage(msg);
                useWorkspaceStore.getState().setLeftPanel('ai');
                setAiPrompt('');
                runAgentTurn();
              }}
              style={{
                ...styles.aiSendBtn,
                opacity: aiPrompt.trim() ? 1 : 0.4,
                cursor: aiPrompt.trim() ? 'pointer' : 'default',
              }}
            >
              <Icon name="send" size={14} color="var(--studio-accent)" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.componentBadge}>
          <Icon name="grid" size={14} color="var(--studio-accent)" />
          <span style={styles.componentType}>{componentTypeLabel}</span>
        </div>
        <span style={styles.componentId}>{selectedComponentId}</span>
        <div style={styles.overviewCard}>
          <div style={styles.overviewMetric}>
            <span style={styles.overviewLabel}>Type</span>
            <span style={styles.overviewValue}>{componentTypeLabel}</span>
          </div>
          <div style={styles.overviewDivider} />
          <div style={styles.overviewMetric}>
            <span style={styles.overviewLabel}>Scope</span>
            <span style={styles.overviewValue}>Selected node</span>
          </div>
        </div>
      </div>

      {/* AI-powered editing hint */}
      <div style={styles.content}>
        <div style={styles.section}>
          <div style={styles.sectionCard}>
            <div style={styles.aiHintRow}>
              <Icon name="sparkles" size={16} color="var(--studio-accent)" />
              <div>
                <p style={styles.aiHintText}>
                  Describe what you want to change about this component using the prompt below. The AI will update the source files for you.
                </p>
              </div>
            </div>
            <div style={styles.suggestionList}>
              {[
                `Change the ${componentTypeLabel} text to...`,
                `Make this a primary variant`,
                `Add padding and a border radius`,
                `Bind this to a data field`,
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => setAiPrompt(suggestion)}
                  style={styles.suggestionBtn}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* AI edit prompt */}
      <div style={styles.aiSection}>
        <div style={styles.aiHeader}>
          <Icon name="sparkles" size={14} color="var(--studio-accent)" />
          <span style={styles.aiLabel}>AI Edit</span>
        </div>
        <div style={styles.aiInputRow}>
          <input
            style={styles.aiInput}
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="Make this a gradient button..."
            onKeyDown={(e) => {
              if (e.key === 'Enter' && aiPrompt.trim()) {
                const text = aiPrompt.trim();
                const msg = {
                  id: crypto.randomUUID(),
                  role: 'user' as const,
                  content: text,
                  timestamp: Date.now(),
                };
                useAIStore.getState().addMessage(msg);
                useWorkspaceStore.getState().setLeftPanel('ai');
                setAiPrompt('');
                runAgentTurn();
              }
            }}
          />
          <button
            onClick={() => {
              if (!aiPrompt.trim()) return;
              const text = aiPrompt.trim();
              const msg = {
                id: crypto.randomUUID(),
                role: 'user' as const,
                content: text,
                timestamp: Date.now(),
              };
              useAIStore.getState().addMessage(msg);
              useWorkspaceStore.getState().setLeftPanel('ai');
              setAiPrompt('');
              runAgentTurn();
            }}
            style={{
              ...styles.aiSendBtn,
              opacity: aiPrompt.trim() ? 1 : 0.4,
              cursor: aiPrompt.trim() ? 'pointer' : 'default',
            }}
          >
            <Icon name="send" size={14} color="var(--studio-accent)" />
          </button>
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: 316,
    display: 'flex',
    flexDirection: 'column',
    background: 'linear-gradient(180deg, var(--studio-bg-muted), var(--studio-bg-elevated))',
    borderLeft: '1px solid var(--studio-border)',
    height: '100%',
    overflow: 'hidden',
    flexShrink: 0,
    boxShadow: '-12px 0 30px rgba(2,6,23,0.18)',
  },
  header: {
    padding: '14px 16px',
    borderBottom: '1px solid var(--studio-border)',
    flexShrink: 0,
    background: 'linear-gradient(180deg, var(--studio-bg-elevated), var(--studio-panel))',
  },
  headerEyebrow: {
    display: 'block',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.14em',
    textTransform: 'uppercase' as const,
    color: 'var(--studio-accent)',
    marginBottom: 4,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--studio-text)',
  },
  componentBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  componentType: {
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--studio-accent)',
  },
  componentId: {
    fontSize: 11,
    color: 'var(--studio-text-muted)',
    fontFamily: 'monospace',
  },
  overviewCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginTop: 12,
    padding: '10px 12px',
    borderRadius: 14,
    background: 'var(--studio-inset)',
    border: '1px solid var(--studio-border)',
  },
  overviewMetric: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    flex: 1,
  },
  overviewLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
    color: 'var(--studio-text-dim)',
  },
  overviewValue: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--studio-text)',
  },
  overviewDivider: {
    width: 1,
    alignSelf: 'stretch',
    background: 'var(--studio-border)',
  },
  emptyState: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    textAlign: 'center',
    gap: 12,
  },
  emptyText: {
    fontSize: 12,
    color: 'var(--studio-text-muted)',
    lineHeight: 1.5,
    margin: 0,
  },
  content: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
    padding: 14,
  },
  section: {},
  sectionCard: {
    padding: '14px 14px 10px',
    borderRadius: 16,
    background: 'var(--studio-inset)',
    border: '1px solid var(--studio-border)',
    boxShadow: '0 14px 28px rgba(2,6,23,0.14)',
  },
  aiHintRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 12,
  },
  aiHintText: {
    fontSize: 12,
    color: 'var(--studio-text-muted)',
    lineHeight: 1.5,
    margin: 0,
  },
  suggestionList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  suggestionBtn: {
    padding: '8px 10px',
    fontSize: 11,
    color: 'var(--studio-text-muted)',
    background: 'var(--studio-surface)',
    border: '1px solid var(--studio-border)',
    borderRadius: 8,
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  },
  aiSection: {
    padding: 14,
    borderTop: '1px solid var(--studio-border)',
    flexShrink: 0,
    background: 'linear-gradient(180deg, var(--studio-bg-muted), var(--studio-bg-elevated))',
  },
  aiHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  aiLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--studio-accent)',
  },
  aiInputRow: {
    display: 'flex',
    gap: 6,
  },
  aiInput: {
    flex: 1,
    padding: '10px 12px',
    background: 'var(--studio-surface)',
    border: '1px solid var(--studio-border)',
    borderRadius: 12,
    color: 'var(--studio-text)',
    fontSize: 12,
    outline: 'none',
    fontFamily: 'inherit',
  },
  aiSendBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    background: 'rgba(56,189,248,0.12)',
    border: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
  },
};
