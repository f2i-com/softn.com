/** Typings for the manifest generator, for the test that checks the committed manifest. */

export interface ManifestType {
  kind: 'boolean' | 'number' | 'string' | 'function' | 'enum' | 'node' | 'array' | 'other' | 'unknown';
  /** An enum's values. */
  options?: string[];
  /** For `other`: the string literals it names beside the other types it takes (`'sm' | 'md' | string`). */
  literals?: string[];
  text?: string;
}

export interface ManifestProp {
  name: string;
  optional: boolean;
  type: ManifestType;
  /** The literal the component gives the prop when a page writes nothing. */
  default?: unknown;
  /** The component gives it a default this generator cannot read. Neither field: it has none. */
  defaultUnknown?: boolean;
  doc?: string;
}

export interface ManifestComponent {
  name: string;
  source: string;
  doc?: string;
  props: { interface: string; members: ManifestProp[]; extends?: string[] } | null;
}

export interface ComponentManifest {
  components: ManifestComponent[];
  /** Registry entry file -> the component names it registers. */
  registered: Record<string, string[]>;
  [extra: string]: unknown;
}

export declare const packageRoot: string;
export declare const manifestPath: string;
export declare const propKindsPath: string;
export declare function describeType(type: unknown, source: unknown, aliases?: Map<string, unknown>): ManifestType;
export declare function buildManifest(): ComponentManifest;
export declare function renderManifest(manifest?: ComponentManifest): string;
export declare function renderPropKinds(manifest?: ComponentManifest): string;
