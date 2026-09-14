/** Typings for the manifest generator, for the test that checks the committed manifest. */

export interface ManifestProp {
  name: string;
  required: boolean;
  type: string;
  options?: string[];
  doc?: string;
  [extra: string]: unknown;
}

export interface ManifestComponent {
  name: string;
  props: ManifestProp[] | null;
  [extra: string]: unknown;
}

export interface ComponentManifest {
  components: ManifestComponent[];
  /** Registry entry file -> the component names it registers. */
  registered: Record<string, string[]>;
  [extra: string]: unknown;
}

export declare const packageRoot: string;
export declare const manifestPath: string;
export declare function describeType(type: unknown, source: unknown): unknown;
export declare function buildManifest(): ComponentManifest;
export declare function renderManifest(manifest?: ComponentManifest): string;
