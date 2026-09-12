import {configureZippWasmSource,ensureZippWasm} from './zipp-wasm-loader';
import {executeSandbox} from './sandbox-execute';
// This worker runs only ZIPP bytecode. Guest text is never browser JavaScript.
let started=false;
self.onmessage = async (event: MessageEvent) => {
  try {
    if(!started){
      if(event.data.zippWasm!==undefined)configureZippWasmSource(event.data.zippWasm);
      started=true;
    } else if(event.data.zippWasm!==undefined)throw new Error('The sandbox engine is already initialized');
    await ensureZippWasm();
    self.postMessage({ready:true});
    const value=executeSandbox(event.data.source,event.data.input);
    self.postMessage({value});
  } catch (error) { self.postMessage({error:String(error).slice(0,500)}); }
};
