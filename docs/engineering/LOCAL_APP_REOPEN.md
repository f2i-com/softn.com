# Reopening local apps

Apps imported into the runtime are cached in IndexedDB. On an app-name route, entries without a directory slug now reopen directly from those local bytes; they do not request an app with the same display name from the public directory. Published entries continue to refresh from the API and retain the existing offline-cache fallback.

The production distribution has no demo catalogue, so production routes no longer request `web/demos/index.json`. Development retains its catalogue lookup.

Validation: 18 focused local-reopen and remote-bundle tests pass, and the web production build passes. A generic local bundle was imported and reopened by its app-name URL in a separate production-preview tab without an API server. It rendered successfully with an empty warning/error log.

Local cache remains scoped to the browser and site origin. A link opened in another browser, or after site data is cleared, cannot restore bytes that are no longer present; import the original bundle again in that case. No app upload is required for local use.
