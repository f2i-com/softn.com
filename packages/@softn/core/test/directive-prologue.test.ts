/**
 * The runtime reads an app's `"use strict"` itself (runtime/directive-prologue.ts),
 * since the engine is handed SoftN's bridges first and would read it as an
 * ordinary string. Held here to the language's rule, by cases and by acorn's
 * reading of a few thousand prologues made at random (seeded, so a failure
 * names one that can be run again).
 */
import * as acorn from 'acorn';
import { describe, expect, it } from 'vitest';
import { prologueIsStrict } from '../src/runtime/directive-prologue';

/** Whether acorn reads `code`'s prologue as strict; null when acorn cannot read the script at all. */
function acornStrict(code: string): boolean | null {
  let program: acorn.Program;
  try {
    program = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
  } catch {
    return null;
  }
  let strict = false;
  for (const statement of program.body) {
    if (statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string') break;
    if (statement.directive === 'use strict') strict = true;
  }
  return strict;
}

describe('an app asks for strict mode', () => {
  it.each([
    '"use strict";\nvar a = 1;',
    "'use strict'\nvar a = 1;",
    '"use strict"',
    '  \n\t"use strict";',
    '// The app.\n/* More\n about it. */\n"use strict";',
    '\ufeff"use strict";',
    '#!/usr/bin/env softn\n"use strict";',
    '"a directive of its own";\n"use strict";\nvar a;',
    '"other"\n"use strict"\nvar a;',
    '"use strict"\n++count;',
    '"use strict"\n--count;',
    '"use strict"\n.5;',
    '"use strict"\n!ready && go();',
    '"use strict"\n{ var a; }',
    '"use strict" // a comment\nvar a;',
    '"use strict" /* a comment */; var a;',
    '<!-- an HTML comment\n"use strict";',
    '"use strict"\n--> an HTML comment\nvar a;',
  ])('%j', (code) => {
    expect(prologueIsStrict(code)).toBe(true);
    expect(acornStrict(code)).toBe(true);
  });
});

describe('an app does not', () => {
  it.each([
    'var a = 1;\n"use strict";',
    '"use strict" + suffix;',
    '"use strict"\n+ suffix;',
    '"use strict"\n.length;',
    '"use strict"\n(0);',
    '"use strict"\n[0];',
    '"use strict"\n`tagged`;',
    '"use strict"\n!= other;',
    '"use strict"\nin object;',
    '"use strict"\ninstanceof Thing;',
    '"use strict"\n/ 2;',
    '"use\\x20strict";',
    '"use\\u0020strict";',
    '"Use strict";',
    '"use strict ";',
    '`use strict`;',
    '("use strict");',
    'function f() { "use strict"; }',
    '"use strict" /* a comment */ + suffix;',
    '',
    '// "use strict";',
  ])('%j', (code) => {
    expect(prologueIsStrict(code)).toBe(false);
    const acornSays = acornStrict(code);
    if (acornSays !== null) expect(acornSays).toBe(false);
  });
});

describe('the reader and acorn', () => {
  it('agree on prologues made at random', () => {
    const strings = ['"use strict"', "'use strict'", '"use\\x20strict"', '"other"', "'use strict '", '"x\\"y"', "'a\\\\'"];
    const between = [';', ';\n', '\n', '\r\n', ' ', ' ;', '\u2028', ' // c\n', ' /* c */', '/*\n*/', '\n\n', '', '\t;'];
    const after = ['', '', '', '+ 1;', '.length;', '\n.length;', '\n(0);', '\n[0];', '\n++x;', '\n--x;', '\n.5;', '\nin o;', '\n!x;', '\n!= 1;', '\n`t`;', '\n-1;', '\n/ 2;', '\n--> c\n'];
    const tails = ['', 'var x = 1;', 'x = 2;', 'function f() {}', '"late";', '{ }'];
    const leads = ['', '', '// head\n', '/* head */', '\ufeff', '#!/bin/x\n', '\n  '];
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)];
    let compared = 0;
    for (let n = 0; n < 4000; n++) {
      let code = pick(leads);
      const count = 1 + Math.floor(random() * 3);
      for (let i = 0; i < count; i++) code += pick(strings) + pick(between) + (i === count - 1 ? pick(after) : '');
      code += pick(tails);
      const expected = acornStrict(code);
      if (expected === null) continue;
      compared++;
      expect(prologueIsStrict(code), JSON.stringify(code)).toBe(expected);
    }
    expect(compared).toBeGreaterThan(2000);
  });
});
