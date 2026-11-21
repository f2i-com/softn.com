import React, { useCallback, useMemo } from 'react';
import { PublishModal, type EditorBundleBuild } from '@softn/editor-shared/PublishModal';
import { useVFSStore, useWorkspaceStore } from '../../stores';
import { buildBundle } from '../../lib/exportBundle';

function readManifestDescription(files: Map<string, { content: string | Uint8Array }>): string {
  const mf = files.get('manifest.json');
  if (!mf) return '';
  try {
    const text = typeof mf.content === 'string' ? mf.content : new TextDecoder().decode(mf.content);
    const parsed = JSON.parse(text) as { description?: unknown };
    return typeof parsed.description === 'string' ? parsed.description : '';
  } catch {
    return '';
  }
}

export function StudioPublishDialog({
  isOpen,
  onClose,
  onFallbackHandoff,
}: {
  isOpen: boolean;
  onClose: () => void;
  onFallbackHandoff?: () => void;
}): React.ReactElement | null {
  const { projectId, projectName } = useWorkspaceStore();
  const files = useVFSStore((s) => s.files);

  const description = useMemo(() => (isOpen ? readManifestDescription(files) : ''), [isOpen, files]);

  const buildStudioBundle = useCallback((): EditorBundleBuild => {
    const currentFiles = useVFSStore.getState().files;
    const currentName = useWorkspaceStore.getState().projectName;
    const bytes = buildBundle(currentFiles);
    const safeName = (currentName || 'app').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
    return { bytes, fileName: `${safeName}.softn` };
  }, []);

  return (
    <PublishModal
      isOpen={isOpen}
      onClose={onClose}
      projectKey={projectId ? `studio:${projectId}` : undefined}
      projectName={projectName || 'Untitled app'}
      projectDescription={description}
      buildBundle={buildStudioBundle}
      onOpenFullPublishPage={onFallbackHandoff}
      onPublished={(app, isUpdate) => {
        useWorkspaceStore
          .getState()
          .addConsoleOutput(
            isUpdate
              ? `Published ${app.name} v${app.version} to SoftN directory (${app.urls.page}).`
              : `Published ${app.name} to SoftN directory (${app.urls.page}).`,
          );
      }}
    />
  );
}
