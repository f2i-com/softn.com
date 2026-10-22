/**
 * The date and colour pickers. About 15 KB minified together, for the forms
 * that ask for a date or a colour; the commonest form controls are in the
 * start-up set (essentials.ts) and the rest in the controls group.
 */
export * from '../form/DatePicker';
export * from '../form/ColorPicker';

import { DatePicker } from '../form/DatePicker';
import { ColorPicker } from '../form/ColorPicker';

export const pickerComponents = { DatePicker, ColorPicker };
