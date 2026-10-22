// Whether server logic asks for strict mode: a `"use strict"` among the
// string-literal statements it opens with, spelled exactly so. The engine
// reads the directive off the start of the text it compiles, and that text
// begins with the shim (wasm-host.mjs), so the logic's own directive was an
// ordinary string and strict logic ran sloppy; the host puts the directive
// first when this says the logic asks for it.
//
// The same reading as the browser runtime's
// (packages/@softn/core/src/runtime/directive-prologue.ts), which is held to
// acorn's; tests/directive-prologue.test.mjs holds this one to that one.

const LINE_TERMINATOR=/[\n\r\u2028\u2029]/;
const WHITE_SPACE=/[\t\v\f \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
const IDENTIFIER_PART=/[\p{ID_Continue}$\u200c\u200d]/u;

function skip(code,at,lineStart){
  let newline=false;
  while(at<code.length){
    const c=code[at];
    if(LINE_TERMINATOR.test(c)){newline=true;at++;}
    else if(WHITE_SPACE.test(c))at++;
    else if(code.startsWith('//',at)||code.startsWith('<!--',at)||((newline||lineStart)&&code.startsWith('-->',at))){
      while(at<code.length&&!LINE_TERMINATOR.test(code[at]))at++;
    }else if(code.startsWith('/*',at)){
      const end=code.indexOf('*/',at+2);
      if(LINE_TERMINATOR.test(code.slice(at+2,end<0?code.length:end)))newline=true;
      at=end<0?code.length:end+2;
    }else break;
  }
  return {at,newline};
}

// Whether what starts at `at`, after a line break, carries on the expression before it.
function continuesExpression(code,at){
  const c=code[at],next=code[at+1]??'';
  if('([`,?=*%&|^<>/'.includes(c))return true;
  if(c==='.')return !/[0-9]/.test(next);
  if(c==='+'||c==='-')return next!==c;
  if(c==='!')return next==='=';
  for(const word of ['instanceof','in'])if(code.startsWith(word,at)&&!IDENTIFIER_PART.test(code[at+word.length]??''))return true;
  return false;
}

export const STRICT_DIRECTIVE='"use strict";';

export function prologueIsStrict(code){
  let at=0;
  if(code.charCodeAt(0)===0xfeff)at=1;
  if(code.startsWith('#!',at))while(at<code.length&&!LINE_TERMINATOR.test(code[at]))at++;
  let strict=false,first=true;
  for(;;){
    at=skip(code,at,first).at;
    first=false;
    const quote=code[at];
    if(quote!=='"'&&quote!=="'")return strict;
    let end=at+1;
    for(;end<code.length&&code[end]!==quote;end++){
      if(code[end]==='\\')end+=code[end+1]==='\r'&&code[end+2]==='\n'?2:1;
      else if(code[end]==='\n'||code[end]==='\r')return strict;
    }
    if(end>=code.length)return strict;
    const raw=code.slice(at+1,end);
    const after=skip(code,end+1,false);
    const next=code[after.at];
    const ends=after.at>=code.length||next===';'||next==='}'||(after.newline&&!continuesExpression(code,after.at));
    if(!ends)return strict;
    if(raw==='use strict')strict=true;
    at=next===';'?after.at+1:after.at;
  }
}
