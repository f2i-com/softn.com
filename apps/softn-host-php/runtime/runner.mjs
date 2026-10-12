import {Worker} from 'node:worker_threads';
import {readFileSync,writeFileSync,writeSync} from 'node:fs';
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
// Twenty seconds. A test may shorten it, never lengthen it: http.php and
// setup.php start the runner with an environment of their own that does not
// carry this variable, and anything outside 1 to 20,000 is the twenty seconds.
const shortened=Number(process.env.SOFTN_RUNNER_DEADLINE_MS);
const DEADLINE_MS=Number.isInteger(shortened)&&shortened>=1&&shortened<=20_000?shortened:20_000;
// The migration the worker is applying, as it says before it starts one
// (request-worker.mjs), or null.
let migration=null;
/**
 * A migration the deadline stopped: said in the log, by its file name, and
 * written down where the next request's worker reads it before it starts
 * the same migration again. The worker gives up on it after `attempts`
 * stops (request-worker.mjs). Written as the process ends, so synchronously.
 */
function stopped(m) {
  try {
    let stops=1;
    try{const was=JSON.parse(readFileSync(m.marker,'utf8'));if(was.name===m.name&&was.sha256===m.sha256)stops=(Number(was.stops)||0)+1;}catch{}
    writeFileSync(m.marker,JSON.stringify({name:m.name,sha256:m.sha256,stops}),{mode:0o600});
    writeSync(2,`softn: startup stage database_migrations: migration ${m.file} was stopped at the ${DEADLINE_MS/1000} s deadline (${stops} of ${m.attempts})\n`);
  } catch { /* The stop itself goes ahead. */ }
}
const deadline=setTimeout(()=>{if(migration)stopped(migration);try{process.kill(process.pid,'SIGKILL');}catch{process.exit(1);}},DEADLINE_MS);
try {
  for await(const chunk of process.stdin){input+=chunk;bytes+=Buffer.byteLength(chunk);if(bytes>6_000_000)throw new Error('Input limit');}
  const worker=new Worker(new URL('./request-worker.mjs',import.meta.url),{workerData:input,resourceLimits:{maxOldGenerationSizeMb:128}});
  worker.on('message',m=>{if(m&&typeof m==='object'&&Object.hasOwn(m,'migration'))migration=m.migration;});
  // The worker's own line names a handler or a startup stage; when it dies
  // without one (out of memory, say) this is all there is to go on.
  worker.once('error',e=>{try{process.stderr.write('softn: runner worker died: '+String(e?.code||e?.name||'error')+'\n');}catch{}process.exit(1);});
  worker.once('exit',code=>{clearTimeout(deadline);process.exitCode=code;});
} catch {clearTimeout(deadline);process.exitCode=1;}
