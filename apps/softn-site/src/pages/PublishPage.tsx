import React, { useState } from 'react';
import type { Category } from '../lib/api';
import type { Route } from '../lib/router';
import { NewAppPage } from '../components/publish/NewAppPage';
import { UpdatePage } from '../components/publish/UpdatePage';
import type { CategoriesStatus } from '../components/publish/shared';

// The pieces of the publish page live in components/publish/; these are the
// ones other modules and the tests reach through this page, as before.
export { KeyBackupDownload, KeyImport, ReplaceKey, type ReplacedKey } from '../components/publish/keys';
export { YourApps, lookupOwnedApps, type OwnedApp } from '../components/publish/YourApps';

/**
 * /publish: the form for a new app, or with `?update=<slug>` the page that
 * changes one with its edit key.
 */
export function PublishPage({ route, categories, onCategories, categoriesError, onRetryCategories }: { route: Route; categories: Category[]; onCategories: (c: Category[]) => void } & CategoriesStatus): React.ReactElement {
  const updateOf = route.query.get('update') ?? '';
  // "Publish another" starts a new form: a fresh mount, so nothing of the
  // last one — its file, its fields, the app it remixed — is carried over.
  const [form, setForm] = useState(0);
  if (updateOf) return <UpdatePage slug={updateOf} categories={categories} categoriesError={categoriesError} onRetryCategories={onRetryCategories} />;
  return (
    <NewAppPage
      key={form}
      route={route}
      categories={categories}
      onCategories={onCategories}
      onPublishAnother={() => setForm((n) => n + 1)}
      categoriesError={categoriesError}
      onRetryCategories={onRetryCategories}
    />
  );
}
