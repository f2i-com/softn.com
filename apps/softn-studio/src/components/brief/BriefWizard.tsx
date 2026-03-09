import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useWorkspaceStore, useAIStore, useVFSStore } from '../../stores';
import { Icon } from '../common/Icon';
import type { ProjectBrief, RuntimeTarget, VisualStyle } from '../../types/studio';
import { generateBlueprintFromBrief, generateTaskGraph, scaffoldProjectFiles } from '../../lib/studioProject';

interface BriefWizardProps {
  onBack: () => void;
  onSubmit?: () => void;
}

type Step = 'basics' | 'structure' | 'style';
const STEPS: { id: Step; label: string; num: string }[] = [
  { id: 'basics', label: 'Basics', num: '1' },
  { id: 'structure', label: 'Structure', num: '2' },
  { id: 'style', label: 'Style', num: '3' },
];

export const BriefWizard: React.FC<BriefWizardProps> = ({ onBack, onSubmit }) => {
  const { setBrief, setProjectName, setMode, setBlueprint, setTaskGraph, setActivePage, addConsoleOutput, brief: existingBrief } = useWorkspaceStore();
  const { providers, activeProviderId, setActiveProvider } = useAIStore();
  const { reset: resetVFS, batchCreateFiles } = useVFSStore();

  const [brief, updateBrief] = useState<ProjectBrief>(() => existingBrief
    ? { ...existingBrief, referenceImages: existingBrief.referenceImages ?? [] }
    : {
      appName: '',
      description: '',
      target: 'web',
      pages: [],
      collections: [],
      authNeeded: false,
      style: 'clean',
      referenceImages: [],
    }
  );
  const [step, setStep] = useState<Step>('basics');
  const [pageInput, setPageInput] = useState('');
  const [collInput, setCollInput] = useState('');
  const [showProviderDropdown, setShowProviderDropdown] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  const imgInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Scroll to top when step changes
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [step]);

  const set = <K extends keyof ProjectBrief>(key: K, value: ProjectBrief[K]) =>
    updateBrief((b) => ({ ...b, [key]: value }));

  const addTag = (field: 'pages' | 'collections', value: string) => {
    const v = value.trim();
    if (!v) return;
    updateBrief((b) => ({ ...b, [field]: [...b[field], v] }));
  };

  const removeTag = (field: 'pages' | 'collections', idx: number) => {
    updateBrief((b) => ({ ...b, [field]: b[field].filter((_, i) => i !== idx) }));
  };

  const canSubmit = brief.appName.trim() && brief.description.trim();
  const stepIdx = STEPS.findIndex((s) => s.id === step);
  const isLast = stepIdx === STEPS.length - 1;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    const blueprint = generateBlueprintFromBrief(brief);
    const tasks = generateTaskGraph(blueprint);
    const starterFiles = scaffoldProjectFiles(brief, blueprint);

    resetVFS();
    batchCreateFiles(starterFiles, 'ai');
    setProjectName(brief.appName);
    setBrief(brief);
    setBlueprint(blueprint);
    setTaskGraph(tasks);
    setActivePage(blueprint.pages[0]?.id ?? null);
    setMode('structure');
    addConsoleOutput(`[Architect] Blueprint generated for ${brief.appName}`);
    addConsoleOutput(`[Builder] Scaffolded ${starterFiles.length} starter file(s)`);
    onSubmit?.();
  }, [brief, canSubmit, resetVFS, batchCreateFiles, setProjectName, setBrief, setBlueprint, setTaskGraph, setActivePage, setMode, addConsoleOutput, onSubmit]);

  const handleNext = () => {
    if (isLast) {
      handleSubmit();
    } else {
      setStep(STEPS[stepIdx + 1].id);
    }
  };

  const handlePrev = () => {
    if (stepIdx > 0) setStep(STEPS[stepIdx - 1].id);
    else onBack();
  };

  const activeProvider = providers.find((p) => p.id === activeProviderId);
  const aiLabel = activeProvider?.name || (providers.length > 0 ? 'Select provider' : 'No provider');

  const targets: { id: RuntimeTarget; label: string; desc: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
    { id: 'web', label: 'Web', desc: 'PWA, runs in browser', icon: 'desktop' },
    { id: 'desktop', label: 'Desktop', desc: 'Native app via Tauri', icon: 'desktop' },
    { id: 'dual', label: 'Both', desc: 'Web + Desktop', icon: 'layout' },
  ];

  const styleOptions: { id: VisualStyle; label: string; color: string }[] = [
    { id: 'clean', label: 'Clean', color: '#3b82f6' },
    { id: 'bold', label: 'Bold', color: '#ef4444' },
    { id: 'minimal', label: 'Minimal', color: '#71717a' },
    { id: 'playful', label: 'Playful', color: '#a855f7' },
    { id: 'dark', label: 'Dark', color: '#1e1e2e' },
  ];

  const m = isMobile;

  return (
    <div style={s.root}>
      {/* Header */}
      <div style={{ ...s.header, padding: m ? '0 12px' : '0 20px' }}>
        <button onClick={handlePrev} style={s.backBtn}>
          <Icon name="chevron-left" size={18} />
          {!m && <span>{stepIdx === 0 ? 'Home' : 'Back'}</span>}
        </button>

        <div style={s.headerCenter}>
          <Icon name="sparkles" size={14} color="var(--studio-accent)" />
          <span style={s.headerTitle}>New App</span>
        </div>

        {/* Provider badge */}
        <div style={s.aiWrap}>
          <button
            onClick={() => setShowProviderDropdown(!showProviderDropdown)}
            style={s.aiBadge}
          >
            <Icon
              name="key"
              size={13}
              color={activeProvider ? 'var(--studio-accent)' : 'var(--studio-error)'}
            />
            {!m && <span style={s.aiBadgeLabel}>{aiLabel}</span>}
            <Icon name="chevron-down" size={12} color="var(--studio-text-dim)" />
          </button>

          {showProviderDropdown && (
            <>
              <div style={s.dropBackdrop} onClick={() => setShowProviderDropdown(false)} />
              <div style={s.dropdown}>
                {providers.length > 0 ? (
                  <div style={s.dropSection}>
                    <span style={s.dropTitle}>Provider</span>
                    {providers.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => { setActiveProvider(p.id); setShowProviderDropdown(false); }}
                        style={{
                          ...s.dropItem,
                          ...(activeProviderId === p.id ? s.dropItemActive : {}),
                        }}
                      >
                        <div style={{
                          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                          background: activeProviderId === p.id ? 'var(--studio-success)' : 'var(--studio-text-dim)',
                        }} />
                        <span style={{ flex: 1 }}>{p.name}</span>
                        {activeProviderId === p.id && <Icon name="check" size={14} color="var(--studio-accent)" />}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div style={s.dropHint}>
                    <Icon name="info" size={12} color="var(--studio-text-dim)" />
                    <span>Add API keys in Settings after creating your app</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Step indicator */}
      <div style={{ ...s.stepper, padding: m ? '10px 16px' : '12px 20px' }}>
        {STEPS.map((st, i) => {
          const active = i === stepIdx;
          const done = i < stepIdx;
          return (
            <button
              key={st.id}
              onClick={() => setStep(st.id)}
              style={{
                ...s.stepPill,
                ...(active ? s.stepPillActive : {}),
                ...(done ? s.stepPillDone : {}),
                fontSize: m ? 12 : 13,
                padding: m ? '6px 10px' : '6px 14px',
              }}
            >
              <span style={{
                ...s.stepNum,
                ...(active ? s.stepNumActive : {}),
                ...(done ? s.stepNumDone : {}),
              }}>
                {done ? <Icon name="check" size={11} color="#fff" /> : st.num}
              </span>
              {(!m || active) && st.label}
            </button>
          );
        })}
        {!m && <span style={s.stepHint}>* name & description required</span>}
      </div>

      {/* Form content */}
      <div ref={scrollRef} style={s.scroll}>
        <div style={{ ...s.formWrap, padding: m ? '24px 16px 100px' : '32px 28px 100px', maxWidth: m ? '100%' : 620 }}>

          {/* ---- Step 1: Basics ---- */}
          {step === 'basics' && (
            <>
              <div style={s.stepHeader}>
                <h2 style={{ ...s.stepTitle, fontSize: m ? 22 : 28 }}>What are you building?</h2>
                <p style={s.stepSub}>Give your app a name and describe what it does.</p>
              </div>

              <div style={s.field}>
                <label style={s.label}>App name <span style={s.req}>*</span></label>
                <input
                  style={s.input}
                  value={brief.appName}
                  onChange={(e) => set('appName', e.target.value)}
                  placeholder="My Amazing App"
                  autoFocus
                />
              </div>

              <div style={s.field}>
                <label style={s.label}>Description <span style={s.req}>*</span></label>
                <textarea
                  style={s.textarea}
                  value={brief.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder="A task management app with categories, due dates, and priority levels. Users can drag tasks between columns like a kanban board."
                  rows={5}
                />
              </div>

              <div style={s.field}>
                <label style={s.label}>Target platform</label>
                <div style={{ ...s.radioGroup, flexDirection: m ? 'column' : 'row' }}>
                  {targets.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => set('target', t.id)}
                      style={{
                        ...s.radioCard,
                        flex: m ? 'none' : '1 1 0',
                        ...(brief.target === t.id ? s.radioCardActive : {}),
                      }}
                    >
                      <Icon
                        name={t.icon}
                        size={18}
                        color={brief.target === t.id ? 'var(--studio-accent)' : 'var(--studio-text-dim)'}
                      />
                      <div>
                        <div style={s.radioLabel}>{t.label}</div>
                        <div style={s.radioDesc}>{t.desc}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ---- Step 2: Structure ---- */}
          {step === 'structure' && (
            <>
              <div style={s.stepHeader}>
                <h2 style={{ ...s.stepTitle, fontSize: m ? 22 : 28 }}>App structure</h2>
                <p style={s.stepSub}>Define the pages and data your app needs. All optional.</p>
              </div>

              <div style={s.field}>
                <label style={s.label}>Pages</label>
                <div style={s.tagInputRow}>
                  <input
                    style={s.tagInput}
                    value={pageInput}
                    onChange={(e) => setPageInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { addTag('pages', pageInput); setPageInput(''); } }}
                    placeholder="e.g., Dashboard, Settings, Profile..."
                    autoFocus
                  />
                  <button
                    style={s.tagAddBtn}
                    onClick={() => { addTag('pages', pageInput); setPageInput(''); }}
                  >
                    Add
                  </button>
                </div>
                {brief.pages.length > 0 && (
                  <div style={s.tags}>
                    {brief.pages.map((p, i) => (
                      <span key={i} style={s.tag}>
                        {p}
                        <button onClick={() => removeTag('pages', i)} style={s.tagX}>
                          <Icon name="x" size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div style={s.field}>
                <label style={s.label}>Data collections</label>
                <div style={s.tagInputRow}>
                  <input
                    style={s.tagInput}
                    value={collInput}
                    onChange={(e) => setCollInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { addTag('collections', collInput); setCollInput(''); } }}
                    placeholder="e.g., Tasks, Users, Categories..."
                  />
                  <button
                    style={s.tagAddBtn}
                    onClick={() => { addTag('collections', collInput); setCollInput(''); }}
                  >
                    Add
                  </button>
                </div>
                {brief.collections.length > 0 && (
                  <div style={s.tags}>
                    {brief.collections.map((c, i) => (
                      <span key={i} style={s.tag}>
                        {c}
                        <button onClick={() => removeTag('collections', i)} style={s.tagX}>
                          <Icon name="x" size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div style={s.field}>
                <label style={s.label}>Authentication</label>
                <button
                  onClick={() => set('authNeeded', !brief.authNeeded)}
                  style={{
                    ...s.toggleRow,
                    borderColor: brief.authNeeded ? 'var(--studio-accent)' : 'var(--studio-border)',
                    background: brief.authNeeded ? 'var(--studio-accent-soft)' : 'var(--studio-surface)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Icon name="key" size={16} color={brief.authNeeded ? 'var(--studio-accent)' : 'var(--studio-text-dim)'} />
                    <span style={s.toggleLabel}>Require user login</span>
                  </div>
                  <div style={{
                    ...s.toggle,
                    background: brief.authNeeded ? 'var(--studio-accent)' : 'var(--studio-text-dim)',
                  }}>
                    <div style={{
                      ...s.toggleKnob,
                      transform: brief.authNeeded ? 'translateX(16px)' : 'translateX(2px)',
                    }} />
                  </div>
                </button>
              </div>
            </>
          )}

          {/* ---- Step 3: Style ---- */}
          {step === 'style' && (
            <>
              <div style={s.stepHeader}>
                <h2 style={{ ...s.stepTitle, fontSize: m ? 22 : 28 }}>Visual style</h2>
                <p style={s.stepSub}>Pick the look and feel. You can refine it later.</p>
              </div>

              <div style={s.field}>
                <label style={s.label}>Style preset</label>
                <div style={{ ...s.styleGrid, gridTemplateColumns: m ? 'repeat(2, 1fr)' : 'repeat(5, 1fr)' }}>
                  {styleOptions.map((opt) => (
                    <button
                      key={opt.id}
                      onClick={() => set('style', opt.id)}
                      style={{
                        ...s.styleCard,
                        ...(brief.style === opt.id ? { borderColor: opt.color, background: `${opt.color}12` } : {}),
                      }}
                    >
                      <div style={{
                        ...s.stylePreview,
                        background: opt.id === 'dark'
                          ? 'linear-gradient(135deg, #1e1e2e, #0c0c14)'
                          : `linear-gradient(135deg, ${opt.color}18, ${opt.color}35)`,
                      }}>
                        <div style={{ width: '60%', height: 5, borderRadius: 3, background: opt.color, opacity: 0.8 }} />
                        <div style={{ width: '40%', height: 4, borderRadius: 2, background: opt.color, opacity: 0.35, marginTop: 5 }} />
                        <div style={{ width: '80%', height: 12, borderRadius: 5, background: opt.color, opacity: 0.15, marginTop: 6 }} />
                      </div>
                      <span style={{
                        ...s.styleLabel,
                        color: brief.style === opt.id ? 'var(--studio-text)' : 'var(--studio-text-dim)',
                        fontWeight: brief.style === opt.id ? 700 : 500,
                      }}>{opt.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div style={s.field}>
                <label style={s.label}>Reference images</label>
                <p style={s.hint}>Upload screenshots or mockups for inspiration (up to 3)</p>
                <input
                  ref={imgInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []).slice(0, 3 - brief.referenceImages.length);
                    if (files.length > 0) {
                      set('referenceImages', [...brief.referenceImages, ...files].slice(0, 3));
                    }
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => imgInputRef.current?.click()}
                  style={s.uploadBtn}
                >
                  <Icon name="upload" size={18} color="var(--studio-text-dim)" />
                  <span>{brief.referenceImages.length > 0
                    ? `${brief.referenceImages.length} image${brief.referenceImages.length > 1 ? 's' : ''} selected`
                    : 'Drop images here or click to upload'
                  }</span>
                </button>
                {brief.referenceImages.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    {brief.referenceImages.map((f, i) => (
                      <div key={i} style={s.imgTag}>
                        <span>{f.name}</span>
                        <button
                          type="button"
                          onClick={() => set('referenceImages', brief.referenceImages.filter((_, j) => j !== i))}
                          style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, display: 'flex', fontFamily: 'inherit' }}
                        >
                          <Icon name="x" size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Bottom bar */}
      <div style={{ ...s.bottomBar, padding: m ? '12px 16px' : '14px 28px' }}>
        <button onClick={handlePrev} style={s.bottomBack}>
          <Icon name="chevron-left" size={16} />
          {stepIdx === 0 ? 'Cancel' : 'Back'}
        </button>

        <div style={s.bottomDots}>
          {STEPS.map((_, i) => (
            <div key={i} style={{
              ...s.dot,
              background: i <= stepIdx ? 'var(--studio-accent)' : 'var(--studio-border)',
            }} />
          ))}
        </div>

        <button
          onClick={handleNext}
          disabled={isLast && !canSubmit}
          style={{
            ...s.bottomNext,
            opacity: isLast && !canSubmit ? 0.4 : 1,
            cursor: isLast && !canSubmit ? 'default' : 'pointer',
          }}
        >
          {isLast ? (
            <>
              <Icon name="sparkles" size={15} color="#fff" />
              Generate
            </>
          ) : (
            <>
              Next
              <Icon name="chevron-right" size={16} color="#fff" />
            </>
          )}
        </button>
      </div>
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    background: 'var(--studio-bg)',
    color: 'var(--studio-text)',
  },

  // Header
  header: {
    display: 'flex',
    alignItems: 'center',
    height: 52,
    borderBottom: '1px solid var(--studio-border)',
    background: 'var(--studio-bg-elevated)',
    flexShrink: 0,
    gap: 8,
  },
  backBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '6px 10px',
    border: 'none',
    background: 'transparent',
    color: 'var(--studio-text-muted)',
    fontSize: 13,
    cursor: 'pointer',
    borderRadius: 8,
    fontFamily: 'inherit',
  },
  headerCenter: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--studio-text)',
  },

  // AI badge
  aiWrap: {
    position: 'relative',
  },
  aiBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 10px',
    border: '1px solid var(--studio-border)',
    borderRadius: 8,
    background: 'var(--studio-surface)',
    color: 'var(--studio-text-muted)',
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  },
  aiBadgeLabel: {
    maxWidth: 140,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  dropBackdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 199,
  },
  dropdown: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: 6,
    width: 240,
    background: 'var(--studio-panel-strong)',
    border: '1px solid var(--studio-border-strong)',
    borderRadius: 12,
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
    zIndex: 200,
    overflow: 'hidden',
  },
  dropSection: {
    padding: '8px 6px',
    borderBottom: '1px solid var(--studio-border)',
  },
  dropTitle: {
    display: 'block',
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--studio-text-dim)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    padding: '4px 8px 6px',
  },
  dropItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '7px 8px',
    border: 'none',
    borderRadius: 6,
    background: 'transparent',
    color: 'var(--studio-text-muted)',
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left' as const,
  },
  dropItemActive: {
    color: 'var(--studio-text)',
    background: 'var(--studio-surface-hover)',
  },
  dropHint: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 14px',
    fontSize: 11,
    color: 'var(--studio-text-dim)',
    lineHeight: 1.4,
  },

  // Stepper
  stepper: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    borderBottom: '1px solid var(--studio-border)',
    background: 'var(--studio-bg-elevated)',
    flexShrink: 0,
  },
  stepPill: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    borderRadius: 8,
    border: 'none',
    background: 'transparent',
    color: 'var(--studio-text-dim)',
    fontWeight: 500,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  },
  stepPillActive: {
    background: 'var(--studio-accent-soft)',
    color: 'var(--studio-text)',
  },
  stepPillDone: {
    color: 'var(--studio-text-muted)',
  },
  stepNum: {
    width: 22,
    height: 22,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
    fontWeight: 700,
    background: 'var(--studio-surface-hover)',
    color: 'inherit',
    transition: 'all 0.15s',
  },
  stepNumActive: {
    background: 'var(--studio-accent)',
    color: '#fff',
  },
  stepNumDone: {
    background: 'var(--studio-success)',
    color: '#fff',
  },
  stepHint: {
    marginLeft: 'auto',
    fontSize: 11,
    color: 'var(--studio-text-dim)',
    whiteSpace: 'nowrap',
    fontStyle: 'italic',
  },

  // Scroll
  scroll: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
    WebkitOverflowScrolling: 'touch',
  },
  formWrap: {
    margin: '0 auto',
  },

  // Step header
  stepHeader: {
    marginBottom: 28,
  },
  stepTitle: {
    fontWeight: 700,
    lineHeight: 1.15,
    margin: 0,
    letterSpacing: '-0.02em',
    color: 'var(--studio-text)',
  },
  stepSub: {
    fontSize: 14,
    color: 'var(--studio-text-muted)',
    margin: '8px 0 0',
    lineHeight: 1.5,
  },

  // Fields
  field: {
    marginBottom: 22,
  },
  label: {
    display: 'block',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--studio-text-muted)',
    marginBottom: 8,
  },
  req: {
    color: 'var(--studio-error)',
  },
  hint: {
    fontSize: 12,
    color: 'var(--studio-text-dim)',
    margin: '0 0 10px',
    lineHeight: 1.4,
  },
  input: {
    width: '100%',
    padding: '11px 14px',
    background: 'var(--studio-surface)',
    border: '1px solid var(--studio-border)',
    borderRadius: 10,
    color: 'var(--studio-text)',
    fontSize: 14,
    outline: 'none',
    fontFamily: 'inherit',
    transition: 'border-color 0.15s',
    boxSizing: 'border-box',
  },
  textarea: {
    width: '100%',
    padding: '11px 14px',
    background: 'var(--studio-surface)',
    border: '1px solid var(--studio-border)',
    borderRadius: 10,
    color: 'var(--studio-text)',
    fontSize: 14,
    outline: 'none',
    fontFamily: 'inherit',
    resize: 'vertical' as const,
    lineHeight: 1.6,
    minHeight: 100,
    boxSizing: 'border-box',
  },

  // Radio cards
  radioGroup: {
    display: 'flex',
    gap: 8,
  },
  radioCard: {
    padding: '14px 16px',
    background: 'var(--studio-surface)',
    border: '1px solid var(--studio-border)',
    borderRadius: 12,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    color: 'var(--studio-text-dim)',
    transition: 'all 0.15s',
    textAlign: 'left' as const,
    fontFamily: 'inherit',
  },
  radioCardActive: {
    borderColor: 'var(--studio-accent)',
    background: 'var(--studio-accent-soft)',
    color: 'var(--studio-accent)',
  },
  radioLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--studio-text)',
  },
  radioDesc: {
    fontSize: 11,
    color: 'var(--studio-text-dim)',
    marginTop: 2,
  },

  // Tags
  tagInputRow: {
    display: 'flex',
    gap: 6,
  },
  tagInput: {
    flex: 1,
    padding: '9px 14px',
    background: 'var(--studio-surface)',
    border: '1px solid var(--studio-border)',
    borderRadius: 10,
    color: 'var(--studio-text)',
    fontSize: 13,
    outline: 'none',
    fontFamily: 'inherit',
  },
  tagAddBtn: {
    padding: '9px 16px',
    borderRadius: 10,
    background: 'var(--studio-surface-hover)',
    border: 'none',
    color: 'var(--studio-text-muted)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    flexShrink: 0,
  },
  tags: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  tag: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '5px 10px',
    background: 'var(--studio-accent-soft)',
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--studio-accent)',
  },
  tagX: {
    background: 'none',
    border: 'none',
    color: 'var(--studio-accent)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    padding: 0,
    display: 'flex',
    opacity: 0.5,
  },

  // Toggle
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '14px 16px',
    border: '1px solid var(--studio-border)',
    borderRadius: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  },
  toggleLabel: {
    fontSize: 13,
    color: 'var(--studio-text)',
  },
  toggle: {
    width: 36,
    height: 20,
    borderRadius: 10,
    position: 'relative',
    transition: 'background 0.2s',
    flexShrink: 0,
  },
  toggleKnob: {
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: '#fff',
    position: 'absolute',
    top: 2,
    transition: 'transform 0.2s',
  },

  // Style picker
  styleGrid: {
    display: 'grid',
    gap: 10,
  },
  styleCard: {
    padding: 10,
    background: 'var(--studio-surface)',
    border: '1px solid var(--studio-border)',
    borderRadius: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.15s',
    textAlign: 'center' as const,
  },
  stylePreview: {
    width: '100%',
    height: 56,
    borderRadius: 8,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '0 12px',
  },
  styleLabel: {
    fontSize: 12,
    marginTop: 8,
    transition: 'color 0.15s',
  },

  // Upload
  uploadBtn: {
    width: '100%',
    padding: 22,
    border: '2px dashed var(--studio-border)',
    borderRadius: 12,
    background: 'transparent',
    color: 'var(--studio-text-dim)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    fontSize: 13,
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  },
  imgTag: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 8px',
    background: 'var(--studio-surface-hover)',
    borderRadius: 6,
    fontSize: 11,
    color: 'var(--studio-text-muted)',
  },

  // Bottom bar
  bottomBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTop: '1px solid var(--studio-border)',
    background: 'var(--studio-bg-elevated)',
    flexShrink: 0,
  },
  bottomBack: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '8px 14px',
    border: '1px solid var(--studio-border)',
    borderRadius: 10,
    background: 'transparent',
    color: 'var(--studio-text-muted)',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  bottomDots: {
    display: 'flex',
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    transition: 'background 0.2s',
  },
  bottomNext: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '9px 20px',
    border: 'none',
    borderRadius: 10,
    background: 'linear-gradient(135deg, #0ea5e9, #2563eb)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 700,
    fontFamily: 'inherit',
    transition: 'all 0.15s',
    boxShadow: '0 2px 8px rgba(37,99,235,0.3)',
  },
};
