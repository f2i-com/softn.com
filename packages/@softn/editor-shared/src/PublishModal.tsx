import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { inspectBundle, type BundleInspection } from '@softn/bundle-format/inspect';
import { useModalFocus } from './useModalFocus';
import {
  DirectPublishError,
  fetchDirectoryCategories,
  fetchDirectoryCategoriesInfo,
  inferCategorySuggestion,
  publishBundleDirect,
  publishVersionDirect,
  savedAuthorName,
  savedEditorEditKeys,
  savedProjectPublishedSlug,
  suggestDirectoryCategory,
  type DirectoryCategory,
  type DirectPublishResult,
  type HostingMode,
  type PublishedAppSummary,
} from './directPublish';

export interface EditorBundleBuild {
  bytes: Uint8Array;
  fileName: string;
}

export interface PublishModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Stable identifier for this project (Studio projectId or Builder project key) so updates remember its slug. */
  projectKey?: string;
  /** Initial app name from the editor. */
  projectName: string;
  /** Initial description from the editor (if available). */
  projectDescription?: string;
  /** Build the current project into a `.softn` archive in memory. */
  buildBundle: () => Promise<EditorBundleBuild> | EditorBundleBuild;
  /** Optional callback to open the standalone `/publish` page via handoff if desired or when API is offline. */
  onOpenFullPublishPage?: () => void;
  /** Optional callback invoked after a successful publish/version push. */
  onPublished?: (app: PublishedAppSummary, isNewVersion: boolean) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function PublishModal({
  isOpen,
  onClose,
  projectKey,
  projectName,
  projectDescription = '',
  buildBundle,
  onOpenFullPublishPage,
  onPublished,
}: PublishModalProps): React.ReactElement | null {
  const titleId = useId();
  const dialogRef = useModalFocus(isOpen, onClose);

  const [bundle, setBundle] = useState<EditorBundleBuild | null>(null);
  const [inspection, setInspection] = useState<BundleInspection | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);

  const [categories, setCategories] = useState<DirectoryCategory[]>([]);
  const [allowPublicServerHosting, setAllowPublicServerHosting] = useState(false);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [loadingCats, setLoadingCats] = useState(false);

  const [mode, setMode] = useState<'new' | 'update'>('new');
  const [ownedKeys, setOwnedKeys] = useState<Record<string, string>>({});
  const [targetSlug, setTargetSlug] = useState('');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [author, setAuthor] = useState('');
  const [category, setCategory] = useState('');
  const [subcategory, setSubcategory] = useState('');
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');
  const [hosting, setHosting] = useState<HostingMode>('browser');
  const [withholdBackend, setWithholdBackend] = useState(false);
  const [thumbFile, setThumbFile] = useState<File | null>(null);
  const [thumbPreview, setThumbPreview] = useState<string | null>(null);

  const [suggesting, setSuggesting] = useState(false);
  const [suggestName, setSuggestName] = useState('');
  const [suggestEmoji, setSuggestEmoji] = useState('');
  const [suggestDesc, setSuggestDesc] = useState('');
  const [suggestAsSub, setSuggestAsSub] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [published, setPublished] = useState<{
    result: DirectPublishResult | { app: PublishedAppSummary; editKey: null; page: string; keyKept: 'stored' };
    isUpdate: boolean;
  } | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);

  const buildRef = useRef(buildBundle);
  buildRef.current = buildBundle;

  // Clean up object URL for thumbnail preview
  useEffect(() => {
    if (!thumbFile) {
      setThumbPreview(null);
      return;
    }
    const url = URL.createObjectURL(thumbFile);
    setThumbPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [thumbFile]);

  // Reset & prepare bundle + fetch categories whenever the modal opens
  useEffect(() => {
    if (!isOpen) return;
    const ac = new AbortController();
    setPublished(null);
    setSubmitError(null);
    setBuildError(null);
    setSuggestError(null);
    setSuggesting(false);
    setThumbFile(null);
    setNotes('');
    setAuthor(savedAuthorName());
    setCopiedLink(false);
    setCopiedKey(false);

    const keys = savedEditorEditKeys();
    setOwnedKeys(keys);
    const prevSlug = savedProjectPublishedSlug(projectKey);
    if (prevSlug && keys[prevSlug]) {
      setMode('update');
      setTargetSlug(prevSlug);
    } else {
      setMode('new');
      const slugs = Object.keys(keys);
      setTargetSlug(slugs[0] ?? '');
    }

    let builtInspection: BundleInspection | null = null;
    setBuilding(true);
    setBundle(null);
    setInspection(null);

    Promise.resolve()
      .then(() => buildRef.current())
      .then((b) => {
        if (ac.signal.aborted) return;
        setBundle(b);
        const info = inspectBundle(b.bytes);
        builtInspection = info;
        setInspection(info);
        setName(projectName.trim() || info.name || 'My App');
        setDescription(projectDescription.trim() || info.description || '');
        if (info.manifestAuthor && !savedAuthorName()) setAuthor(info.manifestAuthor);
        if (info.manifestTags && info.manifestTags.length > 0) setTags(info.manifestTags.join(', '));
        setHosting('browser');
        setWithholdBackend(false);
        setBuilding(false);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setBuildError(err instanceof Error ? err.message : String(err));
        setBuilding(false);
      });

    setLoadingCats(true);
    setCategoriesError(null);
    fetchDirectoryCategoriesInfo(ac.signal)
      .then(({ categories: cats, allowPublicServerHosting: allowHost }) => {
        if (ac.signal.aborted) return;
        setCategories(cats);
        setAllowPublicServerHosting(allowHost);
        const inferred = inferCategorySuggestion(cats, {
          name: projectName || builtInspection?.name,
          description: projectDescription || builtInspection?.description,
          backendRuntime: builtInspection?.backendRuntime,
          manifestCategory: builtInspection?.manifestCategory,
          manifestSubcategory: builtInspection?.manifestSubcategory,
        });
        setCategory(inferred.category);
        setSubcategory(inferred.subcategory);
        setLoadingCats(false);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setCategoriesError(err instanceof Error ? err.message : String(err));
        setLoadingCats(false);
      });

    return () => ac.abort();
  }, [isOpen, projectKey, projectName, projectDescription]);

  // Re-apply smart category hint if bundle inspection completes slightly after categories load
  useEffect(() => {
    if (!isOpen || !inspection || categories.length === 0) return;
    if (inspection.manifestCategory || inspection.backendRuntime) {
      const inferred = inferCategorySuggestion(categories, {
        name: name || inspection.name,
        description: description || inspection.description,
        backendRuntime: inspection.backendRuntime,
        manifestCategory: inspection.manifestCategory,
        manifestSubcategory: inspection.manifestSubcategory,
      });
      setCategory((prev) => (prev === '' || prev === 'tools' ? inferred.category : prev));
      setSubcategory((prev) => (prev === '' ? inferred.subcategory : prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspection, categories.length]);

  const selectedCat = useMemo(() => categories.find((c) => c.id === category), [categories, category]);
  const subcategories = selectedCat?.subcategories ?? [];
  const ownedSlugs = useMemo(() => Object.keys(ownedKeys), [ownedKeys]);
  const hasBackend = Boolean(inspection?.backendRuntime);
  const bundleBlocked = Boolean(buildError || inspection?.problem);

  const handleSuggest = useCallback(async () => {
    setSuggestError(null);
    try {
      const created = await suggestDirectoryCategory({
        name: suggestName,
        description: suggestDesc,
        emoji: suggestEmoji,
        parent: suggestAsSub && category ? category : undefined,
      });
      const fresh = await fetchDirectoryCategories();
      setCategories(fresh);
      if (created.parent) {
        setCategory(created.parent);
        setSubcategory(created.slug ?? created.id.split('/')[1] ?? '');
      } else {
        setCategory(created.id);
        setSubcategory('');
      }
      setSuggesting(false);
      setSuggestName('');
      setSuggestEmoji('');
      setSuggestDesc('');
    } catch (err: unknown) {
      setSuggestError(err instanceof Error ? err.message : String(err));
    }
  }, [suggestName, suggestDesc, suggestEmoji, suggestAsSub, category]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!bundle || bundleBlocked || submitting) return;
      setSubmitting(true);
      setSubmitError(null);
      try {
        if (mode === 'update' && targetSlug && ownedKeys[targetSlug]) {
          const res = await publishVersionDirect({
            slug: targetSlug,
            editKey: ownedKeys[targetSlug],
            bytes: bundle.bytes,
            fileName: bundle.fileName,
            notes,
            projectKey,
          });
          setPublished({
            result: { app: res.app, editKey: null, page: res.app.urls.page, keyKept: 'stored' },
            isUpdate: true,
          });
          onPublished?.(res.app, true);
        } else {
          const res = await publishBundleDirect({
            bytes: bundle.bytes,
            fileName: bundle.fileName,
            name: name.trim() || inspection?.name || 'My App',
            description: description.trim(),
            author: author.trim(),
            category: category || 'other',
            subcategory: subcategory || undefined,
            tags,
            notes,
            hosting: allowPublicServerHosting && hasBackend ? hosting : 'browser',
            withholdBackend: allowPublicServerHosting && hasBackend && hosting === 'server' && withholdBackend,
            thumbnail: thumbFile,
            projectKey,
          });
          setPublished({ result: res, isUpdate: false });
          onPublished?.(res.app, false);
        }
      } catch (err: unknown) {
        if (err instanceof DirectPublishError) {
          setSubmitError(err.message);
        } else {
          setSubmitError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setSubmitting(false);
      }
    },
    [
      bundle,
      bundleBlocked,
      submitting,
      mode,
      targetSlug,
      ownedKeys,
      notes,
      projectKey,
      onPublished,
      name,
      inspection?.name,
      description,
      author,
      category,
      subcategory,
      tags,
      hasBackend,
      allowPublicServerHosting,
      hosting,
      withholdBackend,
      thumbFile,
    ],
  );

  if (!isOpen) return null;

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div
      style={st.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={st.dialog}
      >
        <div style={st.header}>
          <div>
            <h2 id={titleId} style={st.title}>
              {published ? (published.isUpdate ? `Published v${published.result.app.version}` : 'Published to SoftN') : 'Publish to SoftN'}
            </h2>
            {!published && (
              <p style={st.subtitle}>
                Share directly to the SoftN directory right from here — no extra steps.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close publish dialog"
            style={st.closeBtn}
          >
            ✕
          </button>
        </div>

        <div style={st.body}>
          {published ? (
            <div style={st.successWrap}>
              <div style={st.successBadge} aria-hidden="true">✓</div>
              <h3 style={st.successHeading}>
                {published.result.app.name} {published.isUpdate ? `v${published.result.app.version} is live` : 'is live!'}
              </h3>
              <p style={st.successSub}>
                Live at{' '}
                <a href={published.result.app.urls.page} target="_blank" rel="noopener noreferrer" style={st.link}>
                  {origin + published.result.app.urls.page}
                </a>
              </p>
              {'warning' in published.result && published.result.warning && (
                <div style={st.warnBox} role="status">{published.result.warning}</div>
              )}

              <div style={st.actionRow}>
                <a
                  href={published.result.app.urls.page}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={st.btnPrimaryLink}
                >
                  Open app page ↗
                </a>
                <a
                  href={published.result.app.urls.run}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={st.btnLink}
                >
                  Play now ↗
                </a>
                <button
                  type="button"
                  style={st.btn}
                  onClick={async () => {
                    const ok = await copyToClipboard(origin + published.result.app.urls.page);
                    if (ok) {
                      setCopiedLink(true);
                      setTimeout(() => setCopiedLink(false), 1600);
                    }
                  }}
                >
                  {copiedLink ? 'Link copied ✓' : 'Copy link'}
                </button>
              </div>

              {published.result.editKey && (
                <div style={st.keyCard}>
                  <div style={st.keyHeader}>
                    <strong style={{ fontSize: 13 }}>Your edit key</strong>
                    <span style={st.mutedSmall}>
                      {published.result.keyKept === 'stored'
                        ? 'Saved in this browser for 1-click updates'
                        : 'Not saved in browser — copy this now'}
                    </span>
                  </div>
                  <div style={st.keyRow}>
                    <code style={st.keyCode}>{published.result.editKey}</code>
                    <button
                      type="button"
                      style={st.btnSmall}
                      onClick={async () => {
                        const ok = await copyToClipboard(published.result.editKey ?? '');
                        if (ok) {
                          setCopiedKey(true);
                          setTimeout(() => setCopiedKey(false), 1600);
                        }
                      }}
                    >
                      {copiedKey ? 'Copied ✓' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <form id="softn-direct-publish-form" onSubmit={(e) => void handleSubmit(e)}>
              {/* Bundle summary strip */}
              <div style={st.bundleCard}>
                {inspection?.iconDataUrl ? (
                  <img src={inspection.iconDataUrl} alt="" style={st.bundleIcon} />
                ) : (
                  <div style={st.bundleIconPlaceholder} aria-hidden="true">
                    {(name.trim().charAt(0) || 'S').toUpperCase()}
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={st.bundleTitle}>
                    {building ? 'Packaging .softn bundle…' : (bundle?.fileName ?? 'Project bundle')}
                  </div>
                  <div style={st.mutedSmall}>
                    {building
                      ? 'Checking manifest, files and permissions'
                      : buildError
                        ? 'Could not build bundle'
                        : inspection
                          ? `${formatBytes(bundle?.bytes.byteLength ?? 0)} · ${inspection.files} files${
                              inspection.backendRuntime ? ` · ${inspection.backendRuntime.toUpperCase()} backend` : ''
                            }${
                              inspection.capabilities.length === 0
                                ? ' · sandboxed'
                                : ` · asks for ${inspection.capabilities.join(', ')}`
                            }`
                          : ''}
                  </div>
                </div>
                {!building && !bundleBlocked && (
                  <span style={st.readyPill}>Ready</span>
                )}
              </div>

              {buildError && (
                <div style={st.errorBox} role="alert">{buildError}</div>
              )}
              {inspection?.problem && (
                <div style={st.errorBox} role="alert">{inspection.problem}</div>
              )}

              {categoriesError && (
                <div style={st.warnBox} role="alert">
                  <strong>Directory API unavailable here:</strong> {categoriesError}
                  {onOpenFullPublishPage && (
                    <>
                      {' '}
                      <button
                        type="button"
                        style={st.linkBtn}
                        onClick={() => {
                          onClose();
                          onOpenFullPublishPage();
                        }}
                      >
                        Open /publish page instead
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* Toggle: Publish new vs Push new version (only when user owns apps in this browser) */}
              {ownedSlugs.length > 0 && (
                <div style={st.modeBar} role="tablist" aria-label="Publish mode">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'new'}
                    style={mode === 'new' ? st.modeBtnActive : st.modeBtn}
                    onClick={() => setMode('new')}
                  >
                    Publish new app
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'update'}
                    style={mode === 'update' ? st.modeBtnActive : st.modeBtn}
                    onClick={() => {
                      setMode('update');
                      if (!targetSlug && ownedSlugs[0]) setTargetSlug(ownedSlugs[0]);
                    }}
                  >
                    Push new version
                  </button>
                </div>
              )}

              {mode === 'update' ? (
                <>
                  <label style={st.field}>
                    <span style={st.label}>App to update</span>
                    <select
                      value={targetSlug}
                      onChange={(e) => setTargetSlug(e.target.value)}
                      style={st.input}
                      required
                    >
                      {ownedSlugs.map((slug) => (
                        <option key={slug} value={slug}>
                          {slug}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={st.field}>
                    <span style={st.label}>What changed in this version? (optional)</span>
                    <input
                      type="text"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      maxLength={400}
                      placeholder="e.g. Fixed scoring bug, added dark mode"
                      style={st.input}
                    />
                  </label>
                  <p style={st.mutedSmall}>
                    Uses the edit key saved in this browser and keeps all previous versions in history.
                  </p>
                </>
              ) : (
                <>
                  <div style={st.row}>
                    <label style={{ ...st.field, flex: 1 }}>
                      <span style={st.label}>App name</span>
                      <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={64}
                        placeholder="What it is called"
                        required
                        style={st.input}
                      />
                    </label>
                    <label style={{ ...st.field, flex: 1 }}>
                      <span style={st.label}>Your name</span>
                      <input
                        type="text"
                        value={author}
                        onChange={(e) => setAuthor(e.target.value)}
                        maxLength={40}
                        placeholder="Anonymous"
                        style={st.input}
                      />
                    </label>
                  </div>

                  <label style={st.field}>
                    <span style={st.label}>Description</span>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      maxLength={600}
                      rows={2}
                      placeholder="One or two sentences about what it does"
                      style={st.textarea}
                    />
                  </label>

                  <div style={st.row}>
                    <label style={{ ...st.field, flex: 1 }}>
                      <span style={st.label}>Category</span>
                      <select
                        value={category}
                        onChange={(e) => {
                          setCategory(e.target.value);
                          setSubcategory('');
                        }}
                        disabled={loadingCats || categories.length === 0}
                        required
                        style={st.input}
                      >
                        <option value="" disabled>
                          {loadingCats ? 'Loading categories…' : 'Pick a category…'}
                        </option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.emoji} {c.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    {subcategories.length > 0 && (
                      <label style={{ ...st.field, flex: 1 }}>
                        <span style={st.label}>Subcategory</span>
                        <select
                          value={subcategory}
                          onChange={(e) => setSubcategory(e.target.value)}
                          style={st.input}
                        >
                          <option value="">General ({selectedCat?.name})</option>
                          {subcategories.map((sub) => (
                            <option key={sub.slug} value={sub.slug}>
                              {sub.emoji} {sub.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>

                  {categories.length > 0 && (
                    <div style={{ marginTop: -8, marginBottom: 12 }}>
                      <button
                        type="button"
                        style={st.linkBtn}
                        onClick={() => setSuggesting((s) => !s)}
                      >
                        {suggesting ? 'Cancel new category' : '+ Suggest a category or subcategory'}
                      </button>
                    </div>
                  )}

                  {suggesting && (
                    <div style={st.suggestBox}>
                      <div style={st.row}>
                        <label style={{ ...st.field, flex: 1, marginBottom: 8 }}>
                          <span style={st.label}>Name</span>
                          <input
                            type="text"
                            value={suggestName}
                            onChange={(e) => setSuggestName(e.target.value)}
                            maxLength={32}
                            placeholder="e.g. Racing or Finance"
                            style={st.input}
                          />
                        </label>
                        <label style={{ ...st.field, width: 84, marginBottom: 8 }}>
                          <span style={st.label}>Emoji</span>
                          <input
                            type="text"
                            value={suggestEmoji}
                            onChange={(e) => setSuggestEmoji(e.target.value)}
                            maxLength={4}
                            placeholder="🏎️"
                            style={st.input}
                          />
                        </label>
                      </div>
                      <label style={{ ...st.field, marginBottom: 8 }}>
                        <span style={st.label}>Short description</span>
                        <input
                          type="text"
                          value={suggestDesc}
                          onChange={(e) => setSuggestDesc(e.target.value)}
                          maxLength={120}
                          placeholder="What belongs here"
                          style={st.input}
                        />
                      </label>
                      {selectedCat && (
                        <label style={st.checkRow}>
                          <input
                            type="checkbox"
                            checked={suggestAsSub}
                            onChange={(e) => setSuggestAsSub(e.target.checked)}
                          />
                          <span>Create as a subcategory inside {selectedCat.emoji} {selectedCat.name}</span>
                        </label>
                      )}
                      {suggestError && <div style={st.errorBox}>{suggestError}</div>}
                      <button
                        type="button"
                        style={st.btnSmall}
                        disabled={suggestName.trim().length < 2}
                        onClick={() => void handleSuggest()}
                      >
                        Add category
                      </button>
                    </div>
                  )}

                  {hasBackend && allowPublicServerHosting && (
                    <div style={st.hostingBox}>
                      <label style={{ ...st.field, marginBottom: 6 }}>
                        <span style={st.label}>
                          Hosting mode ({inspection?.backendRuntime?.toUpperCase()} backend detected)
                        </span>
                        <select
                          value={hosting}
                          onChange={(e) => setHosting(e.target.value as HostingMode)}
                          style={st.input}
                        >
                          <option value="browser">Browser sandbox — runs 100% locally in visitor&rsquo;s browser</option>
                          <option value="hybrid">Hosted on SoftN (ZIPP safe-sandbox) + local browser option</option>
                          <option value="server">Hosted on SoftN server only (ZIPP safe-sandbox)</option>
                        </select>
                      </label>
                      {hosting === 'server' && (
                        <label style={st.checkRow}>
                          <input
                            type="checkbox"
                            checked={withholdBackend}
                            onChange={(e) => setWithholdBackend(e.target.checked)}
                          />
                          <span>Keep backend source server-side only (strip from client download)</span>
                        </label>
                      )}
                    </div>
                  )}

                  <details style={st.details}>
                    <summary style={st.summary}>Optional details (tags, custom screenshot, notes)</summary>
                    <div style={{ paddingTop: 10 }}>
                      <label style={st.field}>
                        <span style={st.label}>Tags (comma separated)</span>
                        <input
                          type="text"
                          value={tags}
                          onChange={(e) => setTags(e.target.value)}
                          placeholder="arcade, offline, productivity"
                          style={st.input}
                        />
                      </label>
                      <label style={st.field}>
                        <span style={st.label}>Custom screenshot</span>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          onChange={(e) => setThumbFile(e.target.files?.[0] ?? null)}
                          style={{ fontSize: 12, color: 'var(--dim, #8b94a2)' }}
                        />
                        <span style={st.mutedSmall}>
                          Leave blank and SoftN automatically captures a screenshot from your live app.
                        </span>
                        {thumbPreview && <img src={thumbPreview} alt="Thumbnail preview" style={st.thumbPreview} />}
                      </label>
                      <label style={st.field}>
                        <span style={st.label}>Version notes</span>
                        <input
                          type="text"
                          value={notes}
                          onChange={(e) => setNotes(e.target.value)}
                          maxLength={400}
                          placeholder="What to try first"
                          style={st.input}
                        />
                      </label>
                    </div>
                  </details>
                </>
              )}

              {submitError && (
                <div style={st.errorBox} role="alert">{submitError}</div>
              )}
            </form>
          )}
        </div>

        <div style={st.footer}>
          {published ? (
            <button type="button" style={st.btnPrimary} onClick={onClose}>
              Keep editing
            </button>
          ) : (
            <>
              {onOpenFullPublishPage && (
                <button
                  type="button"
                  style={{ ...st.linkBtn, marginRight: 'auto' }}
                  onClick={() => {
                    onClose();
                    onOpenFullPublishPage();
                  }}
                >
                  Open full /publish page ↗
                </button>
              )}
              <button type="button" style={st.btn} onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button
                type="submit"
                form="softn-direct-publish-form"
                style={st.btnPrimary}
                disabled={
                  building ||
                  submitting ||
                  bundleBlocked ||
                  !bundle ||
                  (mode === 'new' && (!name.trim() || !category)) ||
                  (mode === 'update' && !targetSlug)
                }
              >
                {submitting
                  ? 'Publishing…'
                  : mode === 'update'
                    ? 'Publish new version'
                    : 'Publish app'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const st: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 10000,
    background: 'rgba(10, 12, 16, 0.65)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  dialog: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--ink, #141820)',
    color: 'var(--paper, #f2f0ec)',
    border: '1px solid var(--line-strong, #333b47)',
    borderRadius: 14,
    boxShadow: 'var(--shadow, 0 20px 50px rgba(0, 0, 0, 0.45))',
    fontFamily: 'var(--body, system-ui, -apple-system, sans-serif)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    padding: '18px 22px 14px',
    borderBottom: '1px solid var(--line-soft, #1c212a)',
  },
  title: {
    margin: 0,
    fontFamily: 'var(--display, system-ui, sans-serif)',
    fontSize: 18,
    fontWeight: 700,
    letterSpacing: '-0.015em',
    color: 'var(--paper, #f2f0ec)',
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: 12.5,
    color: 'var(--dim, #8b94a2)',
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--dim, #8b94a2)',
    fontSize: 16,
    cursor: 'pointer',
    padding: '4px 8px',
    borderRadius: 6,
  },
  body: {
    padding: '18px 22px',
    overflowY: 'auto',
    flex: 1,
    minHeight: 0,
  },
  bundleCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--line, #262c36)',
    background: 'var(--inset, rgba(255, 255, 255, 0.04))',
    marginBottom: 14,
  },
  bundleIcon: {
    width: 38,
    height: 38,
    borderRadius: 9,
    objectFit: 'cover',
    flexShrink: 0,
  },
  bundleIconPlaceholder: {
    width: 38,
    height: 38,
    borderRadius: 9,
    background: 'var(--mint-glow, rgba(53, 224, 192, 0.14))',
    border: '1px solid var(--mint-edge, rgba(53, 224, 192, 0.35))',
    color: 'var(--paper, #f2f0ec)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize: 16,
    flexShrink: 0,
  },
  bundleTitle: {
    fontSize: 13.5,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  readyPill: {
    fontSize: 11,
    fontWeight: 600,
    padding: '3px 9px',
    borderRadius: 999,
    background: 'var(--mint-glow, rgba(53, 224, 192, 0.16))',
    border: '1px solid var(--mint-edge, rgba(53, 224, 192, 0.4))',
    color: 'var(--paper, #f2f0ec)',
    flexShrink: 0,
  },
  modeBar: {
    display: 'flex',
    gap: 6,
    padding: 4,
    borderRadius: 9,
    border: '1px solid var(--line, #262c36)',
    background: 'var(--inset, rgba(255, 255, 255, 0.03))',
    marginBottom: 14,
  },
  modeBtn: {
    flex: 1,
    padding: '7px 10px',
    borderRadius: 6,
    border: 'none',
    background: 'transparent',
    color: 'var(--dim, #8b94a2)',
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
  },
  modeBtnActive: {
    flex: 1,
    padding: '7px 10px',
    borderRadius: 6,
    border: '1px solid var(--line-strong, #333b47)',
    background: 'var(--ink, #141820)',
    color: 'var(--paper, #f2f0ec)',
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
  },
  row: {
    display: 'flex',
    gap: 12,
    flexWrap: 'wrap',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    marginBottom: 12,
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--dim, #8b94a2)',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid var(--line-strong, #333b47)',
    background: 'var(--inset, rgba(255, 255, 255, 0.04))',
    color: 'var(--paper, #f2f0ec)',
    fontSize: 13.5,
    fontFamily: 'inherit',
  },
  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid var(--line-strong, #333b47)',
    background: 'var(--inset, rgba(255, 255, 255, 0.04))',
    color: 'var(--paper, #f2f0ec)',
    fontSize: 13.5,
    fontFamily: 'inherit',
    resize: 'vertical',
  },
  suggestBox: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--line, #262c36)',
    background: 'var(--inset, rgba(255, 255, 255, 0.03))',
    marginBottom: 12,
  },
  hostingBox: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--line, #262c36)',
    background: 'var(--inset, rgba(255, 255, 255, 0.03))',
    marginBottom: 12,
  },
  checkRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12.5,
    color: 'var(--paper, #f2f0ec)',
    marginBottom: 8,
    cursor: 'pointer',
  },
  details: {
    borderTop: '1px solid var(--line-soft, #1c212a)',
    paddingTop: 10,
    marginTop: 4,
  },
  summary: {
    fontSize: 12.5,
    fontWeight: 600,
    color: 'var(--dim, #8b94a2)',
    cursor: 'pointer',
    userSelect: 'none',
  },
  thumbPreview: {
    marginTop: 8,
    maxWidth: 200,
    maxHeight: 125,
    borderRadius: 8,
    border: '1px solid var(--line, #262c36)',
    objectFit: 'cover',
  },
  mutedSmall: {
    fontSize: 12,
    color: 'var(--dim, #8b94a2)',
    lineHeight: 1.4,
  },
  errorBox: {
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--danger, #ff6b6b)',
    background: 'rgba(255, 107, 107, 0.1)',
    color: 'var(--paper, #f2f0ec)',
    fontSize: 13,
    lineHeight: 1.45,
    marginBottom: 12,
  },
  warnBox: {
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--warn, #e8a33d)',
    background: 'rgba(232, 163, 61, 0.1)',
    color: 'var(--paper, #f2f0ec)',
    fontSize: 12.5,
    lineHeight: 1.45,
    marginBottom: 12,
  },
  linkBtn: {
    background: 'none',
    border: 'none',
    padding: 0,
    color: 'var(--mint, #35e0c0)',
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
    textDecoration: 'underline',
  },
  link: {
    color: 'var(--mint, #35e0c0)',
    textDecoration: 'underline',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
    padding: '12px 22px',
    borderTop: '1px solid var(--line-soft, #1c212a)',
  },
  btn: {
    padding: '8px 14px',
    borderRadius: 8,
    border: '1px solid var(--line-strong, #333b47)',
    background: 'transparent',
    color: 'var(--paper, #f2f0ec)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnSmall: {
    padding: '6px 12px',
    borderRadius: 7,
    border: '1px solid var(--line-strong, #333b47)',
    background: 'transparent',
    color: 'var(--paper, #f2f0ec)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnPrimary: {
    padding: '8px 16px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--paper, #f2f0ec)',
    color: 'var(--ink, #101317)',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
  },
  btnPrimaryLink: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '8px 16px',
    borderRadius: 8,
    background: 'var(--paper, #f2f0ec)',
    color: 'var(--ink, #101317)',
    fontSize: 13,
    fontWeight: 700,
    textDecoration: 'none',
  },
  btnLink: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '8px 14px',
    borderRadius: 8,
    border: '1px solid var(--line-strong, #333b47)',
    color: 'var(--paper, #f2f0ec)',
    fontSize: 13,
    fontWeight: 600,
    textDecoration: 'none',
  },
  successWrap: {
    textAlign: 'center',
    padding: '8px 0',
  },
  successBadge: {
    width: 48,
    height: 48,
    margin: '0 auto 12px',
    borderRadius: '50%',
    background: 'var(--mint-glow, rgba(53, 224, 192, 0.18))',
    border: '1px solid var(--mint-edge, rgba(53, 224, 192, 0.45))',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 22,
    fontWeight: 700,
  },
  successHeading: {
    margin: '0 0 6px',
    fontSize: 20,
    fontFamily: 'var(--display, system-ui, sans-serif)',
  },
  successSub: {
    margin: '0 0 18px',
    fontSize: 13,
    color: 'var(--dim, #8b94a2)',
    wordBreak: 'break-all',
  },
  actionRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center',
    marginBottom: 18,
  },
  keyCard: {
    textAlign: 'left',
    padding: '12px 14px',
    borderRadius: 10,
    border: '1px solid var(--line, #262c36)',
    background: 'var(--inset, rgba(255, 255, 255, 0.04))',
  },
  keyHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 8,
  },
  keyRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  keyCode: {
    flex: 1,
    minWidth: 0,
    fontFamily: 'var(--mono, monospace)',
    fontSize: 12,
    padding: '6px 8px',
    borderRadius: 6,
    background: 'var(--ink, #101317)',
    border: '1px solid var(--line-soft, #1c212a)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
};
