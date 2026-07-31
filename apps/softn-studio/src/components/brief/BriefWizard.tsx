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

/**
 * Focus has to be drawn imperatively: the whole app styles itself with inline
 * style objects, and inline styles cannot express :focus. Setting the two
 * properties on the node directly and putting them back on blur keeps the ring
 * out of React's render path entirely, so no keystroke costs a re-render.
 *
 * The ring is coral because focus is the one moment the tool is asking for your
 * attention, and stacking two --studio-accent-soft layers compounds their alpha
 * into a halo that survives the light theme, where the soft tone is only 10%.
 */
const FOCUS_SHADOW = '0 0 0 1px var(--studio-accent), 0 0 0 4px var(--studio-accent-soft), 0 0 0 7px var(--studio-accent-soft)';

// A coral halo disappears on a coral button, so anything already filled with
// the accent gets the ring gapped off the page ground instead.
const FOCUS_SHADOW_ON_ACCENT = '0 0 0 2px var(--studio-bg), 0 0 0 4px var(--studio-accent)';

const ring = (restBorder: string, restShadow = 'none', focusShadow = FOCUS_SHADOW) => ({
  onFocus: (e: React.FocusEvent<HTMLElement>) => {
    e.currentTarget.style.borderColor = 'var(--studio-accent)';
    e.currentTarget.style.boxShadow = focusShadow;
  },
  onBlur: (e: React.FocusEvent<HTMLElement>) => {
    e.currentTarget.style.borderColor = restBorder;
    e.currentTarget.style.boxShadow = restShadow;
  },
});

// Hover only ever touches `background`, so it can never wipe out a focus ring
// that is living on `borderColor` / `boxShadow` at the same time.
const hover = (rest: string, over: string) => ({
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = over; },
  onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = rest; },
});

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

  /**
   * The presets used to be five saturated hex swatches — blue, red, zinc,
   * purple, near-black — which is four accents the palette does not have. They
   * are now told apart by form instead of hue: bar weight, spacing and corner
   * radius sketch what each preset feels like, all drawn in --studio-text at
   * varying opacity. "Dark" is the one that genuinely needs a value change, so
   * it keeps the same geometry on the darkest ground either theme offers.
   */
  const styleOptions: {
    id: VisualStyle;
    label: string;
    ground: string;
    bars: { w: string; h: number; r: number; o: number }[];
  }[] = [
    { id: 'clean', label: 'Clean', ground: 'var(--studio-surface)', bars: [{ w: '62%', h: 5, r: 3, o: 0.85 }, { w: '40%', h: 4, r: 2, o: 0.38 }, { w: '84%', h: 12, r: 5, o: 0.14 }] },
    { id: 'bold', label: 'Bold', ground: 'var(--studio-surface)', bars: [{ w: '72%', h: 9, r: 2, o: 1 }, { w: '46%', h: 7, r: 2, o: 0.5 }, { w: '88%', h: 13, r: 2, o: 0.22 }] },
    { id: 'minimal', label: 'Minimal', ground: 'var(--studio-surface)', bars: [{ w: '38%', h: 2, r: 1, o: 0.6 }, { w: '22%', h: 2, r: 1, o: 0.3 }, { w: '52%', h: 6, r: 1, o: 0.1 }] },
    { id: 'playful', label: 'Playful', ground: 'var(--studio-surface)', bars: [{ w: '52%', h: 8, r: 99, o: 0.85 }, { w: '32%', h: 8, r: 99, o: 0.42 }, { w: '74%', h: 14, r: 99, o: 0.18 }] },
    { id: 'dark', label: 'Dark', ground: 'var(--studio-overlay)', bars: [{ w: '62%', h: 5, r: 3, o: 0.95 }, { w: '40%', h: 4, r: 2, o: 0.5 }, { w: '84%', h: 12, r: 5, o: 0.24 }] },
  ];

  const m = isMobile;

  const renderCheck = (size = 18) => (
    <span style={{ ...s.selectedBadge, width: size, height: size }}>
      <Icon name="check" size={size - 7} color="var(--studio-bg)" />
    </span>
  );

  return (
    <div style={s.root}>
      {/* Header */}
      <div style={{ ...s.header, padding: m ? '0 12px' : '0 20px' }}>
        <button
          onClick={handlePrev}
          style={s.backBtn}
          {...ring('transparent')}
          {...hover('transparent', 'var(--studio-surface)')}
        >
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
            aria-haspopup="menu"
            aria-expanded={showProviderDropdown}
            {...ring('var(--studio-border)')}
          >
            <Icon
              name="key"
              size={13}
              color={activeProvider ? 'var(--studio-accent)' : 'var(--studio-text-dim)'}
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
                        {...ring('transparent')}
                      >
                        <div style={{
                          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                          background: activeProviderId === p.id ? 'var(--studio-accent)' : 'var(--studio-border-strong)',
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

      {/* Step indicator — the wizard's only progress display */}
      <div style={{ ...s.stepper, padding: m ? '0 12px' : '0 20px' }}>
        <div style={s.stepTrack}>
          {STEPS.map((st, i) => {
            const active = i === stepIdx;
            const done = i < stepIdx;
            return (
              <React.Fragment key={st.id}>
                {i > 0 && (
                  <span style={{
                    ...s.stepRail,
                    background: i <= stepIdx ? 'var(--studio-border-strong)' : 'var(--studio-border)',
                  }} />
                )}
                <button
                  onClick={() => setStep(st.id)}
                  aria-current={active ? 'step' : undefined}
                  style={{
                    ...s.stepBtn,
                    padding: m ? '0 6px' : '0 8px',
                  }}
                  {...ring('transparent')}
                >
                  <span style={{
                    ...s.stepChip,
                    ...(done ? s.stepChipDone : {}),
                    ...(active ? s.stepChipActive : {}),
                  }}>
                    {done ? <Icon name="check" size={12} color="var(--studio-text)" /> : st.num}
                  </span>
                  {(!m || active) && (
                    <span style={{
                      ...s.stepLabel,
                      color: active ? 'var(--studio-text)' : done ? 'var(--studio-text-muted)' : 'var(--studio-text-dim)',
                      fontWeight: active ? 600 : 400,
                    }}>
                      {st.label}
                    </span>
                  )}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {/* Shown on every width. This was desktop-only, so on a phone the
            Generate button was simply disabled and the only thing that said why
            had been rendered out — the button did nothing and offered no
            account of itself. It is the narrow screen that needs the
            explanation most, because there is no room for anything else. */}
        <div
            role="status"
            aria-live="polite"
            style={{
              ...s.reqChip,
              background: canSubmit ? 'transparent' : 'var(--studio-accent-soft)',
              borderColor: canSubmit ? 'var(--studio-border)' : 'var(--studio-accent)',
              color: canSubmit ? 'var(--studio-text-dim)' : 'var(--studio-accent)',
            }}
          >
            <Icon
              name={canSubmit ? 'check' : 'alert-circle'}
              size={12}
              color={canSubmit ? 'var(--studio-text-dim)' : 'var(--studio-accent)'}
            />
            <span>{canSubmit ? 'ready to generate' : 'name & description required'}</span>
          </div>
      </div>

      {/* Form content — the sheet is centred in whatever height is left over */}
      <div ref={scrollRef} style={{ ...s.scroll, padding: m ? '18px 12px' : '32px 24px' }}>
        <div style={{ ...s.sheet, padding: m ? '22px 18px 26px' : '34px 36px 38px', maxWidth: m ? '100%' : 620 }}>

          {/* ---- Step 1: Basics ---- */}
          {step === 'basics' && (
            <>
              <div style={s.stepHeader}>
                <h2 style={{ ...s.stepTitle, fontSize: m ? 24 : 30 }}>What are you building?</h2>
                <p style={s.stepSub}>Give your app a name and describe what it does.</p>
              </div>

              <div style={s.field}>
                <label htmlFor="brief-app-name" style={s.label}>App name <span style={s.req}>*</span></label>
                <input
                  id="brief-app-name"
                  style={s.input}
                  value={brief.appName}
                  onChange={(e) => set('appName', e.target.value)}
                  placeholder="My Amazing App"
                  autoFocus
                  {...ring('var(--studio-border)')}
                />
              </div>

              <div style={s.field}>
                <label htmlFor="brief-description" style={s.label}>Description <span style={s.req}>*</span></label>
                <textarea
                  id="brief-description"
                  style={s.textarea}
                  value={brief.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder="A task management app with categories, due dates, and priority levels. Users can drag tasks between columns like a kanban board."
                  rows={5}
                  {...ring('var(--studio-border)')}
                />
              </div>

              <div style={{ ...s.field, marginBottom: 0 }}>
                <div id="brief-target-label" style={s.label}>Target platform</div>
                <div
                  role="group"
                  aria-labelledby="brief-target-label"
                  style={{ ...s.radioGroup, flexDirection: m ? 'column' : 'row' }}
                >
                  {targets.map((t) => {
                    const on = brief.target === t.id;
                    return (
                      <button
                        key={t.id}
                        onClick={() => set('target', t.id)}
                        aria-pressed={on}
                        style={{
                          ...s.radioCard,
                          flex: m ? 'none' : '1 1 0',
                          ...(on ? s.radioCardActive : {}),
                        }}
                        {...ring(on ? 'var(--studio-accent)' : 'var(--studio-border)')}
                        {...hover(
                          on ? 'var(--studio-accent-soft)' : 'var(--studio-bg-muted)',
                          on ? 'var(--studio-accent-soft)' : 'var(--studio-surface-hover)',
                        )}
                      >
                        <Icon
                          name={t.icon}
                          size={18}
                          color={on ? 'var(--studio-accent)' : 'var(--studio-text-dim)'}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={s.radioLabel}>{t.label}</div>
                          <div style={s.radioDesc}>{t.desc}</div>
                        </div>
                        {/* Corner-mounted so selecting a card cannot reflow its
                            own description onto a second line. */}
                        {on && <span style={s.cardCheck}>{renderCheck(18)}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* ---- Step 2: Structure ---- */}
          {step === 'structure' && (
            <>
              <div style={s.stepHeader}>
                <h2 style={{ ...s.stepTitle, fontSize: m ? 24 : 30 }}>App structure</h2>
                <p style={s.stepSub}>Define the pages and data your app needs. All optional.</p>
              </div>

              <div style={s.field}>
                <label htmlFor="brief-pages" style={s.label}>Pages</label>
                <div style={s.tagInputRow}>
                  <input
                    id="brief-pages"
                    style={s.tagInput}
                    value={pageInput}
                    onChange={(e) => setPageInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { addTag('pages', pageInput); setPageInput(''); } }}
                    placeholder="e.g., Dashboard, Settings, Profile..."
                    autoFocus
                    {...ring('var(--studio-border)')}
                  />
                  <button
                    style={s.tagAddBtn}
                    onClick={() => { addTag('pages', pageInput); setPageInput(''); }}
                    {...ring('var(--studio-border)')}
                    {...hover('var(--studio-bg-muted)', 'var(--studio-surface-hover)')}
                  >
                    Add
                  </button>
                </div>
                {brief.pages.length > 0 && (
                  <div style={s.tags}>
                    {brief.pages.map((p, i) => (
                      <span key={i} style={s.tag}>
                        {p}
                        <button
                          onClick={() => removeTag('pages', i)}
                          style={s.tagX}
                          aria-label={`Remove page ${p}`}
                          {...ring('transparent')}
                        >
                          <Icon name="x" size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div style={s.field}>
                <label htmlFor="brief-collections" style={s.label}>Data collections</label>
                <div style={s.tagInputRow}>
                  <input
                    id="brief-collections"
                    style={s.tagInput}
                    value={collInput}
                    onChange={(e) => setCollInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { addTag('collections', collInput); setCollInput(''); } }}
                    placeholder="e.g., Tasks, Users, Categories..."
                    {...ring('var(--studio-border)')}
                  />
                  <button
                    style={s.tagAddBtn}
                    onClick={() => { addTag('collections', collInput); setCollInput(''); }}
                    {...ring('var(--studio-border)')}
                    {...hover('var(--studio-bg-muted)', 'var(--studio-surface-hover)')}
                  >
                    Add
                  </button>
                </div>
                {brief.collections.length > 0 && (
                  <div style={s.tags}>
                    {brief.collections.map((c, i) => (
                      <span key={i} style={s.tag}>
                        {c}
                        <button
                          onClick={() => removeTag('collections', i)}
                          style={s.tagX}
                          aria-label={`Remove collection ${c}`}
                          {...ring('transparent')}
                        >
                          <Icon name="x" size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ ...s.field, marginBottom: 0 }}>
                <div id="brief-auth-label" style={s.label}>Authentication</div>
                <button
                  onClick={() => set('authNeeded', !brief.authNeeded)}
                  aria-pressed={brief.authNeeded}
                  aria-labelledby="brief-auth-label brief-auth-text"
                  style={{
                    ...s.choiceRow,
                    borderColor: brief.authNeeded ? 'var(--studio-accent)' : 'var(--studio-border)',
                    borderWidth: brief.authNeeded ? 2 : 1,
                    padding: brief.authNeeded ? '13px 15px' : '14px 16px',
                    background: brief.authNeeded ? 'var(--studio-accent-soft)' : 'var(--studio-bg-muted)',
                  }}
                  {...ring(brief.authNeeded ? 'var(--studio-accent)' : 'var(--studio-border)')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Icon name="key" size={16} color={brief.authNeeded ? 'var(--studio-accent)' : 'var(--studio-text-dim)'} />
                    <span id="brief-auth-text" style={s.toggleLabel}>Require user login</span>
                  </div>
                  <div style={{
                    ...s.toggle,
                    background: brief.authNeeded ? 'var(--studio-accent)' : 'var(--studio-border-strong)',
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
                <h2 style={{ ...s.stepTitle, fontSize: m ? 24 : 30 }}>Visual style</h2>
                <p style={s.stepSub}>Pick the look and feel. You can refine it later.</p>
              </div>

              <div style={s.field}>
                <div id="brief-style-label" style={s.label}>Style preset</div>
                <div
                  role="group"
                  aria-labelledby="brief-style-label"
                  style={{ ...s.styleGrid, gridTemplateColumns: m ? 'repeat(2, 1fr)' : 'repeat(5, 1fr)' }}
                >
                  {styleOptions.map((opt) => {
                    const on = brief.style === opt.id;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => set('style', opt.id)}
                        aria-pressed={on}
                        style={{
                          ...s.styleCard,
                          borderColor: on ? 'var(--studio-accent)' : 'var(--studio-border)',
                          borderWidth: on ? 2 : 1,
                          padding: on ? 9 : 10,
                          background: on ? 'var(--studio-accent-soft)' : 'var(--studio-bg-muted)',
                        }}
                        {...ring(on ? 'var(--studio-accent)' : 'var(--studio-border)')}
                      >
                        {on && <span style={s.cardCheck}>{renderCheck(18)}</span>}
                        <div style={{ ...s.stylePreview, background: opt.ground }}>
                          {opt.bars.map((bar, bi) => (
                            <div
                              key={bi}
                              style={{
                                width: bar.w,
                                height: bar.h,
                                borderRadius: bar.r,
                                background: 'var(--studio-text)',
                                opacity: bar.o,
                                marginTop: bi === 0 ? 0 : 5,
                              }}
                            />
                          ))}
                        </div>
                        <span style={{
                          ...s.styleLabel,
                          color: on ? 'var(--studio-accent)' : 'var(--studio-text-dim)',
                          fontWeight: on ? 600 : 400,
                        }}>{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/*
                A "Reference images" upload used to sit here. It worked as an
                input and did nothing as data: the File objects went into brief
                state, the button turned accent-coloured, showed a check and
                said "3 images selected", and then nothing in the app ever read
                them — no request builder touched referenceImages, so the model
                never saw a single pixel. A control that confirms receipt and
                discards the thing is worse than no control.

                Sending them is a real feature, not a wiring fix: it needs a
                vision-capable request shape per provider and a size budget.
                Until that exists, the wizard does not ask.
              */}
            </>
          )}
        </div>
      </div>

      {/* Bottom bar */}
      <div style={{ ...s.bottomBar, padding: m ? '12px 16px' : '14px 24px' }}>
        <button
          onClick={handlePrev}
          style={s.bottomBack}
          {...ring('var(--studio-border)')}
          {...hover('transparent', 'var(--studio-surface)')}
        >
          <Icon name="chevron-left" size={16} />
          {stepIdx === 0 ? 'Cancel' : 'Back'}
        </button>

        <button
          onClick={handleNext}
          disabled={isLast && !canSubmit}
          style={{
            ...s.bottomNext,
            background: isLast && !canSubmit ? 'var(--studio-bg-muted)' : 'var(--studio-accent)',
            color: isLast && !canSubmit ? 'var(--studio-text-dim)' : 'var(--studio-bg)',
            borderColor: isLast && !canSubmit ? 'var(--studio-border)' : 'var(--studio-accent)',
            cursor: isLast && !canSubmit ? 'default' : 'pointer',
          }}
          {...ring(
            isLast && !canSubmit ? 'var(--studio-border)' : 'var(--studio-accent)',
            'none',
            isLast && !canSubmit ? FOCUS_SHADOW : FOCUS_SHADOW_ON_ACCENT,
          )}
        >
          {isLast ? (
            <>
              <Icon
                name="sparkles"
                size={15}
                color={isLast && !canSubmit ? 'var(--studio-text-dim)' : 'var(--studio-bg)'}
              />
              Generate
            </>
          ) : (
            <>
              Next
              <Icon name="chevron-right" size={16} color="var(--studio-bg)" />
            </>
          )}
        </button>
      </div>
    </div>
  );
};

// Every label, count and badge is set in --studio-mono at small sizes with wide
// tracking — the eyebrow treatment softn.com uses — so that the sans is left to
// carry only real prose and the display face only headings.
const eyebrow: React.CSSProperties = {
  fontFamily: 'var(--studio-mono)',
  fontSize: 10.5,
  fontWeight: 500,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
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
    borderBottom: '1px solid var(--studio-border-subtle)',
    background: 'var(--studio-bg)',
    flexShrink: 0,
    gap: 8,
  },
  backBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '6px 10px',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    background: 'transparent',
    color: 'var(--studio-text-muted)',
    fontSize: 13,
    cursor: 'pointer',
    borderRadius: 8,
    fontFamily: 'inherit',
    outline: 'none',
  },
  headerCenter: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 7,
  },
  headerTitle: {
    fontFamily: 'var(--studio-display)',
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '-0.015em',
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
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    borderRadius: 8,
    background: 'var(--studio-bg-elevated)',
    color: 'var(--studio-text-muted)',
    fontFamily: 'var(--studio-mono)',
    fontSize: 11,
    letterSpacing: '0.01em',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    outline: 'none',
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
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border-strong)',
    borderRadius: 12,
    boxShadow: 'var(--studio-shadow)',
    zIndex: 200,
    overflow: 'hidden',
  },
  dropSection: {
    padding: '8px 6px',
  },
  dropTitle: {
    ...eyebrow,
    display: 'block',
    color: 'var(--studio-text-dim)',
    padding: '4px 8px 8px',
  },
  dropItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '7px 8px',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: 6,
    background: 'transparent',
    color: 'var(--studio-text-muted)',
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    outline: 'none',
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

  // Stepper — completed / current / upcoming are three different objects, not
  // three tints of one pill, so the sequence reads without reading the labels.
  stepper: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    height: 56,
    borderBottom: '1px solid var(--studio-border)',
    background: 'var(--studio-bg)',
    flexShrink: 0,
  },
  stepTrack: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
  },
  stepRail: {
    width: 28,
    height: 2,
    borderRadius: 1,
    flexShrink: 0,
  },
  stepBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    height: 34,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: 8,
    background: 'transparent',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontFamily: 'inherit',
    outline: 'none',
  },
  stepChip: {
    width: 26,
    height: 26,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--studio-mono)',
    fontSize: 11,
    fontWeight: 600,
    flexShrink: 0,
    background: 'transparent',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border-strong)',
    color: 'var(--studio-text-dim)',
    transition: 'all 0.15s',
  },
  stepChipDone: {
    background: 'var(--studio-border-strong)',
    borderColor: 'var(--studio-border-strong)',
    color: 'var(--studio-text)',
  },
  stepChipActive: {
    background: 'var(--studio-accent)',
    borderColor: 'var(--studio-accent)',
    color: 'var(--studio-bg)',
    boxShadow: '0 0 0 4px var(--studio-accent-soft)',
  },
  stepLabel: {
    fontSize: 13,
    letterSpacing: '-0.005em',
  },
  reqChip: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 10px',
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    ...eyebrow,
    whiteSpace: 'nowrap',
    transition: 'all 0.2s',
  },

  // Scroll + sheet
  scroll: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
    WebkitOverflowScrolling: 'touch',
    display: 'flex',
    flexDirection: 'column',
  },
  // margin:auto centres a short step in the leftover height and collapses to
  // zero once the step is taller than the viewport, so tall steps still scroll
  // from their top edge instead of being clipped.
  sheet: {
    margin: 'auto',
    width: '100%',
    flexShrink: 0,
    background: 'var(--studio-bg-elevated)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    borderRadius: 18,
    boxShadow: 'var(--studio-shadow)',
  },

  // Step header
  stepHeader: {
    marginBottom: 26,
  },
  stepTitle: {
    fontFamily: 'var(--studio-display)',
    fontWeight: 700,
    lineHeight: 1.1,
    margin: 0,
    letterSpacing: '-0.035em',
    color: 'var(--studio-text)',
  },
  stepSub: {
    fontSize: 14,
    color: 'var(--studio-text-muted)',
    margin: '10px 0 0',
    lineHeight: 1.5,
  },

  // Fields
  field: {
    marginBottom: 24,
  },
  label: {
    ...eyebrow,
    display: 'block',
    color: 'var(--studio-text-dim)',
    marginBottom: 9,
  },
  req: {
    color: 'var(--studio-accent)',
    fontWeight: 600,
  },
  hint: {
    fontSize: 12,
    color: 'var(--studio-text-dim)',
    margin: '-3px 0 10px',
    lineHeight: 1.45,
  },
  // Fields are cut back to the page ground rather than raised off the sheet.
  // Chrome pins ::placeholder to a fixed mid grey that ignores the inherited
  // colour, and inline styles cannot reach a pseudo-element, so the field's own
  // fill is the only lever on placeholder legibility — and the page ground is
  // the value furthest from that mid grey in both themes.
  input: {
    width: '100%',
    padding: '11px 14px',
    background: 'var(--studio-bg)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    borderRadius: 10,
    color: 'var(--studio-text)',
    fontSize: 14,
    outline: 'none',
    fontFamily: 'inherit',
    boxShadow: 'none',
    transition: 'border-color 0.12s, box-shadow 0.12s',
    boxSizing: 'border-box',
  },
  textarea: {
    width: '100%',
    padding: '11px 14px',
    background: 'var(--studio-bg)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    borderRadius: 10,
    color: 'var(--studio-text)',
    fontSize: 14,
    outline: 'none',
    fontFamily: 'inherit',
    resize: 'vertical',
    lineHeight: 1.6,
    minHeight: 104,
    boxShadow: 'none',
    transition: 'border-color 0.12s, box-shadow 0.12s',
    boxSizing: 'border-box',
  },

  // One card language: bg-muted well, hairline border, coral 2px border plus a
  // check badge when chosen — so selection survives without colour vision.
  radioGroup: {
    display: 'flex',
    gap: 8,
  },
  radioCard: {
    position: 'relative',
    padding: '14px 16px',
    background: 'var(--studio-bg-muted)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    borderRadius: 12,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    color: 'var(--studio-text-dim)',
    transition: 'border-color 0.12s, background 0.12s',
    textAlign: 'left',
    fontFamily: 'inherit',
    outline: 'none',
  },
  radioCardActive: {
    borderColor: 'var(--studio-accent)',
    borderWidth: 2,
    padding: '13px 15px',
    background: 'var(--studio-accent-soft)',
  },
  radioLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--studio-text)',
  },
  radioDesc: {
    fontSize: 11,
    color: 'var(--studio-text-dim)',
    marginTop: 3,
    lineHeight: 1.35,
  },
  cardCheck: {
    position: 'absolute',
    top: 6,
    right: 6,
    display: 'flex',
    zIndex: 1,
  },
  selectedBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    background: 'var(--studio-accent)',
    flexShrink: 0,
  },

  // Tags
  tagInputRow: {
    display: 'flex',
    gap: 8,
  },
  tagInput: {
    flex: 1,
    minWidth: 0,
    padding: '10px 14px',
    background: 'var(--studio-bg)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    borderRadius: 10,
    color: 'var(--studio-text)',
    fontSize: 13,
    outline: 'none',
    fontFamily: 'inherit',
    boxShadow: 'none',
    transition: 'border-color 0.12s, box-shadow 0.12s',
  },
  tagAddBtn: {
    ...eyebrow,
    padding: '10px 16px',
    borderRadius: 10,
    background: 'var(--studio-bg-muted)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    color: 'var(--studio-text-muted)',
    cursor: 'pointer',
    flexShrink: 0,
    outline: 'none',
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
    gap: 6,
    padding: '5px 6px 5px 10px',
    background: 'var(--studio-bg-muted)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    borderRadius: 8,
    fontFamily: 'var(--studio-mono)',
    fontSize: 11.5,
    color: 'var(--studio-text)',
  },
  tagX: {
    background: 'none',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: 5,
    color: 'var(--studio-text-dim)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    padding: 1,
    display: 'flex',
    outline: 'none',
  },

  // Toggle
  choiceRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    borderRadius: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'border-color 0.12s, background 0.12s',
    outline: 'none',
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
    background: 'var(--studio-bg)',
    boxShadow: '0 1px 2px var(--studio-overlay)',
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
    position: 'relative',
    background: 'var(--studio-bg-muted)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    borderRadius: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'border-color 0.12s, background 0.12s',
    textAlign: 'center',
    outline: 'none',
  },
  stylePreview: {
    width: '100%',
    height: 58,
    borderRadius: 8,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '0 12px',
    overflow: 'hidden',
  },
  styleLabel: {
    ...eyebrow,
    display: 'block',
    marginTop: 9,
    transition: 'color 0.12s',
  },

  // Upload
  uploadBtn: {
    width: '100%',
    padding: 22,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: 'var(--studio-border-strong)',
    borderRadius: 12,
    background: 'var(--studio-bg-muted)',
    color: 'var(--studio-text-dim)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    fontSize: 13,
    fontFamily: 'inherit',
    transition: 'border-color 0.12s, background 0.12s, color 0.12s',
    outline: 'none',
  },
  imgTag: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '4px 5px 4px 9px',
    background: 'var(--studio-bg-muted)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    borderRadius: 7,
    fontFamily: 'var(--studio-mono)',
    fontSize: 11,
    color: 'var(--studio-text-muted)',
  },

  // Bottom bar — the three dots that used to sit here duplicated the step bar,
  // so the step bar is now the only place progress is reported.
  bottomBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTop: '1px solid var(--studio-border)',
    background: 'var(--studio-bg)',
    flexShrink: 0,
  },
  bottomBack: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '9px 14px',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-border)',
    borderRadius: 10,
    background: 'transparent',
    color: 'var(--studio-text-muted)',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
    outline: 'none',
  },
  bottomNext: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '9px 20px',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--studio-accent)',
    borderRadius: 10,
    background: 'var(--studio-accent)',
    color: 'var(--studio-bg)',
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: '0.01em',
    fontFamily: 'inherit',
    transition: 'background 0.12s, color 0.12s, border-color 0.12s',
    outline: 'none',
  },
};
