import React, { useCallback } from 'react';
import { PublishModal, type EditorBundleBuild } from '@softn/editor-shared/PublishModal';
import { useProjectStore } from '../../stores/projectStore';
import { toast } from '../../stores/notificationStore';
import { buildProjectBundle, bundleFileName } from '../../utils/buildProjectBundle';
import { prepareHandoff } from '../../utils/handoff';

export function BuilderPublishDialog({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}): React.ReactElement | null {
  const { name, description } = useProjectStore();

  const buildBuilderBundle = useCallback(async (): Promise<EditorBundleBuild> => {
    const bytes = await buildProjectBundle();
    const currentName = useProjectStore.getState().name;
    return { bytes, fileName: bundleFileName(currentName) };
  }, []);

  const fallbackFullPage = useCallback(() => {
    void buildProjectBundle()
      .then((bytes) => prepareHandoff('publish', bytes, useProjectStore.getState().name || 'My App'))
      .then((outcome) => {
        if (outcome.ok) {
          window.open(outcome.ready.url, '_blank', 'noopener,noreferrer');
        } else {
          toast.error(outcome.message);
        }
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : 'Could not prepare the bundle for publishing.');
      });
  }, []);

  const projectSlugKey = name ? `builder:${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : undefined;

  return (
    <PublishModal
      isOpen={isOpen}
      onClose={onClose}
      projectKey={projectSlugKey}
      projectName={name || 'My App'}
      projectDescription={description || ''}
      buildBundle={buildBuilderBundle}
      onOpenFullPublishPage={fallbackFullPage}
      onPublished={(app, isUpdate) => {
        toast.success(
          isUpdate
            ? `Published ${app.name} v${app.version} to SoftN.`
            : `Published ${app.name} to SoftN!`,
        );
      }}
    />
  );
}
