/**
 * Builder wrapper around the shared `@softn/editor-shared/SqliteDatabaseAdmin`.
 */

import React, { useMemo } from 'react';
import { hostedContainerOptions } from '@softn/runtime-shell/containerHost';
import {
  SqliteDatabaseAdmin as SharedSqliteDatabaseAdmin,
  type SqliteDatabaseAdminHost,
} from '@softn/editor-shared/SqliteDatabaseAdmin';
import { useProjectStore } from '../../stores/projectStore';
import { useFilesStore } from '../../stores/filesStore';
import { toast } from '../../stores/notificationStore';
import { askConfirm } from '../../utils/confirm';
import {
  createProjectSqliteDatabase,
  detectProjectSqliteDatabases,
  persistSqliteBytesToProject,
  readProjectSqliteTextFile,
} from '../../utils/sqliteDatabase';

export interface SqliteDatabaseAdminProps {
  /** Optional header toggle slot (e.g. switch between SQLite and XDB Collections). */
  modeSwitch?: React.ReactNode;
}

export function SqliteDatabaseAdmin({ modeSwitch }: SqliteDatabaseAdminProps) {
  const source = useProjectStore((state) => state.source);
  const projectId = useProjectStore((state) => state.projectId);
  const logicFiles = useFilesStore((state) => state.logicFiles);
  const assetFiles = useFilesStore((state) => state.assetFiles);

  const databases = useMemo(
    () => detectProjectSqliteDatabases(source, logicFiles, assetFiles),
    [source, logicFiles, assetFiles]
  );

  const host = useMemo<SqliteDatabaseAdminHost>(
    () => ({
      projectId,
      databases,
      runtimeUrl: hostedContainerOptions().runtimeUrl,
      readTextFile: (path) =>
        readProjectSqliteTextFile(
          path,
          useFilesStore.getState().logicFiles,
          useProjectStore.getState().source.extraEntries
        ),
      persistBytes: (db, bytes) => {
        persistSqliteBytesToProject(db, bytes);
      },
      createDatabase: (rawName, opts) => createProjectSqliteDatabase(rawName, opts),
      notify: {
        success: (msg) => toast.success(msg),
        info: (msg) => toast.info(msg),
        error: (msg) => toast.error(msg),
      },
      confirm: (message, opts) => askConfirm(message, opts),
    }),
    [projectId, databases]
  );

  return <SharedSqliteDatabaseAdmin host={host} modeSwitch={modeSwitch} />;
}
