/**
 * The form controls beyond a button and a text field: selects, checkboxes,
 * switches, radios, sliders, file choosers, number inputs, ratings,
 * segmented controls, button groups and copy buttons. Fetched the first time
 * a page draws one; the date and colour pickers are a group of their own.
 */
export * from '../form/Select';
export * from '../form/Checkbox';
export * from '../form/Switch';
export * from '../form/Radio';
export * from '../form/Slider';
export * from '../form/FileChooser';
export * from '../form/NumberInput';
export * from '../form/Rating';
export * from '../form/SegmentedControl';
export * from '../form/ButtonGroup';
export * from '../form/CopyButton';

import { Select } from '../form/Select';
import { Checkbox } from '../form/Checkbox';
import { Switch } from '../form/Switch';
import { Radio } from '../form/Radio';
import { Slider } from '../form/Slider';
import { FileChooser } from '../form/FileChooser';
import { NumberInput } from '../form/NumberInput';
import { Rating } from '../form/Rating';
import { SegmentedControl } from '../form/SegmentedControl';
import { ButtonGroup } from '../form/ButtonGroup';
import { CopyButton } from '../form/CopyButton';

export const controlComponents = {
  Select,
  Checkbox,
  Switch,
  Radio,
  Slider,
  FileChooser,
  NumberInput,
  Rating,
  SegmentedControl,
  ButtonGroup,
  CopyButton,
};
