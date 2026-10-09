/** Typings for the style state audit, for the test that holds src/ to it. */

export declare const packageRoot: string;

export interface StateSpreadConflict {
  /** Package-relative source file */
  file: string;
  line: number;
  /** The longhand a state sets and takes away again */
  longhand: string;
  /** The shorthand the base set, which loses that part when the state ends */
  shorthand: string;
  /** The spread as written */
  text: string;
}

/** Every element under `srcDir` whose style spreads a state over a base, where the state sets a longhand of a shorthand the base has. */
export declare function findStateSpreadConflicts(srcDir?: string): StateSpreadConflict[];
