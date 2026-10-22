/**
 * Every component the runtimes register outside the heavier features, all
 * of them at once: the start-up set (essentials.ts) and the five groups the
 * runtimes fetch on demand (controls, feedback, data, display, navigation).
 * For a host that wants them drawn with no wait at all, as the Builder's
 * canvas does, and for code that imported them from here before they were
 * split: every export this entry had, it still has.
 *
 * A host that wants a component directly imports it from here, from
 * essentials or from the entry that owns it, never from the root barrel: the
 * barrel is the eager path and drags every feature into whichever chunk
 * imports it.
 */

import type { ComponentRegistry, SoftNComponent } from '@softn/core';
import { getDefaultRegistry } from '@softn/core';
import { declareBuiltinPropKinds } from '../prop-kinds';

export * from '../layout';
// The form controls but the pickers, which are an entry of their own.
export * from '../form/Button';
export * from '../form/Input';
export * from '../form/Form';
export * from '../form/TextArea';
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
export * from '../form/Field';
export * from '../form/CopyButton';
export * from '../display';
export * from '../feedback';
export * from '../navigation';
export * from '../data';
export * from '../utility/Accordion';
export * from '../utility/Collapse';
export * from '../utility/Tooltip';
export * from '../utility/Loop';

import { essentialComponents } from './essentials';
import { controlComponents } from './controls';
import { feedbackComponents } from './feedback';
import { dataComponents } from './data';
import { displayComponents } from './display';
import { navigationComponents } from './navigation';

/**
 * The minimal set, by registry name: the six entries' records together. The
 * keys are the tag names a document uses; the same names appear in
 * registry.ts's eager `builtinComponents`.
 */
export const minimalComponents = {
  ...essentialComponents,
  ...controlComponents,
  ...feedbackComponents,
  ...dataComponents,
  ...displayComponents,
  ...navigationComponents,
};

/**
 * Register the minimal set eagerly, every component above at once. The
 * runtimes use registerRuntimeComponents() (lazy.ts) instead, which registers
 * the start-up set eagerly and everything else by loader.
 */
export function registerMinimalComponents(
  registry: ComponentRegistry = getDefaultRegistry()
): void {
  registry.registerAll(minimalComponents as unknown as Record<string, SoftNComponent>);
  declareBuiltinPropKinds(registry);
}
