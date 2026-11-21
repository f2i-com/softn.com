import React, { useCallback } from 'react';
import { PublishModal, type EditorBundleBuild } from '@softn/editor-shared/PublishModal';
import { useProjectStore } from '../../stores/projectStore';
import { toast } from '../../stores/notificationStore';
import { buildProjectBundle, bundleFileName } from '../../utils/buildProjectBundle';

export function BuilderPublishDialog({
  isOpen,
  onClose,
  onFallbackHandoff,
}: {
  isOpen: boolean;
  onClose: () => void;
  onFallbackHandoff?: () => void;
}): React.ReactElement | null {
  const { name, description } = useProjectStore();

  const buildBuilderBundle = useCallback(async (): Promise<EditorBundleBuild> => {
    const bytes = await buildProjectBundle();
    const currentName = useProjectStore.getState().name;
    return { bytes, fileName: bundleFileName(currentName) };
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
      onOpenFullPublishPage={onFallbackHandoff}
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
