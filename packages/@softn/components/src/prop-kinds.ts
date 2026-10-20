/**
 * What the built-in components declare their props to be, for the registry
 * (ComponentRegistry.setPropKinds in @softn/core): the renderer gives a
 * number prop the number a page wrote as text (`<Progress value="40">`), and
 * a boolean prop the yes or no a number means (`required={0}`). Read from
 * prop-kinds.generated.ts, which the manifest generator writes from the
 * components' own props interfaces, so it cannot fall behind them.
 */

import type { ComponentRegistry, DeclaredPropKinds } from '@softn/core';
import { WRITTEN_PROP_KINDS } from './prop-kinds.generated';

let read: Record<string, DeclaredPropKinds> | null = null;

/** WRITTEN_PROP_KINDS read once: `Name:numbers:booleans` entries, a choice of numbers as `name=2|3|4`. */
export function builtinPropKinds(): Readonly<Record<string, DeclaredPropKinds>> {
  if (read) return read;
  read = {};
  for (const entry of WRITTEN_PROP_KINDS.split(';')) {
    const [name, numbers, booleans] = entry.split(':');
    const declared = { numbers: [] as string[], choices: {} as Record<string, number[]>, booleans: booleans ? booleans.split(',') : [] };
    for (const number of numbers ? numbers.split(',') : []) {
      const [prop, choices] = number.split('=');
      if (choices) declared.choices[prop] = choices.split('|').map(Number);
      else declared.numbers.push(prop);
    }
    read[name] = declared;
  }
  return read;
}

/** Give `registry` what the built-ins it now holds declare their props to be. */
export function declareBuiltinPropKinds(registry: ComponentRegistry): void {
  registry.setPropKinds(builtinPropKinds());
}
