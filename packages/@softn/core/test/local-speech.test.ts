import {describe,expect,it,vi} from 'vitest';
import {LocalSpeechHost} from '../src/runtime/local-speech';
import {LocalSystemSpeechHost} from '../src/runtime/local-system-speech.mjs';
import {SoftNScriptRuntime} from '../src/runtime/script-runtime';

/** A speech engine with one local voice whose utterances start at once and end when told. */
function device() {
 const spoken:Array<{text:string;voice:{voiceURI:string};onstart?:()=>void;onend?:()=>void}>=[];
 const synthesis={getVoices:()=>[{voiceURI:'local',name:'Local',lang:'en',localService:true},{voiceURI:'remote',localService:false}],speaking:false,pending:false,
  speak:vi.fn((u:typeof spoken[number])=>{spoken.push(u);u.onstart?.();}),cancel:vi.fn()};
 class Utterance {voice!:{voiceURI:string};constructor(public text:string){}}
 return {synthesis,Utterance,spoken};
}

describe('speech on the device\'s voices',()=>{
 it('speaks with a system voice, and a request for a neural voice is spoken by one too, saying so',async()=>{
  const {synthesis,Utterance,spoken}=device();
  const host=new LocalSpeechHost({system:new LocalSystemSpeechHost({synthesis,Utterance})});
  const plain=await host.speak({text:'Hello'});
  expect(plain).toMatchObject({started:true,voiceURI:'local'});
  spoken[0].onend?.();
  const neural=await host.speak({provider:'kokoro',text:'Hello again',voiceURI:'af_heart'});
  expect(neural).toMatchObject({started:true,voiceURI:'local',fallbackFrom:'kokoro'});
  expect(host.state(String(neural.handle))).toMatchObject({provider:'system',status:'playing'});
  spoken[1].onend?.();
  expect(await host.handle('audio.whenSpeechEnded',[String(neural.handle)])).toMatchObject({status:'ended'});
  expect(await host.speak({provider:'network',text:'Hi'})).toMatchObject({started:false,reason:'unsupported-speech-provider'});
  host.dispose();
  expect(await host.speak({text:'late'})).toMatchObject({started:false,reason:'runtime-closed'});
 });

 it('says the neural model is gone rather than loading anything',async()=>{
  const host=new LocalSpeechHost({system:new LocalSystemSpeechHost({synthesis:undefined,Utterance:undefined})});
  expect(await host.handle('audio.loadSpeechModel',['{"provider":"kokoro"}'])).toEqual({loaded:false,reason:'neural-speech-removed'});
  expect(await host.handle('audio.releaseSpeechModel')).toEqual({released:true});
  expect(host.capabilities()).toMatchObject({available:false,neural:{supported:false,reason:'neural-speech-removed'}});
  expect(await host.handle('audio.speak',['{not json'])).toMatchObject({started:false,reason:'invalid-speech-json'});
  expect(await host.handle('audio.speak',['a','b'])).toEqual({error:'invalid-speech-arguments'});
  expect(host.state('nothing')).toMatchObject({status:'error',reason:'unknown-speech-handle'});
 });
});

it('system speech lists only local voices and does not cancel another owner',async()=>{
 const synthesis={getVoices:()=>[{voiceURI:'local',name:'Local',lang:'en',localService:true},{voiceURI:'remote',localService:false}],speaking:false,pending:false,speak:vi.fn(),cancel:vi.fn()};
 class Utterance {constructor(public text:string){}}
 const first=new LocalSystemSpeechHost({synthesis,Utterance});const second=new LocalSystemSpeechHost({synthesis,Utterance});
 expect(first.capabilities().voices).toHaveLength(1);const start=first.speak({text:'Hi'});expect(await second.speak({text:'No overlap'})).toMatchObject({started:false,reason:'speech-busy'});
 expect(second.stop('')).toMatchObject({stopped:false});expect(synthesis.cancel).not.toHaveBeenCalled();first.stop('');expect(await start).toMatchObject({started:false});expect(synthesis.cancel).toHaveBeenCalledOnce();first.dispose();second.dispose();
});

// The speech host loads at an app's first speech call. An app closed while it
// loaded had nothing for cleanup() to stop, and the host made afterwards spoke
// for it, holding the device's voice from every other app until it finished.
it('says nothing for an app that closed while its speech was loading',async()=>{
 const {synthesis,Utterance}=device();
 vi.stubGlobal('speechSynthesis',synthesis);vi.stubGlobal('SpeechSynthesisUtterance',Utterance);
 try{
  const r=Object.create(SoftNScriptRuntime.prototype);r.permissionConfig=null;r.localSpeech=null;
  const answer=r.executeHostCall({kind:'audio.speak',id:2,args:['{"text":"Still there?"}']});
  r.disposed=true;
  expect(await answer).toMatchObject({started:false,reason:'runtime-closed'});
  expect(synthesis.speak).not.toHaveBeenCalled();
 }finally{vi.unstubAllGlobals();}
});

describe('speech needs no AI permission now that it downloads nothing',()=>{
 const call={kind:'audio.loadSpeechModel',id:1,args:['{"provider":"kokoro"}']};
 it('answers a neural load for any app, and speaks without ai',async()=>{
  for(const config of [null,{permissions:{}},{permissions:{ai:{enabled:true}},consentPending:true}]){
   const r=Object.create(SoftNScriptRuntime.prototype);r.permissionConfig=config;
   expect(await r.executeHostCall(call)).toEqual({loaded:false,reason:'neural-speech-removed'});
  }
 });
});
