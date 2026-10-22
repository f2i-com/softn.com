// The host's reading of a logic file's `"use strict"` (runtime/directive-prologue.mjs)
// is a copy of the browser runtime's, which its own tests hold to acorn's.
// This holds the copy to that one, case by case and on prologues made at
// random (seeded, so a failure names one that can be run again). Node reads
// the TypeScript file directly: it has only erasable types and no imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,resolve} from 'node:path';
import * as copy from '../runtime/directive-prologue.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const core=await import(pathToFileURL(resolve(here,'../../../packages/@softn/core/src/runtime/directive-prologue.ts')));

test('the copy puts the same directive first',()=>{
  assert.equal(copy.STRICT_DIRECTIVE,core.STRICT_DIRECTIVE);
});

test('the copy reads a prologue as the browser runtime does',()=>{
  const named=['"use strict";','\'use strict\'\nx','// c\n"use strict"','\ufeff"use strict"','#!/x\n"use strict"','"a"\n"use strict"','"use strict"\n++x','"use strict"\n.5','"use strict"\n.length','"use strict" + x','var a;\n"use strict"','"use\\x20strict"','<!-- c\n"use strict"','"use strict"\n--> c\nx','"use strict"\nin o','"use strict"\ninstanceof T','"use strict"\n!x','"use strict"\n!= x',''];
  for(const code of named)assert.equal(copy.prologueIsStrict(code),core.prologueIsStrict(code),JSON.stringify(code));
  const strings=['"use strict"',"'use strict'",'"use\\x20strict"','"other"',"'use strict '",'"x\\"y"',"'a\\\\'",'"unterminated'];
  const between=[';',';\n','\n','\r\n',' ',' ;','\u2028',' // c\n',' /* c */','/*\n*/','\n\n','','\t;'];
  const after=['','','','+ 1;','.length;','\n.length;','\n(0);','\n[0];','\n++x;','\n--x;','\n.5;','\nin o;','\ninstanceof T;','\n!x;','\n!= 1;','\n`t`;','\n-1;','\n/ 2;','\n--> c\n','\n<!-- c\n'];
  const tails=['','var x = 1;','x = 2;','function f() {}','"late";','{ }'];
  const leads=['','','// head\n','/* head */','\ufeff','#!/bin/x\n','\n  ','<!-- head\n','--> head\n'];
  let seed=11;
  const random=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
  const pick=(list)=>list[Math.floor(random()*list.length)];
  for(let n=0;n<5000;n++){
    let code=pick(leads);
    const count=1+Math.floor(random()*3);
    for(let i=0;i<count;i++)code+=pick(strings)+pick(between)+(i===count-1?pick(after):'');
    code+=pick(tails);
    assert.equal(copy.prologueIsStrict(code),core.prologueIsStrict(code),JSON.stringify(code));
  }
});
