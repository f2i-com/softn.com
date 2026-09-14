import {Worker} from 'node:worker_threads';
// The supervising thread never enters guest WASM or SQLite. Its independent
// deadline remains effective during synchronous host work and if PHP exits.
let input='';
const deadline=setTimeout(()=>process.exit(1),20_000);
try {
  for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>6_000_000)throw new Error('Input limit');}
  const worker=new Worker(new URL('./request-worker.mjs',import.meta.url),{workerData:input,resourceLimits:{maxOldGenerationSizeMb:128}});
  worker.once('error',()=>process.exit(1));
  worker.once('exit',code=>{clearTimeout(deadline);process.exitCode=code;});
} catch {clearTimeout(deadline);process.exitCode=1;}
