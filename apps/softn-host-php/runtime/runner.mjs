import {Worker} from 'node:worker_threads';
// The supervising thread never enters guest WASM or SQLite. Its independent
// deadline remains effective during synchronous host work and if PHP exits.
// It ends the process with a signal: process.exit waits for the worker
// thread, and a worker inside a SQLite statement that never finishes is in
// native code that nothing interrupts, so the process outlived its deadline
// holding its slot and the write lock.
let input='',bytes=0;
// Decoded as a stream: a chunk boundary inside a character used to leave two
// U+FFFD where it had been, in any body not escaped to ASCII on the way here.
process.stdin.setEncoding('utf8');
const deadline=setTimeout(()=>{try{process.kill(process.pid,'SIGKILL');}catch{process.exit(1);}},20_000);
try {
  for await(const chunk of process.stdin){input+=chunk;bytes+=Buffer.byteLength(chunk);if(bytes>6_000_000)throw new Error('Input limit');}
  const worker=new Worker(new URL('./request-worker.mjs',import.meta.url),{workerData:input,resourceLimits:{maxOldGenerationSizeMb:128}});
  // The worker's own line names a handler or a startup stage; when it dies
  // without one (out of memory, say) this is all there is to go on.
  worker.once('error',e=>{try{process.stderr.write('softn: runner worker died: '+String(e?.code||e?.name||'error')+'\n');}catch{}process.exit(1);});
  worker.once('exit',code=>{clearTimeout(deadline);process.exitCode=code;});
} catch {clearTimeout(deadline);process.exitCode=1;}
