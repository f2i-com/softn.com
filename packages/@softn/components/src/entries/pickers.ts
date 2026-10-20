/**
 * The date and colour pickers. About 15 KB minified together, for the forms
 * that ask for a date or a colour; every other form control is in the
 * minimal set.
 */
export * from '../form/DatePicker';
export * from '../form/ColorPicker';

import { DatePicker } from '../form/DatePicker';
import { ColorPicker } from '../form/ColorPicker';

export const pickerComponents = { DatePicker, ColorPicker };
