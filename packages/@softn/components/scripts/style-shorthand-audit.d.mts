/** Typings for the style shorthand audit, for the test that holds src/ to it. */

export declare const packageRoot: string;

export interface ShorthandConflict {
  /** Package-relative source file */
  file: string;
  line: number;
  /** The longhand that may be written empty */
  longhand: string;
  /** The shorthand before it in the same object, which it would clear */
  shorthand: string;
  /** The property as written */
  text: string;
}

/** Every style object under `srcDir` in which a longhand that may be empty follows its shorthand. */
export declare function findShorthandConflicts(srcDir?: string): ShorthandConflict[];
