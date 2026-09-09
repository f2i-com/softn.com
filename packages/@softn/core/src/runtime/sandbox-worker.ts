import initWasm from '../../wasm-zipp/zipp_wasm.js';
import {executeSandbox} from './sandbox-execute';
// This worker runs only ZIPP bytecode. Guest text is never browser JavaScript.
self.onmessage = async (event: MessageEvent) => {
  try {
    await initWasm();
    self.postMessage({ready:true});
    const value=executeSandbox(event.data.source,event.data.input);
    self.postMessage({value});
  } catch (error) { self.postMessage({error:String(error).slice(0,500)}); }
};
