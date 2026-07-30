/// <reference types="vite/client" />

// Merged into Vite's own ImportMetaEnv so the app-URL overrides are typed
// rather than falling through its `[key: string]: any` index signature.
interface ImportMetaEnv {
  readonly VITE_WEB_URL?: string;
  readonly VITE_BUILDER_URL?: string;
  readonly VITE_STUDIO_URL?: string;
}
