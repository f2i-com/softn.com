export type PlainProp = 's' | 'n' | 'b' | string[];

/** Each registered component's plain props, by name, from a parsed component manifest. */
export function plainProps(manifest: unknown): Record<string, Record<string, PlainProp>>;

/** The generated file's text for `components`. */
export function render(components: Record<string, Record<string, PlainProp>>): string;
