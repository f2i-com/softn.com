import { useEffect, useState, useMemo } from 'react';
import { createEphemeralXDBScope, SoftNWithXDB, type SoftNWithXDBProps, type XDBRecord } from '@softn/core';
import type { CollectionDef, AssetFile } from '../../types/builder';
import { createPreviewAssets } from '../../utils/previewBundle';

/** A private copy: exercising the preview must never mutate the export seeds. */
export function previewRecordsFor(collections: CollectionDef[]): Record<string, XDBRecord[]> {
  const now = new Date().toISOString();
  return Object.fromEntries(collections.map((collection) => [collection.name,
    JSON.parse(JSON.stringify(collection.fullRecords ?? (collection.seedData || []).map((data, index) => ({
      id: `preview_${collection.name}_${index}`, collection: collection.name,
      data, created_at: now, updated_at: now,
    })))).map((record: XDBRecord) => ({ ...record, collection: collection.name, deleted: record.deleted === true })),
  ]));
}

export interface PreviewRuntimeProps extends SoftNWithXDBProps {
  projectId: string;
  records: Record<string, XDBRecord[]>;
  assets?: ReadonlyMap<string, AssetFile>;
}

const EMPTY_ASSETS = new Map<string, AssetFile>();

/** Seed before script initialization, with no localStorage or native database writes. */
export function PreviewRuntime({ projectId, records, assets = EMPTY_ASSETS, ...props }: PreviewRuntimeProps) {
  const [assetSession, setAssetSession] = useState<{ assets: typeof assets; resolver: ReturnType<typeof createPreviewAssets> } | null>(null);
  useEffect(() => {
    const resolver = createPreviewAssets(assets);
    setAssetSession({ assets, resolver });
    return () => resolver.dispose?.();
  }, [assets]);
  const [session, setSession] = useState<{
    projectId: string; records: typeof records; scope: ReturnType<typeof createEphemeralXDBScope>;
  } | null>(null);

  useEffect(() => {
    const scope = createEphemeralXDBScope();
    scope.xdb.import({ version: 1, exportedAt: new Date().toISOString(), collections: records }, { merge: false });
    setSession({ projectId, records, scope });
    return () => scope.dispose();
  }, [projectId, records]);
  const functions = useMemo(() => ({ ...props.functions,
    asset: (...args: unknown[]) => assetSession?.resolver(String(args[0] ?? '')) ?? '',
  }), [props.functions, assetSession]);

  // Do not let an old script observe the next project's seed records during an effect transition.
  if (!session || session.projectId !== projectId || session.records !== records || assetSession?.assets !== assets) return <>{props.loading}</>;
  return <SoftNWithXDB {...props} key={session.scope.appId} appId={session.scope.appId}
    assetResolver={assetSession.resolver}
    functions={functions}
    xdb={session.scope.xdb} resumeSavedSyncRoom={false} />;
}
