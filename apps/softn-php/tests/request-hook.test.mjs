import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeWithHook} from '../runtime/request-hook.mjs';
test('request context is stripped and operator hook is opt-in',async()=>{
  const result=await invokeWithHook({request:{context:{approved:true},body:{context:'untrusted'}},route:{},config:{},host:{invoke:(req,route,context)=>({req,context})},loadHook:()=>{throw Error('must not load');}});
  assert.equal(result.req.context,undefined);assert.deepEqual(result.context,{});assert.equal(result.req.body.context,'untrusted');
});
test('enabled operator can supply context without accepting client context',async()=>{
  const result=await invokeWithHook({request:{context:{approved:false}},route:{},config:{enableRequestHook:true},host:{invoke:(req,route,context)=>context},loadHook:async()=>({handleRequest:({request,invoke})=>{assert.equal(request.context,undefined);return invoke({approved:true});}})});
  assert.deepEqual(result,{approved:true});
});
test('missing enabled hook fails closed',async()=>{
  await assert.rejects(invokeWithHook({request:{},route:{},config:{enableRequestHook:true},host:{invoke:()=>assert.fail('must not invoke')},loadHook:async()=>{throw Error('missing');}}),/missing/);
});
